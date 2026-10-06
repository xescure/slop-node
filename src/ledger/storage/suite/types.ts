import type { LedgerStorageDriverBase } from '../base.js';

/**
 * One entry of the shared driver suite. Every driver runs the same cases, so a
 * driver is described only by how to create a fresh, empty instance and how to
 * release it afterwards. Every driver builds on the shared base, whose test
 * seams the suite may use.
 */
export type DriverUnderTest = {
	readonly name: string;
	create(): LedgerStorageDriverBase;
	destroy(storage: LedgerStorageDriverBase): Promise<void>;
};
