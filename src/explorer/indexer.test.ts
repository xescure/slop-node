import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, inject, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { LogEntry, LogEntryFilled, LogTarget } from '@keetanetwork/keetanet-client/lib/log/common.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import pg from 'pg';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import { certificateFor, certificateIssuedBy, ChainCursor, DEFAULT_WEIGHTS, GENESIS_MOMENT, requireAt } from '../ledger/storage/suite/support.js';
import {
	confirmedStaple,
	createMultisigBlock,
	createTokenBlock,
	manageCertificateBlock,
	receiveBlock,
	sendBlock,
	setInfoBlock,
	tokenSupplyBlock
} from '../testing/blocks.js';
import { createTestNetwork, freezeClock, type TestNetwork } from '../testing/network.js';
import type { TestDatabase } from '../testing/postgres.js';
import {
	checkHoldings,
	DEFAULT_INDEXER_SETTINGS,
	freshness,
	indexBatch,
	Indexer,
	IndexerError,
	knownNodeVersions,
	reconcile,
	startingState,
	type IndexerFault,
	type IndexerState
} from './indexer.js';
import { explorerDatabase } from './testing.js';
import { GAP_GRACE_MILLISECONDS, toStapleSequence } from './watermark.js';

const lib = KeetaNet.lib;

const SETTINGS = { ...DEFAULT_INDEXER_SETTINGS, batchStaples: 2 };

const ZERO_CHECKSUM = 'repeat(\'0\', 256)::bit(256)';

type Fixture = {
	readonly database: TestDatabase;
	readonly writer: pg.Pool;
	readonly admin: pg.Pool;
	readonly network: TestNetwork;
	readonly ledger: Ledger;
	readonly cursor: ChainCursor;
	readonly apply: (blocks: readonly Block[]) => Promise<VoteStaple>;
};

const fixture = async function(): Promise<Fixture> {
	const { database, writer, admin } = await explorerDatabase();
	const storage = new PostgresLedgerStorage({ kind: 'connection-string', connectionString: database.connectionString });
	onTestFinished(function() {
		return(storage.destroy());
	});
	freezeClock(GENESIS_MOMENT);
	const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
	const ledger = network.createLedger(storage, requireAt(network.representatives, 0), { operations: { enableTokenAdminModifyBalance: true } });
	await ledger.add(network.genesis);
	const cursor = new ChainCursor(network.genesis);
	const apply = async function(blocks: readonly Block[]): Promise<VoteStaple> {
		const staple = await confirmedStaple(blocks, network.representatives);
		await ledger.add(staple);
		return(staple);
	};
	return({ database, writer, admin, network, ledger, cursor, apply });
};

const clock = function(at: number): () => number {
	return(function() {
		return(at);
	});
};

const indexAll = async function(writer: pg.Pool, from?: IndexerState, now: () => number = clock(GENESIS_MOMENT.getTime())): Promise<IndexerState> {
	let state = from ?? await startingState(writer);
	for (;;) {
		const result = await indexBatch(writer, state, SETTINGS, now);
		state = result.state;
		if (result.indexed === 0) {
			return(state);
		}
	}
};

const throughOf = function(state: IndexerState): bigint {
	if (state.kind !== 'running') {
		throw(new Error(`the indexer is ${state.kind}`));
	}
	return(state.watermark.through);
};

const idOf = async function(pool: pg.Pool, account: GenericAccount): Promise<string> {
	const rows = await pool.query<{ id: string }>('SELECT id FROM public.accounts WHERE public_key = $1', [account.publicKeyString.get()]);
	const id = rows.rows[0]?.id;
	if (id === undefined) {
		throw(new Error(`${account.publicKeyString.get()} has no id`));
	}
	return(id);
};

const sequenceOf = async function(pool: pg.Pool, staple: VoteStaple): Promise<string> {
	const rows = await pool.query<{ sequence: string }>('SELECT sequence FROM public.staples WHERE blocks_hash = $1', [staple.blocksHash.getBuffer()]);
	return(requireAt(rows.rows, 0).sequence);
};

const positionOf = async function(pool: pg.Pool, staple: VoteStaple): Promise<{ sequence: bigint; stapleTime: Date }> {
	const rows = await pool.query<{ sequence: string; staple_time: Date }>('SELECT sequence, staple_time FROM public.staples WHERE blocks_hash = $1', [staple.blocksHash.getBuffer()]);
	const row = requireAt(rows.rows, 0);
	return({ sequence: BigInt(row.sequence), stapleTime: row.staple_time });
};

const indexedCounts = async function(pool: pg.Pool): Promise<Record<string, number>> {
	const rows = await pool.query<{ blocks_hash: Buffer; count: string }>('SELECT blocks_hash, count(*) FROM explorer.indexed_staples GROUP BY blocks_hash');
	return(Object.fromEntries(rows.rows.map(function(row): [string, number] {
		return([row.blocks_hash.toString('hex').toUpperCase(), Number(row.count)]);
	})));
};

const holdingsOf = async function(pool: pg.Pool): Promise<{ explorer: unknown[]; node: unknown[] }> {
	const explorer = await pool.query('SELECT account_id, token_id, balance::text FROM explorer.holdings ORDER BY account_id, token_id');
	const node = await pool.query('SELECT account_id, token_id, balance::text FROM public.balances WHERE balance <> 0 ORDER BY account_id, token_id');
	return({ explorer: explorer.rows, node: node.rows });
};

/** A staples row of a staple with no blocks, which takes the next sequence. */
const insertBareStaple = async function(client: pg.ClientBase | pg.Pool): Promise<Buffer> {
	const hash = randomBytes(32);
	await client.query(`INSERT INTO public.staples (blocks_hash, staple_time, moment, checksum) VALUES ($1, $2, $2, ${ZERO_CHECKSUM})`, [hash, GENESIS_MOMENT]);
	return(hash);
};

const sendFrom = function(context: Fixture, from: Account, to: GenericAccount, amount: bigint): Promise<Block> {
	return(sendBlock({ from, to, amount, token: context.network.baseToken, previous: context.cursor.previous(from), network: context.network.network }));
};

afterEach(function() {
	vi.useRealTimers();
});

type RecordingTarget = LogTarget & { readonly messages: () => unknown[] };

const recordingTarget = function(): RecordingTarget {
	const entries: (LogEntry | LogEntryFilled)[] = [];
	return({
		logLevel: 'ALL',
		filter: null,
		emitLogs(logs) {
			entries.push(...logs);
			return(Promise.resolve());
		},
		messages() {
			return(entries.map(function(entry) {
				return(entry.args[0]);
			}));
		}
	});
};

/** Makes every insert into explorer.indexed_staples fail, after a staple's blocks and operations are written. */
const refuseIndexedStaples = async function(admin: pg.Pool): Promise<void> {
	await admin.query(`
		CREATE FUNCTION explorer.refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
		CREATE TRIGGER refuse_for_test BEFORE INSERT ON explorer.indexed_staples FOR EACH ROW EXECUTE FUNCTION explorer.refuse_for_test()`);
};

const pause = function(milliseconds: number): Promise<void> {
	return(new Promise(function(resolve) {
		setTimeout(resolve, milliseconds);
	}));
};

describe('the indexer', function() {
	test('genesis then a send are indexed', async function() {
		const context = await fixture();
		const sender = requireAt(context.network.users, 0);
		const recipient = requireAt(context.network.users, 1);
		const sent = context.cursor.append(await sendFrom(context, sender, recipient, 7n));
		const sendStaple = await context.apply([sent]);

		await indexAll(context.writer);

		const operations = await context.admin.query<{ block_hash: Buffer; idx: number; type: string; account_id: string; counterparty_id: string | null; token_id: string | null; amount: string | null }>(
			'SELECT block_hash, idx, type, account_id, counterparty_id, token_id, amount::text FROM explorer.operations ORDER BY block_hash, idx');
		const expected = [];
		for (const block of [...context.network.genesis.blocks, ...sendStaple.blocks]) {
			const accountID = await idOf(context.admin, block.account);
			for (const [index, operation] of block.operations.entries()) {
				expected.push({ block_hash: block.hash.getBuffer(), idx: index, type: lib.Block.OperationType[operation.type], account_id: accountID });
			}
		}
		expect(operations.rows).toHaveLength(expected.length);
		for (const row of expected) {
			expect(operations.rows).toContainEqual(expect.objectContaining(row));
		}
		expect(operations.rows).toContainEqual({
			block_hash: sent.hash.getBuffer(),
			idx: 0,
			type: 'SEND',
			account_id: await idOf(context.admin, sender),
			counterparty_id: await idOf(context.admin, recipient),
			token_id: await idOf(context.admin, context.network.baseToken),
			amount: '7'
		});
		const heights = await context.admin.query<{ explorer: string; node: string }>(
			'SELECT block.height AS explorer, chain.height AS node FROM explorer.blocks block JOIN public.chain chain ON chain.block_hash = block.hash');
		expect(heights.rows).toHaveLength(context.network.genesis.blocks.length + 1);
		for (const row of heights.rows) {
			expect(row.explorer).toBe(row.node);
		}
	});

	test('holdings equal the node\'s non-zero balances', async function() {
		const context = await fixture();
		const { network, cursor } = context;
		const owner = requireAt(network.users, 0);
		const [first, second] = [requireAt(network.users, 1), requireAt(network.users, 2)];
		const created = await createTokenBlock({ owner, previous: cursor.previous(owner), network: network.network });
		const { token } = created;
		cursor.append(created.block);
		const minted = cursor.append(await tokenSupplyBlock({ owner, token, amount: 500n, previous: cursor.previous(token), network: network.network }));
		const toFirst = cursor.append(await sendBlock({ from: token, signer: owner, to: first, amount: 100n, token, previous: cursor.previous(token), network: network.network }));
		const toSecond = cursor.append(await sendBlock({ from: token, signer: owner, to: second, amount: 50n, token, previous: cursor.previous(token), network: network.network }));
		await context.apply([created.block, minted, toFirst, toSecond]);
		await context.apply([cursor.append(await sendBlock({ from: first, to: token, amount: 100n, token, previous: cursor.previous(first), network: network.network }))]);

		await indexAll(context.writer);

		const holdings = await holdingsOf(context.admin);
		expect(holdings.explorer).toEqual(holdings.node);
		const firstHolds = await context.admin.query('SELECT FROM explorer.holdings WHERE account_id = $1 AND token_id = $2', [await idOf(context.admin, first), await idOf(context.admin, token)]);
		expect(firstHolds.rows).toHaveLength(0);
		const secondHolds = await context.admin.query<{ balance: string }>('SELECT balance::text FROM explorer.holdings WHERE account_id = $1 AND token_id = $2', [await idOf(context.admin, second), await idOf(context.admin, token)]);
		expect(secondHolds.rows).toEqual([{ balance: '50' }]);
	});

	test('a staple committed after a higher sequence is indexed once', async function() {
		const context = await fixture();
		const genesisState = await indexAll(context.writer);
		const held = await context.admin.connect();
		onTestFinished(function() {
			held.release();
		});
		await held.query('BEGIN');
		const heldHash = await insertBareStaple(held);
		const sender = requireAt(context.network.users, 0);
		const sendStaple = await context.apply([context.cursor.append(await sendFrom(context, sender, requireAt(context.network.users, 1), 1n))]);

		const before = await indexAll(context.writer, genesisState);
		expect(throughOf(before)).toBe(throughOf(genesisState));
		await held.query('COMMIT');
		const after = await indexAll(context.writer, before);

		expect(await indexedCounts(context.admin)).toEqual({
			[context.network.genesis.blocksHash.toString()]: 1,
			[heldHash.toString('hex').toUpperCase()]: 1,
			[sendStaple.blocksHash.toString()]: 1
		});
		expect(throughOf(after).toString()).toBe(await sequenceOf(context.admin, sendStaple));
		const stored = await context.admin.query<{ watermark: string }>('SELECT watermark FROM explorer.progress');
		expect(stored.rows).toEqual([{ watermark: await sequenceOf(context.admin, sendStaple) }]);
	});

	test('a rolled-back sequence is passed after the grace', async function() {
		const context = await fixture();
		const start = GENESIS_MOMENT.getTime();
		const genesisState = await indexAll(context.writer, undefined, clock(start));
		const rolledBack = await context.admin.connect();
		await rolledBack.query('BEGIN');
		await insertBareStaple(rolledBack);
		await rolledBack.query('ROLLBACK');
		rolledBack.release();
		const sendStaple = await context.apply([context.cursor.append(await sendFrom(context, requireAt(context.network.users, 0), requireAt(context.network.users, 1), 1n))]);

		const waiting = await indexAll(context.writer, genesisState, clock(start));
		const stillWaiting = await indexAll(context.writer, waiting, clock(start + GAP_GRACE_MILLISECONDS - 1));
		const passed = await indexAll(context.writer, stillWaiting, clock(start + GAP_GRACE_MILLISECONDS));

		expect(throughOf(waiting)).toBe(throughOf(genesisState));
		expect(throughOf(stillWaiting)).toBe(throughOf(genesisState));
		expect(throughOf(passed).toString()).toBe(await sequenceOf(context.admin, sendStaple));
	});

	test('reconcile finds a staple the watermark passed', async function() {
		const context = await fixture();
		const sendStaple = await context.apply([context.cursor.append(await sendFrom(context, requireAt(context.network.users, 0), requireAt(context.network.users, 1), 1n))]);
		await indexAll(context.writer);
		const operationsBefore = await context.admin.query('SELECT * FROM explorer.operations ORDER BY block_hash, idx');
		const blockHashes = sendStaple.blocks.map(function(block) {
			return(block.hash.getBuffer());
		});
		await context.admin.query('DELETE FROM explorer.indexed_staples WHERE blocks_hash = $1', [sendStaple.blocksHash.getBuffer()]);
		await context.admin.query('DELETE FROM explorer.operations WHERE block_hash = ANY($1::bytea[])', [blockHashes]);
		const faults: IndexerFault[] = [];

		const found = await reconcile(context.writer, function(fault) {
			faults.push(fault);
		});

		expect(found).toBe(1);
		expect(faults).toEqual([{ kind: 'missed-staple', blocksHash: sendStaple.blocksHash.toString(), sequence: BigInt(await sequenceOf(context.admin, sendStaple)) }]);
		const operationsAfter = await context.admin.query('SELECT * FROM explorer.operations ORDER BY block_hash, idx');
		expect(operationsAfter.rows).toEqual(operationsBefore.rows);
		expect(await indexedCounts(context.admin)).toEqual({ [context.network.genesis.blocksHash.toString()]: 1, [sendStaple.blocksHash.toString()]: 1 });
		expect(await reconcile(context.writer)).toBe(0);
	});

	test('a staple past the watermark is not one reconcile reports', async function() {
		const context = await fixture();

		expect(await reconcile(context.writer)).toBe(0);
		expect(await indexedCounts(context.admin)).toEqual({});
	});

	test('a newer node schema pauses indexing', async function() {
		const context = await fixture();
		const newest = await knownNodeVersions();
		await context.admin.query('INSERT INTO public.schema_version (version, sha256, applied_at) VALUES ($1, $2, $3)', [newest + 1, Buffer.alloc(32), GENESIS_MOMENT]);

		const paused = await indexBatch(context.writer, await startingState(context.writer), SETTINGS, clock(GENESIS_MOMENT.getTime()));

		expect(paused).toEqual({ indexed: 0, state: { kind: 'paused', reason: 'node-schema-newer', nodeVersion: newest + 1, newestKnown: newest } });
		expect(await indexedCounts(context.admin)).toEqual({});
		const operations = await context.admin.query('SELECT FROM explorer.operations');
		expect(operations.rows).toHaveLength(0);
		expect((await freshness(context.writer)).paused).toBe(`node schema ${String(newest + 1)} is newer than this build, which knows up to ${String(newest)}`);

		await context.admin.query('DELETE FROM public.schema_version WHERE version = $1', [newest + 1]);
		const resumed = await indexAll(context.writer, paused.state);

		expect(resumed.kind).toBe('running');
		expect(await indexedCounts(context.admin)).toEqual({ [context.network.genesis.blocksHash.toString()]: 1 });
		expect((await freshness(context.writer)).paused).toBeNull();
	});

	test('the newest known node version is the newest migration file\'s', async function() {
		const versions = await knownNodeVersions(new URL('../../schema/migrations/', import.meta.url));

		expect(versions).toBe(11);
	});

	test('freshness names the newest indexed staple, the node\'s newest, and the staples not yet indexed', async function() {
		const context = await fixture();
		const genesis = await positionOf(context.admin, context.network.genesis);
		const empty = await freshness(context.writer);
		await indexAll(context.writer);
		const sendStaple = await context.apply([context.cursor.append(await sendFrom(context, requireAt(context.network.users, 0), requireAt(context.network.users, 1), 1n))]);

		const behind = await freshness(context.writer);

		expect(empty).toEqual({ newestIndexed: null, newestNode: genesis, behind: 1, paused: null });
		expect(behind).toEqual({
			newestIndexed: genesis,
			newestNode: await positionOf(context.admin, sendStaple),
			behind: 1,
			paused: null
		});
	});

	test('checkHoldings repairs a wrong row', async function() {
		const context = await fixture();
		await indexAll(context.writer);
		const correct = await holdingsOf(context.admin);
		const [changed, removed] = [requireAt(correct.node, 0), requireAt(correct.node, 1)] as { account_id: string; token_id: string }[];
		await context.admin.query('UPDATE explorer.holdings SET balance = balance + 1 WHERE account_id = $1 AND token_id = $2', [changed?.account_id, changed?.token_id]);
		await context.admin.query('DELETE FROM explorer.holdings WHERE account_id = $1 AND token_id = $2', [removed?.account_id, removed?.token_id]);
		await context.admin.query('INSERT INTO explorer.holdings (token_id, account_id, balance) VALUES ($1, $1, 9)', [changed?.token_id]);
		const faults: IndexerFault[] = [];

		const repaired = await checkHoldings(context.writer, function(fault) {
			faults.push(fault);
		});

		expect(repaired).toBe(3);
		expect(faults).toHaveLength(3);
		expect(faults).toContainEqual(expect.objectContaining({ kind: 'holding-differs', accountID: removed?.account_id, tokenID: removed?.token_id, explorer: null }));
		expect(await holdingsOf(context.admin)).toEqual(correct);
		expect(await checkHoldings(context.writer)).toBe(0);
	});

	test('every address an operation names is interned by the node', async function() {
		const context = await fixture();
		const { network, cursor } = context;
		const owner = requireAt(network.users, 0);
		const other = requireAt(network.users, 1);
		const created = await createTokenBlock({ owner, previous: cursor.previous(owner), network: network.network });
		const { token } = created;
		cursor.append(created.block);
		const minted = cursor.append(await tokenSupplyBlock({ owner, token, amount: 10n, previous: cursor.previous(token), network: network.network }));
		const named = cursor.append(await setInfoBlock({ account: token, signer: owner, previous: cursor.previous(token), network: network.network, name: 'T', description: 'token', metadata: '', defaultPermission: new lib.Permissions(['ACCESS']) }));
		await context.apply([created.block, minted, named]);
		const paid = cursor.append(await sendFrom(context, owner, other, 3n));
		const received = cursor.append(await receiveBlock({ account: other, from: owner, amount: 3n, token: network.baseToken, exact: true, previous: cursor.previous(other), network: network.network }));
		await context.apply([paid, received]);
		const certificate = await certificateIssuedBy(other, owner, 3, false);
		const intermediates = new lib.Utils.Certificate.CertificateBundle([await certificateFor(other, 4)]);
		await context.apply([cursor.append(await manageCertificateBlock({ account: owner, method: lib.Block.AdjustMethod.ADD, certificateOrHash: certificate, intermediateCertificates: intermediates, previous: cursor.previous(owner), network: network.network }))]);
		const multisig = await createMultisigBlock({ owner, signers: [owner, other], quorum: 2n, previous: cursor.previous(owner), network: network.network });
		await context.apply([cursor.append(multisig.block)]);

		await indexAll(context.writer);

		const types = await context.admin.query<{ type: string }>('SELECT DISTINCT type FROM explorer.operations ORDER BY type');
		expect(types.rows.map(function(row) {
			return(row.type);
		})).toEqual(['CREATE_IDENTIFIER', 'MANAGE_CERTIFICATE', 'MODIFY_PERMISSIONS', 'RECEIVE', 'SEND', 'SET_INFO', 'SET_REP', 'TOKEN_ADMIN_MODIFY_BALANCE', 'TOKEN_ADMIN_SUPPLY']);
		expect((await freshness(context.writer)).behind).toBe(0);
	});

	test('a staple naming an account the node has not interned stops the batch, naming the staple and the address', async function() {
		const context = await fixture();
		await indexAll(context.writer);
		const stranger = lib.Account.fromSeed('5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d', 0);
		const block = await sendFrom(context, requireAt(context.network.users, 0), stranger, 1n);
		const staple = await insertBareStaple(context.admin);
		await context.admin.query(`
			INSERT INTO public.blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
			VALUES ($1, 'main', $2, $3, 1, $4, $5, 0)`, [block.hash.getBuffer(), await idOf(context.admin, block.account), randomBytes(32), Buffer.from(block.toBytes()), staple]);

		const failure = await indexAll(context.writer).catch(function(error: unknown) {
			return(error);
		});

		expect(failure).toBeInstanceOf(IndexerError);
		expect(failure).toMatchObject({ problem: { kind: 'unknown-account', staple: staple.toString('hex').toUpperCase(), address: stranger.publicKeyString.get() } });
		expect(await indexedCounts(context.admin)).toEqual({ [context.network.genesis.blocksHash.toString()]: 1 });
	});

	test('a block that does not decode stops the batch, naming the staple and the block', async function() {
		const context = await fixture();
		const hash = randomBytes(32);
		const staple = await insertBareStaple(context.admin);
		await context.admin.query(`
			INSERT INTO public.blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
			VALUES ($1, 'main', $2, $3, 0, '\\x00', $4, 0)`, [hash, await idOf(context.admin, requireAt(context.network.users, 0)), randomBytes(32), staple]);
		await indexAll(context.writer).catch(function() {
			// Genesis is indexed in the first batch; the failure is checked below.
		});

		const failure = await indexBatch(context.writer, await startingState(context.writer), SETTINGS, clock(0)).catch(function(error: unknown) {
			return(error);
		});

		expect(failure).toMatchObject({ problem: { kind: 'undecodable-block', staple: staple.toString('hex').toUpperCase(), block: hash.toString('hex').toUpperCase() } });
		expect(Object.keys(await indexedCounts(context.admin))).not.toContain(staple.toString('hex').toUpperCase());
	});

	test('a running indexer indexes until stopped, and logs a pause once', async function() {
		const context = await fixture();
		vi.useRealTimers();
		const entries: (LogEntry | LogEntryFilled)[] = [];
		const target: LogTarget = {
			logLevel: 'ALL',
			filter: null,
			emitLogs(logs) {
				entries.push(...logs);
				return(Promise.resolve());
			}
		};
		const indexer = new Indexer(context.writer, { ...DEFAULT_INDEXER_SETTINGS, pollMilliseconds: 5 }, target);

		indexer.start();
		await vi.waitFor(async function() {
			expect(await indexedCounts(context.admin)).toEqual({ [context.network.genesis.blocksHash.toString()]: 1 });
		});
		const newest = await knownNodeVersions();
		await context.admin.query('INSERT INTO public.schema_version (version, sha256, applied_at) VALUES ($1, $2, $3)', [newest + 1, Buffer.alloc(32), GENESIS_MOMENT]);
		await vi.waitFor(async function() {
			expect((await freshness(context.writer)).paused).not.toBeNull();
		});
		await new Promise(function(resolve) {
			setTimeout(resolve, 50);
		});
		await indexer.stop();

		expect(entries.map(function(entry) {
			return({ level: entry.level, args: entry.args });
		})).toEqual([{ level: 'ERROR', args: [`indexing paused: node schema ${String(newest + 1)} is newer than this build, which knows up to ${String(newest)}`] }]);
	});

	test('a staple whose indexing fails after its rows are written leaves none of them', async function() {
		const context = await fixture();
		await indexAll(context.writer);
		const sent = context.cursor.append(await sendFrom(context, requireAt(context.network.users, 0), requireAt(context.network.users, 1), 1n));
		await context.apply([sent]);
		await refuseIndexedStaples(context.admin);

		const failure = await indexAll(context.writer).catch(function(error: unknown) {
			return(error);
		});

		expect(failure).toMatchObject({ message: 'refused for the test' });
		const blocks = await context.admin.query('SELECT FROM explorer.blocks WHERE hash = $1', [sent.hash.getBuffer()]);
		const operations = await context.admin.query('SELECT FROM explorer.operations WHERE block_hash = $1', [sent.hash.getBuffer()]);
		expect([blocks.rows.length, operations.rows.length]).toEqual([0, 0]);
	});

	test('every read of the node tables runs in READ COMMITTED, whatever the writer role defaults to', async function() {
		const context = await fixture();
		await context.admin.query(`ALTER ROLE explorer_writer IN DATABASE ${pg.escapeIdentifier(context.database.name)} SET default_transaction_isolation = 'serializable'`);
		const cluster = inject('postgresCluster');
		const writer = new pg.Pool({ host: cluster.socketDirectory, port: cluster.port, user: 'explorer_writer', database: context.database.name });
		writer.on('error', function() {
			// Dropping the database terminates idle connections.
		});
		onTestFinished(function() {
			return(writer.end());
		});
		const levels: string[] = [];
		writer.on('connect', function(client) {
			const query = client.query.bind(client) as unknown as (...args: unknown[]) => unknown;
			const show = client.query.bind(client) as unknown as (text: string) => Promise<pg.QueryResult<{ transaction_isolation: string }>>;
			// The client runs its queries in order, so the level shown is the one the next query runs at.
			(client as unknown as { query: (...args: unknown[]) => unknown }).query = function(...args: unknown[]) {
				if (JSON.stringify(args[0]).includes('public.')) {
					show('SHOW transaction_isolation').then(function(result) {
						levels.push(requireAt(result.rows, 0).transaction_isolation);
					}, function() {
						levels.push('unreadable');
					});
				}
				return(query(...args));
			};
		});
		const defaults = await writer.query<{ transaction_isolation: string }>('SHOW transaction_isolation');
		await context.apply([context.cursor.append(await sendFrom(context, requireAt(context.network.users, 0), requireAt(context.network.users, 1), 1n))]);

		await indexAll(writer);
		await context.admin.query('UPDATE explorer.holdings SET balance = balance + 1');
		await checkHoldings(writer);
		await reconcile(writer);
		await freshness(writer);

		expect(defaults.rows).toEqual([{ transaction_isolation: 'serializable' }]);
		expect(levels.length).toBeGreaterThan(0);
		expect(new Set(levels)).toEqual(new Set(['read committed']));
	});

	test('checkHoldings reports no fault for a staple the node applied that is not indexed yet', async function() {
		const context = await fixture();
		await indexAll(context.writer);
		const sendStaple = await context.apply([context.cursor.append(await sendFrom(context, requireAt(context.network.users, 0), requireAt(context.network.users, 1), 1n))]);
		const faults: IndexerFault[] = [];

		const repaired = await checkHoldings(context.writer, function(fault) {
			faults.push(fault);
		});

		expect([repaired, faults]).toEqual([0, []]);
		const holdings = await holdingsOf(context.admin);
		expect(holdings.explorer).toEqual(holdings.node);
		expect(await indexedCounts(context.admin)).toMatchObject({ [sendStaple.blocksHash.toString()]: 1 });
	});

	test('a stale indexer never moves the stored watermark back', async function() {
		const context = await fixture();
		const stale = await startingState(context.writer);
		await indexAll(context.writer);
		await context.admin.query('UPDATE explorer.progress SET watermark = 100');

		const result = await indexBatch(context.writer, stale, SETTINGS, clock(GENESIS_MOMENT.getTime()));

		expect(throughOf(result.state)).toBe(toStapleSequence(BigInt(await sequenceOf(context.admin, context.network.genesis))));
		const stored = await context.admin.query<{ watermark: string }>('SELECT watermark FROM explorer.progress');
		expect(stored.rows).toEqual([{ watermark: '100' }]);
	});

	test('a paused indexer neither reconciles nor checks the holdings', async function() {
		const context = await fixture();
		await indexAll(context.writer);
		vi.useRealTimers();
		await context.admin.query('INSERT INTO public.schema_version (version, sha256, applied_at) VALUES ($1, $2, $3)', [await knownNodeVersions() + 1, Buffer.alloc(32), GENESIS_MOMENT]);
		await context.admin.query('DELETE FROM explorer.indexed_staples');
		await context.admin.query('UPDATE explorer.holdings SET balance = balance + 1');
		const before = await holdingsOf(context.admin);
		const target = recordingTarget();
		const indexer = new Indexer(context.writer, { ...DEFAULT_INDEXER_SETTINGS, pollMilliseconds: 5, reconcileMilliseconds: 0, holdingsCheckMilliseconds: 0 }, target);

		indexer.start();
		await vi.waitFor(function() {
			expect(target.messages()).toHaveLength(1);
		});
		await pause(50);
		await indexer.stop();

		expect(await indexedCounts(context.admin)).toEqual({});
		expect(await holdingsOf(context.admin)).toEqual(before);
		expect(target.messages()).toEqual([expect.stringMatching(/^indexing paused: /u)]);
	});

	test('a backstop that keeps failing is logged once, and the other backstop still runs', async function() {
		const context = await fixture();
		await indexAll(context.writer);
		vi.useRealTimers();
		await context.admin.query('DELETE FROM explorer.indexed_staples');
		await context.admin.query('UPDATE explorer.holdings SET balance = balance + 1 WHERE (account_id, token_id) IN (SELECT account_id, token_id FROM explorer.holdings LIMIT 1)');
		await refuseIndexedStaples(context.admin);
		const target = recordingTarget();
		const indexer = new Indexer(context.writer, { ...DEFAULT_INDEXER_SETTINGS, pollMilliseconds: 5, reconcileMilliseconds: 0, holdingsCheckMilliseconds: 0 }, target);

		indexer.start();
		await vi.waitFor(async function() {
			const holdings = await holdingsOf(context.admin);
			expect(holdings.explorer).toEqual(holdings.node);
		});
		await pause(50);
		await indexer.stop();

		const messages = target.messages() as string[];
		expect(messages.filter(function(message) {
			return(message.startsWith('the reconcile failed: '));
		})).toEqual(['the reconcile failed: refused for the test']);
		expect(messages.filter(function(message) {
			return(message.startsWith('indexer fault: holding'));
		})).toHaveLength(1);
		expect(messages.some(function(message) {
			return(message.startsWith('indexing stopped'));
		})).toBe(false);
	});

	test('of two indexers on one database one indexes, and the other takes over once it stops', async function() {
		const context = await fixture();
		vi.useRealTimers();
		const settings = { ...DEFAULT_INDEXER_SETTINGS, pollMilliseconds: 5 };
		const [firstTarget, secondTarget] = [recordingTarget(), recordingTarget()];
		const first = new Indexer(context.writer, settings, firstTarget);
		const second = new Indexer(context.writer, settings, secondTarget);
		const indexedSend = async function(): Promise<VoteStaple> {
			const staple = await context.apply([context.cursor.append(await sendFrom(context, requireAt(context.network.users, 0), requireAt(context.network.users, 1), 1n))]);
			await vi.waitFor(async function() {
				expect(await indexedCounts(context.admin)).toMatchObject({ [staple.blocksHash.toString()]: 1 });
			});
			return(staple);
		};

		first.start();
		await vi.waitFor(async function() {
			expect(await indexedCounts(context.admin)).toEqual({ [context.network.genesis.blocksHash.toString()]: 1 });
		});
		second.start();
		await vi.waitFor(function() {
			expect(secondTarget.messages()).toEqual(['another indexer holds the indexer lock; waiting for it to stop']);
		});
		await indexedSend();
		await first.stop();
		await indexedSend();
		await second.stop();

		expect(firstTarget.messages()).toEqual([]);
		expect(secondTarget.messages()).toEqual(['another indexer holds the indexer lock; waiting for it to stop']);
		expect(Object.values(await indexedCounts(context.admin))).toEqual([1, 1, 1]);
	});
});
