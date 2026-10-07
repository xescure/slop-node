import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BootstrapClient as DeclaredBootstrapClient } from '@keetanetwork/keetanet-client/lib/bootstrap.js';
import type { NodeConfig } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { P2PPeer } from '@keetanetwork/keetanet-client/lib/p2p.js';

const lib = KeetaNet.lib;

/** What a bootstrap client is built on, as upstream's typings declare it (lib/bootstrap.d.ts). */
export type BootstrapNode = ConstructorParameters<typeof DeclaredBootstrapClient>[0];

/*
 * Upstream's node configuration has no place for representatives that are
 * bootstrapped from without being peers, and the client is built on the
 * node alone, so they are kept beside the configuration object itself.
 */
const configuredEndpoints = new WeakMap<NodeConfig, readonly string[]>();

/** Makes the node bootstrap from these API endpoints too, besides the peers it knows. */
export function bootstrapFrom(config: NodeConfig, endpoints: readonly string[]): void {
	configuredEndpoints.set(config, [...endpoints]);
}

/** The API endpoints given for the configuration by bootstrapFrom. */
export function bootstrapEndpointsOf(config: NodeConfig): readonly string[] {
	return(configuredEndpoints.get(config) ?? []);
}

function apiEndpointsOf(peers: readonly P2PPeer[]): string[] {
	return(peers.flatMap(function(peer): string[] {
		if (peer.kind !== lib.Node.Kind.REPRESENTATIVE) {
			return([]);
		}
		return([peer.endpoints.api]);
	}));
}

/**
 * The switch lists a representative's peers only once the representative
 * advertises both its endpoints, and fails until then
 * [Keeta TS] index.js:72543, 73506-73516; it cannot have greeted anyone
 * before, so it knows no peer.
 */
function switchListsPeers(config: NodeConfig): boolean {
	return(config.kind !== lib.Node.Kind.REPRESENTATIVE || (config.endpoints?.api !== undefined && config.endpoints.p2p !== undefined));
}

/**
 * The representatives among the peers that hold voting weight on the node's
 * own ledger. A representative that merely greeted the node chose its own
 * endpoints, so polling it would let anyone with a key point the node's
 * requests anywhere; one the network gave weight to is one the node already
 * trusts to vote.
 */
async function weightedRepresentatives(node: BootstrapNode, peers: readonly P2PPeer[]): Promise<P2PPeer[]> {
	const weighted: P2PPeer[] = [];
	for (const peer of peers) {
		if (peer.kind === lib.Node.Kind.REPRESENTATIVE && await node.ledger.votingPower(peer.key) > 0n) {
			weighted.push(peer);
		}
	}
	return(weighted);
}

/**
 * The API endpoints of the representatives the node bootstraps from, each
 * once: those it was given, its manual peers, which its operator chose
 * whether or not their advertisements are signed, and the representatives
 * its switch has verified that hold voting weight on its ledger, even those
 * it has not heard from lately, since a node that was offline is the one
 * with most to catch up on. The staples a peer sends are checked by the
 * ledger like any other.
 */
export async function bootstrapSources(node: BootstrapNode): Promise<string[]> {
	let known: P2PPeer[] = [];
	if (node.switch !== undefined && switchListsPeers(node.config)) {
		known = await weightedRepresentatives(node, await node.switch.peers({ includeStale: true }));
	}
	const endpoints = [
		...bootstrapEndpointsOf(node.config),
		...apiEndpointsOf(node.config.manualPeers ?? []),
		...apiEndpointsOf(known)
	];
	const own = node.config.endpoints?.api;
	return([...new Set(endpoints)].filter(function(endpoint): boolean {
		return(endpoint !== own);
	}));
}
