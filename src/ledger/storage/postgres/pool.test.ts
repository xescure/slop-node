import { describe, expect, inject, onTestFinished, test } from 'vitest';
import { createDatabase } from '../../../testing/postgres.js';
import type { TestDatabase } from '../../../testing/postgres.js';
import { PostgresPool } from './pool.js';

const freshDatabase = async function(): Promise<TestDatabase> {
	const database = await createDatabase(inject('postgresCluster'));
	onTestFinished(function() {
		return(database.drop());
	});
	return(database);
};

const currentDatabase = async function(pool: PostgresPool): Promise<string | undefined> {
	const result = await pool.pool.query<{ name: string }>('SELECT current_database() AS name');
	return(result.rows[0]?.name);
};

describe('PostgresPool', function() {
	test('a pool opened from a connection string is owned and ended on close', async function() {
		const database = await freshDatabase();
		const pool = await PostgresPool.open({ kind: 'connection-string', connectionString: database.connectionString });

		expect(await currentDatabase(pool)).toBe(database.name);
		await pool.close();
		await pool.close();

		expect(pool.pool.ended).toBe(true);
	});

	test('an injected pool is left open on close', async function() {
		const database = await freshDatabase();
		const injected = database.pool();
		const pool = await PostgresPool.open({
			kind: 'injected',
			pool: function() {
				return(Promise.resolve(injected));
			}
		});

		expect(pool.pool).toBe(injected);
		await pool.close();

		expect(injected.ended).toBe(false);
		expect(await currentDatabase(pool)).toBe(database.name);
	});
});
