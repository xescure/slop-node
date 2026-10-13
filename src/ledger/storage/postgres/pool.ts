import pg from 'pg';
import { assertNever } from '../../../util/assert-never.js';
import { SCHEMA_MIGRATIONS, applyMigrations } from './migrations.js';

/** The settings of a pool the driver opens itself; an injected pool keeps its owner's. */
export type PostgresPoolOptions = {
	/** The most connections the pool holds open at once. */
	readonly max: number;
	/** How long a checkout waits for a connection, whether opening one or queued for a busy pool. */
	readonly connectionTimeoutMillis: number;
	/** TCP keepalive on every connection, so a peer that vanished is noticed while a connection idles. */
	readonly keepAlive: boolean;
	/** How long a connection idles before the first keepalive probe; left at 0, the operating system's default applies, two hours on Linux. */
	readonly keepAliveInitialDelayMillis: number;
	/** The session's statement_timeout: the server cancels a statement that runs longer. */
	readonly statementTimeoutMillis: number;
	/** The session's idle_in_transaction_session_timeout: the server ends a session left idle inside a transaction this long. */
	readonly idleInTransactionTimeoutMillis: number;
};

/*
 * Ledger.run gives up retrying once 5 s have passed since the first attempt
 * [Keeta TS] index.js:70294-70389. A checkout queued longer than that has
 * outlived the retries of the request waiting for it, so it fails instead of
 * hanging. Between the statements of one attempt the process only computes,
 * for milliseconds, so a session idle in a transaction for twice the budget
 * belongs to a process that has stopped; ending it releases the row locks
 * that other attempts wait on. A statement may run longer than the budget:
 * gc runs its batches in one transaction for up to its time limit, 280 s by
 * default [Keeta TS] index.js:68888-68898, though each statement handles at
 * most one batch, and stats counts the whole main ledger in one statement.
 * Thirty seconds leaves room for those on a large ledger and still ends a
 * statement stuck waiting for a lock, which the idle limit frees long before.
 */
export const DEFAULT_POOL_OPTIONS: PostgresPoolOptions = {
	max: 10,
	connectionTimeoutMillis: 5000,
	keepAlive: true,
	keepAliveInitialDelayMillis: 10000,
	statementTimeoutMillis: 30000,
	idleInTransactionTimeoutMillis: 10000
};

/**
 * Where the connections come from: a pool someone else owns and supplies, or
 * a connection string from which a pool of our own is opened, with any of the
 * default options overridden.
 */
export type PostgresPoolSource =
	| { readonly kind: 'injected'; readonly pool: () => Promise<pg.Pool> }
	| { readonly kind: 'connection-string'; readonly connectionString: string; readonly options?: Partial<PostgresPoolOptions> };

const poolConfig = function(connectionString: string, overrides: Partial<PostgresPoolOptions>): pg.PoolConfig {
	const options: PostgresPoolOptions = { ...DEFAULT_POOL_OPTIONS, ...overrides };
	// pg sends both timeouts as startup parameters, so every session begins with them.
	return({
		connectionString,
		max: options.max,
		connectionTimeoutMillis: options.connectionTimeoutMillis,
		keepAlive: options.keepAlive,
		keepAliveInitialDelayMillis: options.keepAliveInitialDelayMillis,
		statement_timeout: options.statementTimeoutMillis,
		idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMillis
	});
};

/** A pool, and whether closing it here is ours to do. */
export class PostgresPool {
	readonly pool: pg.Pool;
	readonly #owned: boolean;
	#closing: Promise<void> | undefined;

	private constructor(pool: pg.Pool, owned: boolean) {
		this.pool = pool;
		this.#owned = owned;
	}

	static async open(source: PostgresPoolSource): Promise<PostgresPool> {
		switch (source.kind) {
			case 'injected':
				return(new PostgresPool(await source.pool(), false));
			case 'connection-string': {
				const pool = new pg.Pool(poolConfig(source.connectionString, source.options ?? {}));
				pool.on('error', function() {
					// The pool drops a connection that fails while idle and
					// opens a fresh one on the next checkout; without a
					// listener the event would end the process.
				});
				return(new PostgresPool(pool, true));
			}
			default:
				return(assertNever(source));
		}
	}

	/** Opens the pool and brings the database up to this build's schema; a pool opened here is closed again if that fails. */
	static async openMigrated(source: PostgresPoolSource): Promise<PostgresPool> {
		const connection = await PostgresPool.open(source);
		try {
			await applyMigrations(connection.pool, SCHEMA_MIGRATIONS);
		} catch (error: unknown) {
			await connection.close();
			throw(error);
		}
		return(connection);
	}

	/** Ends a pool opened here, once; an injected pool is left to its owner. */
	close(): Promise<void> {
		if (!this.#owned) {
			return(Promise.resolve());
		}
		this.#closing ??= this.pool.end();
		return(this.#closing);
	}
}

/**
 * The pool of one store, opened and migrated on first use. A failed attempt
 * is forgotten, so the next use tries again; after destroy every use fails.
 */
export class MigratedPostgresPool {
	readonly #source: PostgresPoolSource;
	readonly #owner: string;
	#opening: Promise<PostgresPool> | undefined;
	#destroyed = false;

	/** The owner names the store in the error a use after destroy raises. */
	constructor(source: PostgresPoolSource, owner: string) {
		this.#source = source;
		this.#owner = owner;
	}

	connection(): Promise<PostgresPool> {
		if (this.#destroyed) {
			return(Promise.reject(new Error(`${this.#owner} is destroyed`)));
		}
		this.#opening ??= PostgresPool.openMigrated(this.#source).catch((error: unknown) => {
			this.#opening = undefined;
			throw(error);
		});
		return(this.#opening);
	}

	/** Ends the pool if it was opened here; an injected pool is left to its owner. */
	async destroy(): Promise<void> {
		this.#destroyed = true;
		const opening = this.#opening;
		this.#opening = undefined;
		const connection = await opening?.catch(function() {
			return(undefined);
		});
		await connection?.close();
	}
}
