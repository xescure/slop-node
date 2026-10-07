import type { KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import { afterEach, vi } from 'vitest';
import type { KVProviderUnderTest } from './types.js';

export const START_MOMENT: Date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

export type StoreFactory = () => Promise<KVStorageProviderAPI>;

/*
 * Registers cleanup for every store a case opens, so a failing case still
 * releases its store and restores the real clock.
 */
export function useStores(provider: KVProviderUnderTest): StoreFactory {
	const created: KVStorageProviderAPI[] = [];

	afterEach(async function() {
		vi.useRealTimers();
		for (const store of created.splice(0)) {
			await provider.destroy(store);
		}
	});

	return(async function(): Promise<KVStorageProviderAPI> {
		const store = await provider.create();
		created.push(store);
		return(store);
	});
}

export function sorted(keys: readonly string[]): string[] {
	return(Array.from(keys).sort());
}
