import { afterEach, describe, expect, inject, test } from 'vitest';
import { BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY } from '../node/bootstrap-cursors.js';
import type { PeerProgress } from '../node/bootstrap-pass.js';
import type { RangeLayout } from '../node/bootstrap-ranges.js';
import { createDatabase } from '../testing/postgres.js';
import type { TestDatabase } from '../testing/postgres.js';
import { heldBeforeOf, openFollowerStore, readOnlyPool } from './follower-store.js';
import type { FollowerStore } from './follower-store.js';

const PEER = 'https://rep1.example/api';
const OTHER_PEER = 'https://rep2.example/api';

const ACCOUNTS = [
	'keeta_aabiko2lb4klv75vi72jxkgaotfravn7p4clfko4lcw7vywrzfznrvemqxb5iai',
	'keeta_aabk62tezl4whordlviamlx3zrdgux6lk63cghay45vkzdatyemzvqqjuj5resa',
	'keeta_aabwip6zeo2fnzfxp5hssrrqtascs2277w2zk7vqd6d3k3m4dkt2flcbca2mqki'
];

const STAPLE = 'AB'.repeat(32);
const OTHER_STAPLE = 'CD'.repeat(32);

function progress(reached: number): PeerProgress {
	return({ reached: new Date(reached), caughtUp: false, deepScanFrom: new Date(0), nextDeepScan: new Date(0), deepScan: undefined, keying: 'votes' });
}

function layout(ranges: readonly { readonly reached: number; readonly end: number }[]): RangeLayout {
	return({
		from: new Date(1000),
		end: new Date(9000),
		deepScanPeer: PEER,
		ranges: ranges.map(function(range) {
			return({ reached: new Date(range.reached), end: new Date(range.end), peer: PEER });
		}),
		standings: {}
	});
}

describe('where the follower holds every staple before', function() {
	test('is where the earliest range not read yet reached, while it reads ranges', function() {
		expect(heldBeforeOf(layout([{ reached: 2000, end: 4000 }, { reached: 6000, end: 9000 }]), [progress(8000)])).toEqual(new Date(2000));
	});

	test('is where it reached furthest on any representative, without ranges', function() {
		expect(heldBeforeOf(undefined, [progress(3000), progress(5000)])).toEqual(new Date(5000));
	});

	test('is nowhere before it has read from any representative', function() {
		expect(heldBeforeOf(undefined, [])).toBeUndefined();
	});
});

const databases: TestDatabase[] = [];
const stores: FollowerStore[] = [];

afterEach(async function() {
	await Promise.all(stores.splice(0).map(function(store) {
		return(store.close());
	}));
	await Promise.all(databases.splice(0).map(function(database) {
		return(database.drop());
	}));
});

/** A ledger database holding the three accounts, a staple in the history of the first, and the bootstrap state given. */
async function followerDatabase(state: { readonly caughtUp?: number; readonly layout?: unknown; readonly cursors?: Readonly<Record<string, unknown>> }): Promise<TestDatabase> {
	const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	databases.push(database);
	const pool = database.pool();
	for (const account of ACCOUNTS) {
		await pool.query('INSERT INTO accounts (public_key, key_type) VALUES ($1, 0)', [account]);
	}
	const stapleTime = new Date('2025-12-01T00:00:00.000Z');
	for (const staple of [STAPLE, OTHER_STAPLE]) {
		await pool.query('INSERT INTO staples (blocks_hash, staple_time, moment) VALUES ($1, $2, $2)', [Buffer.from(staple, 'hex'), stapleTime]);
	}
	await pool.query('INSERT INTO history (account_id, blocks_hash, staple_time) SELECT id, $2, $3 FROM accounts WHERE public_key = $1', [ACCOUNTS[0], Buffer.from(STAPLE, 'hex'), stapleTime]);
	const entries: [string, string, unknown][] = Object.entries(state.cursors ?? {}).map(function([peer, value]): [string, string, unknown] {
		return([BOOTSTRAP_CURSOR_ARENA, peer, value]);
	});
	if (state.caughtUp !== undefined) {
		entries.push([BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, state.caughtUp]);
	}
	if (state.layout !== undefined) {
		entries.push([BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, state.layout]);
	}
	for (const [arena, key, value] of entries) {
		await pool.query('INSERT INTO kv_entries (arena, key, value) VALUES ($1, $2, $3)', [arena, key, JSON.stringify(value)]);
	}
	await database.endPools();
	return(database);
}

function storeOf(database: TestDatabase): FollowerStore {
	const store = openFollowerStore(database.connectionString);
	stores.push(store);
	return(store);
}

function storedProgress(reached: number): unknown {
	return({ reached, caughtUp: false, deepScanFrom: 0, nextDeepScan: 0, deepScan: null, keying: 'votes' });
}

describe('the follower\'s store, read from its database', function() {
	test('lists every account the follower knows, in pages after a row', async function() {
		const store = storeOf(await followerDatabase({}));
		const first = await store.accountsAfter('0', 2);
		expect(first.map(function(known) {
			return(known.account);
		})).toEqual(ACCOUNTS.slice(0, 2));
		const rest = await store.accountsAfter(first[1]?.rowID ?? '', 2);
		expect(rest.map(function(known) {
			return(known.account);
		})).toEqual(ACCOUNTS.slice(2));
		expect(await store.accountsAfter(rest[0]?.rowID ?? '', 2)).toEqual([]);
		expect(await store.accountCount()).toBe(3);
		expect(await store.accountsUpTo(first[1]?.rowID ?? '')).toBe(2);
	});

	test('gives each account the time of the newest staple in its history', async function() {
		const store = storeOf(await followerDatabase({}));
		expect((await store.accountsAfter('0', 2)).map(function(known) {
			return(known.newestStaple);
		})).toEqual([new Date('2025-12-01T00:00:00.000Z'), undefined]);
	});

	test('tells whether a staple is in an account\'s history', async function() {
		const store = storeOf(await followerDatabase({}));
		expect(await store.historyHolds(ACCOUNTS[0] ?? '', STAPLE)).toBe(true);
		expect(await store.historyHolds(ACCOUNTS[0] ?? '', OTHER_STAPLE)).toBe(false);
		expect(await store.historyHolds(ACCOUNTS[1] ?? '', STAPLE)).toBe(false);
		expect(await store.historyHolds('keeta_unknown', STAPLE)).toBe(false);
	});

	test('reads the bootstrap progress the node stored', async function() {
		const stored = { from: 1000, end: 9000, deepScanPeer: PEER, ranges: [{ reached: 2500, end: 4000, peer: PEER }], standings: {} };
		const store = storeOf(await followerDatabase({ caughtUp: 7000, layout: stored, cursors: { [PEER]: storedProgress(8000), [OTHER_PEER]: storedProgress(3000) } }));
		expect(await store.progress()).toEqual({ completedPass: new Date(7000), heldBefore: new Date(2500) });
	});

	test('reads no progress from a node that stored none', async function() {
		const store = storeOf(await followerDatabase({ cursors: { [PEER]: storedProgress(4000), [OTHER_PEER]: { written: 'by another version' } } }));
		expect(await store.progress()).toEqual({ completedPass: undefined, heldBefore: new Date(4000) });
	});

	test('opens sessions that cannot write to the follower\'s database', async function() {
		const database = await followerDatabase({});
		const pool = readOnlyPool(database.connectionString);
		try {
			await expect(pool.query('SELECT count(*) AS count FROM accounts')).resolves.toMatchObject({ rows: [{ count: '3' }] });
			await expect(pool.query('DELETE FROM accounts')).rejects.toThrow(/read-only transaction/);
		} finally {
			await pool.end();
		}
	});

	test('reads the stored checksum and the fold of the main blocks in one view, with the staples asked for in commit order', async function() {
		const database = await followerDatabase({});
		const pool = database.pool();
		const hashes = ['11', '22', '33', '44'].map(function(byte): Buffer {
			return(Buffer.from(byte.repeat(32), 'hex'));
		});
		const staple = function(byte: string): Buffer {
			return(Buffer.from(byte.repeat(32), 'hex'));
		};
		// Each block in a staple of its own but the last two, which share one; a side block is no part of the fold.
		const placements: readonly (readonly [Buffer | undefined, string | null, number])[] = [[hashes[0], 'AB', 0], [hashes[1], 'CD', 0], [hashes[2], 'CD', 1], [hashes[3], null, 0]];
		for (const [hash, holder, position] of placements) {
			let ledger = 'side';
			let stapleHash: Buffer | null = null;
			let stapleAt: number | null = null;
			if (holder !== null) {
				ledger = 'main';
				stapleHash = staple(holder);
				stapleAt = position;
			}
			await pool.query(`INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
				SELECT $1, $2::ledger_name, id, $1, 1, '\\x00', $3, $4 FROM accounts WHERE public_key = $5`, [hash, ledger, stapleHash, stapleAt, ACCOUNTS[0]]);
		}
		await pool.query('INSERT INTO kv_buffers (key, value) VALUES ($1, $2)', ['@buffer:ledgerChecksum', hashes[0]]);
		await database.endPools();
		const store = storeOf(database);
		const fold = function(...bytes: readonly string[]): bigint {
			return(bytes.reduce(function(value, byte): bigint {
				return(value ^ BigInt(`0x${byte.repeat(32)}`));
			}, 0n));
		};

		const newest = await store.checksumSnapshot({ kind: 'newest', count: 1 });
		expect(newest).toEqual({ stored: fold('11'), folded: fold('11', '22', '33'), mainBlocks: 3, staples: [expect.objectContaining({ sequence: '2', blocksHash: OTHER_STAPLE, fold: fold('22', '33') })] });
		const every = await store.checksumSnapshot({ kind: 'every' });
		expect(every.staples.map(function(listed) {
			return([listed.sequence, listed.blocksHash, listed.fold]);
		})).toEqual([['1', STAPLE, fold('11')], ['2', OTHER_STAPLE, fold('22', '33')]]);
	});

	test('reads a zero checksum and fold from a node that applied nothing', async function() {
		const store = storeOf(await followerDatabase({}));
		expect(await store.checksumSnapshot({ kind: 'newest', count: 4 })).toMatchObject({ stored: 0n, folded: 0n, mainBlocks: 0 });
	});
});
