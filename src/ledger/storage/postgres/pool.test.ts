import { describe, expect, inject, onTestFinished, test } from 'vitest';
import { createDatabase } from '../../../testing/postgres.js';
import type { TestDatabase } from '../../../testing/postgres.js';
import { DEFAULT_POOL_OPTIONS, PostgresPool } from './pool.js';

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

const sessionSetting = async function(pool: PostgresPool, setting: 'statement_timeout' | 'idle_in_transaction_session_timeout'): Promise<string | undefined> {
	const result = await pool.pool.query<Record<string, string>>(`SHOW ${setting}`);
	return(result.rows[0]?.[setting]);
};

describe('PostgresPool', function() {
	test('a pool opened from a connection string starts every session with the default timeouts', async function() {
		const database = await freshDatabase();
		const pool = await PostgresPool.open({ kind: 'connection-string', connectionString: database.connectionString });
		onTestFinished(function() {
			return(pool.close());
		});

		expect(await sessionSetting(pool, 'statement_timeout')).toBe('30s');
		expect(await sessionSetting(pool, 'idle_in_transaction_session_timeout')).toBe('10s');
		expect(pool.pool.options).toMatchObject({
			max: DEFAULT_POOL_OPTIONS.max,
			connectionTimeoutMillis: DEFAULT_POOL_OPTIONS.connectionTimeoutMillis,
			keepAlive: true
		});
	});

	test('each pool option can be overridden', async function() {
		const database = await freshDatabase();
		const pool = await PostgresPool.open({
			kind: 'connection-string',
			connectionString: database.connectionString,
			options: { max: 3, connectionTimeoutMillis: 250, keepAlive: false, statementTimeoutMillis: 1500, idleInTransactionTimeoutMillis: 2500 }
		});
		onTestFinished(function() {
			return(pool.close());
		});

		expect(await sessionSetting(pool, 'statement_timeout')).toBe('1500ms');
		expect(await sessionSetting(pool, 'idle_in_transaction_session_timeout')).toBe('2500ms');
		expect(pool.pool.options).toMatchObject({ max: 3, connectionTimeoutMillis: 250, keepAlive: false });
	});

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
