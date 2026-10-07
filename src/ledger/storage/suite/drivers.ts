import { PostgresInstances } from '../../../testing/postgres-instances.js';
import type { LedgerStorageDriverBase } from '../base.js';
import { MemoryLedgerStorage } from '../memory/driver.js';
import { PostgresLedgerStorage } from '../postgres/driver.js';
import type { DriverUnderTest } from './types.js';

const postgresInstances = new PostgresInstances(function(database): PostgresLedgerStorage {
	return(new PostgresLedgerStorage({ kind: 'connection-string', connectionString: database.connectionString }));
});

/** Every driver the shared suite and the conformance corpus run against. */
export const driversUnderTest: readonly DriverUnderTest[] = [
	{
		name: 'memory',
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
		sharing: {
			kind: 'shared',
			openSibling: function(storage: LedgerStorageDriverBase): Promise<LedgerStorageDriverBase> {
				return(Promise.resolve(postgresInstances.openSibling(storage)));
			}
		},
		create: function(): Promise<LedgerStorageDriverBase> {
			return(postgresInstances.create());
		},
		destroy: function(storage: LedgerStorageDriverBase): Promise<void> {
			return(postgresInstances.destroy(storage));
		}
	}
];

/** The driver under test of that name; a test that runs one driver alone looks it up by name. */
export function driverUnderTestNamed(name: string): DriverUnderTest {
	const driver = driversUnderTest.find(function(candidate): boolean {
		return(candidate.name === name);
	});
	if (driver === undefined) {
		throw(new Error(`the ${name} driver is not under test`));
	}
	return(driver);
}
