import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { P2PConnection, P2PPeer, P2PPeerRep, P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { JSONSerializableObject } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { P2PInternals } from '../upstream/internals.js';
import type { DeclaredP2PGroup, DeclaredResult } from './declared.js';
import { asPayload, requiredObject, requiredString } from './payload.js';
import type { Payload } from './payload.js';
import { definePOST } from './route.js';
import type { APIRequest, Route } from './route.js';

const lib = KeetaNet.lib;

/** Deliveries to each switch still running; every copy of a node shares the node's switch. */
const deliveries = new WeakMap<P2PSwitch, Set<Promise<void>>>();

/**
 * How long stopping waits for the messages peers posted: handling one can
 * wait on the node's own posts to peers, which have no time limit
 * [Keeta TS] index.js:72203-72218, so a peer that never answers could
 * otherwise keep the node from stopping.
 */
export const DELIVERY_SETTLE_MILLISECONDS = 5000;

async function allDelivered(running: Set<Promise<void>>): Promise<'delivered'> {
	while (running.size > 0) {
		await Promise.all(running);
	}
	return('delivered');
}

/**
 * Waits until every message posted to the node's switch over HTTP has been
 * handled, for DELIVERY_SETTLE_MILLISECONDS at most.
 */
export async function settleDeliveries(node: Node): Promise<void> {
	const running = deliveries.get(node.switch);
	if (running === undefined || running.size === 0) {
		return;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<'timed out'>(function(resolve) {
		timer = setTimeout(function() {
			resolve('timed out');
		}, DELIVERY_SETTLE_MILLISECONDS);
	});
	try {
		const outcome = await Promise.race([allDelivered(running), timedOut]);
		if (outcome === 'timed out') {
			node.log.warn('P2P', `Stopped waiting for ${String(running.size)} messages posted over HTTP after ${String(DELIVERY_SETTLE_MILLISECONDS)} ms`);
		}
	} finally {
		clearTimeout(timer);
	}
}

function track(p2pSwitch: P2PSwitch, delivery: Promise<void>): void {
	let running = deliveries.get(p2pSwitch);
	if (running === undefined) {
		running = new Set();
		deliveries.set(p2pSwitch, running);
	}
	const tracked = delivery.finally(function() {
		running.delete(tracked);
	});
	running.add(tracked);
}

/**
 * A representative's advertisement, kept to what its signature covers
 * [Keeta TS] index.js:71854-71863, and that advertisement as the switch
 * serializes one [Keeta TS] index.js:71988-72019.
 */
type SignedAdvertisement = {
	readonly peer: P2PPeerRep;
	readonly greeting: JSONSerializableObject;
};

/**
 * The sender's advertisement, if it is a representative's whose signature
 * covers it [Keeta TS] index.js:71911-71986, 71828-71867. Only a
 * representative sends over HTTP [Keeta TS] index.js:72161-72169, 72196-72198.
 *
 * The parser passes on the advertisement's endpoints object as it is
 * [Keeta TS] index.js:71946, and the switch reads a "filter" beside the
 * advertisement [Keeta TS] index.js:73576-73582; neither is signed, so they
 * are dropped. The switch keeps a filter under the connection's name
 * [Keeta TS] index.js:73092, 73657-73668, which for an HTTP connection is
 * the representative and its API endpoint [Keeta TS] index.js:72183-72194,
 * the name of the node's own connection to that representative too: anyone
 * replaying a representative's advertisement with a filter would otherwise
 * stop the node sending it every staple outside the filter. A peer that
 * filters does so on its own WebSocket, whose name is its socket's
 * [Keeta TS] index.js:72385-72392.
 */
function signedAdvertisementOf(greeting: Payload): SignedAdvertisement | undefined {
	let parsed: P2PPeer | null;
	try {
		parsed = P2PInternals.P2PPeerFromJSO(greeting);
	} catch {
		return(undefined);
	}
	if (parsed === null || parsed.kind !== lib.Node.Kind.REPRESENTATIVE) {
		return(undefined);
	}
	const peer: P2PPeerRep = { ...parsed, endpoints: { p2p: parsed.endpoints.p2p, api: parsed.endpoints.api } };
	return({ peer, greeting: P2PInternals.P2PPeerToJSO(peer) });
}

/** Whether the switch would take the text as a message [Keeta TS] index.js:72751-72783. */
function isMessage(message: Buffer): boolean {
	try {
		return(lib.P2P.parseJSONMessage(message).valid);
	} catch {
		return(false);
	}
}

/**
 * The sender's greeting, as the switch receives one on a connection
 * [Keeta TS] index.js:73541-73545. Its ID is the hash of what the
 * advertisement's signature covers [Keeta TS] index.js:71854-71863 rather
 * than a fresh one, so that the switch's check for messages it has seen
 * [Keeta TS] index.js:72830-72843 handles a sender's greeting once while that
 * check remembers it, not once for every message the sender posts, nor once
 * for every encoding of its signature: handling a greeting sends the sender
 * every peer the node knows [Keeta TS] index.js:73466-73479, 73592, which a
 * sender that also posts over HTTP answers with its own greeting, so two such
 * nodes would otherwise answer each other without end.
 */
function greetingMessage(advertisement: SignedAdvertisement): Buffer {
	const { peer, greeting } = advertisement;
	const signed = [peer.kind, peer.endpoints.p2p, peer.endpoints.api, peer.preferUpdates, peer.key.publicKeyString.get()];
	const digest = Buffer.from(lib.Utils.Hash.Hash(Buffer.from(JSON.stringify(signed)))).toString('hex');
	return(Buffer.from(JSON.stringify({ id: `greeting-${digest}`, greeting, ttl: 0 })));
}

/** A failure here has no request left to answer, so it is logged. */
async function receive(node: Node, connection: P2PConnection, message: Buffer): Promise<void> {
	try {
		await node.switch.recvMessageFromPeer(connection, message);
	} catch (error) {
		node.log.error('P2P', 'Handling a message posted over HTTP failed:', error);
	}
}

function deliver(node: Node, connection: P2PConnection, message: Buffer): void {
	track(node.switch, receive(node, connection, message));
}

/**
 * A peer-to-peer message a representative posts over HTTP, with its own
 * advertisement as the greeting [Keeta TS] index.js:72195-72218. The message
 * reaches the switch on a connection to the sender, as the sender's greeting
 * and then the message, since the switch handles a greeting on an HTTP
 * connection even from a peer it knows [Keeta TS] index.js:72851-72866.
 *
 * The answer says whether the message was taken: the greeting a valid
 * advertisement and the message one the switch reads. The switch handles it
 * after the answer, as it handles a message on a WebSocket without the sender
 * waiting [Keeta TS] index.js:72362-72369. It must: handling a staple syncs
 * the node [Keeta TS] index.js:71436, which waits for the node's own posts
 * to peers [Keeta TS] index.js:71377-71383, 72677-72683, so two nodes each
 * handling the other's post before answering it would each wait for the
 * other.
 *
 * The message does not wait for the greeting, whose handling also sends the
 * sender every peer the node knows [Keeta TS] index.js:73466-73479, 73592:
 * the connection already carries the sender's advertisement
 * [Keeta TS] index.js:72175-72181, and the messages one sender posts are
 * handled in the order they arrive, as on a WebSocket, rather than a message
 * whose greeting the switch has already seen overtaking the one before it.
 */
function handleMessage(request: APIRequest, body: unknown): Promise<DeclaredResult<DeclaredP2PGroup['message']['POST']>> {
	const payload = asPayload(body);
	const message = Buffer.from(requiredString(payload, 'message'));
	const advertisement = signedAdvertisementOf(requiredObject(payload, 'greeting'));
	if (advertisement === undefined || !isMessage(message)) {
		return(Promise.resolve({ success: false }));
	}
	const node = request.node;
	const connection = new P2PInternals.HTTPConnection(advertisement.peer, node.switch);
	deliver(node, connection, greetingMessage(advertisement));
	deliver(node, connection, message);
	return(Promise.resolve({ success: true }));
}

/** The routes peers use to reach the node over HTTP, below /p2p. */
export const p2pRoutes: readonly Route[] = [
	definePOST('/p2p/message', handleMessage, 'none')
];
