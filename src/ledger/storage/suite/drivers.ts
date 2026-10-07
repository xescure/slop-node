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
};

const postgresInstances = new WeakMap<LedgerStorageDriverBase, PostgresInstance>();

/** Every driver the shared suite and the conformance corpus run against. */
export const driversUnderTest: readonly DriverUnderTest[] = [
	{
		name: 'memory',
		groups: 'all',
		create: function(): Promise<LedgerStorageDriverBase> {
			return(Promise.resolve(new MemoryLedgerStorage()));
		},
		destroy: function(): Promise<void> {
			return(Promise.resolve());
		}
	},
	{
		name: 'postgres',
		groups: ['transactions', 'genesis'],
		// Each instance is a fresh database copied from the migrated template, dropped with it.
		create: async function(): Promise<LedgerStorageDriverBase> {
			const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
			const storage = new PostgresLedgerStorage({ kind: 'connection-string', connectionString: database.connectionString });
			postgresInstances.set(storage, { storage, database });
			return(storage);
		},
		destroy: async function(created: LedgerStorageDriverBase): Promise<void> {
			const instance = postgresInstances.get(created);
			if (instance === undefined) {
				throw(new Error('this storage was not created by the postgres entry'));
			}
			postgresInstances.delete(created);
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
