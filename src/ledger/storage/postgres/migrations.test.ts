import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, inject, onTestFinished, test } from 'vitest';
import type pg from 'pg';
import { createDatabase } from '../../../testing/postgres.js';
import type { TestDatabase } from '../../../testing/postgres.js';
import { MigrationError, SCHEMA_MIGRATIONS, applyMigrations } from './migrations.js';
import type { MigrationProblem } from './migrations.js';

const FIRST_START = new Date('2026-10-07T12:00:00.000Z');
const SECOND_START = new Date('2026-10-08T12:00:00.000Z');

const FIRST = 'CREATE TABLE first_probe (id integer PRIMARY KEY);\n';
const SECOND = 'CREATE TABLE second_probe (id integer PRIMARY KEY);\nINSERT INTO second_probe (id) VALUES (1);\n';
const THIRD = 'CREATE TABLE third_probe (id integer PRIMARY KEY);\n';

type MigrationFiles = Readonly<Record<string, string>>;

const TWO_MIGRATIONS: MigrationFiles = {
	'0001_first.sql': FIRST,
	'0002_second.sql': SECOND
};

type VersionRow = { version: number; sha256: Buffer; applied_at: Date };

const clockAt = function(moment: Date): () => Date {
	return(function() {
		return(moment);
	});
};

const sha256 = function(content: string): Buffer {
	return(createHash('sha256').update(content, 'utf-8').digest());
};

const freshDatabase = async function(): Promise<TestDatabase> {
	const database = await createDatabase(inject('postgresCluster'));
	onTestFinished(function() {
		return(database.drop());
	});
	return(database);
};

const migrationDirectory = async function(files: MigrationFiles): Promise<URL> {
	const directory = await mkdtemp(join(tmpdir(), 'slop-migrations-'));
	onTestFinished(function() {
		return(rm(directory, { recursive: true, force: true }));
	});
	for (const [name, content] of Object.entries(files)) {
		await writeFile(join(directory, name), content);
	}
	return(pathToFileURL(`${directory}/`));
};

const versionRows = async function(pool: pg.Pool): Promise<VersionRow[]> {
	const result = await pool.query<VersionRow>('SELECT version, sha256, applied_at FROM schema_version ORDER BY version');
	return(result.rows);
};

const tableExists = async function(pool: pg.Pool, table: string): Promise<boolean> {
	const result = await pool.query<{ found: boolean }>('SELECT to_regclass($1) IS NOT NULL AS found', [table]);
	return(result.rows[0]?.found === true);
};

const advisoryLockCount = async function(pool: pg.Pool): Promise<number> {
	const result = await pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory'");
	return(result.rows[0]?.count ?? -1);
};

const refusalOf = async function(attempt: Promise<unknown>): Promise<MigrationProblem> {
	const error = await attempt.then(function() {
		return(undefined);
	}, function(reason: unknown) {
		return(reason);
	});
	if (!(error instanceof MigrationError)) {
		throw(new Error(`expected a MigrationError, got ${String(error)}`));
	}
	return(error.problem);
};

describe('applyMigrations', function() {
	test('migrations apply once and record each file\'s digest', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const directory = await migrationDirectory(TWO_MIGRATIONS);

		expect(await applyMigrations(pool, directory, clockAt(FIRST_START))).toBe(2);

		expect(await versionRows(pool)).toEqual([
			{ version: 1, sha256: sha256(FIRST), applied_at: FIRST_START },
			{ version: 2, sha256: sha256(SECOND), applied_at: FIRST_START }
		]);
		expect(await tableExists(pool, 'first_probe')).toBe(true);
		expect(await tableExists(pool, 'second_probe')).toBe(true);
	});

	test('the shipped migrations apply to an empty database', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const files = (await readdir(SCHEMA_MIGRATIONS)).sort();

		expect(files.length).toBeGreaterThan(0);
		expect(await applyMigrations(pool, SCHEMA_MIGRATIONS, clockAt(FIRST_START))).toBe(files.length);

		const digests = await Promise.all(files.map(async function(file) {
			return(createHash('sha256').update(await readFile(new URL(file, SCHEMA_MIGRATIONS))).digest());
		}));
		expect((await versionRows(pool)).map(function(row) {
			return(row.sha256);
		})).toEqual(digests);
	});

	test('migrations re-run as a no-op', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const directory = await migrationDirectory(TWO_MIGRATIONS);
		await applyMigrations(pool, directory, clockAt(FIRST_START));
		const before = await versionRows(pool);

		// The files are not idempotent: applying either again would fail.
		expect(await applyMigrations(pool, directory, clockAt(SECOND_START))).toBe(2);

		expect(await versionRows(pool)).toEqual(before);
	});

	test('a later build applies only the files it adds', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		await applyMigrations(pool, await migrationDirectory(TWO_MIGRATIONS), clockAt(FIRST_START));

		const later = await migrationDirectory({ ...TWO_MIGRATIONS, '0003_third.sql': THIRD });
		expect(await applyMigrations(pool, later, clockAt(SECOND_START))).toBe(3);

		expect((await versionRows(pool)).map(function(row) {
			return([row.version, row.applied_at]);
		})).toEqual([[1, FIRST_START], [2, FIRST_START], [3, SECOND_START]]);
	});

	test('concurrent starts migrate exactly once', async function() {
		const database = await freshDatabase();
		const directory = await migrationDirectory({ ...TWO_MIGRATIONS, '0003_third.sql': THIRD });
		const pools = Array.from({ length: 8 }, function() {
			return(database.pool());
		});

		const versions = await Promise.all(pools.map(function(pool) {
			return(applyMigrations(pool, directory, clockAt(FIRST_START)));
		}));

		expect(versions).toEqual(Array.from({ length: 8 }, function() {
			return(3);
		}));
		const pool = database.pool();
		expect((await versionRows(pool)).map(function(row) {
			return(row.version);
		})).toEqual([1, 2, 3]);
		expect(await advisoryLockCount(pool)).toBe(0);
	});

	test('a database at an unknown version is refused', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		await applyMigrations(pool, await migrationDirectory(TWO_MIGRATIONS), clockAt(FIRST_START));
		const before = await versionRows(pool);

		const older = await migrationDirectory({ '0001_first.sql': FIRST });
		const attempt = applyMigrations(pool, older, clockAt(SECOND_START));

		await expect(attempt).rejects.toThrow(/version 2/);
		expect(await refusalOf(attempt)).toEqual({ kind: 'unknown-version', version: 2, newestKnown: 1 });
		expect(await versionRows(pool)).toEqual(before);
		expect(await advisoryLockCount(pool)).toBe(0);
	});

	test('an edited migration is refused', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		await applyMigrations(pool, await migrationDirectory(TWO_MIGRATIONS), clockAt(FIRST_START));
		const before = await versionRows(pool);

		const edited = await migrationDirectory({
			'0001_first.sql': `${FIRST}-- edited after it was applied\n`,
			'0002_second.sql': SECOND,
			'0003_third.sql': THIRD
		});
		const attempt = applyMigrations(pool, edited, clockAt(SECOND_START));

		await expect(attempt).rejects.toThrow(/version 1/);
		expect(await refusalOf(attempt)).toEqual({
			kind: 'edited',
			version: 1,
			recordedSHA256: sha256(FIRST).toString('hex'),
			fileSHA256: sha256(`${FIRST}-- edited after it was applied\n`).toString('hex')
		});
		expect(await versionRows(pool)).toEqual(before);
		expect(await tableExists(pool, 'third_probe')).toBe(false);
		expect(await advisoryLockCount(pool)).toBe(0);
	});

	test('a database without the record of an earlier version is refused', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const directory = await migrationDirectory(TWO_MIGRATIONS);
		await applyMigrations(pool, directory, clockAt(FIRST_START));
		await pool.query('DELETE FROM schema_version WHERE version = 1');

		expect(await refusalOf(applyMigrations(pool, directory, clockAt(SECOND_START)))).toEqual({ kind: 'missing-record', version: 1 });
		expect(await advisoryLockCount(pool)).toBe(0);
	});

	test('a failing migration leaves nothing of itself behind', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const directory = await migrationDirectory({
			'0001_first.sql': FIRST,
			'0002_broken.sql': 'CREATE TABLE broken_probe (id integer);\nSELECT no_such_column FROM broken_probe;\n'
		});

		const attempt = applyMigrations(pool, directory, clockAt(FIRST_START));

		await expect(attempt).rejects.toThrow(/version 2/);
		expect(await refusalOf(attempt)).toEqual({ kind: 'failed', version: 2 });
		expect((await versionRows(pool)).map(function(row) {
			return(row.version);
		})).toEqual([1]);
		expect(await tableExists(pool, 'broken_probe')).toBe(false);
		expect(await advisoryLockCount(pool)).toBe(0);
	});

	test('a directory that skips a version is refused', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const directory = await migrationDirectory({ '0001_first.sql': FIRST, '0003_third.sql': THIRD });

		expect(await refusalOf(applyMigrations(pool, directory, clockAt(FIRST_START)))).toEqual({ kind: 'missing-file', version: 2 });
		expect(await tableExists(pool, 'first_probe')).toBe(false);
	});

	test('a file not named as a migration is refused', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const notes = await migrationDirectory({ '0001_first.sql': FIRST, 'notes.txt': 'not a migration\n' });
		const zero = await migrationDirectory({ '0000_zero.sql': FIRST });

		expect(await refusalOf(applyMigrations(pool, notes, clockAt(FIRST_START)))).toEqual({ kind: 'invalid-file-name', fileName: 'notes.txt' });
		expect(await refusalOf(applyMigrations(pool, zero, clockAt(FIRST_START)))).toEqual({ kind: 'invalid-file-name', fileName: '0000_zero.sql' });
	});
});
