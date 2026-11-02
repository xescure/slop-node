import type { KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { Logger } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { manualPeerOf } from './config.js';
import type { ManualPeer } from './config.js';
import { signedBy } from './verified-peers.js';

/** How often the node dials the peers it discovered: as often as the switch checks in with its manual peers [Keeta TS] index.js:72968. */
export const DISCOVERY_PERIOD_MILLISECONDS: number = 10 * 60 * 1000;

/** The most discovered peers the node keeps dialing, beside the peers it was configured with. */
export const MAX_DISCOVERED_PEERS: number = 8;

const LOG_SOURCE = 'discovered-peers';

/** The peer a record is the advertisement of, if it is signed by the key it is filed under. */
function advertisedPeer(key: string, record: Parameters<typeof signedBy>[1]): ManualPeer | undefined {
	const advertisement = signedBy(key, record);
	if (advertisement === undefined) {
		return(undefined);
	}
	return(manualPeerOf(advertisement));
}

/**
 * Peers the node learned of from its peers' exchange of advertisements
 * [Keeta TS] index.js:74638-74649, 74051-74064, each signed by the key it
 * is filed under, those it already connected to first, so that it keeps
 * the same ones, leaving out the keys excluded.
 */
export async function chooseDiscoveredPeers(store: KVStorageProviderAPI, excluded: ReadonlySet<string>, limit: number): Promise<ManualPeer[]> {
	const [known, potential] = await Promise.all([store.getAll('knownPeers'), store.getAll('potentialPeers')]);
	const named = new Set(excluded);
	const chosen: ManualPeer[] = [];
	for (const records of [known, potential]) {
		for (const key of Object.keys(records).sort()) {
			if (chosen.length >= limit) {
				return(chosen);
			}
			if (named.has(key)) {
				continue;
			}
			const peer = advertisedPeer(key, records[key]);
			if (peer !== undefined) {
				named.add(key);
				chosen.push(peer);
			}
		}
	}
	return(chosen);
}

/**
 * Dials, every period, the peers the node discovered.
 *
 * The switch dials a peer it learned of only while it sends a message on
 * [Keeta TS] index.js:74413-74480, and a staple's sender is mostly a
 * representative the node is already connected to, so third-party nodes
 * would otherwise learn of each other and never connect. Each is dialed as
 * a manual peer once, which the switch skips while it is connected to it
 * [Keeta TS] index.js:73793-73830.
 */
export class DiscoveredPeerDialer {
	readonly #switch: P2PSwitch;
	readonly #excluded: ReadonlySet<string>;
	readonly #log: Logger;
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(peerSwitch: P2PSwitch, excluded: ReadonlySet<string>, log: Logger) {
		this.#switch = peerSwitch;
		this.#excluded = excluded;
		this.#log = log;
	}

	start(periodMilliseconds: number): void {
		this.#timer = setInterval(() => {
			this.dial().catch((error: unknown) => {
				this.#log.error(LOG_SOURCE, 'Dialing discovered peers failed:', error);
			});
		}, periodMilliseconds);
	}

	/** Dials the peers chooseDiscoveredPeers names, answering them. */
	async dial(): Promise<ManualPeer[]> {
		const peers = await chooseDiscoveredPeers(this.#switch.config.kv, this.#excluded, MAX_DISCOVERED_PEERS);
		for (const peer of peers) {
			this.#switch.addManualPeer(peer, false);
		}
		return(peers);
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}
}
