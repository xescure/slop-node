import type { LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';

/**
 * One entry of the shared driver suite. Every driver runs the same cases, so a
 * driver is described only by how to create a fresh, empty instance and how to
 * release it afterwards.
 */
export type DriverUnderTest = {
	readonly name: string;
	create(): LedgerStorageAPI;
	destroy(storage: LedgerStorageAPI): Promise<void>;
};
