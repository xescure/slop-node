import { readdir } from 'node:fs/promises';
import { describe, expect, inject, onTestFinished, test } from 'vitest';
import { createDatabase } from './testing/postgres.js';

/*
 * The package as built, which "make test" builds first. It is imported by URL
 * so that type checking and linting never depend on a build being present.
 */
const BUILT_ENTRY = new URL('../dist/index.js', import.meta.url);

// One copy of the migrations, at the package root, serves the build and every other implementation of the schema.
const PACKAGE_MIGRATIONS = new URL('../schema/migrations/', import.meta.url);

type PackageEntry = typeof import('./index.js');

const importBuiltEntry = async function(): Promise<PackageEntry> {
	const built: unknown = await import(BUILT_ENTRY.href);
	if (typeof built !== 'object' || built === null || !('applyMigrations' in built) || typeof built.applyMigrations !== 'function') {
		throw(new Error(`${BUILT_ENTRY.href} does not export applyMigrations`));
	}
	// The build compiles this very source, so its exports have these types.
	return(built as PackageEntry);
};

describe('the built package', function() {
	test('exports the Postgres stores, the migration runner and its error', async function() {
		const built = await importBuiltEntry();

		expect(built.PostgresLedgerStorage).toBeTypeOf('function');
		expect(built.PostgresKVStorage).toBeTypeOf('function');
		expect(built.MigrationError).toBeTypeOf('function');
		expect(built.DEFAULT_POOL_OPTIONS).toMatchObject({ keepAlive: true });
	});

	test('exports the node and its error', async function() {
		const built = await importBuiltEntry();

		expect(built.LocalNode).toBeTypeOf('function');
		expect(built.LocalNodeError).toBeTypeOf('function');
	});

	test('exports the configuration from the environment, the fee policy and genesis', async function() {
		const built = await importBuiltEntry();

		expect(built.getConfigFromEnv).toBeTypeOf('function');
		expect(built.ConfigError).toBeTypeOf('function');
		expect(built.localNodeConfig).toBeTypeOf('function');
		expect(built.computeFeeFromBlocksFor).toBeTypeOf('function');
		expect(built.parseFeeSchedule('flat:1')).toEqual({ kind: 'flat', amountPerBlock: 1n });
		expect(built.addGenesis).toBeTypeOf('function');
		expect(built.getGenesisConfigFromEnv).toBeTypeOf('function');
		expect(built.GenesisError).toBeTypeOf('function');
	});

	test('migrates a fresh database from the migrations at the package root', async function() {
		const built = await importBuiltEntry();
		const database = await createDatabase(inject('postgresCluster'));
		onTestFinished(function() {
			return(database.drop());
		});
		const files = await readdir(PACKAGE_MIGRATIONS);

		expect(built.SCHEMA_MIGRATIONS.href).toBe(PACKAGE_MIGRATIONS.href);
		expect(await built.applyMigrations(database.pool(), built.SCHEMA_MIGRATIONS)).toBe(files.length);

		const newest = await database.pool().query<{ version: number }>('SELECT max(version) AS version FROM schema_version');
		expect(newest.rows).toEqual([{ version: files.length }]);
	});
});
