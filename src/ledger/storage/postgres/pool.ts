import pg from 'pg';
import { assertNever } from '../../../util/assert-never.js';

/**
 * Where the connections come from: a pool someone else owns and supplies, or
 * a connection string from which a pool of our own is opened.
 */
export type PostgresPoolSource =
	| { readonly kind: 'injected'; readonly pool: () => Promise<pg.Pool> }
	| { readonly kind: 'connection-string'; readonly connectionString: string };

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
				const pool = new pg.Pool({ connectionString: source.connectionString });
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

	/** Ends a pool opened here, once; an injected pool is left to its owner. */
	close(): Promise<void> {
		if (!this.#owned) {
			return(Promise.resolve());
		}
		this.#closing ??= this.pool.end();
		return(this.#closing);
	}
}
