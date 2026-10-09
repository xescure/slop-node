import pg from 'pg';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, layoutOf, progressOf } from '../node/bootstrap-cursors.js';
import type { PeerProgress } from '../node/bootstrap-pass.js';
import type { RangeLayout } from '../node/bootstrap-ranges.js';
import { assertNever } from '../util/assert-never.js';

const lib = KeetaNet.lib;

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

/** A main staple whose stored checksum is not the XOR of the hashes of its blocks. */
export type MismatchedStaple = {
	/** The staple's row in commit order, as decimal text. */
	readonly sequence: string;
	readonly blocksHash: string;
	readonly stored: bigint;
	readonly fold: bigint;
};

/**
 * The ledger checksum as the follower stores it, the XOR of each main
 * staple's checksum written with it, and the XOR of the main ledger's
 * blocks, read from one view of the database, with the staples whose stored
 * checksum is not the fold of their blocks when the two differ.
 */
export type ChecksumSnapshot = {
	readonly stored: bigint;
	/** The XOR of the hash of every block on the main ledger. */
	readonly folded: bigint;
	readonly mainBlocks: number;
	/** At most MISMATCHES_LISTED of them, oldest first by commit order; none when the totals are equal. */
	readonly mismatched: readonly MismatchedStaple[];
};

/** The most staples a snapshot lists whose stored checksum is not the fold of their blocks. */
export const MISMATCHES_LISTED = 20;

/** Accounts the API diff draws on, by what makes them a risk. */
export type AccountKind = 'token' | 'storage' | 'multisig' | 'certificates' | 'permissions';

/** An account the follower holds quiet, with what its requests name. */
export type AccountCandidate = {
	readonly account: string;
	/** Tokens it holds a balance of. */
	readonly tokens: readonly string[];
	/** The hashes of its certificates. */
	readonly certificates: readonly string[];
	/** Entities it holds permissions on, as a principal. */
	readonly entities: readonly string[];
	/** Its newest blocks, with their bytes. */
	readonly chain: readonly HeldBlock[];
	/** Its newest staples, by the hash of their blocks. */
	readonly history: readonly string[];
};

/** A block on the main ledger, in a staple the follower holds within its reach. */
export type HeldBlock = {
	readonly hash: string;
	readonly account: string;
	readonly bytes: Buffer;
};

/** A main staple and the time the follower's history keys it by. */
export type HeldStaple = {
	readonly staple: VoteStaple;
	readonly stapleTime: Date;
};

/** Where a read of staples in history order resumes: after the staple at this time with this hash of its blocks. */
export type StapleKey = { readonly stapleTime: Date; readonly blocksHash: string };

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
	checksumSnapshot(): Promise<ChecksumSnapshot>;
	/**
	 * Accounts of the kind with a staple in their history and none from the
	 * moment on, at most the count of them, drawn in an order the seed fixes.
	 */
	quietAccounts(kind: AccountKind, quietBefore: Date, count: number, seed: string): Promise<readonly AccountCandidate[]>;
	/** Main blocks from the hash on, in hash order, of staples before the moment. */
	heldBlocks(fromHash: string, before: Date, count: number): Promise<readonly HeldBlock[]>;
	/** The main blocks of those staples, by the hash of their blocks, that are before the moment. */
	heldBlocksOfStaples(blocksHashes: readonly string[], before: Date): Promise<readonly HeldBlock[]>;
	/** How many main staples there are before the moment. */
	stapleCountBefore(before: Date): Promise<number>;
	/** Main staples before the moment, oldest first by time and then by the hash of their blocks, after the key, at most the count of them. */
	staplesBefore(before: Date, after: StapleKey | undefined, count: number): Promise<readonly HeldStaple[]>;
	/** The time of each account's newest staple, none for an account without history. */
	newestStaples(accounts: readonly string[]): Promise<ReadonlyMap<string, Date>>;
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
 * so the whole ledger is folded afresh each time, apart from the checksum
 * the node wrote with each staple.
 */
function bitsOf(column: string): string {
	return(`('x' || encode(${column}, 'hex'))::bit(256)`);
}

const STORED_CHECKSUM = 'SELECT bit_xor(checksum)::text AS stored FROM staples';

const FOLDED_MAIN_BLOCKS = `SELECT count(*) AS blocks, bit_xor(${bitsOf('hash')})::text AS fold FROM blocks WHERE ledger = 'main'`;

const MISMATCHED_STAPLES = `
	SELECT sequence, blocks_hash, stored, fold FROM (
		SELECT s.sequence::text AS sequence, s.sequence AS position, s.blocks_hash, s.checksum::text AS stored, (SELECT bit_xor(${bitsOf('b.hash')}) FROM blocks b WHERE b.staple = s.blocks_hash)::text AS fold
		FROM staples s
	) AS staple
	WHERE stored IS DISTINCT FROM fold
	ORDER BY position
	LIMIT $1`;

/** A bit string as Postgres prints one, or zero for the fold of nothing. */
function bigintOfBits(bits: string | null): bigint {
	if (bits === null || bits === '') {
		return(0n);
	}
	return(BigInt(`0b${bits}`));
}

type MismatchedStapleRow = { sequence: string; blocks_hash: Buffer; stored: string | null; fold: string | null };

function mismatchedStapleOf(row: MismatchedStapleRow): MismatchedStaple {
	return({ sequence: row.sequence, blocksHash: row.blocks_hash.toString('hex').toUpperCase(), stored: bigintOfBits(row.stored), fold: bigintOfBits(row.fold) });
}

/** Which accounts a kind is, as a condition on the accounts row "a". */
function kindCondition(kind: AccountKind): string {
	switch (kind) {
		case 'token':
			return(`a.key_type = ${String(lib.Account.AccountKeyAlgorithm.TOKEN)}`);
		case 'storage':
			return(`a.key_type = ${String(lib.Account.AccountKeyAlgorithm.STORAGE)}`);
		case 'multisig':
			return(`a.key_type = ${String(lib.Account.AccountKeyAlgorithm.MULTISIG)}`);
		case 'certificates':
			return('a.id IN (SELECT account_id FROM certificates)');
		case 'permissions':
			return('a.id IN (SELECT principal_id FROM acls UNION SELECT entity_id FROM acls)');
		default:
			return(assertNever(kind));
	}
}

/** The history key leads with the account and the staple time, so both conditions are read from its index. */
function quietAccountsQuery(kind: AccountKind): string {
	return(`
		SELECT a.id, a.public_key FROM accounts a
		WHERE ${kindCondition(kind)}
			AND EXISTS (SELECT 1 FROM history h WHERE h.account_id = a.id)
			AND NOT EXISTS (SELECT 1 FROM history h WHERE h.account_id = a.id AND h.staple_time >= $1)
		ORDER BY md5(a.public_key || $2) LIMIT $3`);
}

/** A few of each, enough for the requests that name them. */
const DETAILS_PER_ACCOUNT = 3;

const ACCOUNT_TOKENS = 'SELECT t.public_key FROM balances b JOIN accounts t ON t.id = b.token_id WHERE b.account_id = $1 ORDER BY t.public_key LIMIT $2';

const ACCOUNT_CERTIFICATES = 'SELECT hash FROM certificates WHERE account_id = $1 ORDER BY hash LIMIT $2';

const ACCOUNT_ENTITIES = 'SELECT DISTINCT e.public_key FROM acls x JOIN accounts e ON e.id = x.entity_id WHERE x.principal_id = $1 ORDER BY e.public_key LIMIT $2';

const ACCOUNT_CHAIN = `
	SELECT b.hash, b.bytes, $3::text AS public_key FROM chain c JOIN blocks b ON b.hash = c.block_hash
	WHERE c.account_id = $1 ORDER BY c.height DESC LIMIT $2`;

const ACCOUNT_HISTORY = 'SELECT blocks_hash FROM history WHERE account_id = $1 ORDER BY staple_time DESC, blocks_hash DESC LIMIT $2';

const HELD_BLOCKS = `
	SELECT b.hash, b.bytes, a.public_key FROM blocks b
	JOIN staples s ON s.blocks_hash = b.staple
	JOIN accounts a ON a.id = b.account_id
	WHERE b.ledger = 'main' AND b.hash >= $1 AND s.staple_time < $2
	ORDER BY b.hash LIMIT $3`;

const HELD_BLOCKS_OF_STAPLES = `
	SELECT b.hash, b.bytes, a.public_key FROM blocks b
	JOIN staples s ON s.blocks_hash = b.staple
	JOIN accounts a ON a.id = b.account_id
	WHERE b.staple = ANY($1::bytea[]) AND s.staple_time < $2
	ORDER BY b.staple, b.staple_position`;

const NEWEST_STAPLES = `
	SELECT a.public_key, (SELECT max(h.staple_time) FROM history h WHERE h.account_id = a.id) AS newest_staple
	FROM accounts a WHERE a.public_key = ANY($1::text[])`;

const STAPLE_COUNT_BEFORE = 'SELECT count(*) AS count FROM staples WHERE staple_time < $1';

/** The history index orders staples by time and hash, newest first, so it is read backwards. */
const STAPLES_BEFORE = `
	SELECT blocks_hash, staple_time, bytes FROM staples
	WHERE staple_time < $1 AND (staple_time, blocks_hash) > ($2, $3)
	ORDER BY staple_time, blocks_hash LIMIT $4`;

const REBUILT_STAPLE_BLOCKS = `
	SELECT staple, bytes FROM blocks WHERE ledger = 'main' AND staple = ANY($1::bytea[]) ORDER BY staple, staple_position`;

// Votes were inserted in staple order, so their IDs keep it.
const REBUILT_STAPLE_VOTES = `
	SELECT blocks_hash, bytes, validity_from FROM votes WHERE ledger = 'main' AND blocks_hash = ANY($1::bytea[]) ORDER BY id`;

/** Grouped by the hex of a column, in the order the rows came. */
function groupedBy<Row>(rows: readonly Row[], keyOf: (row: Row) => Buffer): Map<string, Row[]> {
	const groups = new Map<string, Row[]>();
	for (const row of rows) {
		const key = hexOfBytes(keyOf(row));
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return(groups);
}

/*
 * A staple is read as the bytes it was received as; one stored before
 * those were kept is rebuilt from its blocks and votes, as the follower's
 * own driver rebuilds it (src/ledger/storage/postgres/driver.ts). A vote
 * is decoded at its own validity, so a temporary one is not refused as
 * expired.
 */
async function heldStaplesOf(pool: pg.Pool, rows: readonly { blocks_hash: Buffer; staple_time: Date; bytes: Buffer | null }[]): Promise<HeldStaple[]> {
	const missing = rows.filter(function(row): boolean {
		return(row.bytes === null);
	}).map(function(row): Buffer {
		return(row.blocks_hash);
	});
	let blocks = new Map<string, { staple: Buffer; bytes: Buffer }[]>();
	let votes = new Map<string, { blocks_hash: Buffer; bytes: Buffer; validity_from: Date }[]>();
	if (missing.length > 0) {
		blocks = groupedBy((await pool.query<{ staple: Buffer; bytes: Buffer }>(REBUILT_STAPLE_BLOCKS, [missing])).rows, function(row): Buffer {
			return(row.staple);
		});
		votes = groupedBy((await pool.query<{ blocks_hash: Buffer; bytes: Buffer; validity_from: Date }>(REBUILT_STAPLE_VOTES, [missing])).rows, function(row): Buffer {
			return(row.blocks_hash);
		});
	}
	return(rows.map(function(row): HeldStaple {
		if (row.bytes !== null) {
			return({ staple: new lib.Vote.Staple(row.bytes), stapleTime: row.staple_time });
		}
		const key = hexOfBytes(row.blocks_hash);
		const staple = lib.Vote.Staple.fromVotesAndBlocks((votes.get(key) ?? []).map(function(vote) {
			return(new lib.Vote(vote.bytes, { now: vote.validity_from }));
		}), (blocks.get(key) ?? []).map(function(block) {
			return(new lib.Block(block.bytes));
		}));
		return({ staple, stapleTime: row.staple_time });
	}));
}

function hexOfBytes(bytes: Buffer): string {
	return(bytes.toString('hex').toUpperCase());
}

type HeldBlockRow = { hash: Buffer; bytes: Buffer; public_key: string };

function heldBlockOf(row: HeldBlockRow): HeldBlock {
	return({ hash: hexOfBytes(row.hash), account: row.public_key, bytes: row.bytes });
}

async function accountCandidateOf(pool: pg.Pool, id: string, account: string): Promise<AccountCandidate> {
	const tokens = await pool.query<{ public_key: string }>(ACCOUNT_TOKENS, [id, DETAILS_PER_ACCOUNT]);
	const certificates = await pool.query<{ hash: Buffer }>(ACCOUNT_CERTIFICATES, [id, DETAILS_PER_ACCOUNT]);
	const entities = await pool.query<{ public_key: string }>(ACCOUNT_ENTITIES, [id, DETAILS_PER_ACCOUNT]);
	const chain = await pool.query<HeldBlockRow>(ACCOUNT_CHAIN, [id, DETAILS_PER_ACCOUNT, account]);
	const history = await pool.query<{ blocks_hash: Buffer }>(ACCOUNT_HISTORY, [id, DETAILS_PER_ACCOUNT]);
	return({
		account,
		tokens: tokens.rows.map(function(row): string {
			return(row.public_key);
		}),
		certificates: certificates.rows.map(function(row): string {
			return(hexOfBytes(row.hash));
		}),
		entities: entities.rows.map(function(row): string {
			return(row.public_key);
		}),
		chain: chain.rows.map(heldBlockOf),
		history: history.rows.map(function(row): string {
			return(hexOfBytes(row.blocks_hash));
		})
	});
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
		checksumSnapshot(): Promise<ChecksumSnapshot> {
			return(inOneView(pool, async function(client): Promise<ChecksumSnapshot> {
				const stored = bigintOfBits((await client.query<{ stored: string | null }>(STORED_CHECKSUM)).rows[0]?.stored ?? null);
				const folded = await client.query<{ blocks: string; fold: string | null }>(FOLDED_MAIN_BLOCKS);
				const fold = bigintOfBits(folded.rows[0]?.fold ?? null);
				let mismatched: readonly MismatchedStaple[] = [];
				if (stored !== fold) {
					mismatched = (await client.query<MismatchedStapleRow>(MISMATCHED_STAPLES, [MISMATCHES_LISTED])).rows.map(mismatchedStapleOf);
				}
				return({ stored, folded: fold, mainBlocks: Number(folded.rows[0]?.blocks ?? 0), mismatched });
			}));
		},
		async quietAccounts(kind: AccountKind, quietBefore: Date, count: number, seed: string): Promise<readonly AccountCandidate[]> {
			const chosen = await pool.query<{ id: string; public_key: string }>(quietAccountsQuery(kind), [quietBefore, seed, count]);
			const candidates: AccountCandidate[] = [];
			for (const row of chosen.rows) {
				candidates.push(await accountCandidateOf(pool, row.id, row.public_key));
			}
			return(candidates);
		},
		async heldBlocks(fromHash: string, before: Date, count: number): Promise<readonly HeldBlock[]> {
			return((await pool.query<HeldBlockRow>(HELD_BLOCKS, [Buffer.from(fromHash, 'hex'), before, count])).rows.map(heldBlockOf));
		},
		async heldBlocksOfStaples(blocksHashes: readonly string[], before: Date): Promise<readonly HeldBlock[]> {
			const keys = blocksHashes.map(function(hash): Buffer {
				return(Buffer.from(hash, 'hex'));
			});
			return((await pool.query<HeldBlockRow>(HELD_BLOCKS_OF_STAPLES, [keys, before])).rows.map(heldBlockOf));
		},
		async stapleCountBefore(before: Date): Promise<number> {
			const result = await pool.query<{ count: string }>(STAPLE_COUNT_BEFORE, [before]);
			return(Number(result.rows[0]?.count ?? 0));
		},
		async staplesBefore(before: Date, after: StapleKey | undefined, count: number): Promise<readonly HeldStaple[]> {
			const from = after ?? { stapleTime: new Date(0), blocksHash: '' };
			const rows = await pool.query<{ blocks_hash: Buffer; staple_time: Date; bytes: Buffer | null }>(STAPLES_BEFORE, [before, from.stapleTime, Buffer.from(from.blocksHash, 'hex'), count]);
			return(await heldStaplesOf(pool, rows.rows));
		},
		async newestStaples(accounts: readonly string[]): Promise<ReadonlyMap<string, Date>> {
			const result = await pool.query<{ public_key: string; newest_staple: Date | null }>(NEWEST_STAPLES, [accounts]);
			const newest = new Map<string, Date>();
			for (const row of result.rows) {
				if (row.newest_staple !== null) {
					newest.set(row.public_key, row.newest_staple);
				}
			}
			return(newest);
		},
		async close(): Promise<void> {
			await pool.end();
		}
	});
}
