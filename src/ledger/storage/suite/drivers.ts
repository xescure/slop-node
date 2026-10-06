import type { LedgerStorageDriverBase } from '../base.js';
import { MemoryLedgerStorage } from '../memory/driver.js';
import type { DriverUnderTest } from './types.js';

/** Every driver the shared suite and the conformance corpus run against. */
export const driversUnderTest: readonly DriverUnderTest[] = [
	{
		name: 'memory',
		create: function(): Promise<LedgerStorageDriverBase> {
			return(Promise.resolve(new MemoryLedgerStorage()));
		},
		destroy: function(): Promise<void> {
			return(Promise.resolve());
		}
	}
];
