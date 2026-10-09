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

type MigrationFiles = Readonly<Record<string, string | Buffer>>;

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
	// pg_locks spans the cluster, where other tests migrate their own databases at the same time.
	const result = await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM pg_locks
		WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
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

	test('version 6 lists for gc the deferred staples already released or dead, and history keeps its rows through version 5', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const shipped = (await readdir(SCHEMA_MIGRATIONS)).sort();
		const beforeChecks: Record<string, Buffer> = {};
		for (const file of shipped.filter(function(name) {
			return(name < '0006');
		})) {
			beforeChecks[file] = await readFile(new URL(file, SCHEMA_MIGRATIONS));
		}
		expect(await applyMigrations(pool, await migrationDirectory(beforeChecks), clockAt(FIRST_START))).toBe(5);
		const hash = function(label: string): string {
			return(`sha256(convert_to('${label}', 'UTF8'))`);
		};
		await pool.query('INSERT INTO accounts (public_key, key_type) VALUES (\'keeta_migrated\', 0)');
		await pool.query(`INSERT INTO staples (blocks_hash, staple_time, moment) VALUES (${hash('main staple')}, $1, $1)`, [FIRST_START]);
		await pool.query(`INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
			SELECT ${hash('arrived')}, 'main', id, ${hash('contested')}, 1, '\\x00', ${hash('main staple')}, 0 FROM accounts`);
		await pool.query(`INSERT INTO history (account_id, blocks_hash, staple_time) SELECT id, ${hash('main staple')}, $1 FROM accounts`, [FIRST_START]);
		// Released: it waits only on a block on main. Dead: one of its blocks competes with that block. Waiting: neither.
		for (const [staple, awaited, previous] of [['released', 'arrived', 'free'], ['dead', 'missing', 'contested'], ['waiting', 'missing', 'free']] as const) {
			await pool.query(`INSERT INTO deferred_staples (blocks_hash, bytes, latest_vote_from) VALUES (${hash(staple)}, '\\x00', $1)`, [FIRST_START]);
			await pool.query(`INSERT INTO deferred_waits (block_hash, blocks_hash) VALUES (${hash(awaited)}, ${hash(staple)})`);
			await pool.query(`INSERT INTO deferred_blocks (blocks_hash, previous) VALUES (${hash(staple)}, ${hash(previous)})`);
		}

		expect(await applyMigrations(pool, SCHEMA_MIGRATIONS, clockAt(SECOND_START))).toBe(shipped.length);

		const listed = await pool.query<{ blocks_hash: Buffer }>('SELECT blocks_hash FROM deferred_checks ORDER BY blocks_hash');
		const expected = await pool.query<{ blocks_hash: Buffer }>(`SELECT blocks_hash FROM deferred_staples WHERE blocks_hash IN (${hash('released')}, ${hash('dead')}) ORDER BY blocks_hash`);
		expect(listed.rows).toEqual(expected.rows);
		expect(listed.rows).toHaveLength(2);
		const history = await pool.query<{ staple_time: Date }>('SELECT staple_time FROM history');
		expect(history.rows).toEqual([{ staple_time: FIRST_START }]);
	});

	test('version 7 gives each staple the XOR of its blocks\' hashes, which the ledger checksum folds, and drops the statistic that held it', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const shipped = (await readdir(SCHEMA_MIGRATIONS)).sort();
		const beforeChecksums: Record<string, Buffer> = {};
		for (const file of shipped.filter(function(name) {
			return(name < '0007');
		})) {
			beforeChecksums[file] = await readFile(new URL(file, SCHEMA_MIGRATIONS));
		}
		expect(await applyMigrations(pool, await migrationDirectory(beforeChecksums), clockAt(FIRST_START))).toBe(6);
		const hash = function(label: string): string {
			return(`sha256(convert_to('${label}', 'UTF8'))`);
		};
		await pool.query('INSERT INTO accounts (public_key, key_type) VALUES (\'keeta_migrated\', 0)');
		for (const [staple, blocks] of [['first', ['a', 'b']], ['second', ['c']]] as const) {
			await pool.query(`INSERT INTO staples (blocks_hash, staple_time, moment) VALUES (${hash(staple)}, $1, $1)`, [FIRST_START]);
			for (const [position, block] of blocks.entries()) {
				await pool.query(`INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
					SELECT ${hash(block)}, 'main', id, ${hash(`before ${block}`)}, 1, '\\x00', ${hash(staple)}, $1 FROM accounts`, [position]);
			}
		}
		await pool.query('INSERT INTO kv_buffers (key, value) VALUES (\'@buffer:ledgerChecksum\', \'\\x01\'), (\'@buffer:other\', \'\\x02\')');

		expect(await applyMigrations(pool, SCHEMA_MIGRATIONS, clockAt(SECOND_START))).toBe(shipped.length);

		const hashes = await pool.query<{ label: string; hash: Buffer }>(`SELECT label, sha256(convert_to(label, 'UTF8')) AS hash FROM unnest(ARRAY['a', 'b', 'c']) AS label`);
		const bits = new Map(hashes.rows.map(function(row): [string, bigint] {
			return([row.label, BigInt(`0x${row.hash.toString('hex')}`)]);
		}));
		const checksums = await pool.query<{ checksum: string }>(`SELECT checksum::text FROM staples ORDER BY blocks_hash = ${hash('second')}`);
		expect(checksums.rows.map(function(row): bigint {
			return(BigInt(`0b${row.checksum}`));
		})).toEqual([(bits.get('a') ?? 0n) ^ (bits.get('b') ?? 0n), bits.get('c')]);
		const buffers = await pool.query<{ key: string }>('SELECT key FROM kv_buffers ORDER BY key');
		expect(buffers.rows).toEqual([{ key: '@buffer:other' }]);
	});

	test('versions 8 and 9 keep the ledger checksum folded from the staples\' checksums, in a row per first byte of their blocks hashes', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const shipped = (await readdir(SCHEMA_MIGRATIONS)).sort();
		const beforeChecksums: Record<string, Buffer> = {};
		for (const file of shipped.filter(function(name) {
			return(name < '0008');
		})) {
			beforeChecksums[file] = await readFile(new URL(file, SCHEMA_MIGRATIONS));
		}
		expect(await applyMigrations(pool, await migrationDirectory(beforeChecksums), clockAt(FIRST_START))).toBe(7);
		// Two staples whose blocks hashes begin with 0x0A, one with 0xFF.
		const staples: readonly (readonly [string, string])[] = [['0a01', '11'], ['0a02', '22'], ['ff03', '44']];
		for (const [hashStart, checksum] of staples) {
			await pool.query('INSERT INTO staples (blocks_hash, staple_time, moment, checksum) VALUES ($1, $2, $2, (\'x\' || $3)::bit(256))', [Buffer.from(hashStart.padEnd(64, '0'), 'hex'), FIRST_START, checksum.repeat(32)]);
		}

		expect(await applyMigrations(pool, SCHEMA_MIGRATIONS, clockAt(SECOND_START))).toBe(shipped.length);

		const rows = await pool.query<{ shard: number; checksum: string }>('SELECT shard, checksum::text FROM ledger_checksum ORDER BY shard');
		expect(rows.rows).toHaveLength(256);
		const nonZero = rows.rows.flatMap(function(row): [number, string][] {
			const value = BigInt(`0b${row.checksum}`);
			if (value === 0n) {
				return([]);
			}
			return([[row.shard, value.toString(16)]]);
		});
		expect(nonZero).toEqual([[0x0a, '33'.repeat(32)], [0xff, '44'.repeat(32)]]);
		// Version 9 keeps the rows, on pages filled to a tenth.
		const options = await pool.query<{ reloptions: string[] | null }>('SELECT reloptions FROM pg_class WHERE relname = \'ledger_checksum\'');
		expect(options.rows).toEqual([{ reloptions: ['fillfactor=10'] }]);
	});

	test('a migration runs without the session\'s statement timeout, which the session gets back afterwards', async function() {
		const database = await freshDatabase();
		// One connection, so the setting read afterwards is the migrating session's.
		const pool = database.pool({ max: 1, statement_timeout: 100 });
		const directory = await migrationDirectory({ '0001_slow.sql': 'SELECT pg_sleep(0.3);\n' });

		expect(await applyMigrations(pool, directory, clockAt(FIRST_START))).toBe(1);

		const setting = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
		expect(setting.rows).toEqual([{ statement_timeout: '100ms' }]);
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

	test('two files with one migration number are refused', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const directory = await migrationDirectory({ '0001_first.sql': FIRST, '0001_third.sql': THIRD });

		expect(await refusalOf(applyMigrations(pool, directory, clockAt(FIRST_START)))).toEqual({ kind: 'duplicate-file', version: 1 });
		expect(await tableExists(pool, 'first_probe')).toBe(false);
		expect(await tableExists(pool, 'third_probe')).toBe(false);
	});

	test('a missing migration directory is refused', async function() {
		const database = await freshDatabase();
		const parent = await migrationDirectory({});
		const absent = new URL('absent/', parent);

		const attempt = applyMigrations(database.pool(), absent, clockAt(FIRST_START));

		expect(await refusalOf(attempt)).toEqual({ kind: 'unreadable-directory', directory: absent.href });
		await expect(attempt).rejects.toMatchObject({ cause: { code: 'ENOENT' } });
	});

	test('a migration that is not UTF-8 is refused before anything applies', async function() {
		const database = await freshDatabase();
		const pool = database.pool();
		const directory = await migrationDirectory({
			'0001_first.sql': FIRST,
			'0002_binary.sql': Buffer.from([0x53, 0xff, 0x0a])
		});

		expect(await refusalOf(applyMigrations(pool, directory, clockAt(FIRST_START)))).toEqual({ kind: 'invalid-file', fileName: '0002_binary.sql' });
		expect(await tableExists(pool, 'first_probe')).toBe(false);
	});
});
