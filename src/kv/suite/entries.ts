import type { KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import { describe, expect, test } from 'vitest';
import { assertNever } from '../../util/assert-never.js';
import { sorted, useStores } from './support.js';
import type { KVProviderUnderTest } from './types.js';

export function defineEntryCases(provider: KVProviderUnderTest): void {
	describe('entries', function() {
		const openStore = useStores(provider);

		test('a stored value reads back as the same JSON, and a missing key as undefined', async function() {
			const store = await openStore();
			const peer = { id: 'peer-1', addresses: ['wss://a.example', 'wss://b.example'], weight: 0, verified: false, seen: null, nested: { z: 1, a: [true, 'x'] } };
			await store.set('knownPeers', 'peer-1', peer);
			await store.set('knownPeers', 'count', 12.5);
			await store.set('knownPeers', 'name', '');
			await store.set('knownPeers', 'flag', false);

			expect(await store.get('knownPeers', 'peer-1')).toEqual(peer);
			expect(await store.get('knownPeers', 'count')).toBe(12.5);
			expect(await store.get('knownPeers', 'name')).toBe('');
			expect(await store.get('knownPeers', 'flag')).toBe(false);
			expect(await store.get('knownPeers', 'absent')).toBeUndefined();
		});

		test('arenas keep their keys apart', async function() {
			const store = await openStore();
			await store.set('connectedPeers', 'peer', 'connected');
			await store.set('lastSeenPeers', 'peer', 1700000000000);

			expect(await store.get('connectedPeers', 'peer')).toBe('connected');
			expect(await store.get('lastSeenPeers', 'peer')).toBe(1700000000000);
			expect(await store.getAll('connectedPeers')).toEqual({ peer: 'connected' });
			expect(await store.list('potentialPeers')).toEqual([]);
			expect(await store.getAll('potentialPeers')).toEqual({});
		});

		test('set replaces a value, and storing undefined or null removes the key', async function() {
			const store = await openStore();
			await store.set('messageFilters', 'a', 'first');
			await store.set('messageFilters', 'a', 'second');
			await store.set('messageFilters', 'b', 'kept');
			await store.set('messageFilters', 'c', 'gone');

			expect(await store.get('messageFilters', 'a')).toBe('second');

			await store.set('messageFilters', 'a', undefined);
			await store.set('messageFilters', 'c', null);

			expect(await store.get('messageFilters', 'a')).toBeUndefined();
			expect(await store.get('messageFilters', 'c')).toBeUndefined();
			expect(await store.list('messageFilters')).toEqual(['b']);
			expect(await store.getAll('messageFilters')).toEqual({ b: 'kept' });
		});

		test('getAll and list cover every entry of one arena', async function() {
			const store = await openStore();
			const entries = { 'peer-b': { port: 2 }, 'peer-a': { port: 1 }, '10': 'ten', '9': 'nine' };
			for (const [key, value] of Object.entries(entries)) {
				await store.set('knownPeers', key, value);
			}
			await store.set('lastSeenPeers', 'peer-a', 5);

			expect(await store.getAll('knownPeers')).toEqual(entries);
			expect(sorted(await store.list('knownPeers'))).toEqual(sorted(Object.keys(entries)));
		});

		test('an exclusive create stores a new key and refuses one that exists, keeping its value', async function() {
			const store = await openStore();
			await store.set('seenMessageIDs', 'message-1', 1, { exclusiveCreate: true });

			await expect(store.set('seenMessageIDs', 'message-1', 2, { exclusiveCreate: true })).rejects.toEqual(expect.objectContaining(provider.existingKeyRefusal));

			expect(await store.get('seenMessageIDs', 'message-1')).toBe(1);
		});

		test('an exclusive create of null refuses a key that exists and otherwise stores nothing', async function() {
			const store = await openStore();
			await store.set('seenMessageIDs', 'message-1', 1);

			await expect(store.set('seenMessageIDs', 'message-1', null, { exclusiveCreate: true })).rejects.toEqual(expect.objectContaining(provider.existingKeyRefusal));
			await store.set('seenMessageIDs', 'message-2', null, { exclusiveCreate: true });

			expect(await store.getAll('seenMessageIDs')).toEqual({ 'message-1': 1 });
		});

		test('of concurrent exclusive creates of one key, exactly one succeeds', async function() {
			const store = await openStore();

			const outcomes = await Promise.allSettled(createConcurrently([store, store]));

			expectOneCreated(outcomes, provider);
			expect(await store.get('seenMessageIDs', 'message-1')).toEqual(expect.any(Number));
		});

		const sharing = provider.sharing;
		switch (sharing.kind) {
			case 'process-local':
				break;
			case 'shared':
				test('of exclusive creates of one key by two processes, exactly one succeeds', async function() {
					const store = await openStore();
					const sibling = await sharing.openSibling(store);

					const outcomes = await Promise.allSettled(createConcurrently([store, sibling, store, sibling]));

					expectOneCreated(outcomes, provider);
				});
				break;
			default:
				assertNever(sharing);
		}
	});
}

const createConcurrently = function(stores: readonly KVStorageProviderAPI[]): Promise<void>[] {
	return(stores.map(function(store, index) {
		return(store.set('seenMessageIDs', 'message-1', index, { exclusiveCreate: true, ttl: 60000 }));
	}));
};

const expectOneCreated = function(outcomes: readonly PromiseSettledResult<void>[], provider: KVProviderUnderTest): void {
	const refusals = outcomes.flatMap(function(outcome): unknown[] {
		if (outcome.status === 'rejected') {
			return([outcome.reason]);
		}
		return([]);
	});
	const refusal: unknown = expect.objectContaining(provider.existingKeyRefusal);
	expect(refusals).toEqual(Array.from({ length: outcomes.length - 1 }, function(): unknown {
		return(refusal);
	}));
};
