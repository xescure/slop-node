import { describe, expect, inject, onTestFinished, test } from 'vitest';
import type pg from 'pg';
import { createDatabase } from '../../../testing/postgres.js';
import { accountHistory, accountHistoryAfter } from './confirmed-statements.js';

const MOMENT = new Date('2026-10-07T12:00:00.000Z');

const ACCOUNT = 'keeta_plan_account';

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

/** One account with one main staple in its history. */
const seedMainLedger = async function(pool: pg.Pool): Promise<void> {
	await pool.query('INSERT INTO accounts (public_key, key_type) VALUES ($1, 0)', [ACCOUNT]);
	await pool.query(`INSERT INTO staples (blocks_hash, staple_time, moment) VALUES (${hashOf('main staple')}, $1, $1)`, [MOMENT]);
	await pool.query(`INSERT INTO history (account_id, blocks_hash, staple_time) SELECT id, ${hashOf('main staple')}, $2 FROM accounts WHERE public_key = $1`, [ACCOUNT, MOMENT]);
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
