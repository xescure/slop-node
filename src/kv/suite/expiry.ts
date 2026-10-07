import { describe, expect, test } from 'vitest';
import { advanceClock, freezeClock } from '../../testing/network.js';
import { assertNever } from '../../util/assert-never.js';
import { START_MOMENT, sorted, useStores } from './support.js';
import type { KVProviderUnderTest } from './types.js';

const TTL = 60000;

export function defineExpiryCases(provider: KVProviderUnderTest): void {
	describe('expiry', function() {
		const openStore = useStores(provider);

		test('an entry reads back until its expiry and is absent after it, in get and getAll', async function() {
			freezeClock(START_MOMENT);
			const store = await openStore();
			await store.set('seenMessageIDs', 'message-1', START_MOMENT.valueOf(), { ttl: TTL });
			await store.set('seenMessageIDs', 'message-2', 'kept');

			advanceClock(TTL);
			expect(await store.get('seenMessageIDs', 'message-1')).toBe(START_MOMENT.valueOf());

			advanceClock(1);
			expect(await store.get('seenMessageIDs', 'message-1')).toBeUndefined();
			expect(await store.getAll('seenMessageIDs')).toEqual({ 'message-2': 'kept' });
		});

		test('an entry stored with a ttl of zero expires once the clock moves on', async function() {
			freezeClock(START_MOMENT);
			const store = await openStore();
			await store.set('seenMessageIDs', 'message-1', 1, { ttl: 0 });

			expect(await store.get('seenMessageIDs', 'message-1')).toBe(1);
			advanceClock(1);
			expect(await store.get('seenMessageIDs', 'message-1')).toBeUndefined();
		});

		test('a later set without a ttl keeps the entry for good', async function() {
			freezeClock(START_MOMENT);
			const store = await openStore();
			await store.set('knownPeers', 'peer', 'first', { ttl: TTL });
			await store.set('knownPeers', 'peer', 'second');

			advanceClock(TTL * 10);
			expect(await store.get('knownPeers', 'peer')).toBe('second');
		});

		test('a later set with a ttl moves the expiry', async function() {
			freezeClock(START_MOMENT);
			const store = await openStore();
			await store.set('knownPeers', 'peer', 'first');
			advanceClock(TTL);
			await store.set('knownPeers', 'peer', 'second', { ttl: TTL });

			advanceClock(TTL);
			expect(await store.get('knownPeers', 'peer')).toBe('second');
			advanceClock(1);
			expect(await store.get('knownPeers', 'peer')).toBeUndefined();
		});

		test('list leaves an expired entry out', async function() {
			freezeClock(START_MOMENT);
			const store = await openStore();
			await store.set('seenMessageIDs', 'expiring', 1, { ttl: TTL });
			await store.set('seenMessageIDs', 'lasting', 2);
			advanceClock(TTL + 1);

			const expected = provider.expiredEntries;
			switch (expected) {
				case 'forgotten-on-read':
					expect(sorted(await store.list('seenMessageIDs'))).toEqual(['expiring', 'lasting']);
					expect(await store.get('seenMessageIDs', 'expiring')).toBeUndefined();
					break;
				case 'absent':
					break;
				default:
					assertNever(expected);
			}
			expect(await store.list('seenMessageIDs')).toEqual(['lasting']);
		});

		test('an exclusive create takes the key of an expired entry', async function() {
			freezeClock(START_MOMENT);
			const store = await openStore();
			await store.set('seenMessageIDs', 'message-1', 1, { exclusiveCreate: true, ttl: TTL });
			advanceClock(TTL + 1);

			const expected = provider.expiredEntries;
			switch (expected) {
				case 'forgotten-on-read':
					await expect(store.set('seenMessageIDs', 'message-1', 2, { exclusiveCreate: true, ttl: TTL })).rejects.toEqual(expect.objectContaining(provider.existingKeyRefusal));
					expect(await store.get('seenMessageIDs', 'message-1')).toBeUndefined();
					break;
				case 'absent':
					break;
				default:
					assertNever(expected);
			}
			await store.set('seenMessageIDs', 'message-1', 2, { exclusiveCreate: true, ttl: TTL });

			expect(await store.get('seenMessageIDs', 'message-1')).toBe(2);
			advanceClock(TTL + 1);
			expect(await store.get('seenMessageIDs', 'message-1')).toBeUndefined();
		});
	});
}
