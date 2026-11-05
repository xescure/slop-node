import { describe, expect, test } from 'vitest';
import type { JSONSerializableObject } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { MAIN_REP1, MAIN_REP2, MAIN_REP3, MAIN_REP4 } from '../testing/advertisements.js';
import { KVInternals } from '../upstream/internals.js';
import { manualPeerOf } from './config.js';
import { chooseDiscoveredPeers } from './discovered-peers.js';

type Entry = readonly ['knownPeers' | 'potentialPeers', string, JSONSerializableObject];

async function choose(entries: readonly Entry[], excluded: readonly string[], limit: number, address?: string): Promise<string[]> {
	const store = new KVInternals.KVStorageProviderMemory();
	for (const [arena, key, value] of entries) {
		await store.set(arena, key, value);
	}
	const peers = await chooseDiscoveredPeers(store, { keys: new Set(excluded), address }, limit);
	return(peers.map(function(peer): string {
		return(peer.key.publicKeyString.get());
	}));
}

const { signature: _ignoredSignature, ...UNSIGNED_REP4 } = MAIN_REP4;

describe('the discovered peers a node dials', function() {
	test('are built from advertisements that each hold their signature', function() {
		for (const advertisement of [MAIN_REP1, MAIN_REP2, MAIN_REP3, MAIN_REP4]) {
			expect(manualPeerOf(advertisement)).toBeDefined();
		}
	});

	test('are the advertisements it learned, each signed by the key it is filed under', async function() {
		const chosen = await choose([
			['potentialPeers', MAIN_REP1.key, MAIN_REP1],
			['potentialPeers', MAIN_REP3.key, MAIN_REP2],
			['potentialPeers', MAIN_REP4.key, UNSIGNED_REP4]
		], [], 8);
		expect(chosen).toEqual([MAIN_REP1.key]);
	});

	test('leave out the keys it is given, such as its own and its configured peers', async function() {
		const chosen = await choose([
			['potentialPeers', MAIN_REP1.key, MAIN_REP1],
			['potentialPeers', MAIN_REP2.key, MAIN_REP2]
		], [MAIN_REP1.key], 8);
		expect(chosen).toEqual([MAIN_REP2.key]);
	});

	test('leave out every advertisement of the node\'s own address, which only a key it had before signs', async function() {
		const chosen = await choose([
			['knownPeers', MAIN_REP1.key, MAIN_REP1],
			['potentialPeers', MAIN_REP2.key, MAIN_REP2]
		], [], 8, MAIN_REP1.endpoints.p2p);
		expect(chosen).toEqual([MAIN_REP2.key]);
	});

	test('take the node\'s address as the same however its host is cased', async function() {
		const chosen = await choose([
			['potentialPeers', MAIN_REP1.key, MAIN_REP1],
			['potentialPeers', MAIN_REP2.key, MAIN_REP2]
		], [], 8, MAIN_REP1.endpoints.p2p.replace('rep1.main', 'REP1.Main'));
		expect(chosen).toEqual([MAIN_REP2.key]);
	});

	test('are the peers it already knows first, so that the same ones are kept', async function() {
		const chosen = await choose([
			['potentialPeers', MAIN_REP1.key, MAIN_REP1],
			['potentialPeers', MAIN_REP2.key, MAIN_REP2],
			['knownPeers', MAIN_REP3.key, MAIN_REP3]
		], [], 2);
		expect(chosen[0]).toBe(MAIN_REP3.key);
		expect(chosen).toHaveLength(2);
	});

	test('name each peer once, known or only learned', async function() {
		const chosen = await choose([
			['potentialPeers', MAIN_REP1.key, MAIN_REP1],
			['knownPeers', MAIN_REP1.key, MAIN_REP1]
		], [], 8);
		expect(chosen).toEqual([MAIN_REP1.key]);
	});

	test('are at most as many as the limit', async function() {
		const chosen = await choose([MAIN_REP1, MAIN_REP2, MAIN_REP3, MAIN_REP4].map(function(advertisement): Entry {
			return(['potentialPeers', advertisement.key, advertisement]);
		}), [], 3);
		expect(chosen).toHaveLength(3);
	});
});
