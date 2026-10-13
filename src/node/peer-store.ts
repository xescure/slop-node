import type { KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import { ConfigError, networkClosedToP2P } from './config.js';
import type { EnvironmentConfig } from './config.js';

/**
 * The arenas of its key-value store in which the switch keeps peers: those it
 * has verified and those that greeted it [Keeta TS] index.js:73680-73696, 74711-74715, 74792,
 * when it last saw each [Keeta TS] index.js:74599, the connections it can
 * reopen [Keeta TS] index.js:73608-73620, 73868, 74538-74549, when it last
 * dialed each manual peer [Keeta TS] index.js:73774-73781, and the filters
 * peers' connections asked for [Keeta TS] index.js:74728, 74807.
 */
export const PEER_ARENAS = ['knownPeers', 'potentialPeers', 'lastSeenPeers', 'connectedPeers', 'manualPeerCheckIn', 'messageFilters'] as const;

export type PeerArena = typeof PEER_ARENAS[number];

/** How many entries each arena held. */
export type PeerEntryCounts = Readonly<Record<PeerArena, number>>;

/** The arenas that hold any peer. */
export async function rememberedPeerArenas(kv: KVStorageProviderAPI): Promise<PeerArena[]> {
	const held = await Promise.all(PEER_ARENAS.map(async function(arena): Promise<PeerArena[]> {
		if ((await kv.list(arena)).length === 0) {
			return([]);
		}
		return([arena]);
	}));
	return(held.flat());
}

/**
 * The switch dials and broadcasts to the peers its store remembers, whatever
 * the environment names [Keeta TS] index.js:73667-73768, 74398-74454, so a node
 * whose network is closed to its peer-to-peer surface (networkClosedToP2P)
 * refuses to start with any.
 */
export async function refuseRememberedPeers(config: EnvironmentConfig, kv: KVStorageProviderAPI): Promise<void> {
	const network = networkClosedToP2P(config.network, config.ledgerWriteMode);
	if (network === undefined) {
		return;
	}
	const arenas = await rememberedPeerArenas(kv);
	if (arenas.length > 0) {
		throw(new ConfigError({ kind: 'remembered-peers', network, ledgerWriteMode: config.ledgerWriteMode, arenas }));
	}
}

/** Removes every entry of the peer arenas, and nothing else, answering how many each held. */
export async function forgetPeers(kv: KVStorageProviderAPI): Promise<PeerEntryCounts> {
	const removed = await Promise.all(PEER_ARENAS.map(async function(arena): Promise<[PeerArena, number]> {
		const keys = await kv.list(arena);
		for (const key of keys) {
			await kv.set(arena, key, undefined);
		}
		return([arena, keys.length]);
	}));
	const counts: Record<PeerArena, number> = { knownPeers: 0, potentialPeers: 0, lastSeenPeers: 0, connectedPeers: 0, manualPeerCheckIn: 0, messageFilters: 0 };
	for (const [arena, count] of removed) {
		counts[arena] = count;
	}
	return(counts);
}
