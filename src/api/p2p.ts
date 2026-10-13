import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { P2PConnection, P2PPeer, P2PPeerRep, P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { JSONSerializableObject } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { nodeNetworkClosedToP2P } from '../node/config.js';
import { P2PInternals } from '../upstream/internals.js';
import type { DeclaredP2PGroup, DeclaredResult } from './declared.js';
import { asPayload, requiredObject, requiredString } from './payload.js';
import { definePOST } from './route.js';
import type { APIRequest, Route } from './route.js';

const lib = KeetaNet.lib;

/** How many messages posted over HTTP each switch is handling; every copy of a node shares the node's switch. */
const postedHandled = new WeakMap<P2PSwitch, number>();

function postedHandledBy(p2pSwitch: P2PSwitch): number {
	return(postedHandled.get(p2pSwitch) ?? 0);
}

/**
 * A representative's advertisement, kept to what its signature covers
 * [Keeta TS] index.js:73002-73011, and that advertisement as the switch
 * serializes one [Keeta TS] index.js:73136-73167.
 */
type SignedAdvertisement = {
	readonly peer: P2PPeerRep;
	readonly serialized: JSONSerializableObject;
};

/**
 * The advertisement, if it is a representative's whose signature covers it
 * [Keeta TS] index.js:73059-73134, 72976-73015. Only a representative sends
 * over HTTP [Keeta TS] index.js:73309-73317, 73344-73346, and only
 * representatives' advertisements are passed on as peers
 * [Keeta TS] index.js:74614-74627, 74792.
 *
 * The parser passes on the advertisement's endpoints object as it is
 * [Keeta TS] index.js:73094, and the switch reads a "filter" beside the
 * advertisement [Keeta TS] index.js:74724-74730; neither is signed, so they
 * are dropped. The switch keeps a filter under the connection's name
 * [Keeta TS] index.js:74240, 74805-74816, which for an HTTP connection is
 * the representative and its API endpoint [Keeta TS] index.js:73331-73342,
 * the name of the node's own connection to that representative too: anyone
 * replaying a representative's advertisement with a filter would otherwise
 * stop the node sending it every staple outside the filter. A peer that
 * filters does so on its own WebSocket, whose name is its socket's
 * [Keeta TS] index.js:73533-73540.
 */
function signedAdvertisementOf(advertisement: unknown): SignedAdvertisement | undefined {
	let parsed: P2PPeer | null;
	try {
		parsed = P2PInternals.P2PPeerFromJSO(advertisement);
	} catch {
		return(undefined);
	}
	if (parsed === null || parsed.kind !== lib.Node.Kind.REPRESENTATIVE) {
		return(undefined);
	}
	const peer: P2PPeerRep = { ...parsed, endpoints: { p2p: parsed.endpoints.p2p, api: parsed.endpoints.api } };
	return({ peer, serialized: P2PInternals.P2PPeerToJSO(peer) });
}

/** A message as the switch reads it [Keeta TS] index.js:73899-73931. */
type ReadMessage = {
	readonly id: string;
	readonly type: string;
	readonly data: unknown;
	readonly ttl: number | undefined;
};

function readMessage(message: Buffer): ReadMessage | undefined {
	let read: ReturnType<typeof lib.P2P.parseJSONMessage>;
	try {
		read = lib.P2P.parseJSONMessage(message);
	} catch {
		return(undefined);
	}
	if (!read.valid) {
		return(undefined);
	}
	const data: unknown = read.data;
	return({ id: read.id, type: read.type, data, ttl: read.ttl });
}

/** Whether the switch passes the message on to its other peers [Keeta TS] index.js:74098-74103, 72579-72587. */
function isRelayed(message: ReadMessage): boolean {
	return(message.ttl !== undefined && message.ttl >= 1);
}

/**
 * A peer a representative passes on, with only what its signature covers
 * [Keeta TS] index.js:74614-74627. The switch keeps the advertisement as the
 * message carries it [Keeta TS] index.js:74028-74041, and dials it, and
 * keeps it as a known peer, from that [Keeta TS] index.js:74757-74796. The
 * sender passes a peer on with a TTL of 0; one that asks the node to pass it
 * on would have any key make the node relay a known representative's
 * advertisement to every peer [Keeta TS] index.js:74048-74068, 74094-74109.
 */
function republishedPeer(message: ReadMessage): Buffer | undefined {
	const advertisement = signedAdvertisementOf(message.data);
	if (advertisement === undefined || isRelayed(message)) {
		return(undefined);
	}
	return(Buffer.from(JSON.stringify({ id: message.id, peer: advertisement.serialized, ttl: message.ttl })));
}

/**
 * The message to hand the switch, if it is one a representative posts over
 * HTTP: a staple [Keeta TS] index.js:72530-72532, 72592, or a peer it passes
 * on [Keeta TS] index.js:74614-74627. The sender's greeting arrives as the
 * greeting field, of which the signed part is taken; a greeting as the
 * message is refused, since the switch handles one on an HTTP connection as
 * it comes [Keeta TS] index.js:73999-74014, 74696-74730, filter included,
 * and under whatever advertisement it carries.
 * The switch passes a test message on to every peer
 * [Keeta TS] index.js:74075-74078, which no node sends, and acts on no
 * other type [Keeta TS] index.js:72541-72575.
 */
function republishedMessage(text: string): Buffer | undefined {
	const buffer = Buffer.from(text);
	const message = readMessage(buffer);
	if (message === undefined) {
		return(undefined);
	}
	switch (message.type) {
		case 'add':
			return(buffer);
		case 'peer':
			return(republishedPeer(message));
		default:
			return(undefined);
	}
}

/**
 * The sender's greeting, as the switch receives one on a connection
 * [Keeta TS] index.js:74689-74693. Its ID is the hash of what the
 * advertisement's signature covers [Keeta TS] index.js:73002-73011 rather
 * than a fresh one, so that the switch's check for messages it has seen
 * [Keeta TS] index.js:73978-73991 handles a sender's greeting once while that
 * check remembers it, not once for every message the sender posts, nor once
 * for every encoding of its signature: handling a greeting sends the sender
 * every peer the node knows [Keeta TS] index.js:74614-74627, 74740, which a
 * sender that also posts over HTTP answers with its own greeting, so two such
 * nodes would otherwise answer each other without end.
 */
function greetingMessage(advertisement: SignedAdvertisement): Buffer {
	const { peer, serialized } = advertisement;
	const signed = [peer.kind, peer.endpoints.p2p, peer.endpoints.api, peer.preferUpdates, peer.key.publicKeyString.get()];
	const digest = Buffer.from(lib.Utils.Hash.Hash(Buffer.from(JSON.stringify(signed)))).toString('hex');
	return(Buffer.from(JSON.stringify({ id: `greeting-${digest}`, greeting: serialized, ttl: 0 })));
}

/**
 * A failure here has no request left to answer, so it is logged. The node
 * waits for the message as it stops, as for one that arrived on a WebSocket,
 * since both reach the same switch (src/node/messages.ts).
 */
async function receive(node: Node, connection: P2PConnection, message: Buffer): Promise<void> {
	const p2pSwitch = node.switch;
	postedHandled.set(p2pSwitch, postedHandledBy(p2pSwitch) + 1);
	try {
		await p2pSwitch.recvMessageFromPeer(connection, message);
	} catch (error) {
		node.log.error('P2P', 'Handling a message posted over HTTP failed:', error);
	} finally {
		postedHandled.set(p2pSwitch, postedHandledBy(p2pSwitch) - 1);
	}
}

function deliver(node: Node, connection: P2PConnection, message: Buffer): void {
	void receive(node, connection, message);
}

/**
 * A peer-to-peer message a representative posts over HTTP, with its own
 * advertisement as the greeting [Keeta TS] index.js:73343-73366. The message
 * reaches the switch on a connection to the sender, as the sender's greeting
 * and then the message, since the switch handles a greeting on an HTTP
 * connection even from a peer it knows [Keeta TS] index.js:73999-74014.
 *
 * A valid advertisement reaches the switch as the sender's greeting whatever
 * the message is: a representative's first post to the node is its greeting
 * as the message [Keeta TS] index.js:73841-73851, 74689-74693, which is
 * refused, and the node answers the greeting with every peer it knows
 * [Keeta TS] index.js:74614-74627, 74740 as the switch would.
 *
 * The answer says whether the message was taken: the greeting a valid
 * advertisement and the message one a representative posts over HTTP. The
 * switch handles it after the answer, as it handles a message on a WebSocket
 * without the sender waiting [Keeta TS] index.js:73510-73517. It must:
 * handling a staple syncs the node [Keeta TS] index.js:72564, which waits for
 * the node's own posts to peers [Keeta TS] index.js:72505-72511,
 * 73825-73831, so two nodes each handling the other's post before answering
 * it would each wait for the other.
 *
 * The message does not wait for the greeting, whose handling also sends the
 * sender every peer the node knows: the connection already carries the
 * sender's advertisement [Keeta TS] index.js:73323-73329, and the messages
 * one sender posts are handled in the order they arrive, as on a WebSocket,
 * rather than a message whose greeting the switch has already seen
 * overtaking the one before it.
 *
 * A node whose network is closed to its peer-to-peer surface
 * (networkClosedToP2P) refuses every message unread: the greeting alone
 * would make the sender a peer the node broadcasts to
 * [Keeta TS] index.js:74398, 74711-74715, and one it remembers. So does a node
 * handling as many messages posted over HTTP as its peer limits allow.
 */
function handleMessage(request: APIRequest, body: unknown): Promise<DeclaredResult<DeclaredP2PGroup['message']['POST']>> {
	const node = request.node;
	if (nodeNetworkClosedToP2P(node.config.network, node.ledger.ledgerWriteMode) !== undefined || postedHandledBy(node.switch) >= request.peerLimits.postedMessages) {
		return(Promise.resolve({ success: false }));
	}
	const payload = asPayload(body);
	const text = requiredString(payload, 'message');
	const advertisement = signedAdvertisementOf(requiredObject(payload, 'greeting'));
	if (advertisement === undefined) {
		return(Promise.resolve({ success: false }));
	}
	const connection = new P2PInternals.HTTPConnection(advertisement.peer, node.switch);
	deliver(node, connection, greetingMessage(advertisement));
	const message = republishedMessage(text);
	if (message === undefined) {
		return(Promise.resolve({ success: false }));
	}
	deliver(node, connection, message);
	return(Promise.resolve({ success: true }));
}

/** The routes peers use to reach the node over HTTP, below /p2p. */
export const p2pRoutes: readonly Route[] = [
	definePOST('/p2p/message', handleMessage, 'none')
];
