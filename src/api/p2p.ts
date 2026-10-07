import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { P2PConnection, P2PPeer, P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { P2PInternals } from '../upstream/internals.js';
import type { DeclaredP2PGroup, DeclaredResult } from './declared.js';
import { asPayload, requiredObject, requiredString } from './payload.js';
import type { Payload } from './payload.js';
import { definePOST } from './route.js';
import type { APIRequest, Route } from './route.js';

const lib = KeetaNet.lib;

/** Deliveries to each switch still running; every copy of a node shares the node's switch. */
const deliveries = new WeakMap<P2PSwitch, Set<Promise<void>>>();

/** Waits until every message posted to the switch over HTTP has been handled. */
export async function settleDeliveries(p2pSwitch: P2PSwitch): Promise<void> {
	const running = deliveries.get(p2pSwitch);
	while (running !== undefined && running.size > 0) {
		await Promise.all(running);
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
 * The sender's peer record, if it is a representative's advertisement whose
 * signature covers it [Keeta TS] index.js:71911-71986, 71828-71867. Only a
 * representative sends over HTTP [Keeta TS] index.js:72161-72169, 72196-72198.
 */
function representativeOf(greeting: Payload): P2PPeer | undefined {
	let peer: P2PPeer | null;
	try {
		peer = P2PInternals.P2PPeerFromJSO(greeting);
	} catch {
		return(undefined);
	}
	if (peer === null || peer.kind !== lib.Node.Kind.REPRESENTATIVE) {
		return(undefined);
	}
	return(peer);
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
 * [Keeta TS] index.js:73541-73545. Its ID is the hash of the greeting rather
 * than a fresh one, so that the switch's check for messages it has seen
 * [Keeta TS] index.js:72830-72843 handles a sender's greeting once while that
 * check remembers it, not once for every message the sender posts: handling a
 * greeting sends the sender every peer the node knows [Keeta TS]
 * index.js:73466-73479, 73592, which a sender that also posts over HTTP
 * answers with its own greeting, so two such nodes would otherwise answer
 * each other without end.
 */
function greetingMessage(greeting: Payload): Buffer {
	const digest = Buffer.from(lib.Utils.Hash.Hash(Buffer.from(JSON.stringify(greeting)))).toString('hex');
	return(Buffer.from(JSON.stringify({ id: `greeting-${digest}`, greeting, ttl: 0 })));
}

/** A failure here has no request left to answer, so it is logged. */
async function deliver(node: Node, connection: P2PConnection, greeting: Buffer, message: Buffer): Promise<void> {
	try {
		await node.switch.recvMessageFromPeer(connection, greeting);
		await node.switch.recvMessageFromPeer(connection, message);
	} catch (error) {
		node.log.error('P2P', 'Handling a message posted over HTTP failed:', error);
	}
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
 * waiting [Keeta TS] index.js:72362-72369: handling a staple lasts until the
 * node has added it, synced and passed it on to its own peers
 * [Keeta TS] index.js:71409-71468, and the sender does not read the answer
 * [Keeta TS] index.js:72203-72218.
 */
function handleMessage(request: APIRequest, body: unknown): Promise<DeclaredResult<DeclaredP2PGroup['message']['POST']>> {
	const payload = asPayload(body);
	const message = Buffer.from(requiredString(payload, 'message'));
	const greeting = requiredObject(payload, 'greeting');
	const sender = representativeOf(greeting);
	if (sender === undefined || !isMessage(message)) {
		return(Promise.resolve({ success: false }));
	}
	const connection = new P2PInternals.HTTPConnection(sender, request.node.switch);
	track(request.node.switch, deliver(request.node, connection, greetingMessage(greeting), message));
	return(Promise.resolve({ success: true }));
}

/** The routes peers use to reach the node over HTTP, below /p2p. */
export const p2pRoutes: readonly Route[] = [
	definePOST('/p2p/message', handleMessage, 'none')
];
