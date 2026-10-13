import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { KVErrorCode } from '@keetanetwork/keetanet-client/lib/error/kv.js';
import type { KVSetOptionsType, KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { BufferStorage } from '@keetanetwork/keetanet-client/lib/utils/buffer.js';
import type { JSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { checkIn, checkOut } from '../ledger/storage/postgres/connection.js';
import { isTransientCheckoutError, isTransientDatabaseError } from '../ledger/storage/postgres/errors.js';
import type { FailedStatement } from '../ledger/storage/postgres/errors.js';
import { MigratedPostgresPool } from '../ledger/storage/postgres/pool.js';
import type { PostgresPoolSource } from '../ledger/storage/postgres/pool.js';
import { Statement } from '../ledger/storage/postgres/sql.js';
import type { SQLValue } from '../ledger/storage/postgres/sql.js';

const lib = KeetaNet.lib;

const BUFFER_KEY_PREFIX = '@buffer:';

/*
 * A write that sets an expiry then removes at most this many expired entries
 * of its arena. Each such write adds at most one entry that can expire, so
 * expired rows never pile up, and no process has to sweep the table.
 */
const EXPIRED_ENTRIES_REMOVED_PER_WRITE = 2;

function kvStatement<Parameters extends readonly SQLValue[], Row extends object = Record<string, never>>(name: string, text: string): Statement<Parameters, Row> {
	return(new Statement<Parameters, Row>(`kv_${name}`, text));
}

/** An entry counts while it has no expiry or its expiry is not before the caller's moment, the parameter given. */
function liveEntry(moment: `$${number}`): string {
	return(`(kv_entries.expires_at IS NULL OR kv_entries.expires_at >= ${moment}::timestamptz)`);
}

const entryOf: Statement<[string, string, Date], { value: JSONSerializable }> = kvStatement('entry_of', `
	SELECT value FROM kv_entries WHERE arena = $1 AND key = $2 AND ${liveEntry('$3')}`);

const entriesOf: Statement<[string, Date], { key: string; value: JSONSerializable }> = kvStatement('entries_of', `
	SELECT key, value FROM kv_entries WHERE arena = $1 AND ${liveEntry('$2')} ORDER BY key`);

const keysOf: Statement<[string, Date], { key: string }> = kvStatement('keys_of', `
	SELECT key FROM kv_entries WHERE arena = $1 AND ${liveEntry('$2')} ORDER BY key`);

const liveEntryCount: Statement<[string, string, Date], { count: string }> = kvStatement('live_entry_count', `
	SELECT count(*) AS count FROM kv_entries WHERE arena = $1 AND key = $2 AND ${liveEntry('$3')}`);

const putEntry: Statement<[string, string, string, Date | null]> = kvStatement('put_entry', `
	INSERT INTO kv_entries (arena, key, value, expires_at) VALUES ($1, $2, $3::json, $4)
	ON CONFLICT (arena, key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`);

// An expired entry is absent, so an exclusive create replaces it; a live one returns no row.
const createEntry: Statement<[string, string, string, Date | null, Date], { arena: string }> = kvStatement('create_entry', `
	INSERT INTO kv_entries (arena, key, value, expires_at) VALUES ($1, $2, $3::json, $4)
	ON CONFLICT (arena, key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
	WHERE kv_entries.expires_at < $5::timestamptz
	RETURNING arena`);

const deleteEntry: Statement<[string, string]> = kvStatement('delete_entry', `
	DELETE FROM kv_entries WHERE arena = $1 AND key = $2`);

// Another process purging at once takes other rows instead of waiting for these.
const purgeExpiredEntries: Statement<[string, Date, number]> = kvStatement('purge_expired_entries', `
	DELETE FROM kv_entries WHERE (arena, key) IN (
		SELECT arena, key FROM kv_entries
		WHERE arena = $1 AND expires_at < $2::timestamptz
		ORDER BY expires_at
		LIMIT $3
		FOR UPDATE SKIP LOCKED)`);

/*
 * Counts in double precision, as upstream's memory store counts in
 * JavaScript numbers. An expired counter counts from zero and loses its
 * expiry; an unexpired one keeps it [Keeta TS] index.js:67967-67986. A live
 * value that is not a number returns no row.
 */
const incrementEntry: Statement<[string, string, number, Date], { total: string }> = kvStatement('increment_entry', `
	INSERT INTO kv_entries AS entry (arena, key, value) VALUES ($1, $2, to_json($3::float8))
	ON CONFLICT (arena, key) DO UPDATE SET
		value = to_json(CASE WHEN entry.expires_at < $4::timestamptz THEN 0 ELSE (entry.value #>> '{}')::float8 END + $3::float8),
		expires_at = CASE WHEN entry.expires_at < $4::timestamptz THEN NULL ELSE entry.expires_at END
	WHERE entry.expires_at < $4::timestamptz OR json_typeof(entry.value) = 'number'
	RETURNING value #>> '{}' AS total`);

const bufferOf: Statement<[string], { value: Buffer }> = kvStatement('buffer_of', `
	SELECT value FROM kv_buffers WHERE key = $1`);

// The upsert locks the row it updates, so concurrent folds into one key apply one after another.
const foldBuffer: Statement<[string, Buffer]> = kvStatement('fold_buffer', `
	INSERT INTO kv_buffers AS stored (key, value) VALUES ($1, $2)
	ON CONFLICT (key) DO UPDATE SET value = kv_xor(stored.value, EXCLUDED.value)`);

/** How the store makes an operation again after a transient failure. */
export type KVRetryPolicy = {
	/** The most attempts at one operation, the first included. */
	readonly attempts: number;
	/** How long to wait after the failed attempt of this number, counted from 1, before the next. */
	readonly backoffMilliseconds: (failedAttempt: number) => number;
};

/** The longest wait after the first failed attempt; each later one may wait twice as long as the one before. */
const FIRST_BACKOFF_CEILING_MILLISECONDS = 100;

/**
 * Three attempts. Each wait is drawn from the upper half of its ceiling,
 * 100 ms and then 200 ms, so that writers that failed together do not retry
 * together: an operation waits at most 300 ms in all between its attempts,
 * besides the attempts themselves, each of which the pool's checkout
 * timeout and the session's statement timeout bound.
 */
export const DEFAULT_KV_RETRY_POLICY: KVRetryPolicy = {
	attempts: 3,
	backoffMilliseconds: function(failedAttempt: number): number {
		const ceiling = FIRST_BACKOFF_CEILING_MILLISECONDS * 2 ** (failedAttempt - 1);
		return(ceiling * (1 + Math.random()) / 2);
	}
};

/** How one attempt at an operation ended; a failure is transient when it committed nothing and may pass. */
type Attempt<Result> =
	| { readonly kind: 'committed'; readonly result: Result }
	| { readonly kind: 'failed'; readonly error: unknown; readonly transient: boolean };

/**
 * Builds upstream's error for a code of its key-value type. The package
 * exports no key-value error class, so the public JSON decoder builds it.
 * [Keeta TS] index.js:67343-67347, 67408-67410, 67435-67440
 */
function createKVError(code: KVErrorCode, message: string): Error {
	const error = lib.Error.fromJSON({ type: 'KV', code, message });
	if (!lib.Error.isInstance(error) || error.code !== code) {
		throw(new Error(`internal error: upstream did not build a ${code} error`, { cause: error }));
	}
	return(error);
}

/**
 * The moment an entry stored now with this ttl expires, by the caller's
 * clock, as upstream's memory store computes it
 * [Keeta TS] index.js:67923-67926. The store refuses a ttl that names no
 * moment a Date can hold.
 */
function expiryOf(ttl: number | undefined): Date | null {
	if (ttl === undefined) {
		return(null);
	}
	const expiry = new Date(Date.now() + ttl);
	if (Number.isNaN(expiry.valueOf())) {
		throw(createKVError('KV_TTL_NOT_SUPPORTED', `a ttl of ${String(ttl)} ms names no moment the store can hold`));
	}
	return(expiry);
}

/** JSON has no NaN or infinities, and storing them as null would change the value. */
function encodeValue(value: JSONSerializable): string {
	return(JSON.stringify(value, function(_key: string, item: unknown): unknown {
		if (typeof item === 'number' && !Number.isFinite(item)) {
			throw(new TypeError(`${String(item)} cannot be stored as JSON`));
		}
		return(item);
	}));
}

/**
 * Upstream's key-value store (lib/kv) on Postgres, in the schema the
 * migrations create, sharing one database with the ledger driver and with
 * other processes of the same node.
 *
 * Every operation runs in its own READ COMMITTED transaction, whatever the
 * database's default isolation. Each write is one statement whose outcome
 * the row lock of its upsert decides: concurrent increments and folds of one
 * key wait for each other and each reads the committed result of the one
 * before, and of two concurrent exclusive creates of one key, the second
 * finds the first's row. SERIALIZABLE would abort one of two such writes
 * instead, for a retry that reaches the same result. A read is one
 * statement, so it sees one snapshot.
 *
 * An operation that fails transiently, committing nothing, is attempted
 * again as the retry policy says: the switch writes to the store from timers
 * and from work it does not wait for [Keeta TS] index.js:73770-73806, 74163-74165,
 * so a database that is busy or restarting for a moment would otherwise fail
 * work that no caller retries. Any other failure is the operation's.
 */
export class PostgresKVStorage implements KVStorageProviderAPI {
	readonly #pool: MigratedPostgresPool;
	readonly #retry: KVRetryPolicy;

	constructor(source: PostgresPoolSource, retry: KVRetryPolicy = DEFAULT_KV_RETRY_POLICY) {
		this.#pool = new MigratedPostgresPool(source, 'key-value store');
		this.#retry = retry;
	}

	/** Ends the pool if this store opened it; an injected pool is left to its owner. */
	destroy(): Promise<void> {
		return(this.#pool.destroy());
	}

	/**
	 * Stores the value, or removes the key for undefined or null; an
	 * exclusive create refuses a key that has a live entry
	 * [Keeta TS] index.js:67914-67932.
	 */
	async set(arena: string, key: string, value: JSONSerializable | undefined, options?: KVSetOptionsType): Promise<void> {
		const exclusive = options?.exclusiveCreate ?? false;
		const moment = new Date();
		if (value === undefined) {
			await this.#run(deleteEntry, [arena, key]);
			return;
		}
		if (value === null) {
			// An expired entry is already absent, so an exclusive create of null
			// only checks; deleting afterwards could remove an entry created since.
			if (!exclusive) {
				await this.#run(deleteEntry, [arena, key]);
			} else if (await this.#hasLiveEntry(arena, key, moment)) {
				throw(this.#existingKeyError(arena, key));
			}
			return;
		}
		const text = encodeValue(value);
		const expiry = expiryOf(options?.ttl);
		/*
		 * The write is the only statement that waits for a lock, and it runs
		 * first, so the transaction holds no lock while it waits. The purge
		 * after it skips rows other transactions hold, so it never waits, and
		 * the two cannot deadlock with another transaction.
		 */
		await this.#transaction(async (client): Promise<void> => {
			if (exclusive) {
				const created = await query(client, createEntry, [arena, key, text, expiry, moment]);
				if (created.length === 0) {
					throw(this.#existingKeyError(arena, key));
				}
			} else {
				await query(client, putEntry, [arena, key, text, expiry]);
			}
			if (expiry !== null) {
				await query(client, purgeExpiredEntries, [arena, moment, EXPIRED_ENTRIES_REMOVED_PER_WRITE]);
			}
		});
	}

	/**
	 * A named arena's live entry, or, in the null arena, the buffer under the
	 * key as uppercase hex, as upstream prints a BufferStorage
	 * [Keeta TS] index.js:67901-67906, 67933-67950, 78006-78009.
	 */
	async get(arena: string | null, key: string): Promise<JSONSerializable | undefined> {
		if (arena === null) {
			const [buffer] = await this.#run(bufferOf, [key]);
			return(buffer?.value.toString('hex').toUpperCase());
		}
		const [entry] = await this.#run(entryOf, [arena, key, new Date()]);
		return(entry?.value);
	}

	async getAll(arena: string): Promise<{ [key: string]: JSONSerializable }> {
		const entries = await this.#run(entriesOf, [arena, new Date()]);
		// fromEntries defines each key as its own property, "__proto__" included.
		return(Object.fromEntries(entries.map(function(entry): [string, JSONSerializable] {
			return([entry.key, entry.value]);
		})));
	}

	/** The keys of the arena's live entries, in byte order. */
	async list(arena: string): Promise<string[]> {
		const keys = await this.#run(keysOf, [arena, new Date()]);
		return(keys.map(function(entry): string {
			return(entry.key);
		}));
	}

	/**
	 * Adds the change to the counter and returns the new total. A change that
	 * is not a finite number is refused before it can reach the store.
	 */
	async incr(arena: string, key: string, change: number): Promise<bigint> {
		if (!Number.isFinite(change)) {
			throw(new TypeError(`cannot increment by ${String(change)}`));
		}
		const [row] = await this.#run(incrementEntry, [arena, key, change, new Date()]);
		if (row === undefined) {
			throw(new Error('May not increment non-number'));
		}
		return(BigInt(Number(row.total)));
	}

	/**
	 * Folds the change into the null arena's buffer under the key; the arena
	 * argument is ignored, as upstream ignores it
	 * [Keeta TS] index.js:67867-67872, 67987-68004.
	 */
	async xor(_arena: null, key: string, change: BufferStorage): Promise<void> {
		if (!key.startsWith(BUFFER_KEY_PREFIX)) {
			throw(new Error('Key provided for XOR must begin with "@buffer"'));
		}
		await this.#run(foldBuffer, [key, change.getBuffer()]);
	}

	async #hasLiveEntry(arena: string, key: string, moment: Date): Promise<boolean> {
		const [row] = await this.#run(liveEntryCount, [arena, key, moment]);
		return(row !== undefined && row.count !== '0');
	}

	#existingKeyError(arena: string, key: string): Error {
		return(createKVError('KV_KEY_ALREADY_EXISTS', `${arena}: ${key} already exists`));
	}

	#run<Parameters extends readonly SQLValue[], Row extends object>(statement: Statement<Parameters, Row>, parameters: Parameters): Promise<Row[]> {
		return(this.#transaction(function(client): Promise<Row[]> {
			return(query(client, statement, parameters));
		}));
	}

	async #transaction<Result>(work: (client: pg.PoolClient) => Promise<Result>): Promise<Result> {
		let attempt = 1;
		let outcome = await this.#attempt(work);
		while (outcome.kind === 'failed' && outcome.transient && attempt < this.#retry.attempts) {
			await delay(this.#retry.backoffMilliseconds(attempt));
			attempt++;
			outcome = await this.#attempt(work);
		}
		if (outcome.kind === 'failed') {
			throw(outcome.error);
		}
		return(outcome.result);
	}

	/*
	 * A connection whose rollback or COMMIT fails may still hold the
	 * transaction, so it is closed rather than returned to the pool.
	 */
	async #attempt<Result>(work: (client: pg.PoolClient) => Promise<Result>): Promise<Attempt<Result>> {
		let client: pg.PoolClient;
		try {
			const { pool } = await this.#pool.connection();
			client = await checkOut(pool);
		} catch (error: unknown) {
			return({ kind: 'failed', error, transient: isTransientCheckoutError(error) });
		}
		// pg reports the loss of the connection before it fails the statements it affects.
		let connectionLost = false;
		const noteConnectionLost = function(): void {
			connectionLost = true;
		};
		client.on('error', noteConnectionLost);
		let broken = false;
		const failed = function(error: unknown, statement: FailedStatement): Attempt<Result> {
			return({ kind: 'failed', error, transient: isTransientDatabaseError(error, statement) });
		};
		try {
			let result: Result;
			try {
				await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
				result = await work(client);
			} catch (error: unknown) {
				await client.query('ROLLBACK').catch(function() {
					broken = true;
				});
				return(failed(error, { kind: 'before-commit', connectionLost }));
			}
			try {
				await client.query('COMMIT');
			} catch (error: unknown) {
				broken = true;
				return(failed(error, { kind: 'commit' }));
			}
			return({ kind: 'committed', result });
		} finally {
			client.removeListener('error', noteConnectionLost);
			checkIn(client, broken);
		}
	}
}

async function query<Parameters extends readonly SQLValue[], Row extends object>(client: pg.PoolClient, statement: Statement<Parameters, Row>, parameters: Parameters): Promise<Row[]> {
	const result = await client.query<Row>({ name: statement.name, text: statement.text, values: Array.from(parameters) });
	return(result.rows);
}
