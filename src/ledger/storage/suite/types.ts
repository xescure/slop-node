import type { LedgerStorageDriverBase } from '../base.js';
import type { FixtureFactory } from './support.js';

/** The groups of the shared suite, one per file of cases. */
export const SUITE_GROUPS = ['transactions', 'genesis', 'confirmed', 'deferral', 'votes', 'gc', 'stats', 'stage', 'concurrency', 'canaries'] as const;

export type SuiteGroup = typeof SUITE_GROUPS[number];

/**
 * Whether other processes can open the store a driver instance keeps. A
 * process's memory serves that process alone: a second memory instance is a
 * second, empty ledger, not another process of the same node. A database
 * serves every process that connects to it, and a sibling instance on the
 * same database, with connections of its own, stands for another process of
 * the same representative.
 */
export type StoreSharing =
	| { readonly kind: 'process-local' }
	| { readonly kind: 'shared'; openSibling(storage: LedgerStorageDriverBase): Promise<LedgerStorageDriverBase> };

/**
 * One entry of the shared suite. Every driver runs the same cases, so a
 * driver is described only by how to create a fresh, empty instance and how to
 * release it afterwards. Creation may need to reach a database, so it is
 * asynchronous. Every driver builds on the shared base, whose test seams the
 * suite may use.
 */
export type DriverUnderTest = {
	readonly name: string;
	/** A sibling is released with the instance it was opened beside. */
	readonly sharing: StoreSharing;
	create(): Promise<LedgerStorageDriverBase>;
	destroy(storage: LedgerStorageDriverBase): Promise<void>;
};

/** One case of the shared suite, runnable against any driver's fixtures. */
export type SuiteCase = {
	readonly name: string;
	run(startNetwork: FixtureFactory): Promise<void>;
};
