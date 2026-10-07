import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { NodeKind } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { P2PPeer } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { LEDGER_CHECKSUM_KEY, LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { assertNever } from '../util/assert-never.js';
import type { AssertNever } from '../util/assert-never.js';
import { NODE_VERSION } from '../version.js';
import type { DeclaredNodeGroup, DeclaredResult } from './declared.js';
import { apiError, parseBase64, parseLimit } from './parameters.js';
import type { LimitBounds } from './parameters.js';
import { asPayload, requiredString } from './payload.js';
import { defineGET, definePOST } from './route.js';
import type { APIRequest, Route } from './route.js';

const lib = KeetaNet.lib;

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
 * [node-lite] adapted from debugClearStats.
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
	const read = async function(): Promise<DeclaredResult<DeclaredNodeGroup['ledger']['checksum']['GET']>> {
		const [statistics, checksum] = await Promise.all([request.node.ledger.stats(), request.node.stats.getXor(LEDGER_CHECKSUM_KEY)]);
		return({ moment: new Date(statistics.moment), momentRange: statistics.momentRange, checksum: checksum.toBigInt() });
	};
	const storage = request.node.config.ledger.storageDriver;
	// Only this node's own drivers can hold commits back; another driver's checksum may run ahead of its counts.
	if (storage instanceof LedgerStorageDriverBase) {
		return(await storage.betweenCommits(read));
	}
	return(await read());
}

/** [node-lite] adapted from getVersion. */
function getVersion(): Promise<DeclaredResult<DeclaredNodeGroup['version']['GET']>> {
	return(Promise.resolve({ node: NODE_VERSION }));
}

/**
 * Adds a staple of blocks and the votes that confirm them to the ledger, and
 * passes on to peers the staples that adding it created; publish says
 * whether the staple sent was among them [Keeta TS] index.js:71384-71410,
 * 58481-58485.
 * [node-lite] adapted from publishVoteStaple.
 */
async function publishVoteStaple(request: APIRequest, body: unknown): Promise<DeclaredResult<DeclaredNodeGroup['publish']['POST']>> {
	const staple = new lib.Vote.Staple(parseBase64(requiredString(asPayload(body), 'votesAndBlocks')));
	return({ publish: await request.node.addToLedger(staple) });
}

/** A page of a bootstrap holds 1000 staples, the ledger's own default, unless the request asks for fewer [Keeta TS] index.js:69633. */
const BOOTSTRAP_LIMIT: LimitBounds = { defaultLimit: 1000, maximum: 1000 };

/**
 * The moment a bootstrap page starts from, as the client writes a date
 * [Keeta TS] index.js:59166-59168. A representative fails on one it cannot
 * read as an internal error rather than refusing it, so this throws a plain
 * error.
 */
function parseBootstrapStart(text: string | undefined): Date {
	if (text === undefined) {
		throw(apiError('API_START_MISSING', '"start" parameter must be supplied'));
	}
	const start = new Date(text);
	if (Number.isNaN(start.getTime())) {
		throw(new Error(`Invalid start: ${text}`));
	}
	return(start);
}

/**
 * The staples added to the ledger on or after the moment, leaving out those
 * the bloom filter says the client already holds; a page is empty once every
 * staple has been sent [Keeta TS] index.js:59140-59182, 69633-69700. The
 * ledger adds staples until their count reaches the limit, so a fractional
 * limit holds one staple more than its whole part [Keeta TS] index.js:69639.
 * [node-lite] adapted from getVoteStaplesAfter.
 */
async function getVoteStaplesAfter(request: APIRequest): Promise<DeclaredResult<DeclaredNodeGroup['bootstrap']['votes']['GET']>> {
	const start = parseBootstrapStart(request.query['start']);
	const limit = parseLimit(request.query, BOOTSTRAP_LIMIT);
	const options: Parameters<Ledger['getVoteStaplesAfter']>[2] = {};
	const bloomFilter = request.query['bloomFilter'];
	if (bloomFilter !== undefined) {
		options.bloomFilter = lib.Utils.Bloom.deserializeBloomFilter(bloomFilter);
	}
	return({ voteStaples: await request.node.ledger.getVoteStaplesAfter(start, limit, options) });
}

/** The routes about the node itself rather than the ledger's contents. */
export const nodeRoutes: readonly Route[] = [
	definePOST('/node/publish', publishVoteStaple),
	defineGET('/node/bootstrap/votes', getVoteStaplesAfter),
	defineGET('/node/version', getVersion),
	defineGET('/node/stats', getNodeStats),
	defineGET('/node/peers', getPeers),
	defineGET('/node/ledger/checksum', getLedgerChecksum),
	defineGET('/node/ledger/clearstats', debugClearStats)
];

type _PeersResultIsDeclared = AssertNever<PeersResult extends DeclaredResult<DeclaredNodeGroup['peers']['GET']> ? never : PeersResult>;
