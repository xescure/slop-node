import pg from 'pg';
import { BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, layoutOf, progressOf } from '../node/bootstrap-cursors.js';
import type { PeerProgress } from '../node/bootstrap-pass.js';
import type { RangeLayout } from '../node/bootstrap-ranges.js';
import { LEDGER_CHECKSUM_KEY } from '../ledger/storage/base.js';
import { assertNever } from '../util/assert-never.js';

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

/** A main staple, the order the follower committed it in, and the XOR of the hashes of its blocks. */
export type StapleFold = {
	/** The staple's row in commit order, as decimal text. */
	readonly sequence: string;
	readonly blocksHash: string;
	readonly moment: Date;
	readonly fold: bigint;
};

/** Which staples a checksum snapshot lists beside the totals. */
export type SnapshotStaples = { readonly kind: 'newest'; readonly count: number } | { readonly kind: 'every' };

/** The stored checksum and the XOR of the main ledger's blocks, read from one view of the database. */
export type ChecksumSnapshot = {
	/** The ledger checksum statistic as stored, zero while none is. */
	readonly stored: bigint;
	/** The XOR of the hash of every block on the main ledger. */
	readonly folded: bigint;
	readonly mainBlocks: number;
	/** The staples asked for, oldest first by commit order. */
	readonly staples: readonly StapleFold[];
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
	checksumSnapshot(staples: SnapshotStaples): Promise<ChecksumSnapshot>;
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

/*
 * A hash is 32 bytes, so it reads as a bit string of 256 bits, which
 * bit_xor folds. On the follower, folding 224,212 main blocks took 164 ms,
 * so the whole ledger is folded afresh each time rather than kept as a
 * running total that would need its own record of what it covers.
 */
function bitsOf(column: string): string {
	return(`('x' || encode(${column}, 'hex'))::bit(256)`);
}

const STORED_CHECKSUM = 'SELECT value FROM kv_buffers WHERE key = $1';

const FOLDED_MAIN_BLOCKS = `SELECT count(*) AS blocks, bit_xor(${bitsOf('hash')})::text AS fold FROM blocks WHERE ledger = 'main'`;

const STAPLE_FOLDS = `
	SELECT s.sequence::text AS sequence, s.blocks_hash, s.moment, (SELECT bit_xor(${bitsOf('b.hash')}) FROM blocks b WHERE b.staple = s.blocks_hash)::text AS fold
	FROM staples s`;

const NEWEST_STAPLE_FOLDS = `${STAPLE_FOLDS} ORDER BY s.sequence DESC LIMIT $1`;

const EVERY_STAPLE_FOLD = `${STAPLE_FOLDS} ORDER BY s.sequence`;

/** A bit string as Postgres prints one, or zero for the fold of nothing. */
function bigintOfBits(bits: string | null): bigint {
	if (bits === null || bits === '') {
		return(0n);
	}
	return(BigInt(`0b${bits}`));
}

type StapleFoldRow = { sequence: string; blocks_hash: Buffer; moment: Date; fold: string | null };

function stapleFoldOf(row: StapleFoldRow): StapleFold {
	return({ sequence: row.sequence, blocksHash: row.blocks_hash.toString('hex').toUpperCase(), moment: row.moment, fold: bigintOfBits(row.fold) });
}

/** Reads every query in one view of the database, so that no commit lands between them. */
async function inOneView<Result>(pool: pg.Pool, read: (client: pg.PoolClient) => Promise<Result>): Promise<Result> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
		try {
			return(await read(client));
		} finally {
			await client.query('ROLLBACK');
		}
	} finally {
		client.release();
	}
}

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
		checksumSnapshot(staples: SnapshotStaples): Promise<ChecksumSnapshot> {
			return(inOneView(pool, async function(client): Promise<ChecksumSnapshot> {
				const stored = await client.query<{ value: Buffer }>(STORED_CHECKSUM, [`@buffer:${LEDGER_CHECKSUM_KEY}`]);
				const folded = await client.query<{ blocks: string; fold: string | null }>(FOLDED_MAIN_BLOCKS);
				let rows: StapleFoldRow[];
				switch (staples.kind) {
					case 'newest':
						rows = (await client.query<StapleFoldRow>(NEWEST_STAPLE_FOLDS, [staples.count])).rows.reverse();
						break;
					case 'every':
						rows = (await client.query<StapleFoldRow>(EVERY_STAPLE_FOLD)).rows;
						break;
					default:
						return(assertNever(staples));
				}
				const value = stored.rows[0]?.value;
				let storedValue = 0n;
				if (value !== undefined && value.length > 0) {
					storedValue = BigInt(`0x${value.toString('hex')}`);
				}
				return({
					stored: storedValue,
					folded: bigintOfBits(folded.rows[0]?.fold ?? null),
					mainBlocks: Number(folded.rows[0]?.blocks ?? 0),
					staples: rows.map(stapleFoldOf)
				});
			}));
		},
		async close(): Promise<void> {
			await pool.end();
		}
	});
}
