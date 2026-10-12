import { afterEach, describe, expect, inject, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY } from '../node/bootstrap-cursors.js';
import type { PeerProgress } from '../node/bootstrap-pass.js';
import type { RangeLayout } from '../node/bootstrap-ranges.js';
import { confirmedStaple, sendBlock, setRepresentativeBlock } from '../testing/blocks.js';
import { createDatabase } from '../testing/postgres.js';
import type { TestDatabase } from '../testing/postgres.js';
import { CHAIN_ACCOUNTS_AFTER, heldBeforeOf, openFollowerStore, readOnlyPool } from './follower-store.js';
import type { FollowerStore, KnownAccount } from './follower-store.js';

const lib = KeetaNet.lib;

const PEER = 'https://rep1.example/api';
const OTHER_PEER = 'https://rep2.example/api';

const ACCOUNTS = [
	'keeta_aabiko2lb4klv75vi72jxkgaotfravn7p4clfko4lcw7vywrzfznrvemqxb5iai',
	'keeta_aabk62tezl4whordlviamlx3zrdgux6lk63cghay45vkzdatyemzvqqjuj5resa',
	'keeta_aabwip6zeo2fnzfxp5hssrrqtascs2277w2zk7vqd6d3k3m4dkt2flcbca2mqki'
];

const STAPLE = 'AB'.repeat(32);

/** Where the staples a test adds after the database's own two are placed. */
const PLACES: readonly bigint[] = [9n, 10n, 100n];
const OTHER_STAPLE = 'CD'.repeat(32);

/** The checksum the node keeps folded, folded afresh from the staples' own, as a node writing them would have kept it. */
const KEEP_FOLDED = `UPDATE ledger_checksum SET checksum = COALESCE(
	(SELECT bit_xor(checksum) FROM staples WHERE get_byte(blocks_hash, 0) = shard),
	repeat('0', 256)::bit(256))`;

function progress(reached: number): PeerProgress {
	return({ reached: new Date(reached), caughtUp: false, deepScanFrom: new Date(0), nextDeepScan: new Date(0), deepScan: undefined, keying: 'votes' });
}

function layout(ranges: readonly { readonly reached: number; readonly end: number }[]): RangeLayout {
	return({
		from: new Date(1000),
		end: new Date(9000),
		deepScanPeer: PEER,
		ranges: ranges.map(function(range, id) {
			return({ id, reached: new Date(range.reached), end: new Date(range.end), peer: PEER, pace: { spent: 0, advanced: 0 } });
		}),
		standings: {},
		fullQueueUpdates: 0,
		nextID: ranges.length
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
		await pool.query('INSERT INTO staples (blocks_hash, staple_time, moment, checksum) VALUES ($1, $2, $2, repeat(\'0\', 256)::bit(256))', [Buffer.from(staple, 'hex'), stapleTime]);
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
	test('lists the accounts with a chain apart from the rest, each in pages after a row', async function() {
		const database = await followerDatabase({});
		const pool = database.pool();
		const [first = '', second = '', third = ''] = ACCOUNTS;
		const BLOCK = '12'.repeat(32);
		await pool.query(`INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
			SELECT $1, 'main', id, $1, 1, '\\x0102', $3, 0 FROM accounts WHERE public_key = $2`, [Buffer.from(BLOCK, 'hex'), second, Buffer.from(STAPLE, 'hex')]);
		await pool.query('INSERT INTO heads (account_id, block_hash, height) SELECT id, $2, 0 FROM accounts WHERE public_key = $1', [second, Buffer.from(BLOCK, 'hex')]);
		await database.endPools();
		const store = storeOf(database);
		const accountsOf = function(known: readonly KnownAccount[]): readonly string[] {
			return(known.map(function(entry) {
				return(entry.account);
			}));
		};

		const chains = await store.chainAccountsAfter('0', 2);
		expect(accountsOf(chains)).toEqual([second]);
		expect(await store.chainAccountsAfter(chains[0]?.rowID ?? '', 2)).toEqual([]);
		const passive = await store.passiveAccountsAfter('0', 1);
		expect(passive).toEqual([{ rowID: passive[0]?.rowID, account: first, newestStaple: new Date('2025-12-01T00:00:00.000Z') }]);
		const rest = await store.passiveAccountsAfter(passive[0]?.rowID ?? '', 2);
		expect(rest).toEqual([{ rowID: rest[0]?.rowID, account: third, newestStaple: undefined }]);
		expect(await store.passiveAccountsAfter(rest[0]?.rowID ?? '', 2)).toEqual([]);
		expect(await store.accountCount()).toBe(3);
		expect(await store.chainAccounts()).toEqual(chains);
		expect(await store.rowIDsOf([third, first, 'keeta_unknown'])).toEqual(new Map([[first, passive[0]?.rowID], [third, rest[0]?.rowID]]));
	});

	test('reads the accounts with a chain from the heads, each account and its newest staple by its key, so that no account outside them is read', async function() {
		const database = await followerDatabase({});
		const pool = database.pool();
		type PlanNode = { readonly 'Relation Name'?: string; readonly 'Parent Relationship'?: string; readonly Plans?: readonly PlanNode[] };
		const explained = await pool.query<{ 'QUERY PLAN': readonly { readonly Plan: PlanNode }[] }>(`EXPLAIN (FORMAT JSON) ${CHAIN_ACCOUNTS_AFTER}`, ['0', 1000]);
		await database.endPools();
		const outer = function(node: PlanNode): readonly string[] {
			const own: string[] = [];
			if (node['Relation Name'] !== undefined) {
				own.push(node['Relation Name']);
			}
			return([...own, ...(node.Plans ?? []).filter(function(child) {
				return(child['Parent Relationship'] !== 'SubPlan' && child['Parent Relationship'] !== 'InitPlan');
			}).flatMap(outer)]);
		};
		const plan = explained.rows[0]?.['QUERY PLAN'][0]?.Plan;
		expect(plan && outer(plan)).toEqual(['heads']);
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
		expect(await store.progress()).toEqual({ completedPass: new Date(7000), heldBefore: new Date(2500), staged: 0 });
	});

	test('reads no progress from a node that stored none', async function() {
		const store = storeOf(await followerDatabase({ cursors: { [PEER]: storedProgress(4000), [OTHER_PEER]: { written: 'by another version' } } }));
		expect(await store.progress()).toEqual({ completedPass: undefined, heldBefore: new Date(4000), staged: 0 });
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

	test('reads the stored checksum and the fold of the main blocks in one view, with the staples whose own checksum is not the fold of their blocks', async function() {
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
		// The first staple's checksum is its block's; the second's leaves out one of its two blocks.
		await pool.query('UPDATE staples SET checksum = (\'x\' || $2)::bit(256) WHERE blocks_hash = $1', [staple('AB'), '11'.repeat(32)]);
		await pool.query('UPDATE staples SET checksum = (\'x\' || $2)::bit(256) WHERE blocks_hash = $1', [staple('CD'), '22'.repeat(32)]);
		await pool.query(KEEP_FOLDED);
		const store = storeOf(database);
		const fold = function(...bytes: readonly string[]): bigint {
			return(bytes.reduce(function(value, byte): bigint {
				return(value ^ BigInt(`0x${byte.repeat(32)}`));
			}, 0n));
		};

		expect(await store.checksumSnapshot()).toEqual({
			stored: fold('11', '22'),
			folded: fold('11', '22', '33'),
			mainBlocks: 3,
			mismatched: [{ sequence: '2', blocksHash: OTHER_STAPLE, stored: fold('22'), fold: fold('22', '33') }]
		});
		await pool.query('UPDATE staples SET checksum = (\'x\' || $2)::bit(256) WHERE blocks_hash = $1', [staple('CD'), fold('22', '33').toString(16)]);
		expect((await store.checksumSnapshot()).stored).toBe(fold('11', '22'));
		await pool.query(KEEP_FOLDED);
		expect(await store.checksumSnapshot()).toEqual({ stored: fold('11', '22', '33'), folded: fold('11', '22', '33'), mainBlocks: 3, mismatched: [] });

		// The checksum kept folded, not the staples', is what is checked: one that drifted from its staples differs with no staple listed.
		await pool.query('UPDATE ledger_checksum SET checksum = checksum # (\'x\' || $1)::bit(256) WHERE shard = 0', ['44'.repeat(32)]);
		expect(await store.checksumSnapshot()).toEqual({ stored: fold('11', '22', '33', '44'), folded: fold('11', '22', '33'), mainBlocks: 3, mismatched: [] });
	});

	test('reads a zero checksum and fold from a node that applied nothing', async function() {
		const store = storeOf(await followerDatabase({}));
		expect(await store.checksumSnapshot()).toMatchObject({ stored: 0n, folded: 0n, mainBlocks: 0 });
	});

	test('draws quiet accounts of a kind with what their requests name, and the held blocks and staples', async function() {
		const database = await followerDatabase({});
		const pool = database.pool();
		const [first = '', second = '', third = ''] = ACCOUNTS;
		const quietTime = new Date('2025-12-01T00:00:00.000Z');
		const recentTime = new Date('2026-02-01T00:00:00.000Z');
		const RECENT_STAPLE = 'EF'.repeat(32);
		const BLOCK = '12'.repeat(32);
		await pool.query('UPDATE accounts SET key_type = 3 WHERE public_key = ANY($1)', [[first, second]]);
		await pool.query('INSERT INTO staples (blocks_hash, staple_time, moment, checksum) VALUES ($1, $2, $2, repeat(\'0\', 256)::bit(256))', [Buffer.from(RECENT_STAPLE, 'hex'), recentTime]);
		await pool.query('INSERT INTO history (account_id, blocks_hash, staple_time) SELECT id, $2, $3 FROM accounts WHERE public_key = $1', [second, Buffer.from(RECENT_STAPLE, 'hex'), recentTime]);
		await pool.query(`INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
			SELECT $1, 'main', id, $1, 1, '\\x0102', $3, 0 FROM accounts WHERE public_key = $2`, [Buffer.from(BLOCK, 'hex'), first, Buffer.from(STAPLE, 'hex')]);
		await pool.query('INSERT INTO chain (account_id, height, block_hash) SELECT id, 0, $2 FROM accounts WHERE public_key = $1', [first, Buffer.from(BLOCK, 'hex')]);
		await pool.query('INSERT INTO balances (account_id, token_id, balance) SELECT a.id, t.id, 5 FROM accounts a, accounts t WHERE a.public_key = $1 AND t.public_key = $2', [first, second]);
		await pool.query(`INSERT INTO acls (principal_id, entity_id, target_id, base_permissions, external_permissions)
			SELECT a.id, e.id, e.id, 1, 0 FROM accounts a, accounts e WHERE a.public_key = $1 AND e.public_key = $2`, [first, third]);
		await pool.query('INSERT INTO certificates (account_id, hash, certificate) SELECT id, $2, $3 FROM accounts WHERE public_key = $1', [first, Buffer.from('34'.repeat(32), 'hex'), Buffer.from('00', 'hex')]);
		await database.endPools();
		const store = storeOf(database);
		const quietBefore = new Date('2026-01-01T00:00:00.000Z');

		const tokens = await store.quietAccounts('token', quietBefore, 10, 'seed');
		expect(tokens).toEqual([{ account: first, tokens: [second], certificates: ['34'.repeat(32)], entities: [third], chain: [{ hash: BLOCK, account: first, bytes: Buffer.from([1, 2]) }], history: [STAPLE] }]);
		expect((await store.quietAccounts('certificates', quietBefore, 10, 'seed')).map(function(candidate) {
			return(candidate.account);
		})).toEqual([first]);
		expect((await store.quietAccounts('permissions', quietBefore, 10, 'seed')).map(function(candidate) {
			return(candidate.account);
		})).toEqual([first]);
		expect(await store.quietAccounts('storage', quietBefore, 10, 'seed')).toEqual([]);

		expect(await store.heldBlocks('00'.repeat(32), quietBefore, 10)).toEqual([{ hash: BLOCK, account: first, bytes: Buffer.from([1, 2]) }]);
		expect(await store.heldBlocks('13'.repeat(32), quietBefore, 10)).toEqual([]);
		expect(await store.heldBlocks('00'.repeat(32), quietTime, 10)).toEqual([]);
		expect(await store.holdsBlock(BLOCK)).toBe(true);
		expect(await store.holdsBlock('13'.repeat(32))).toBe(false);
		const pages = await store.blockPages();
		expect(pages).toBeGreaterThan(0);
		expect(await store.heldBlocksInPages(0, pages, quietBefore)).toEqual([{ hash: BLOCK, account: first, bytes: Buffer.from([1, 2]) }]);
		expect(await store.heldBlocksInPages(pages, pages + 1, quietBefore)).toEqual([]);
		expect(await store.heldBlocksInPages(0, pages, quietTime)).toEqual([]);
		expect(await store.heldBlocksOfStaples([STAPLE, OTHER_STAPLE], quietBefore)).toHaveLength(1);
		expect(await store.heldBlocksOfStaples([OTHER_STAPLE], quietBefore)).toEqual([]);

		expect(await store.newestStaples([first, second, third])).toEqual(new Map([[first, quietTime], [second, recentTime]]));
	});

	test('reads in one view an account\'s stored balances and those its history leaves it with, the history in reads of so many staples, on the view\'s one session', async function() {
		const database = await followerDatabase({});
		const pool = database.pool();
		const sender = lib.Account.fromSeed('5e'.repeat(32), 0);
		const recipient = lib.Account.fromSeed('5e'.repeat(32), 1);
		const token = sender.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);
		const RECIPIENT = recipient.publicKeyString.get();
		const SENDER = sender.publicKeyString.get();
		await pool.query('INSERT INTO accounts (public_key, key_type) VALUES ($1, 0), ($2, 0)', [RECIPIENT, SENDER]);
		let previous: VoteStaple | undefined;
		for (const [day, amount] of [[1, 5n], [2, 7n]] as const) {
			const block = await sendBlock({ from: sender, to: recipient, amount, token, previous: previous?.blocks[0]?.hash ?? null, network: 0x5382n, date: new Date(Date.UTC(2025, 10, day)) });
			const staple = await confirmedStaple([block], [sender]);
			previous = staple;
			const key = Buffer.from(staple.blocksHash.toString(), 'hex');
			// The second staple was stored before staples kept their bytes, so it is rebuilt from its block and vote.
			let bytes: Buffer | null = Buffer.from(staple.toBytes());
			if (day === 2) {
				bytes = null;
			}
			await pool.query('INSERT INTO staples (blocks_hash, staple_time, moment, bytes, checksum) VALUES ($1, $2, $2, $3, repeat(\'0\', 256)::bit(256))', [key, staple.timestamp(), bytes]);
			await pool.query(`INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
				SELECT $1, 'main', id, $2, 1, $3, $4, 0 FROM accounts WHERE public_key = $5`, [Buffer.from(block.hash.toString(), 'hex'), Buffer.from(block.previous.toString(), 'hex'), Buffer.from(block.toBytes()), key, SENDER]);
			for (const vote of staple.votes) {
				await pool.query(`INSERT INTO votes (ledger, uid, blocks_hash, issuer_id, validity_from, validity_to, permanent, bytes)
					SELECT 'main', $1, $2, id, $3, $4, $5, $6 FROM accounts WHERE public_key = $7`, [vote.$uid, key, vote.validityFrom, vote.validityTo, vote.$permanent, Buffer.from(vote.toBytes()), SENDER]);
			}
			await pool.query('INSERT INTO history (account_id, blocks_hash, staple_time) SELECT id, $2, $3 FROM accounts WHERE public_key = $1', [RECIPIENT, key, staple.timestamp()]);
		}
		await pool.query('INSERT INTO balances (account_id, token_id, balance) SELECT a.id, t.id, 12 FROM accounts a, accounts t WHERE a.public_key = $1 AND t.public_key = $2', [RECIPIENT, ACCOUNTS[0]]);
		await database.endPools();
		// One session only: a read that took a second would wait for it until the pool gave up.
		const store = openFollowerStore(database.connectionString, { historyStaplesPerRead: 1, connections: 1 });
		stores.push(store);

		expect(await store.balancesSnapshot(RECIPIENT, function() {
			return(Promise.resolve('seen'));
		})).toEqual({ stored: new Map([[ACCOUNTS[0], 12n]]), head: null, fromHistory: new Map([[token.publicKeyString.get(), 12n]]), during: 'seen' });
		expect(await store.balancesSnapshot(ACCOUNTS[2] ?? '', function() {
			return(Promise.resolve(null));
		})).toEqual({ stored: new Map(), head: null, fromHistory: new Map(), during: null });
	});

	test('reads the staples in the order the ledger added them, rebuilding one stored without its bytes', async function() {
		const database = await followerDatabase({});
		const pool = database.pool();
		const signer = lib.Account.fromSeed('5e'.repeat(32), 0);
		const issuer = signer.publicKeyString.get();
		await pool.query('INSERT INTO accounts (public_key, key_type) VALUES ($1, 0)', [issuer]);
		const made: VoteStaple[] = [];
		for (const day of [1, 2, 3]) {
			const block = await setRepresentativeBlock({ account: signer, representative: signer, previous: made.at(-1)?.blocks[0]?.hash ?? null, network: 0x5382n, date: new Date(Date.UTC(2025, 10, day)) });
			made.push(await confirmedStaple([block], [signer]));
		}
		for (const [index, staple] of made.entries()) {
			// The second staple was stored before staples kept their bytes.
			let bytes: Buffer | null = Buffer.from(staple.toBytes());
			if (index === 1) {
				bytes = null;
			}
			const key = Buffer.from(staple.blocksHash.toString(), 'hex');
			// Places whose order as text is not their order as numbers.
			await pool.query('INSERT INTO staples (blocks_hash, staple_time, moment, bytes, checksum, sequence) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $2, $3, repeat(\'0\', 256)::bit(256), $4)', [key, staple.timestamp(), bytes, PLACES[index]]);
			for (const [position, block] of staple.blocks.entries()) {
				await pool.query(`INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
					SELECT $1, 'main', id, $2, 1, $3, $4, $5 FROM accounts WHERE public_key = $6`, [Buffer.from(block.hash.toString(), 'hex'), Buffer.from(block.previous.toString(), 'hex'), Buffer.from(block.toBytes()), key, position, issuer]);
			}
			for (const vote of staple.votes) {
				await pool.query(`INSERT INTO votes (ledger, uid, blocks_hash, issuer_id, validity_from, validity_to, permanent, bytes)
					SELECT 'main', $1, $2, id, $3, $4, $5, $6 FROM accounts WHERE public_key = $7`, [vote.$uid, key, vote.validityFrom, vote.validityTo, vote.$permanent, Buffer.from(vote.toBytes()), issuer]);
			}
		}
		await database.endPools();
		const store = storeOf(database);
		const hexOf = function(staple: VoteStaple | undefined): string {
			return(Buffer.from(staple?.toBytes() ?? new ArrayBuffer(0)).toString('hex'));
		};
		const placed = function(staples: readonly { readonly staple: VoteStaple; readonly stapleTime: Date; readonly sequence: bigint }[]) {
			return(staples.map(function(entry) {
				return([entry.staple.blocksHash.toString(), entry.stapleTime.getTime(), entry.sequence]);
			}));
		};

		// The two staples the database starts with were added first.
		expect(await store.lastSequence()).toBe(100n);
		expect(await store.stapleAt(1n)).toBe(STAPLE);
		expect(await store.stapleAt(10n)).toBe(made[1]?.blocksHash.toString());
		expect(await store.stapleAt(11n)).toBeUndefined();
		const read = await store.staplesAfter(2n, 100n, 2);
		expect(placed(read)).toEqual(made.slice(0, 2).map(function(staple, index) {
			return([staple.blocksHash.toString(), staple.timestamp().getTime(), PLACES[index]]);
		}));
		expect(hexOf(read[1]?.staple)).toBe(hexOf(made[1]));
		expect(placed(await store.staplesAfter(9n, 99n, 10)).map(function([hash]) {
			return(hash);
		})).toEqual([made[1]?.blocksHash.toString()]);
		expect(placed(await store.staplesOf([made[2]?.blocksHash.toString() ?? '', made[1]?.blocksHash.toString() ?? '']))).toEqual([1, 2].map(function(index) {
			const staple = made[index];
			return([staple?.blocksHash.toString(), staple?.timestamp().getTime(), PLACES[index]]);
		}));
	});

	test('counts the staples staged and not added yet', async function() {
		const database = await followerDatabase({ caughtUp: 7000 });
		const pool = database.pool();
		const moment = new Date('2026-07-01T00:00:00.000Z');
		await pool.query('INSERT INTO bootstrap_stage (blocks_hash, first_vote_from, last_vote_from, bytes) VALUES ($1, $2, $2, $3), ($4, $2, $2, $3)', [Buffer.from(STAPLE, 'hex'), moment, Buffer.from([1]), Buffer.from(OTHER_STAPLE, 'hex')]);
		await database.endPools();
		expect(await storeOf(database).progress()).toMatchObject({ completedPass: new Date(7000), staged: 2 });
	});
});
