import { afterEach, vi } from 'vitest';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { createTestNetwork, freezeClock } from '../../../testing/network.js';
import type { TestLedgerOptions, TestNetwork } from '../../../testing/network.js';
import type { LedgerStorageDriverBase } from '../base.js';
import type { DriverUnderTest } from './types.js';

export const GENESIS_MOMENT: Date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
// The key the driver base's test hooks answer to.
export const TESTING_KEY = 'ba48dff1-fc9c-4834-abc0-68434c8dc29b';
export const DEFAULT_WEIGHTS: readonly bigint[] = [400n, 300n, 300n];

export type NetworkFixture = {
	readonly network: TestNetwork;
	readonly storage: LedgerStorageDriverBase;
	readonly ledger: Ledger;
};

export type FixtureFactory = (weights?: readonly bigint[], ledgerOptions?: TestLedgerOptions) => Promise<NetworkFixture>;

/*
 * Registers cleanup for every storage instance a case creates, so a failing
 * case still releases its driver and restores the real clock.
 */
export function useFixtures(driver: DriverUnderTest): FixtureFactory {
	const created: LedgerStorageDriverBase[] = [];

	afterEach(async function() {
		vi.useRealTimers();
		const toDestroy = created.splice(0);
		for (const storage of toDestroy) {
			await driver.destroy(storage);
		}
	});

	return(async function(weights = DEFAULT_WEIGHTS, ledgerOptions = {}) {
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: weights });
		const storage = driver.create();
		created.push(storage);
		const ledger = network.createLedger(storage, requireAt(network.representatives, 0), ledgerOptions);
		return({ network, storage, ledger });
	});
}

export function requireAt<T>(values: readonly T[], index: number): T {
	const value = values[index];
	if (value === undefined) {
		throw(new Error(`missing element ${String(index)}`));
	}
	return(value);
}

export function headOf(staple: VoteStaple, account: GenericAccount): BlockHash {
	const head = staple.blocks.filter(function(block): boolean {
		return(block.account.comparePublicKey(account));
	}).at(-1);
	if (head === undefined) {
		throw(new Error(`no block for ${account.publicKeyString.get()}`));
	}
	return(head.hash);
}

export function chainLengthOf(staple: VoteStaple, account: GenericAccount): bigint {
	return(BigInt(staple.blocks.filter(function(block): boolean {
		return(block.account.comparePublicKey(account));
	}).length));
}

export function publicKeysOf(accounts: readonly (Account | GenericAccount)[]): string[] {
	return(accounts.map(function(account): string {
		return(account.publicKeyString.get());
	}));
}
