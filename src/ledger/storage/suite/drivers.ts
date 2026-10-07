import { inject } from 'vitest';
import { createDatabase } from '../../../testing/postgres.js';
import type { TestDatabase } from '../../../testing/postgres.js';
import type { LedgerStorageDriverBase } from '../base.js';
import { MemoryLedgerStorage } from '../memory/driver.js';
import { PostgresLedgerStorage } from '../postgres/driver.js';
import type { DriverUnderTest, SuiteGroup } from './types.js';

type PostgresInstance = {
	readonly storage: PostgresLedgerStorage;
	readonly database: TestDatabase;
	readonly siblings: PostgresLedgerStorage[];
};

const postgresInstances = new WeakMap<LedgerStorageDriverBase, PostgresInstance>();

const postgresInstanceOf = function(storage: LedgerStorageDriverBase): PostgresInstance {
	const instance = postgresInstances.get(storage);
	if (instance === undefined) {
		throw(new Error('this storage was not created by the postgres entry'));
	}
	return(instance);
};

const openPostgresStorage = function(database: TestDatabase): PostgresLedgerStorage {
	return(new PostgresLedgerStorage({ kind: 'connection-string', connectionString: database.connectionString }));
};

/** Every driver the shared suite and the conformance corpus run against. */
export const driversUnderTest: readonly DriverUnderTest[] = [
	{
		name: 'memory',
		groups: 'all',
		sharing: { kind: 'process-local' },
		create: function(): Promise<LedgerStorageDriverBase> {
			return(Promise.resolve(new MemoryLedgerStorage()));
		},
		destroy: function(): Promise<void> {
			return(Promise.resolve());
		}
	},
	{
		name: 'postgres',
		groups: 'all',
		sharing: {
			kind: 'shared',
			openSibling: function(storage: LedgerStorageDriverBase): Promise<LedgerStorageDriverBase> {
				const instance = postgresInstanceOf(storage);
				const sibling = openPostgresStorage(instance.database);
				instance.siblings.push(sibling);
				return(Promise.resolve(sibling));
			}
		},
		// Each instance is a fresh database copied from the migrated template, dropped with it.
		create: async function(): Promise<LedgerStorageDriverBase> {
			const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
			const storage = openPostgresStorage(database);
			postgresInstances.set(storage, { storage, database, siblings: [] });
			return(storage);
		},
		destroy: async function(created: LedgerStorageDriverBase): Promise<void> {
			const instance = postgresInstanceOf(created);
			postgresInstances.delete(created);
			for (const sibling of instance.siblings.splice(0)) {
				await sibling.destroy();
			}
			await instance.storage.destroy();
			await instance.database.drop();
		}
	}
];

export function runsGroup(driver: DriverUnderTest, group: SuiteGroup): boolean {
	if (driver.groups === 'all') {
		return(true);
	}
	return(driver.groups.includes(group));
}

/**
 * The corpus replays whole ledger histories, which reach every member, so it
 * runs only on drivers that run every group.
 */
export const completeDriversUnderTest: readonly DriverUnderTest[] = driversUnderTest.filter(function(driver): boolean {
	return(driver.groups === 'all');
});
