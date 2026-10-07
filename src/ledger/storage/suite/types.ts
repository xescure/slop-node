import type { LedgerStorageDriverBase } from '../base.js';
import type { FixtureFactory } from './support.js';

/** The groups of the shared suite, one per file of cases. */
export const SUITE_GROUPS = ['transactions', 'genesis', 'confirmed', 'deferral', 'votes', 'gc', 'stats', 'concurrency', 'canaries'] as const;

export type SuiteGroup = typeof SUITE_GROUPS[number];

/**
 * One entry of the shared suite. Every driver runs the same cases, so a
 * driver is described only by how to create a fresh, empty instance and how to
 * release it afterwards. Creation may need to reach a database, so it is
 * asynchronous. Every driver builds on the shared base, whose test seams the
 * suite may use.
 */
export type DriverUnderTest = {
	readonly name: string;
	/** Every group, or, while the driver is still being built, the groups whose members it implements. */
	readonly groups: 'all' | readonly SuiteGroup[];
	create(): Promise<LedgerStorageDriverBase>;
	destroy(storage: LedgerStorageDriverBase): Promise<void>;
};

/** One case of the shared suite, runnable against any driver's fixtures. */
export type SuiteCase = {
	readonly name: string;
	run(startNetwork: FixtureFactory): Promise<void>;
};
