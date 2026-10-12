import { describe, expect, test } from 'vitest';
import { deriveTestKeys, TEST_NETWORK_SEEDS } from '../testing/network.js';
import { KVInternals } from '../upstream/internals.js';
import { ConfigError, getConfigFromEnv } from './config.js';
import type { ConfigProblem, Environment } from './config.js';
import { forgetPeers, PEER_ARENAS, refuseRememberedPeers, rememberedPeerArenas } from './peer-store.js';
import type { PeerArena } from './peer-store.js';

const NODE: Environment = {
	KEETANET_LOCAL_NODE_SEED: TEST_NETWORK_SEEDS.representative,
	KEETANET_INITIAL_TRUSTED_ACCOUNT: deriveTestKeys(TEST_NETWORK_SEEDS, 1).trustedRoot.publicKeyString.get()
};

type Store = InstanceType<typeof KVInternals.KVStorageProviderMemory>;

async function storeWith(arenas: readonly PeerArena[]): Promise<Store> {
	const kv = new KVInternals.KVStorageProviderMemory();
	for (const arena of arenas) {
		await kv.set(arena, 'peer', 'remembered');
	}
	return(kv);
}

async function problemOf(environment: Environment, kv: Store): Promise<ConfigProblem | undefined> {
	try {
		await refuseRememberedPeers(getConfigFromEnv({ ...NODE, ...environment }), kv);
	} catch (error: unknown) {
		if (error instanceof ConfigError) {
			return(error.problem);
		}
		throw(error);
	}
	return(undefined);
}

describe('a node that may not have peers on its network', function() {
	test.each(PEER_ARENAS.flatMap(function(arena) {
		return((['dev', 'staging'] as const).flatMap(function(network) {
			return((['read-write', 'no-voting'] as const).map(function(mode) {
				return({ arena, network, mode });
			}));
		}));
	}))('refuses to start on $network in $mode mode when $arena remembers a peer', async function({ arena, network, mode }) {
		const environment = { KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode };
		expect(await problemOf(environment, await storeWith([arena]))).toEqual({ kind: 'remembered-peers', network, ledgerWriteMode: mode, arenas: [arena] });
	});

	test.each(PEER_ARENAS.flatMap(function(arena) {
		return((['main', 'test'] as const).flatMap(function(network) {
			return((['bootstrap-only', 'read-only'] as const).map(function(mode) {
				return({ arena, network, mode });
			}));
		}));
	}))('refuses to start following $network in $mode mode when $arena remembers a peer, its peer-to-peer surface being closed there', async function({ arena, network, mode }) {
		const environment = { KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode };
		expect(await problemOf(environment, await storeWith([arena]))).toEqual({ kind: 'remembered-peers', network, ledgerWriteMode: mode, arenas: [arena] });
	});

	test('tells a node following main only to forget the peers it remembers', async function() {
		const kv = await storeWith(['knownPeers']);
		const environment = { KEETANET_LOCAL_NODE_NETWORK: 'main', KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'bootstrap-only' };
		await expect(refuseRememberedPeers(getConfigFromEnv({ ...NODE, ...environment }), kv)).rejects.toThrow('the main network is Keeta\'s, and the store of KEETANET_LOCAL_NODE_POSTGRES_URL remembers peers (in knownPeers), which the node would reach even without KEETANET_LOCAL_NODE_MANUAL_PEERS: run "slop-node clear-peers" with the same environment to forget them');
	});

	test('names every arena that remembers a peer, and how to forget them', async function() {
		const kv = await storeWith(['knownPeers', 'lastSeenPeers']);
		const environment = { KEETANET_LOCAL_NODE_NETWORK: 'dev' };
		await expect(refuseRememberedPeers(getConfigFromEnv({ ...NODE, ...environment }), kv)).rejects.toThrow('the dev network is Keeta\'s, and the store of KEETANET_LOCAL_NODE_POSTGRES_URL remembers peers (in knownPeers, lastSeenPeers), which the node would reach even without KEETANET_LOCAL_NODE_MANUAL_PEERS: run "slop-node clear-peers" with the same environment to forget them, or set KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE to read-only or bootstrap-only (it is read-write)');
	});

	test('starts when no arena remembers a peer', async function() {
		const kv = await storeWith([]);
		await kv.set('p2p', 'incomingMessages', 3);
		expect(await problemOf({ KEETANET_LOCAL_NODE_NETWORK: 'dev' }, kv)).toBeUndefined();
	});
});

describe('a node that may have peers', function() {
	test.each([
		{ network: 'local', mode: 'read-write' },
		{ network: 'dev', mode: 'read-only' },
		{ network: 'staging', mode: 'bootstrap-only' }
	])('starts on $network in $mode mode with remembered peers', async function({ network, mode }) {
		const environment = { KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode };
		expect(await problemOf(environment, await storeWith(PEER_ARENAS))).toBeUndefined();
	});
});

describe('forgetting peers', function() {
	test('empties every peer arena, and nothing else, saying how many entries each held', async function() {
		const kv = await storeWith(PEER_ARENAS);
		await kv.set('knownPeers', 'another', 'remembered');
		await kv.set('p2p', 'incomingMessages', 3);

		const removed = await forgetPeers(kv);

		expect(removed).toEqual({ knownPeers: 2, potentialPeers: 1, lastSeenPeers: 1, connectedPeers: 1, manualPeerCheckIn: 1, messageFilters: 1 });
		expect(await rememberedPeerArenas(kv)).toEqual([]);
		expect(await kv.get('p2p', 'incomingMessages')).toBe(3);
	});
});
