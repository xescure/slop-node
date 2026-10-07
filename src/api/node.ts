import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { APITree } from '@keetanetwork/keetanet-client/api/index.js';
import type { NodeKind } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { P2PPeer } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { LEDGER_CHECKSUM_KEY } from '../ledger/storage/base.js';
import { assertNever } from '../util/assert-never.js';
import type { AssertNever } from '../util/assert-never.js';
import { NODE_VERSION } from '../version.js';
import { defineGET } from './route.js';
import type { APIRequest, Route } from './route.js';

const lib = KeetaNet.lib;

/** What upstream's typings say a handler of the node group answers. */
type DeclaredResult<Handler> = Handler extends (...parameters: never[]) => Promise<infer Result> ? Result : never;

type DeclaredNodeGroup = APITree['node'];

type PeerEndpoints = { readonly p2p: string; readonly api: string };

/**
 * A peer as a node writes it out [Keeta TS] index.js:71988-72019: a
 * representative with its key, endpoints, preferred update channel and either
 * its signature in base64 or a certificate, or a participant with only its
 * kind.
 */
type PeerRecord =
	| { kind: NodeKind.REPRESENTATIVE; key: string; endpoints: PeerEndpoints; preferUpdates: 'http' | 'websocket'; signature: string }
	| { kind: NodeKind.REPRESENTATIVE; key: string; endpoints: PeerEndpoints; preferUpdates: 'http' | 'websocket'; certificate: null }
	| { kind: NodeKind.PARTICIPANT };

/** [Keeta TS] index.js:71988-72019 */
function peerRecord(peer: P2PPeer): PeerRecord {
	switch (peer.kind) {
		case lib.Node.Kind.REPRESENTATIVE: {
			const advertised = { kind: peer.kind, key: peer.key.publicKeyString.get(), endpoints: peer.endpoints, preferUpdates: peer.preferUpdates };
			if ('certificate' in peer) {
				return({ ...advertised, certificate: peer.certificate });
			}
			const signature = Buffer.from(peer.signature).toString('base64');
			if (signature === '') {
				throw(new Error('internal error: signature is required'));
			}
			return({ ...advertised, signature });
		}
		case lib.Node.Kind.PARTICIPANT:
			return({ kind: peer.kind });
		default:
			return(assertNever(peer));
	}
}

type PeersResult = { peers: PeerRecord[] };

/**
 * The peers the switch counts as current: validated, recently seen, and never
 * this node itself, as the switch lists them by default
 * [Keeta TS] index.js:72521-72614.
 * [node-lite] adapted from getPeers.
 */
async function getPeers(request: APIRequest): Promise<PeersResult> {
	const peers = await request.node.switch.peers();
	return({ peers: peers.map(peerRecord) });
}

/** [node-lite] adapted from getNodeStats. */
async function getNodeStats(request: APIRequest): Promise<DeclaredResult<DeclaredNodeGroup['stats']['GET']>> {
	const [ledger, peerToPeer] = await Promise.all([request.node.ledger.stats(), request.node.switch.stats()]);
	return({ ledger, switch: peerToPeer });
}

/**
 * Clearing the statistics is a debugging aid that this node does not offer,
 * and the answer says that nothing was cleared.
 */
function debugClearStats(): Promise<DeclaredResult<DeclaredNodeGroup['ledger']['clearstats']['GET']>> {
	return(Promise.resolve({ clearStats: false }));
}

/**
 * The XOR of every block hash the ledger applied, which it keeps as a node
 * statistic [Keeta TS] index.js:69415, 74397-74411, with the moment of the
 * ledger's counts.
 * [node-lite] adapted from getLedgerChecksum, reading the statistic the
 * ledger writes.
 */
async function getLedgerChecksum(request: APIRequest): Promise<DeclaredResult<DeclaredNodeGroup['ledger']['checksum']['GET']>> {
	const [statistics, checksum] = await Promise.all([request.node.ledger.stats(), request.node.stats.getXor(LEDGER_CHECKSUM_KEY)]);
	return({ moment: new Date(statistics.moment), momentRange: statistics.momentRange, checksum: checksum.toBigInt() });
}

function getVersion(): Promise<DeclaredResult<DeclaredNodeGroup['version']['GET']>> {
	return(Promise.resolve({ node: NODE_VERSION }));
}

/** The routes about the node itself rather than the ledger's contents. */
export const nodeRoutes: readonly Route[] = [
	defineGET('/node/version', getVersion),
	defineGET('/node/stats', getNodeStats),
	defineGET('/node/peers', getPeers),
	defineGET('/node/ledger/checksum', getLedgerChecksum),
	defineGET('/node/ledger/clearstats', debugClearStats)
];

type _PeersResultIsDeclared = AssertNever<PeersResult extends DeclaredResult<DeclaredNodeGroup['peers']['GET']> ? never : PeersResult>;
