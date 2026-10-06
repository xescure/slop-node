import type { LedgerStorageDriverBase } from '../base.js';
import type { FixtureFactory } from './support.js';

/**
 * One entry of the shared driver suite. Every driver runs the same cases, so a
 * driver is described only by how to create a fresh, empty instance and how to
 * release it afterwards. Creation may need to reach a database, so it is
 * asynchronous. Every driver builds on the shared base, whose test seams the
 * suite may use.
 */
export type DriverUnderTest = {
	readonly name: string;
	create(): Promise<LedgerStorageDriverBase>;
	destroy(storage: LedgerStorageDriverBase): Promise<void>;
};

/** One case of the shared suite, runnable against any driver's fixtures. */
export type SuiteCase = {
	readonly name: string;
	run(startNetwork: FixtureFactory): Promise<void>;
};
