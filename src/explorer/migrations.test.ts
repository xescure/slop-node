import { appendFile, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, inject, onTestFinished, test } from 'vitest';
import type pg from 'pg';
import { SCHEMA_MIGRATIONS, applyMigrations } from '../ledger/storage/postgres/migrations.js';
import { createDatabase } from '../testing/postgres.js';
import { interceptQueries } from '../testing/query-faults.js';
import type { IssuedQuery } from '../testing/query-faults.js';
import { EXPLORER_MIGRATIONS, ExplorerMigrationError, applyExplorerMigrations } from './migrations.js';
import type { ExplorerMigrationProblem } from './migrations.js';
import { explorerDatabase, rolePool, runExplorerSetup } from './testing.js';

const newestShippedVersion = async function(): Promise<number> {
	const versions = (await readdir(EXPLORER_MIGRATIONS)).map(function(name) {
		return(Number(name.slice(0, 4)));
	});
	return(Math.max(...versions));
};

const copiedMigrations = async function(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'slop-explorer-migrations-'));
	onTestFinished(function() {
		return(rm(directory, { recursive: true, force: true }));
	});
	await cp(fileURLToPath(EXPLORER_MIGRATIONS), directory, { recursive: true });
	return(directory);
};

const refusalOf = async function(attempt: Promise<unknown>): Promise<ExplorerMigrationProblem> {
	try {
		await attempt;
	} catch (error: unknown) {
		if (error instanceof ExplorerMigrationError) {
			return(error.problem);
		}
		throw(error);
	}
	throw(new Error('the migration was not refused'));
};

const failureCodeOf = async function(pool: pg.Pool, statement: string): Promise<unknown> {
	try {
		await pool.query(statement);
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error) {
			return(error.code);
		}
		throw(error);
	}
	throw(new Error(`${statement} succeeded`));
};

describe('explorer migrations', function() {
	test('applying twice brings the schema to the newest shipped version and records each file once', async function() {
		const { writer } = await explorerDatabase();
		const newest = await newestShippedVersion();

		expect(await applyExplorerMigrations(writer)).toBe(newest);
		expect(await applyExplorerMigrations(writer)).toBe(newest);

		const rows = await writer.query<{ version: number }>('SELECT version FROM explorer.schema_version ORDER BY version');
		expect(rows.rows.map(function(row) {
			return(row.version);
		})).toEqual(Array.from({ length: newest }, function(_, index) {
			return(index + 1);
		}));
	});

	test('a migration edited after it was applied is refused, naming its version', async function() {
		const { writer } = await explorerDatabase();
		const directory = await copiedMigrations();
		await appendFile(join(directory, '0001_explorer.sql'), '\n');

		const attempt = applyExplorerMigrations(writer, pathToFileURL(`${directory}/`));

		await expect(attempt).rejects.toThrow(/migration version 1 was applied with sha256 [0-9a-f]{64}, but the file now has sha256 [0-9a-f]{64}/);
		expect(await refusalOf(attempt)).toMatchObject({ kind: 'edited', version: 1 });
	});

	test('the migration holds the explorer lock, keetaexp, and not the node lock', async function() {
		const { writer } = await explorerDatabase();
		const issued: IssuedQuery[] = [];
		interceptQueries(writer, function(query, run) {
			issued.push(query);
			return(run());
		});

		await applyExplorerMigrations(writer);

		const locks = issued.filter(function(query) {
			return(query.text.includes('pg_advisory'));
		});
		expect(locks).toEqual([
			{ name: undefined, text: 'SELECT pg_advisory_lock($1::bigint)', values: [0x6b65657461657870n.toString()] },
			{ name: undefined, text: 'SELECT pg_advisory_unlock($1::bigint)', values: [0x6b65657461657870n.toString()] }
		]);
	});

	test('the node schema_version is left as the node migrations wrote it', async function() {
		const { admin, writer } = await explorerDatabase();
		const before = await admin.query('SELECT version, sha256, applied_at FROM public.schema_version ORDER BY version');

		await applyExplorerMigrations(writer);

		const after = await admin.query('SELECT version, sha256, applied_at FROM public.schema_version ORDER BY version');
		expect(after.rows).toEqual(before.rows);
	});
});

const NODE_MIGRATION_LOCK_KEY = 0x6b656574616c6467n;

const EXPLORER_MIGRATION_LOCK_KEY = 0x6b65657461657870n;

const INDEXER_LOCK_KEY = 0x6b65657461696478n;

/** The built-in functions setup.sql takes from PUBLIC: those that write WAL, take advisory locks or change a setting. */
const REVOKED_FUNCTIONS = `
	SELECT oid::regprocedure::text AS routine, proname ~ '^pg_(try_)?advisory_' AS advisory
	FROM pg_proc
	WHERE pronamespace = 'pg_catalog'::regnamespace AND (proname IN ('pg_logical_emit_message', 'set_config') OR proname ~ '^pg_(try_)?advisory_')
	ORDER BY 1`;

type RevokedFunction = { readonly routine: string; readonly advisory: boolean };

const mayRun = async function(admin: pg.Pool, role: string, routine: string): Promise<boolean> {
	const allowed = await admin.query<{ allowed: boolean }>('SELECT has_function_privilege($1, $2, \'EXECUTE\') AS allowed', [role, routine]);
	return(allowed.rows[0]?.allowed === true);
};

/** A role that owns the node's tables without being a superuser, as the node's own role may in a deployment. */
const TABLE_OWNER = 'explorer_test_table_owner';

const OWN_THE_NODE_TABLES = `
	DO $$
	DECLARE
		node_table name;
	BEGIN
		IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TABLE_OWNER}') THEN
			CREATE ROLE ${TABLE_OWNER} LOGIN;
		END IF;
		FOR node_table IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
			EXECUTE format('ALTER TABLE public.%I OWNER TO ${TABLE_OWNER}', node_table);
		END LOOP;
	END
	$$;
	GRANT CREATE ON SCHEMA public TO ${TABLE_OWNER};`;

describe('explorer roles', function() {
	test('the reader may run none of the functions that write WAL, take advisory locks or change a setting, and the writer and the owner of the node tables take the advisory locks', async function() {
		const { admin } = await explorerDatabase();
		const owner = await admin.query<{ owner: string }>('SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace = \'public\'::regnamespace AND relkind = \'r\'');
		const revoked = await admin.query<RevokedFunction>(REVOKED_FUNCTIONS);
		expect(revoked.rows.map(function(row) {
			return(row.routine);
		})).toEqual(expect.arrayContaining(['pg_advisory_lock(bigint)', 'pg_advisory_lock(integer,integer)', 'pg_try_advisory_xact_lock_shared(bigint)', 'pg_advisory_unlock_all()', 'pg_logical_emit_message(boolean,text,text,boolean)', 'pg_logical_emit_message(boolean,text,bytea,boolean)', 'set_config(text,text,boolean)']));
		for (const { routine, advisory } of revoked.rows) {
			expect({ routine, reader: await mayRun(admin, 'explorer_reader', routine), writer: await mayRun(admin, 'explorer_writer', routine) }).toEqual({ routine, reader: false, writer: advisory });
			for (const row of owner.rows.filter(function() {
				return(advisory);
			})) {
				expect({ routine, owner: row.owner, allowed: await mayRun(admin, row.owner, routine) }).toEqual({ routine, owner: row.owner, allowed: true });
			}
		}
	});

	test.each([
		`SELECT pg_advisory_lock(${NODE_MIGRATION_LOCK_KEY.toString()})`,
		'SELECT pg_try_advisory_xact_lock(1, 2)',
		'SELECT pg_advisory_lock_shared(1)',
		`SELECT pg_logical_emit_message(false, 'explorer', 'x')`,
		`SELECT pg_logical_emit_message(true, 'explorer', '\\x00'::bytea)`,
		`SELECT set_config('work_mem', '1GB', true)`
	])('the reader is refused %s', async function(statement) {
		const { reader } = await explorerDatabase();

		expect(await failureCodeOf(reader, statement)).toBe('42501');
	});

	test('the reader still runs its queries', async function() {
		const { reader } = await explorerDatabase();

		const counted = await reader.query<{ count: string }>('SELECT count(*) AS count FROM explorer.holdings');
		expect(counted.rows).toEqual([{ count: '0' }]);
	});

	test.each([EXPLORER_MIGRATION_LOCK_KEY, INDEXER_LOCK_KEY])('the writer takes and releases the advisory lock %s', async function(key) {
		const { writer } = await explorerDatabase();
		const client = await writer.connect();
		try {
			const taken = await client.query<{ taken: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS taken', [key.toString()]);
			const released = await client.query<{ released: boolean }>('SELECT pg_advisory_unlock($1::bigint) AS released', [key.toString()]);
			expect([taken.rows[0]?.taken, released.rows[0]?.released]).toEqual([true, true]);
		} finally {
			client.release();
		}
	});

	test('an owner of the node tables that is no superuser still runs the node\'s migrations under their lock', async function() {
		const { database, admin } = await explorerDatabase();
		await runExplorerSetup(admin, OWN_THE_NODE_TABLES);
		const owner = rolePool(inject('postgresCluster'), database, TABLE_OWNER);
		onTestFinished(function() {
			return(owner.end());
		});

		const versions = await admin.query<{ newest: number }>('SELECT max(version) AS newest FROM public.schema_version');
		expect(await applyMigrations(owner, SCHEMA_MIGRATIONS)).toBe(versions.rows[0]?.newest);
		expect(await mayRun(admin, TABLE_OWNER, 'pg_advisory_lock(bigint)')).toBe(true);
	});

	test('the setup refuses a database without the node tables, and changes nothing', async function() {
		const database = await createDatabase(inject('postgresCluster'));
		onTestFinished(function() {
			return(database.drop());
		});
		const admin = database.pool();

		await expect(runExplorerSetup(admin)).rejects.toThrow('the node\'s tables are not in the public schema of this database; run the node\'s migrations first');
		const schemas = await admin.query('SELECT FROM pg_namespace WHERE nspname = \'explorer\'');
		expect(schemas.rows).toHaveLength(0);
	});

	test('the reader cannot read the node tables', async function() {
		const { reader } = await explorerDatabase();

		expect(await failureCodeOf(reader, 'SELECT * FROM public.balances')).toBe('42501');
	});

	test('the writer reads the node tables and cannot write them', async function() {
		const { writer } = await explorerDatabase();

		await expect(writer.query('SELECT * FROM public.staples')).resolves.toBeDefined();
		expect(await failureCodeOf(writer, `INSERT INTO public.staples (blocks_hash) VALUES ('\\x00')`)).toBe('42501');
	});

	test('the reader runs read-only under its own limits', async function() {
		const { reader } = await explorerDatabase();

		const timeout = await reader.query<{ statement_timeout: string }>('SHOW statement_timeout');
		expect(timeout.rows).toEqual([{ statement_timeout: '30s' }]);
		expect(await failureCodeOf(reader, 'INSERT INTO explorer.progress DEFAULT VALUES')).toBe('25006');
	});
});
