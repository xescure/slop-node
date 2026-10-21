import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';
import { assertNever } from '../util/assert-never.js';

/** The number of an explorer migration, and of the newest one a database has applied. */
export type ExplorerSchemaVersion = number & { readonly __explorerSchemaVersion: never };

/** The explorer migrations this build ships. */
export const EXPLORER_MIGRATIONS: URL = new URL('../../schema/explorer/migrations/', import.meta.url);

/*
 * Every explorer process takes this session lock to migrate, so that
 * processes starting together apply each migration once. It differs from the
 * node's key, keetaldg, so that the explorer never waits on the node's
 * migrations nor the node on the explorer's.
 */
const MIGRATION_LOCK_KEY = 0x6b65657461657870n;

const MIGRATION_FILE_NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export type ExplorerMigrationProblem =
	| { readonly kind: 'unreadable-directory'; readonly directory: string }
	| { readonly kind: 'no-migrations'; readonly directory: string }
	| { readonly kind: 'invalid-file-name'; readonly fileName: string }
	| { readonly kind: 'invalid-file'; readonly fileName: string }
	| { readonly kind: 'duplicate-file'; readonly version: ExplorerSchemaVersion }
	| { readonly kind: 'missing-file'; readonly version: ExplorerSchemaVersion }
	| { readonly kind: 'no-schema' }
	| { readonly kind: 'unknown-version'; readonly version: ExplorerSchemaVersion; readonly newestKnown: ExplorerSchemaVersion }
	| { readonly kind: 'missing-record'; readonly version: ExplorerSchemaVersion }
	| { readonly kind: 'edited'; readonly version: ExplorerSchemaVersion; readonly recordedSHA256: string; readonly fileSHA256: string }
	| { readonly kind: 'failed'; readonly version: ExplorerSchemaVersion };

const describeProblem = function(problem: ExplorerMigrationProblem): string {
	switch (problem.kind) {
		case 'unreadable-directory':
			return(`cannot list the explorer migrations in ${problem.directory}`);
		case 'no-migrations':
			return(`no explorer migrations in ${problem.directory}`);
		case 'invalid-file-name':
			return(`${problem.fileName} is not named NNNN_<name>.sql`);
		case 'invalid-file':
			return(`the explorer migration ${problem.fileName} is not valid UTF-8`);
		case 'duplicate-file':
			return(`more than one file is explorer migration version ${String(problem.version)}`);
		case 'missing-file':
			return(`no file is explorer migration version ${String(problem.version)}, though later versions exist`);
		case 'no-schema':
			return('the database has no explorer schema; run schema/explorer/setup.sql as a superuser first');
		case 'unknown-version':
			return(`the database is at explorer schema version ${String(problem.version)}, newer than the newest this build knows, ${String(problem.newestKnown)}`);
		case 'missing-record':
			return(`the database has no record of explorer schema version ${String(problem.version)}, though it records later versions`);
		case 'edited':
			return(`explorer migration version ${String(problem.version)} was applied with sha256 ${problem.recordedSHA256}, but the file now has sha256 ${problem.fileSHA256}`);
		case 'failed':
			return(`applying explorer migration version ${String(problem.version)} failed`);
		default:
			return(assertNever(problem));
	}
};

/** A refusal to migrate, or a migration that failed; the database is left as it was before that migration. */
export class ExplorerMigrationError extends Error {
	readonly problem: ExplorerMigrationProblem;

	constructor(problem: ExplorerMigrationProblem, options?: ErrorOptions) {
		super(describeProblem(problem), options);
		this.name = 'ExplorerMigrationError';
		this.problem = problem;
	}
}

type Migration = {
	readonly version: ExplorerSchemaVersion;
	readonly sql: string;
	readonly sha256: Buffer;
};

type VersionRecord = {
	readonly version: number;
	readonly sha256: Buffer;
};

const toSchemaVersion = function(value: number): ExplorerSchemaVersion {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw(new Error(`internal error: ${String(value)} is not an explorer schema version`));
	}
	// The brand marks a positive integer.
	return(value as ExplorerSchemaVersion);
};

const asDirectory = function(directory: URL): URL {
	if (directory.pathname.endsWith('/')) {
		return(directory);
	}
	return(new URL(`${directory.href}/`));
};

// A migration that is not valid UTF-8 would be applied as something other
// than the bytes its digest records.
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const listDirectory = async function(base: URL): Promise<Dirent[]> {
	try {
		return(await readdir(base, { withFileTypes: true }));
	} catch (error: unknown) {
		throw(new ExplorerMigrationError({ kind: 'unreadable-directory', directory: base.href }, { cause: error }));
	}
};

const decodeMigrationFile = function(fileName: string, bytes: Buffer): string {
	try {
		return(UTF8.decode(bytes));
	} catch (error: unknown) {
		throw(new ExplorerMigrationError({ kind: 'invalid-file', fileName }, { cause: error }));
	}
};

const loadMigrations = async function(directory: URL): Promise<readonly Migration[]> {
	const base = asDirectory(directory);
	const migrations: Migration[] = [];
	for (const entry of await listDirectory(base)) {
		const number = Number(MIGRATION_FILE_NAME.exec(entry.name)?.[1]);
		if (!entry.isFile() || !(number >= 1)) {
			throw(new ExplorerMigrationError({ kind: 'invalid-file-name', fileName: entry.name }));
		}
		const bytes = await readFile(new URL(entry.name, base));
		migrations.push({
			version: toSchemaVersion(number),
			sql: decodeMigrationFile(entry.name, bytes),
			sha256: createHash('sha256').update(bytes).digest()
		});
	}
	migrations.sort(function(left, right) {
		return(left.version - right.version);
	});
	if (migrations.length === 0) {
		throw(new ExplorerMigrationError({ kind: 'no-migrations', directory: base.href }));
	}
	for (const [index, migration] of migrations.entries()) {
		const expected = toSchemaVersion(index + 1);
		if (migration.version < expected) {
			throw(new ExplorerMigrationError({ kind: 'duplicate-file', version: migration.version }));
		}
		if (migration.version > expected) {
			throw(new ExplorerMigrationError({ kind: 'missing-file', version: expected }));
		}
	}
	return(migrations);
};

/**
 * The migrations the database has yet to apply, after checking that what it
 * has applied is exactly this build's first migrations, byte for byte.
 */
const pendingMigrations = function(migrations: readonly Migration[], records: readonly VersionRecord[]): readonly Migration[] {
	const newestKnown = toSchemaVersion(migrations.length);
	const newestRecorded = records.at(-1);
	if (newestRecorded !== undefined && newestRecorded.version > newestKnown) {
		throw(new ExplorerMigrationError({ kind: 'unknown-version', version: toSchemaVersion(newestRecorded.version), newestKnown }));
	}
	for (const [index, record] of records.entries()) {
		const migration = migrations[index];
		if (migration === undefined || record.version !== migration.version) {
			throw(new ExplorerMigrationError({ kind: 'missing-record', version: toSchemaVersion(index + 1) }));
		}
		if (!record.sha256.equals(migration.sha256)) {
			throw(new ExplorerMigrationError({
				kind: 'edited',
				version: migration.version,
				recordedSHA256: record.sha256.toString('hex'),
				fileSHA256: migration.sha256.toString('hex')
			}));
		}
	}
	return(migrations.slice(records.length));
};

const applyMigration = async function(client: pg.PoolClient, migration: Migration): Promise<void> {
	await client.query('BEGIN');
	try {
		await client.query(migration.sql);
		await client.query('INSERT INTO explorer.schema_version (version, sha256, applied_at) VALUES ($1, $2, $3)', [migration.version, migration.sha256, new Date()]);
		await client.query('COMMIT');
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(function() {
			// A session that cannot roll back cannot unlock either, so
			// releaseLock closes it, which rolls back as well.
		});
		throw(new ExplorerMigrationError({ kind: 'failed', version: migration.version }, { cause: error }));
	}
};

const migrateLocked = async function(client: pg.PoolClient, migrations: readonly Migration[]): Promise<ExplorerSchemaVersion> {
	// The schema is the one thing the setup makes that a migration needs; the
	// writer, which migrates, cannot create it with the owner it must have.
	const schema = await client.query<{ present: boolean }>(`SELECT to_regnamespace('explorer') IS NOT NULL AS present`);
	if (schema.rows[0]?.present !== true) {
		throw(new ExplorerMigrationError({ kind: 'no-schema' }));
	}
	// The lock covers creating this table too, so concurrent first starts
	// never race to create it.
	await client.query(`CREATE TABLE IF NOT EXISTS explorer.schema_version (
		version integer PRIMARY KEY,
		sha256 bytea NOT NULL,
		applied_at timestamptz NOT NULL
	)`);
	const records = await client.query<VersionRecord>('SELECT version, sha256 FROM explorer.schema_version ORDER BY version');
	for (const migration of pendingMigrations(migrations, records.rows)) {
		await applyMigration(client, migration);
	}
	return(toSchemaVersion(migrations.length));
};

/**
 * Unlocks, gives the session back its own statement timeout, and returns the
 * connection to the pool, or, if the session cannot do both, closes it:
 * closing a session releases its locks and rolls back its transaction.
 */
const releaseLock = async function(client: pg.PoolClient): Promise<void> {
	let unlocked = true;
	try {
		await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY.toString()]);
		await client.query('RESET statement_timeout');
	} catch {
		unlocked = false;
	}
	// A closed connection keeps listening: the server that ended it may still
	// report the loss of its socket, and the pool no longer holds it.
	if (unlocked) {
		client.removeListener('error', ignoreConnectionError);
	}
	client.release(!unlocked);
};

/*
 * pg reports a connection lost while a client is checked out as an event,
 * which would end the process without a listener; the failing statement
 * reports it instead.
 */
const ignoreConnectionError = function(): void {
	// The failing statement carries the error.
};

/**
 * Brings the explorer schema up to the newest migration in the directory,
 * applying each pending file in a transaction of its own under the explorer's
 * migration lock, and returns the version the schema is then at. It refuses
 * a database that has applied a version this build does not know or a file
 * that has changed since it was applied.
 */
export const applyExplorerMigrations = async function(pool: pg.Pool, directory: URL = EXPLORER_MIGRATIONS): Promise<ExplorerSchemaVersion> {
	const migrations = await loadMigrations(directory);
	const client = await pool.connect();
	client.on('error', ignoreConnectionError);
	let version: ExplorerSchemaVersion;
	try {
		// Waiting for another process's migration, and a migration itself, may
		// rightly take longer than any one statement.
		await client.query('SET statement_timeout = 0');
		await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY.toString()]);
		version = await migrateLocked(client, migrations);
	} catch (error: unknown) {
		await releaseLock(client);
		throw(error);
	}
	await releaseLock(client);
	return(version);
};
