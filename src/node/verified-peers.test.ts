import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { JSONSerializableObject } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { KVInternals, P2PInternals } from '../upstream/internals.js';
import { VerifiedPeerStore } from './verified-peers.js';

const lib = KeetaNet.lib;

/** Two main network representatives' advertisements, as they greet peers. */
const REP2 = {
	kind: 1,
	key: 'keeta_aabvmwxttv4q56gbfveighwfwp3yvitlrdfsacic3ckqc7lqelsspvmhc7oldmq',
	endpoints: { api: 'https://rep2.main.network.api.keeta.com/api', p2p: 'wss://rep2.main.network.api.keeta.com/p2p' },
	preferUpdates: 'http',
	signature: 'MEUCAQAEQJploQp0Tzx8drrYLdYg9QzQZz0qjlGqtUPVDhr/iw/TIxUNuWn5jyDGZXdUrfhXFxpGqMIC09FnBM720R5/01U='
} satisfies JSONSerializableObject;
const REP4 = {
	kind: 1,
	key: 'keeta_aablpogflko72eusdhuuqgsto2rwcvy2m5mo5snmvrmbacz3qczwjtwpmzf5ufq',
	endpoints: { api: 'https://rep4.main.network.api.keeta.com/api', p2p: 'wss://rep4.main.network.api.keeta.com/p2p' },
	preferUpdates: 'http',
	signature: 'MEUCAQAEQHAncB4AasFKPJy1fWxf8MTzLeQAdlW3237CE6vcb+MbEzTOZ842u8BlU5at6i31vOPpS9ghN93ueN2P3a4gI9E='
} satisfies JSONSerializableObject;

/** A manual peer given without a signature, as the switch records it after dialing it. */
function unsignedRecordOf(advertisement: typeof REP4): JSONSerializableObject {
	return(P2PInternals.P2PPeerToJSO({
		kind: lib.Node.Kind.REPRESENTATIVE,
		key: lib.Account.fromPublicKeyString(advertisement.key).assertAccount(),
		endpoints: advertisement.endpoints,
		preferUpdates: 'websocket',
		certificate: null
	}));
}

function storeWith(entries: [string, string, JSONSerializableObject][]): { underlying: InstanceType<typeof KVInternals.KVStorageProviderMemory>; store: VerifiedPeerStore; ready: Promise<void> } {
	const underlying = new KVInternals.KVStorageProviderMemory();
	const ready = Promise.all(entries.map(function([arena, key, value]): Promise<void> {
		return(underlying.set(arena, key, value));
	})).then(function(): void {
		// Only that every entry is in place matters.
	});
	return({ underlying, store: new VerifiedPeerStore(underlying), ready });
}

describe('a peer recorded as known without a signature', function() {
	test.each(['knownPeers', 'potentialPeers'])('keeps the advertisement it greeted with, signed by its own key, from %s', async function(arena) {
		const { underlying, store, ready } = storeWith([[arena, REP4.key, REP4]]);
		await ready;

		await store.set('knownPeers', REP4.key, unsignedRecordOf(REP4));

		expect(await underlying.get('knownPeers', REP4.key)).toEqual(REP4);
	});

	test('is recorded as given when the greeting under its key is signed by another', async function() {
		const { underlying, store, ready } = storeWith([['potentialPeers', REP4.key, REP2]]);
		await ready;

		await store.set('knownPeers', REP4.key, unsignedRecordOf(REP4));

		expect(await underlying.get('knownPeers', REP4.key)).toEqual(unsignedRecordOf(REP4));
	});

	test('is recorded as given when it has not greeted', async function() {
		const { underlying, store } = storeWith([]);

		await store.set('knownPeers', REP4.key, unsignedRecordOf(REP4));

		expect(await underlying.get('knownPeers', REP4.key)).toEqual(unsignedRecordOf(REP4));
	});
});

describe('every other write', function() {
	test('records a signed advertisement as given', async function() {
		const { underlying, store, ready } = storeWith([['potentialPeers', REP2.key, REP2]]);
		await ready;

		await store.set('knownPeers', REP4.key, REP4);

		expect(await underlying.get('knownPeers', REP4.key)).toEqual(REP4);
	});

	test('removes a known peer', async function() {
		const { underlying, store, ready } = storeWith([['knownPeers', REP4.key, REP4]]);
		await ready;

		await store.set('knownPeers', REP4.key, undefined);

		expect(await underlying.get('knownPeers', REP4.key)).toBeUndefined();
	});

	test('passes an unsigned record outside the known peers on', async function() {
		const { underlying, store, ready } = storeWith([['knownPeers', REP4.key, REP4]]);
		await ready;

		await store.set('potentialPeers', REP4.key, unsignedRecordOf(REP4));

		expect(await underlying.get('potentialPeers', REP4.key)).toEqual(unsignedRecordOf(REP4));
	});
});

describe('repairing the known peers', function() {
	test('replaces a record without a signature by the greeting signed by its key', async function() {
		const { underlying, store, ready } = storeWith([['knownPeers', REP4.key, unsignedRecordOf(REP4)], ['potentialPeers', REP4.key, REP4]]);
		await ready;

		await store.repair();

		expect(await underlying.get('knownPeers', REP4.key)).toEqual(REP4);
	});

	test('leaves a record without a signature whose peer has not greeted, or greeted signed by another key', async function() {
		const { underlying, store, ready } = storeWith([['knownPeers', REP4.key, unsignedRecordOf(REP4)], ['knownPeers', REP2.key, unsignedRecordOf(REP2)], ['potentialPeers', REP2.key, REP4]]);
		await ready;

		await store.repair();

		expect(await underlying.get('knownPeers', REP4.key)).toEqual(unsignedRecordOf(REP4));
		expect(await underlying.get('knownPeers', REP2.key)).toEqual(unsignedRecordOf(REP2));
	});

	test('leaves a signed record', async function() {
		const { underlying, store, ready } = storeWith([['knownPeers', REP4.key, REP4], ['potentialPeers', REP4.key, REP2]]);
		await ready;

		await store.repair();

		expect(await underlying.get('knownPeers', REP4.key)).toEqual(REP4);
	});
});
