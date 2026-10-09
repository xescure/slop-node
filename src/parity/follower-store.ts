import pg from 'pg';
import { BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, layoutOf, progressOf } from '../node/bootstrap-cursors.js';
import type { PeerProgress } from '../node/bootstrap-pass.js';
import type { RangeLayout } from '../node/bootstrap-ranges.js';

/** How far the follower's bootstrap has come, as its node stored it (src/node/bootstrap-cursors.ts). */
export type FollowerProgress = {
	/** The horizon of the latest bootstrap pass that completed, or nothing while none has. */
	readonly completedPass: Date | undefined;
	/**
	 * The follower holds, or has queued for retry, every staple whose votes
	 * the representatives keyed before this moment; nothing while it has
	 * read from none.
	 */
	readonly heldBefore: Date | undefined;
};

/** An account the follower's ledger names, with the row that orders the sweep over them. */
export type KnownAccount = {
	readonly rowID: string;
	readonly account: string;
	/** The time of the newest staple in the account's history on the follower, or nothing when it has none. */
	readonly newestStaple: Date | undefined;
};

/** What the parity tools read of the follower's own storage. */
export type FollowerStore = {
	progress(): Promise<FollowerProgress>;
	/** The accounts after the row, in row order, at most the count of them. */
	accountsAfter(rowID: string, count: number): Promise<readonly KnownAccount[]>;
	accountCount(): Promise<number>;
	/** How many accounts there are up to the row, in row order. */
	accountsUpTo(rowID: string): Promise<number>;
	/** Whether the staple, by the hash of its blocks, is in the account's history on the follower's main ledger. */
	historyHolds(account: string, blocksHash: string): Promise<boolean>;
	close(): Promise<void>;
};

/**
 * Where the follower holds every staple before. While it reads ranges, the
 * ranges not read yet are kept in order and everything before the earliest's
 * reach was read; otherwise every representative serves the whole ledger,
 * so whatever was read from the one reached furthest is all there is before
 * that.
 */
export function heldBeforeOf(layout: RangeLayout | undefined, peers: readonly PeerProgress[]): Date | undefined {
	if (layout !== undefined) {
		return(layout.ranges[0]?.reached ?? layout.end);
	}
	const furthest = Math.max(...peers.map(function(peer): number {
		return(peer.reached.getTime());
	}));
	if (!Number.isFinite(furthest)) {
		return(undefined);
	}
	return(new Date(furthest));
}

/**
 * A pool whose sessions cannot write: the follower's node owns its
 * database, and the parity tools only read it. One connection serves the
 * tools, which query one at a time.
 */
export function readOnlyPool(connectionString: string): pg.Pool {
	const pool = new pg.Pool({
		connectionString,
		max: 1,
		options: '-c default_transaction_read_only=on',
		statement_timeout: 30_000,
		connectionTimeoutMillis: 10_000
	});
	pool.on('error', function() {
		// A connection lost while idle is replaced at the next query, which reports any failure.
	});
	return(pool);
}

const KV_VALUE = 'SELECT value FROM kv_entries WHERE arena = $1 AND key = $2 AND (expires_at IS NULL OR expires_at > now())';

const KV_VALUES = 'SELECT value FROM kv_entries WHERE arena = $1 AND (expires_at IS NULL OR expires_at > now())';

/** The history key leads with the account and the staple time, so its newest staple is the last of its keys. */
const ACCOUNTS_AFTER = `
	SELECT a.id, a.public_key, (SELECT max(h.staple_time) FROM history h WHERE h.account_id = a.id) AS newest_staple
	FROM accounts a WHERE a.id > $1::bigint ORDER BY a.id LIMIT $2`;

/** The history key is (account, staple time, blocks hash), and the staple's time is found from its hash. */
const HISTORY_HOLDS = `
	SELECT EXISTS (
		SELECT 1 FROM staples s
		JOIN history h ON h.account_id = (SELECT id FROM accounts WHERE public_key = $1) AND h.staple_time = s.staple_time AND h.blocks_hash = s.blocks_hash
		WHERE s.blocks_hash = $2
	) AS holds`;

function isWholeNumber(value: unknown): value is number {
	return(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

/** The follower's store, read through a pool of read-only sessions on its database. */
export function openFollowerStore(connectionString: string): FollowerStore {
	const pool = readOnlyPool(connectionString);
	return({
		async progress(): Promise<FollowerProgress> {
			const caughtUp = await pool.query<{ value: unknown }>(KV_VALUE, [BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY]);
			const layout = await pool.query<{ value: unknown }>(KV_VALUE, [BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY]);
			const cursors = await pool.query<{ value: unknown }>(KV_VALUES, [BOOTSTRAP_CURSOR_ARENA]);
			const horizon = caughtUp.rows[0]?.value;
			let completedPass: Date | undefined;
			if (isWholeNumber(horizon)) {
				completedPass = new Date(horizon);
			}
			const peers = cursors.rows.map(function(row) {
				return(progressOf(row.value));
			}).filter(function(peer): peer is PeerProgress {
				return(peer !== undefined);
			});
			return({ completedPass, heldBefore: heldBeforeOf(layoutOf(layout.rows[0]?.value), peers) });
		},
		async accountsAfter(rowID: string, count: number): Promise<readonly KnownAccount[]> {
			const result = await pool.query<{ id: string; public_key: string; newest_staple: Date | null }>(ACCOUNTS_AFTER, [rowID, count]);
			return(result.rows.map(function(row): KnownAccount {
				return({ rowID: row.id, account: row.public_key, newestStaple: row.newest_staple ?? undefined });
			}));
		},
		async accountCount(): Promise<number> {
			const result = await pool.query<{ count: string }>('SELECT count(*) AS count FROM accounts');
			return(Number(result.rows[0]?.count ?? 0));
		},
		async accountsUpTo(rowID: string): Promise<number> {
			const result = await pool.query<{ count: string }>('SELECT count(*) AS count FROM accounts WHERE id <= $1::bigint', [rowID]);
			return(Number(result.rows[0]?.count ?? 0));
		},
		async historyHolds(account: string, blocksHash: string): Promise<boolean> {
			const result = await pool.query<{ holds: boolean }>(HISTORY_HOLDS, [account, Buffer.from(blocksHash, 'hex')]);
			return(result.rows[0]?.holds ?? false);
		},
		async close(): Promise<void> {
			await pool.end();
		}
	});
}
