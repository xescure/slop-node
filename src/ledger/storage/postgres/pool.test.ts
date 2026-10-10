import { describe, expect, inject, onTestFinished, test, vi } from 'vitest';
import pg from 'pg';
import { createDatabase } from '../../../testing/postgres.js';
import type { TestDatabase } from '../../../testing/postgres.js';
import { MigrationError } from './migrations.js';
import { DEFAULT_POOL_OPTIONS, MigratedPostgresPool, PostgresPool } from './pool.js';

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

/** A database that records a schema version newer than this build knows, which migrating refuses. */
const databaseFromTheFuture = async function(): Promise<TestDatabase> {
	const database = await freshDatabase();
	const pool = database.pool();
	await pool.query('CREATE TABLE schema_version (version integer PRIMARY KEY, sha256 bytea NOT NULL, applied_at timestamptz NOT NULL)');
	await pool.query('INSERT INTO schema_version (version, sha256, applied_at) VALUES (9999, \'\\x00\', \'2026-10-07T12:00:00Z\')');
	return(database);
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
			keepAlive: true,
			keepAliveInitialDelayMillis: DEFAULT_POOL_OPTIONS.keepAliveInitialDelayMillis
		});
	});

	test('each pool option can be overridden', async function() {
		const database = await freshDatabase();
		const pool = await PostgresPool.open({
			kind: 'connection-string',
			connectionString: database.connectionString,
			options: { max: 3, connectionTimeoutMillis: 250, keepAlive: false, keepAliveInitialDelayMillis: 750, statementTimeoutMillis: 1500, idleInTransactionTimeoutMillis: 2500 }
		});
		onTestFinished(function() {
			return(pool.close());
		});

		expect(await sessionSetting(pool, 'statement_timeout')).toBe('1500ms');
		expect(await sessionSetting(pool, 'idle_in_transaction_session_timeout')).toBe('2500ms');
		expect(pool.pool.options).toMatchObject({ max: 3, connectionTimeoutMillis: 250, keepAlive: false, keepAliveInitialDelayMillis: 750 });
	});

	test('a pool opened from a connection string is owned and ended on close', async function() {
		const database = await freshDatabase();
		const pool = await PostgresPool.open({ kind: 'connection-string', connectionString: database.connectionString });

		expect(await currentDatabase(pool)).toBe(database.name);
		await pool.close();
		await pool.close();

		expect(pool.pool.ended).toBe(true);
	});

	test('an error a connection reports while it idles in a pool opened here does not end the process', async function() {
		const database = await freshDatabase();
		const pool = await PostgresPool.open({ kind: 'connection-string', connectionString: database.connectionString });
		onTestFinished(function() {
			return(pool.close());
		});

		expect(pool.pool.emit('error', new Error('the server ended an idle session'))).toBe(true);
	});

	test('a pool opened here whose migration is refused is ended', async function() {
		const database = await databaseFromTheFuture();
		const end = vi.spyOn(pg.Pool.prototype, 'end');
		onTestFinished(function() {
			end.mockRestore();
		});

		await expect(PostgresPool.openMigrated({ kind: 'connection-string', connectionString: database.connectionString })).rejects.toMatchObject({ problem: { kind: 'unknown-version' } });

		expect(end).toHaveBeenCalledOnce();
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

describe('MigratedPostgresPool', function() {
	test('a use whose migration failed is forgotten, so the next use tries again', async function() {
		const database = await databaseFromTheFuture();
		const store = new MigratedPostgresPool({ kind: 'connection-string', connectionString: database.connectionString }, 'probe store');
		onTestFinished(function() {
			return(store.destroy());
		});

		await expect(store.connection()).rejects.toBeInstanceOf(MigrationError);
		await database.pool().query('DELETE FROM schema_version');
		const connection = await store.connection();

		expect(await currentDatabase(connection)).toBe(database.name);
		expect(await store.connection()).toBe(connection);
	});
});
