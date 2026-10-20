import { appendFile, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, onTestFinished, test } from 'vitest';
import type pg from 'pg';
import { interceptQueries } from '../testing/query-faults.js';
import type { IssuedQuery } from '../testing/query-faults.js';
import { EXPLORER_MIGRATIONS, ExplorerMigrationError, applyExplorerMigrations } from './migrations.js';
import type { ExplorerMigrationProblem } from './migrations.js';
import { explorerDatabase } from './testing.js';

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

describe('explorer roles', function() {
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
