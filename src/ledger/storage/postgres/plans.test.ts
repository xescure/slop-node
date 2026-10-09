import { describe, expect, inject, onTestFinished, test } from 'vitest';
import type pg from 'pg';
import { createDatabase } from '../../../testing/postgres.js';
import { accountHistory, accountHistoryAfter } from './confirmed-statements.js';
import { deadDeferredStaples, releasedDeferredStaples } from './side-statements.js';

/** A catch-up far behind its peers defers tens of thousands of staples, beside a main ledger of many more blocks. */
const WAITING_STAPLES = 10_000;
const CONFIRMED_BLOCKS = 10_000;

/** gc's reads must not grow with the staples that still wait, nor with the main ledger: far fewer pages than one per hundred of either. */
const MOST_PAGES = Math.min(WAITING_STAPLES, CONFIRMED_BLOCKS) / 100;

const MOMENT = new Date('2026-10-07T12:00:00.000Z');

const ACCOUNT = 'keeta_plan_account';

type PlanNode = {
	readonly 'Shared Hit Blocks': number;
	readonly 'Shared Read Blocks': number;
};

type ExplainRow = {
	readonly 'QUERY PLAN': readonly [{ readonly Plan: PlanNode }];
};

const ledgerPool = async function(): Promise<pg.Pool> {
	const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	onTestFinished(function() {
		return(database.drop());
	});
	return(database.pool({ max: 1 }));
};

/** The 32 bytes the database derives from a label, so a seed names each row by a word. */
const hashOf = function(label: string): string {
	return(`sha256(convert_to('${label}', 'UTF8'))`);
};

/**
 * One account with one main staple of two blocks: one is awaited by a
 * deferred staple, and the other confirms a successor of a previous that a
 * deferred staple's block also extends.
 */
const seedMainLedger = async function(pool: pg.Pool): Promise<void> {
	await pool.query('INSERT INTO accounts (public_key, key_type) VALUES ($1, 0)', [ACCOUNT]);
	await pool.query(`INSERT INTO staples (blocks_hash, staple_time, moment) VALUES (${hashOf('main staple')}, $1, $1)`, [MOMENT]);
	await pool.query(`
		INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
		SELECT block.hash, 'main', accounts.id, block.previous, 1, '\\x00', ${hashOf('main staple')}, block.position
		FROM accounts, (VALUES
			(${hashOf('arrived')}, ${hashOf('before arrived')}, 0),
			(${hashOf('successor')}, ${hashOf('contested')}, 1)
		) AS block (hash, previous, position)
		WHERE accounts.public_key = $1`, [ACCOUNT]);
	await pool.query(`INSERT INTO history (account_id, blocks_hash, staple_time) SELECT id, ${hashOf('main staple')}, $2 FROM accounts WHERE public_key = $1`, [ACCOUNT, MOMENT]);
};

/** More confirmed blocks in the main staple, each the successor of a previous no deferred staple extends. */
const seedConfirmedBlocks = async function(pool: pg.Pool, count: number): Promise<void> {
	await pool.query(`
		INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
		SELECT sha256(convert_to('confirmed ' || n, 'UTF8')), 'main', accounts.id, sha256(convert_to('confirmed previous ' || n, 'UTF8')), 1, '\\x00', ${hashOf('main staple')}, n + 1
		FROM accounts, generate_series(1, $2) AS n
		WHERE accounts.public_key = $1`, [ACCOUNT, count]);
};

/** Staples that wait on blocks no one has, none of them released or dead. */
const seedWaitingStaples = async function(pool: pg.Pool, count: number): Promise<void> {
	const staple = 'sha256(convert_to(\'waiting \' || n, \'UTF8\'))';
	await pool.query(`INSERT INTO deferred_staples (blocks_hash, bytes, latest_vote_from) SELECT ${staple}, '\\x00', $2 FROM generate_series(1, $1) AS n`, [count, MOMENT]);
	await pool.query(`INSERT INTO deferred_waits (block_hash, blocks_hash) SELECT sha256(convert_to('missing ' || n, 'UTF8')), ${staple} FROM generate_series(1, $1) AS n`, [count]);
	await pool.query(`INSERT INTO deferred_blocks (blocks_hash, previous) SELECT ${staple}, sha256(convert_to('unclaimed ' || n, 'UTF8')) FROM generate_series(1, $1) AS n`, [count]);
};

/** A deferred staple waiting on one block whose one block extends a previous; listed for gc to check. */
const seedDeferredStaple = async function(pool: pg.Pool, staple: string, awaited: string, previous: string): Promise<void> {
	await pool.query(`INSERT INTO deferred_staples (blocks_hash, bytes, latest_vote_from) VALUES (${hashOf(staple)}, '\\x00', $1)`, [MOMENT]);
	await pool.query(`INSERT INTO deferred_waits (block_hash, blocks_hash) VALUES (${hashOf(awaited)}, ${hashOf(staple)})`);
	await pool.query(`INSERT INTO deferred_blocks (blocks_hash, previous) VALUES (${hashOf(staple)}, ${hashOf(previous)})`);
	await pool.query(`INSERT INTO deferred_checks (blocks_hash) VALUES (${hashOf(staple)})`);
};

const labelHash = async function(pool: pg.Pool, label: string): Promise<Buffer> {
	const result = await pool.query<{ hash: Buffer }>(`SELECT ${hashOf(label)} AS hash`);
	const hash = result.rows[0]?.hash;
	if (hash === undefined) {
		throw(new Error(`no hash for ${label}`));
	}
	return(hash);
};

/** The shared pages a statement read or found in the buffer pool, over its whole plan. */
const pagesRead = async function(pool: pg.Pool, text: string, parameters: readonly unknown[]): Promise<number> {
	const result = await pool.query<ExplainRow>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, [...parameters]);
	const plan = result.rows[0]?.['QUERY PLAN'][0].Plan;
	if (plan === undefined) {
		throw(new Error('EXPLAIN returned no plan'));
	}
	return(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']);
};

const planOf = async function(pool: pg.Pool, text: string, parameters: readonly unknown[]): Promise<string> {
	const client = await pool.connect();
	try {
		// The test tables are too small for the planner to prefer reading an index in order of its own accord.
		await client.query('SET enable_seqscan = off');
		await client.query('SET enable_bitmapscan = off');
		const result = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, [...parameters]);
		return(result.rows.map(function(row): string {
			return(row['QUERY PLAN']);
		}).join('\n'));
	} finally {
		await client.query('RESET ALL');
		client.release();
	}
};

describe('the Postgres driver\'s plans', function() {
	test('gc reads the staples listed for it, however many other staples still wait and blocks are confirmed', async function() {
		const pool = await ledgerPool();
		await seedMainLedger(pool);
		await seedConfirmedBlocks(pool, CONFIRMED_BLOCKS);
		await seedWaitingStaples(pool, WAITING_STAPLES);
		await seedDeferredStaple(pool, 'released', 'arrived', 'before released');
		await seedDeferredStaple(pool, 'dead', 'missing for dead', 'contested');
		// Autovacuum keeps the statistics of a live database about this current.
		await pool.query('ANALYZE');

		const dead = await pool.query<{ blocks_hash: Buffer }>(deadDeferredStaples.text, [101]);
		const released = await pool.query<{ blocks_hash: Buffer }>(releasedDeferredStaples.text, [100, []]);

		expect(dead.rows.map(function(row) {
			return(row.blocks_hash);
		})).toEqual([await labelHash(pool, 'dead')]);
		expect(released.rows.map(function(row) {
			return(row.blocks_hash);
		})).toEqual([await labelHash(pool, 'released')]);
		expect(await pagesRead(pool, deadDeferredStaples.text, [101])).toBeLessThan(MOST_PAGES);
		expect(await pagesRead(pool, releasedDeferredStaples.text, [100, []])).toBeLessThan(MOST_PAGES);
		expect(await pagesRead(pool, releasedDeferredStaples.text, [1, [await labelHash(pool, 'released')]])).toBeLessThan(MOST_PAGES);
	});

	test.each([
		{ name: 'from the newest', text: accountHistory.text, parameters: [ACCOUNT, 10] },
		{ name: 'after a start', text: accountHistoryAfter.text, parameters: [ACCOUNT, Buffer.alloc(32, 0xab), 10] }
	])('an account\'s history page $name reads one index newest first, without sorting', async function({ text, parameters }) {
		const pool = await ledgerPool();
		await seedMainLedger(pool);

		const plan = await planOf(pool, text, parameters);

		expect(plan).toMatch(/Scan Backward using history_pkey on history /);
		expect(plan).not.toContain('history_order');
		expect(plan).not.toContain('Sort');
	});

	test('a history page\'s start is found by the whole history key, its time read from its staple', async function() {
		const pool = await ledgerPool();
		await seedMainLedger(pool);

		const plan = await planOf(pool, accountHistoryAfter.text, [ACCOUNT, Buffer.alloc(32, 0xab), 10]);

		expect(plan).toContain('Index Scan using staples_pkey on staples');
		expect(plan).toMatch(/Scan using history_pkey on history start .*\n\s+Index Cond: \(\(account_id = [^\n]*\) AND \(staple_time = [^\n]*\) AND \(blocks_hash = [^\n]*\)\)\n/);
	});
});
