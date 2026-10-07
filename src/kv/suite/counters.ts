import type { KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import { describe, expect, test } from 'vitest';
import { advanceClock, freezeClock } from '../../testing/network.js';
import { assertNever } from '../../util/assert-never.js';
import { START_MOMENT, useStores } from './support.js';
import type { KVProviderUnderTest, KVStoreSharing } from './types.js';
import type { StoreFactory } from './support.js';

const TTL = 60000;
const INCREMENTS = 40;

const incrementTimes = function(store: KVStorageProviderAPI, times: number): Promise<bigint>[] {
	return(Array.from({ length: times }, function() {
		return(store.incr('stats', 'requests', 1));
	}));
};

// Every increment of one returns the total it made, so the totals are 1 to n, each once.
const oneToN = function(count: number): bigint[] {
	return(Array.from({ length: count }, function(_ignored, index) {
		return(BigInt(index + 1));
	}));
};

const ascending = function(values: readonly bigint[]): bigint[] {
	return(Array.from(values).sort(function(left, right) {
		return(Number(left - right));
	}));
};

export function defineCounterCases(provider: KVProviderUnderTest): void {
	describe('counters', function() {
		const openStore = useStores(provider);

		test('incr counts an absent key from zero, returns the total as a bigint, and stores a number', async function() {
			const store = await openStore();

			expect(await store.incr('stats', 'votes', 3)).toBe(3n);
			expect(await store.incr('stats', 'votes', -1)).toBe(2n);
			expect(await store.get('stats', 'votes')).toBe(2);
		});

		test('incr adds to a number that set stored', async function() {
			const store = await openStore();
			await store.set('stats', 'votes', 40);

			expect(await store.incr('stats', 'votes', 2)).toBe(42n);
		});

		test('incr refuses a value that is not a number and leaves it as it was', async function() {
			const store = await openStore();
			await store.set('stats', 'label', 'text');

			await expect(store.incr('stats', 'label', 1)).rejects.toThrow('May not increment non-number');
			expect(await store.get('stats', 'label')).toBe('text');
		});

		test('incr stores a fractional total, then cannot return it as a bigint', async function() {
			const store = await openStore();
			await store.incr('stats', 'average', 2);

			await expect(store.incr('stats', 'average', 0.5)).rejects.toThrow(RangeError);
			expect(await store.get('stats', 'average')).toBe(2.5);
		});

		test('incr keeps the expiry of an unexpired counter', async function() {
			freezeClock(START_MOMENT);
			const store = await openStore();
			await store.set('stats', 'window', 5, { ttl: TTL });

			expect(await store.incr('stats', 'window', 1)).toBe(6n);
			advanceClock(TTL + 1);
			expect(await store.get('stats', 'window')).toBeUndefined();
		});

		test('incr counts an expired counter from zero and drops its expiry', async function() {
			freezeClock(START_MOMENT);
			const store = await openStore();
			await store.set('stats', 'window', 5, { ttl: TTL });
			advanceClock(TTL + 1);

			expect(await store.incr('stats', 'window', 2)).toBe(2n);
			advanceClock(TTL * 10);
			expect(await store.get('stats', 'window')).toBe(2);
		});

		test('concurrent increments on one store sum exactly', async function() {
			const store = await openStore();

			const totals = await Promise.all(incrementTimes(store, INCREMENTS));

			expect(ascending(totals)).toEqual(oneToN(INCREMENTS));
			expect(await store.get('stats', 'requests')).toBe(INCREMENTS);
		});

		const sharing = provider.sharing;
		switch (sharing.kind) {
			case 'process-local':
				break;
			case 'shared':
				defineCrossProcessCounterCases(openStore, sharing);
				break;
			default:
				assertNever(sharing);
		}
	});
}

function defineCrossProcessCounterCases(openStore: StoreFactory, sharing: Extract<KVStoreSharing, { kind: 'shared' }>): void {
	test('increments from two processes on one store sum exactly', async function() {
		const store = await openStore();
		const sibling = await sharing.openSibling(store);

		const totals = await Promise.all([...incrementTimes(store, INCREMENTS), ...incrementTimes(sibling, INCREMENTS)]);

		expect(ascending(totals)).toEqual(oneToN(INCREMENTS * 2));
		expect(await sibling.get('stats', 'requests')).toBe(INCREMENTS * 2);
	});
}
