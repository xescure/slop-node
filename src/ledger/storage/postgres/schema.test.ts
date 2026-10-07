import { describe, expect, inject, onTestFinished, test } from 'vitest';
import type pg from 'pg';
import { createDatabase } from '../../../testing/postgres.js';

const HASH = Buffer.alloc(32, 0xab);

const ledgerPool = async function(): Promise<pg.Pool> {
	const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	onTestFinished(function() {
		return(database.drop());
	});
	return(database.pool());
};

const failureOf = async function(attempt: Promise<unknown>): Promise<unknown> {
	return(await attempt.then(function(): never {
		throw(new Error('expected the statement to fail'));
	}, function(error: unknown) {
		return(error);
	}));
};

describe('the Postgres schema', function() {
	test('every moment the migrations store is a whole number of milliseconds', async function() {
		const pool = await ledgerPool();

		const columns = await pool.query<{ table_name: string; column_name: string; domain_name: string | null }>(`
			SELECT table_name, column_name, domain_name FROM information_schema.columns
			WHERE table_schema = 'public' AND data_type = 'timestamp with time zone' AND table_name <> 'schema_version'
			ORDER BY table_name, column_name`);

		expect(columns.rows.length).toBeGreaterThan(0);
		for (const column of columns.rows) {
			expect(column.domain_name, `${column.table_name}.${column.column_name}`).toBe('timestamptz_ms');
		}
	});

	test('a moment with a fraction of a millisecond is refused, and a whole millisecond is stored', async function() {
		const pool = await ledgerPool();

		const refused = await failureOf(pool.query('INSERT INTO staples (blocks_hash, staple_time, moment) VALUES ($1, $2, $2)', [HASH, '2026-10-07 12:00:00.0005+00']));
		await pool.query('INSERT INTO staples (blocks_hash, staple_time, moment) VALUES ($1, $2, $2)', [HASH, '2026-10-07 12:00:00.123+00']);

		expect(refused).toMatchObject({ code: '23514' });
		const stored = await pool.query<{ moment: Date }>('SELECT moment FROM staples');
		expect(stored.rows).toEqual([{ moment: new Date('2026-10-07T12:00:00.123Z') }]);
	});
});
