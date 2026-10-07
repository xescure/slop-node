import { describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { NodeConfig } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { P2PConnection, P2PPeer } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { JSONSerializableObject } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { APIDocument } from '../conformance/api/document.js';
import { driversUnderTest } from '../ledger/storage/suite/drivers.js';
import { ChainCursor, requireAt } from '../ledger/storage/suite/support.js';
import type { DriverUnderTest } from '../ledger/storage/suite/types.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { postJSON, useLocalNodes } from '../testing/local-node.js';
import type { RunningLocalNode } from '../testing/local-node.js';
import type { TestNetwork } from '../testing/network.js';
import { watchOpenHandles } from '../testing/open-handles.js';
import { NODE_ENVIRONMENT, useSDKNodes } from '../testing/sdk.js';
import type { ServingNode } from '../testing/sdk.js';
import { P2PInternals } from '../upstream/internals.js';
import type { LedgerWriteMode } from './config.js';
import type { LocalNode } from './local.js';
import { MESSAGE_SETTLE_MILLISECONDS, SwitchMessages } from './messages.js';
import { rememberedPeerArenas } from './peer-store.js';

const lib = KeetaNet.lib;

const nodes = useLocalNodes();
const sdkNodes = useSDKNodes();

const api = new APIDocument();

const MESSAGE_ROUTE = { method: 'POST', path: '/api/p2p/message' } as const;

/** Each representative holds half the weight; the staples sent here carry both votes. */
const WEIGHTS: readonly bigint[] = [1000n, 1000n];

/** The status a WebSocket closes with when a frame is larger than the receiver accepts (RFC 6455 section 7.4.1). */
const MESSAGE_TOO_BIG = 1009;

/** An account no node holds the key of, from a fixed seed. */
const STRANGER: Account = lib.Account.fromSeed('9a7c5e3f1b2d4068a0c2e4f6b8d1a3c5e7f9b0d2c4e6a8f1b3d5c7e9a0f2b4d6', 0);

type Pair = { readonly first: RunningLocalNode; readonly second: RunningLocalNode };

type PairOptions = { readonly driver?: DriverUnderTest; readonly p2p?: NodeConfig['p2p'] };

/** Two representatives of one network, each with storage of its own, serving on the loopback interface. */
async function startPair(options: PairOptions = {}): Promise<Pair> {
	const first = await nodes.start({ ...options, representativeWeights: WEIGHTS, representative: 0 });
	const second = await nodes.start({ ...options, representativeWeights: WEIGHTS, representative: 1 });
	return({ first, second });
}

/** The node's own signed advertisement as a peer record holding the public key only, as a manual peer is configured. */
async function peerRecordOf(node: LocalNode): Promise<P2PPeer> {
	const peer = P2PInternals.P2PPeerFromJSO(await node.switch.getOutgoingGreetingInfo());
	if (peer === null) {
		throw(new Error('the node advertises no valid peer record'));
	}
	return(peer);
}

function representativeKeys(peers: readonly P2PPeer[]): string[] {
	return(peers.flatMap(function(peer): string[] {
		if (peer.kind !== lib.Node.Kind.REPRESENTATIVE) {
			return([]);
		}
		return([peer.key.publicKeyString.get()]);
	}).sort());
}

function keyOf(account: Account): string {
	return(account.publicKeyString.get());
}

function representativeOf(running: RunningLocalNode, index: number): Account {
	return(requireAt(running.network.representatives, index));
}

function messageTypeOf(buffer: Buffer | ArrayBuffer): string | undefined {
	try {
		const message = lib.P2P.parseJSONMessage(Buffer.from(buffer));
		if (!message.valid) {
			return(undefined);
		}
		return(message.type);
	} catch {
		return(undefined);
	}
}

/** The types of the messages peers deliver to the node from now on, as the switch reads them. */
function deliveredTypes(node: LocalNode): (string | undefined)[] {
	const handle = node.switch.recvMessageFromPeer.bind(node.switch);
	const types: (string | undefined)[] = [];
	vi.spyOn(node.switch, 'recvMessageFromPeer').mockImplementation(function(from: P2PConnection, buffer: Buffer | ArrayBuffer): Promise<boolean> {
		types.push(messageTypeOf(buffer));
		return(handle(from, buffer));
	});
	return(types);
}

/** Tracks the messages peers deliver to the node from now on, as the node does to wait for them as it stops. */
function trackedMessages(node: LocalNode): SwitchMessages {
	return(new SwitchMessages(node.switch, node.log));
}

/**
 * The switch's answers to the next messages of that type peers deliver to the
 * node, in the order they arrive, once the switch, and the node behind it,
 * have handled them.
 */
function handledInTurn(node: LocalNode, type: string, count: number): Promise<boolean[]> {
	const handle = node.switch.recvMessageFromPeer.bind(node.switch);
	const answers: Promise<boolean>[] = [];
	return(new Promise<boolean[]>(function(resolve, reject) {
		vi.spyOn(node.switch, 'recvMessageFromPeer').mockImplementation(function(from: P2PConnection, buffer: Buffer | ArrayBuffer): Promise<boolean> {
			const handled = handle(from, buffer);
			if (answers.length < count && messageTypeOf(buffer) === type) {
				answers.push(handled);
				if (answers.length === count) {
					Promise.all(answers).then(resolve, reject);
				}
			}
			return(handled);
		});
	}));
}

/** The switch's answer to the next message of that type a peer delivers to the node. */
async function nextHandled(node: LocalNode, type: string): Promise<boolean> {
	const [answer] = await handledInTurn(node, type, 1);
	if (answer === undefined) {
		throw(new Error('internal error: no answer for the message'));
	}
	return(answer);
}

/** Resolves once the node has recorded a peer as known, which the switch does once it has dialed one [Keeta TS] index.js:73644. */
function nextKnownPeer(node: LocalNode): Promise<void> {
	const kv = node.switch.config.kv;
	const set = kv.set.bind(kv);
	return(new Promise<void>(function(resolve) {
		vi.spyOn(kv, 'set').mockImplementation(async function(arena, key, value, options): Promise<void> {
			await set(arena, key, value, options);
			if (arena === 'knownPeers') {
				resolve();
			}
		});
	}));
}

/**
 * The records the node keeps of potential peers from now on, one for each
 * greeting of a representative the switch handles [Keeta TS] index.js:73563-73567.
 */
function recordedPotentialPeers(node: LocalNode): unknown[] {
	const kv = node.switch.config.kv;
	const set = kv.set.bind(kv);
	const recorded: unknown[] = [];
	vi.spyOn(kv, 'set').mockImplementation(async function(arena, key, value, options): Promise<void> {
		if (arena === 'potentialPeers') {
			recorded.push(value);
		}
		await set(arena, key, value, options);
	});
	return(recorded);
}

/** Adds the peer as the node's configuration would, and waits until the node has dialed it. */
async function dial(from: LocalNode, to: LocalNode): Promise<void> {
	from.switch.addManualPeer(await peerRecordOf(to));
	await from.switch.wait();
}

/** A send from user 0 to user 1, voted for by both representatives. */
async function sendStaple(network: TestNetwork, amount: bigint): Promise<VoteStaple> {
	const cursor = new ChainCursor(network.genesis);
	const user = requireAt(network.users, 0);
	const block = await sendBlock({ from: user, to: requireAt(network.users, 1), amount, token: network.baseToken, previous: cursor.previous(user), network: network.network });
	return(await confirmedStaple([block], network.representatives));
}

function p2pEndpointOf(node: LocalNode): string {
	const endpoint = node.config.endpoints?.p2p;
	if (endpoint === undefined) {
		throw(new Error('the node advertises no peer-to-peer endpoint'));
	}
	return(endpoint);
}

function opened(socket: WebSocket): Promise<void> {
	return(new Promise<void>(function(resolve, reject) {
		socket.addEventListener('open', function() {
			resolve();
		}, { once: true });
		socket.addEventListener('error', function() {
			reject(new Error('the WebSocket did not open'));
		}, { once: true });
	}));
}

function closed(socket: WebSocket): Promise<number> {
	return(new Promise<number>(function(resolve) {
		socket.addEventListener('close', function(event) {
			resolve(event.code);
		}, { once: true });
	}));
}

/** A client of the node's "/p2p" endpoint that is no node: it sends only what the test gives it. */
async function rawPeerSocket(node: LocalNode): Promise<WebSocket> {
	const socket = new WebSocket(p2pEndpointOf(node));
	await opened(socket);
	return(socket);
}

/** A test message whose JSON text is exactly that many bytes long. */
function testMessageOfLength(bytes: number): string {
	const empty = JSON.stringify({ id: 'frame-bound', test: '', ttl: 0 });
	return(JSON.stringify({ id: 'frame-bound', test: 'x'.repeat(bytes - empty.length), ttl: 0 }));
}

/** The node's advertisement with its endpoints altered after signing, so that its signature no longer covers it. */
async function alteredAdvertisement(node: LocalNode): Promise<JSONSerializableObject> {
	const genuine = await node.switch.getOutgoingGreetingInfo();
	return({ ...genuine, endpoints: { api: 'http://127.0.0.1:9/api', p2p: 'ws://127.0.0.1:9/p2p' } });
}

/** The node's advertisement claiming an account whose key the signer does not hold. */
async function advertisementOfAnotherAccount(node: LocalNode): Promise<JSONSerializableObject> {
	const genuine = await node.switch.getOutgoingGreetingInfo();
	return({ ...genuine, key: keyOf(STRANGER) });
}

function endpointsOf(node: LocalNode): { readonly api: string; readonly p2p: string } {
	const endpoints = node.config.endpoints;
	if (endpoints?.api === undefined || endpoints.p2p === undefined) {
		throw(new Error('the node advertises no endpoints'));
	}
	return({ api: endpoints.api, p2p: endpoints.p2p });
}

/**
 * The node's genuine advertisement with fields its signature does not cover
 * beside it and in its endpoints, among them a filter on an account that the
 * staples sent here do not touch.
 */
async function advertisementWithUnsignedFields(node: LocalNode): Promise<JSONSerializableObject> {
	const genuine = await node.switch.getOutgoingGreetingInfo();
	return({ ...genuine, filter: keyOf(STRANGER), unsigned: 'unsigned', endpoints: { ...endpointsOf(node), unsigned: 'unsigned' } });
}

/** A peer passed on, as a representative passes on each peer it knows [Keeta TS] index.js:73466-73479. */
function peerMessage(id: string, advertisement: JSONSerializableObject, ttl: number): string {
	return(JSON.stringify({ id, peer: advertisement, ttl }));
}

/** A greeting as the message, with a filter beside the advertisement on an account the staples sent here do not touch. */
async function filteringGreetingMessage(node: LocalNode): Promise<string> {
	const genuine = await node.switch.getOutgoingGreetingInfo();
	return(JSON.stringify({ id: 'smuggled', greeting: { ...genuine, filter: keyOf(STRANGER) }, ttl: 0 }));
}

/** A representative of another network, whose key the pair's nodes do not know. */
async function startStranger(): Promise<RunningLocalNode> {
	return(await nodes.start({ representativeWeights: [1000n, 1000n, 1000n], representative: 2, p2p: { useHTTPRepublish: true } }));
}

async function strangersGreeting(): Promise<JSONSerializableObject> {
	return(await (await startStranger()).node.switch.getOutgoingGreetingInfo());
}

async function secondsGreeting(pair: Pair): Promise<JSONSerializableObject> {
	return(await pair.second.node.switch.getOutgoingGreetingInfo());
}

/** A test message the switch would pass on [Keeta TS] index.js:72927-72930. */
function relayedTestMessage(): Promise<string> {
	return(Promise.resolve(JSON.stringify({ id: 'test', test: 'hello', ttl: 5 })));
}

function unknownMessage(): Promise<string> {
	return(Promise.resolve(JSON.stringify({ id: 'unknown', unknown: 'hello', ttl: 0 })));
}

async function relayedPeerMessage(node: LocalNode): Promise<string> {
	return(peerMessage('relayed-peer', await node.switch.getOutgoingGreetingInfo(), 1));
}

async function alteredPeerMessage(node: LocalNode): Promise<string> {
	return(peerMessage('altered-peer', await alteredAdvertisement(node), 0));
}

function listenerPeerMessage(): Promise<string> {
	return(Promise.resolve(peerMessage('listener-peer', { kind: lib.Node.Kind.PARTICIPANT }, 0)));
}

/** Sends from user 0 to user 1, each following the one before it, voted for by both representatives. */
async function chainedStaples(network: TestNetwork, amounts: readonly bigint[]): Promise<VoteStaple[]> {
	const cursor = new ChainCursor(network.genesis);
	const user = requireAt(network.users, 0);
	const staples: VoteStaple[] = [];
	for (const amount of amounts) {
		const block = cursor.append(await sendBlock({ from: user, to: requireAt(network.users, 1), amount, token: network.baseToken, previous: cursor.previous(user), network: network.network }));
		staples.push(await confirmedStaple([block], network.representatives));
	}
	return(staples);
}

/** Resolves once the node's switch has kept a staple from a peer whose filter it does not pass [Keeta TS] index.js:73091-73096. */
function nextFiltered(node: LocalNode): Promise<void> {
	const increment = node.stats.incr.bind(node.stats);
	return(new Promise<void>(function(resolve) {
		vi.spyOn(node.stats, 'incr').mockImplementation(function(arena: string, key: string, change?: number): void {
			increment(arena, key, change);
			if (arena === 'p2p' && key === 'outgoingMessagesPeerFiltered') {
				resolve();
			}
		});
	}));
}

/** The switch sends its messages as text frames [Keeta TS] index.js:72404. */
function typeOfFrame(data: unknown): string | undefined {
	if (typeof data !== 'string') {
		return(undefined);
	}
	return(messageTypeOf(Buffer.from(data)));
}

/** The types of the messages the socket receives from now on. */
function receivedTypes(socket: WebSocket): (string | undefined)[] {
	const types: (string | undefined)[] = [];
	socket.addEventListener('message', function(event: MessageEvent<unknown>) {
		types.push(typeOfFrame(event.data));
	});
	return(types);
}

function nextReceived(socket: WebSocket, type: string): Promise<void> {
	return(new Promise<void>(function(resolve) {
		socket.addEventListener('message', function(event: MessageEvent<unknown>) {
			if (typeOfFrame(event.data) === type) {
				resolve();
			}
		});
	}));
}

/**
 * Resolves once the switch has registered that many more connections, which
 * for an inbound one lasts until its greeting is handled
 * [Keeta TS] index.js:72319-72343, 72693-72731.
 */
function connectionsRegistered(node: LocalNode, count: number): Promise<void> {
	const register = node.switch.registerConnection.bind(node.switch);
	let registered = 0;
	return(new Promise<void>(function(resolve) {
		vi.spyOn(node.switch, 'registerConnection').mockImplementation(async function(connection: P2PConnection): Promise<void> {
			await register(connection);
			registered++;
			if (registered === count) {
				resolve();
			}
		});
	}));
}

/** A listener's greeting, which names no endpoint and filters on the account. */
function listenerGreeting(id: string, filter: Account): string {
	return(JSON.stringify({ id, greeting: { kind: lib.Node.Kind.PARTICIPANT, filter: keyOf(filter) }, ttl: 0 }));
}

type HeldStaples = {
	/** Resolves once a staple has arrived. */
	readonly arrived: Promise<void>;
	readonly release: () => void;
};

/**
 * Holds every staple the switch hands the node, inside the switch's handling
 * of the message [Keeta TS] index.js:72870-72890, 71409-71415, until released.
 */
function holdStaplesInNode(node: LocalNode): HeldStaples {
	const handle = node.recvMessageFromPeer.bind(node);
	let arrive: () => void = function() {
		throw(new Error('arrived before the test waited'));
	};
	const arrived = new Promise<void>(function(resolve) {
		arrive = resolve;
	});
	let release: () => void = function() {
		throw(new Error('released before the staple arrived'));
	};
	const held = new Promise<void>(function(resolve) {
		release = resolve;
	});
	vi.spyOn(node, 'recvMessageFromPeer').mockImplementation(async function(...args: Parameters<LocalNode['recvMessageFromPeer']>): Promise<boolean> {
		if (args[2] === 'add') {
			arrive();
			await held;
		}
		return(await handle(...args));
	});
	return({ arrived, release });
}

/** Turns of the event loop in which stopping a node has run out of anything to do but wait. */
const STOPPING_TURNS = 50;

async function eventLoopTurns(count: number): Promise<void> {
	for (let turn = 0; turn < count; turn++) {
		await new Promise<void>(function(resolve) {
			setImmediate(resolve);
		});
	}
}

describe('peers over the /p2p WebSocket', function() {
	test('the dialing node knows the peer it dialed, which lists it as unverified until it dials back', async function() {
		const { first, second } = await startPair();
		const greeted = nextHandled(second.node, 'greeting');

		await dial(first.node, second.node);
		await greeted;

		expect(representativeKeys(await first.node.switch.peers())).toEqual([keyOf(representativeOf(second, 1))]);
		expect(representativeKeys(await second.node.switch.peers())).toEqual([]);
		expect(representativeKeys(await second.node.switch.peers({ includeUnverified: true }))).toEqual([keyOf(representativeOf(first, 0))]);

		await dial(second.node, first.node);

		expect(representativeKeys(await first.node.switch.peers())).toEqual([keyOf(representativeOf(second, 1))]);
		expect(representativeKeys(await second.node.switch.peers())).toEqual([keyOf(representativeOf(first, 0))]);
	});

	test('is not served when the node runs without the WebSocket server', async function() {
		const running = await nodes.start({ run: { startWebSocketServer: false } });
		const socket = new WebSocket(p2pEndpointOf(running.node));
		await expect(opened(socket)).rejects.toThrow('did not open');
	});

	test('refuses a frame over 16 MiB, and hands one of exactly 16 MiB to the switch', async function() {
		const { second } = await startPair();
		const socket = await rawPeerSocket(second.node);
		const atBound = nextHandled(second.node, 'test');

		socket.send(testMessageOfLength(P2PInternals.P2P_WEBSOCKET_MAX_PAYLOAD_BYTES));
		// The connection has not greeted, so the switch takes the message but does not act on it.
		expect(await atBound).toBe(false);

		const handle = vi.spyOn(second.node.switch, 'recvMessageFromPeer');
		handle.mockClear();
		const closing = closed(socket);
		socket.send(testMessageOfLength(P2PInternals.P2P_WEBSOCKET_MAX_PAYLOAD_BYTES + 1));
		expect(await closing).toBe(MESSAGE_TOO_BIG);
		expect(handle).not.toHaveBeenCalled();
	});

	test('makes an unverified peer of a greeting with a genuine advertisement, whoever sends it', async function() {
		const { first, second } = await startPair();
		const socket = await rawPeerSocket(second.node);
		const greeted = nextHandled(second.node, 'greeting');

		socket.send(JSON.stringify({ id: 'genuine-greeting', greeting: await first.node.switch.getOutgoingGreetingInfo(), ttl: 0 }));

		await greeted;
		expect(representativeKeys(await second.node.switch.peers({ includeUnverified: true }))).toEqual([keyOf(representativeOf(first, 0))]);
		socket.close();
	});

	test.each([
		{ forgery: 'an advertisement altered after signing', advertise: alteredAdvertisement },
		{ forgery: 'an advertisement for an account without its key', advertise: advertisementOfAnotherAccount }
	])('never makes a peer of a greeting with $forgery', async function({ advertise }) {
		const { first, second } = await startPair();
		const socket = await rawPeerSocket(second.node);
		const greeted = nextHandled(second.node, 'greeting');

		socket.send(JSON.stringify({ id: 'forged-greeting', greeting: await advertise(first.node), ttl: 0 }));

		await greeted;
		expect(await second.node.switch.peers({ includeUnverified: true, includeStale: true })).toEqual([]);
		expect(await second.node.switch.config.kv.getAll('potentialPeers')).toEqual({});
		expect(await second.node.switch.config.kv.getAll('knownPeers')).toEqual({});
		socket.close();
	});

	test('sends a listener that filters on an account only the staples that touch it', async function() {
		const { first } = await startPair();
		const listening = connectionsRegistered(first.node, 2);
		const filtering = await rawPeerSocket(first.node);
		const touched = await rawPeerSocket(first.node);
		filtering.send(listenerGreeting('listener-filtering', STRANGER));
		touched.send(listenerGreeting('listener-touched', requireAt(first.network.users, 1)));
		await listening;
		const filteringReceived = receivedTypes(filtering);
		const filtered = nextFiltered(first.node);
		const sent = nextReceived(touched, 'add');

		expect(await first.node.addToLedger(await sendStaple(first.network, 10n))).toBe(true);

		await Promise.all([filtered, sent]);
		expect(filteringReceived).not.toContain('add');
		filtering.close();
		touched.close();
	});
});

describe('peers over HTTP republish', function() {
	test('a greeting of a representative is accepted, as the API document describes the answer', async function() {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		const greeted = nextHandled(second.node, 'greeting');
		const greeting = await first.node.switch.getOutgoingGreetingInfo();

		const answer = await postJSON(second, '/p2p/message', { message: peerMessage('hello', greeting, 0), greeting });

		expect(answer.status).toBe(200);
		expect(answer.body).toEqual({ success: true });
		expect(api.responseViolations(MESSAGE_ROUTE, answer.status, answer.body)).toEqual([]);
		await greeted;
		expect(representativeKeys(await second.node.switch.peers({ includeUnverified: true }))).toEqual([keyOf(representativeOf(first, 0))]);
	});

	/*
	 * Neither node waits on its own dialing here, as a node configured with
	 * manual peers does not, so each dial is still pending when the other
	 * node's greeting arrives.
	 */
	test('lets two nodes dial each other at once, each answering the other\'s greeting while its own dial is pending', async function() {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		const firstPeer = await peerRecordOf(first.node);
		const secondPeer = await peerRecordOf(second.node);
		const known = Promise.all([nextKnownPeer(first.node), nextKnownPeer(second.node)]);

		first.node.switch.addManualPeer(secondPeer);
		second.node.switch.addManualPeer(firstPeer);
		await known;

		expect(representativeKeys(await first.node.switch.peers())).toEqual([keyOf(representativeOf(second, 1))]);
		expect(representativeKeys(await second.node.switch.peers())).toEqual([keyOf(representativeOf(first, 0))]);
	});

	test.each([
		{ forgery: 'an advertisement altered after signing', advertise: alteredAdvertisement },
		{ forgery: 'an advertisement for an account without its key', advertise: advertisementOfAnotherAccount }
	])('refuses a message whose greeting is $forgery, and never makes a peer of it', async function({ advertise }) {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		const handle = vi.spyOn(second.node.switch, 'recvMessageFromPeer');
		const message = peerMessage('forged', await second.node.switch.getOutgoingGreetingInfo(), 0);

		const answer = await postJSON(second, '/p2p/message', { message, greeting: await advertise(first.node) });

		expect(answer.status).toBe(200);
		expect(answer.body).toEqual({ success: false });
		expect(api.responseViolations(MESSAGE_ROUTE, answer.status, answer.body)).toEqual([]);
		expect(handle).not.toHaveBeenCalled();
		expect(await second.node.switch.peers({ includeUnverified: true, includeStale: true })).toEqual([]);
	});

	test('takes from a replayed greeting only what its signature covers, so a filter in it does not keep staples from that representative', async function() {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		// The node's own connection to the representative has the name a filter in its greeting would be kept under.
		await dial(first.node, second.node);
		const recorded = recordedPotentialPeers(first.node);
		const messages = trackedMessages(first.node);
		const genuine = await second.node.switch.getOutgoingGreetingInfo();

		const answer = await postJSON(first, '/p2p/message', { message: peerMessage('replayed', genuine, 0), greeting: await advertisementWithUnsignedFields(second.node) });

		expect(answer.body).toEqual({ success: true });
		await messages.settled();
		// Once for the greeting, once for the peer the message passes on.
		expect(recorded).toEqual([genuine, genuine]);
		expect(await first.node.switch.config.kv.getAll('messageFilters')).toEqual({});

		const applied = nextHandled(second.node, 'add');
		expect(await first.node.addToLedger(await sendStaple(first.network, 10n))).toBe(true);
		expect(await applied).toBe(true);
		expect(await second.node.ledger.getBalance(requireAt(second.network.users, 1), second.network.baseToken)).toBe(1010n);
	});

	test('handles a representative\'s greeting once, whatever fields its signature does not cover are added to it', async function() {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		const recorded = recordedPotentialPeers(second.node);
		const messages = trackedMessages(second.node);
		const [plain, withUnsignedFields] = await chainedStaples(first.network, [10n, 20n]);
		if (plain === undefined || withUnsignedFields === undefined) {
			throw(new Error('internal error: fewer staples than amounts'));
		}

		await postJSON(second, '/p2p/message', { message: JSON.stringify({ id: 'plain', add: plain.toString(), ttl: 0 }), greeting: await first.node.switch.getOutgoingGreetingInfo() });
		await messages.settled();
		await postJSON(second, '/p2p/message', { message: JSON.stringify({ id: 'with-unsigned-fields', add: withUnsignedFields.toString(), ttl: 0 }), greeting: await advertisementWithUnsignedFields(first.node) });
		await messages.settled();

		expect(recorded).toEqual([await first.node.switch.getOutgoingGreetingInfo()]);
	});

	test('handles the staples one representative posts in the order they arrive, while the node still answers its greeting', async function() {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		// A peer the node knows, which handling the sender's greeting sends the sender.
		await dial(second.node, first.node);
		const send = second.node.switch.sendMessage.bind(second.node.switch);
		let release: () => void = function() {
			throw(new Error('released before the peer was sent'));
		};
		const held = new Promise<void>(function(resolve) {
			release = resolve;
		});
		vi.spyOn(second.node.switch, 'sendMessage').mockImplementation(async function(...args: Parameters<typeof send>): Promise<boolean> {
			if (args[2] === 'peer') {
				await held;
			}
			return(await send(...args));
		});
		const arrivals: string[] = [];
		const forward = second.node.recvMessageFromPeer.bind(second.node);
		vi.spyOn(second.node, 'recvMessageFromPeer').mockImplementation(function(...args: Parameters<typeof forward>): Promise<boolean> {
			arrivals.push(args[1]);
			return(forward(...args));
		});
		const staples = await chainedStaples(first.network, [10n, 20n, 30n]);
		const handled = handledInTurn(second.node, 'add', staples.length);
		const messages = trackedMessages(second.node);
		const greeting = await first.node.switch.getOutgoingGreetingInfo();

		for (const [index, staple] of staples.entries()) {
			const message = JSON.stringify({ id: `staple-${String(index)}`, add: staple.toString(), ttl: 0 });
			expect((await postJSON(second, '/p2p/message', { message, greeting })).body).toEqual({ success: true });
		}
		await handled;
		release();
		await messages.settled();

		expect(arrivals).toEqual(['staple-0', 'staple-1', 'staple-2']);
		expect(await second.node.ledger.getBalance(requireAt(second.network.users, 1), second.network.baseToken)).toBe(1060n);
	});

	test.each([
		{ sender: 'its own key', greetingOf: strangersGreeting },
		{ sender: 'the replayed greeting of the representative', greetingOf: secondsGreeting }
	])('refuses a greeting as the message from a sender greeting with $sender, so a filter in it does not keep staples from that representative', async function({ greetingOf }) {
		const pair = await startPair({ p2p: { useHTTPRepublish: true } });
		const { first, second } = pair;
		// The node's own connection to the representative has the name a filter in its greeting would be kept under.
		await dial(first.node, second.node);
		const greeting = await greetingOf(pair);
		const delivered = deliveredTypes(first.node);
		const messages = trackedMessages(first.node);

		const answer = await postJSON(first, '/p2p/message', { message: await filteringGreetingMessage(second.node), greeting });

		expect(answer.body).toEqual({ success: false });
		expect(api.responseViolations(MESSAGE_ROUTE, answer.status, answer.body)).toEqual([]);
		await messages.settled();
		// Only the greeting the node builds from the greeting field.
		expect([...delivered]).toEqual(['greeting']);
		expect(await first.node.switch.config.kv.getAll('messageFilters')).toEqual({});

		const applied = nextHandled(second.node, 'add');
		expect(await first.node.addToLedger(await sendStaple(first.network, 10n))).toBe(true);
		expect(await applied).toBe(true);
	});

	test.each([
		{ refused: 'a test message, which the switch passes on to every peer', message: relayedTestMessage },
		{ refused: 'a message of a type the node does not act on', message: unknownMessage },
		{ refused: 'a peer to pass on to every peer', message: relayedPeerMessage },
		{ refused: 'a peer whose advertisement was altered after signing', message: alteredPeerMessage },
		{ refused: 'a peer that is no representative', message: listenerPeerMessage }
	])('refuses $refused', async function({ message }) {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		const delivered = deliveredTypes(second.node);
		const messages = trackedMessages(second.node);

		const answer = await postJSON(second, '/p2p/message', { message: await message(first.node), greeting: await first.node.switch.getOutgoingGreetingInfo() });

		expect(answer.body).toEqual({ success: false });
		await messages.settled();
		expect(delivered).toEqual(['greeting']);
	});

	test('keeps a peer passed on with only what its signature covers', async function() {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		const stranger = await startStranger();
		const genuine = await stranger.node.switch.getOutgoingGreetingInfo();
		const messages = trackedMessages(second.node);

		const answer = await postJSON(second, '/p2p/message', { message: peerMessage('passed-on', await advertisementWithUnsignedFields(stranger.node), 0), greeting: await first.node.switch.getOutgoingGreetingInfo() });

		expect(answer.body).toEqual({ success: true });
		await messages.settled();
		expect(await second.node.switch.config.kv.get('potentialPeers', keyOf(representativeOf(stranger, 2)))).toEqual(genuine);
		expect(await second.node.switch.config.kv.getAll('messageFilters')).toEqual({});
	});

	test('refuses a message that is no peer-to-peer message, and still takes the sender\'s greeting', async function() {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		const delivered = deliveredTypes(second.node);
		const messages = trackedMessages(second.node);

		const answer = await postJSON(second, '/p2p/message', { message: '{"id": 7}', greeting: await first.node.switch.getOutgoingGreetingInfo() });

		expect(answer.body).toEqual({ success: false });
		await messages.settled();
		expect(delivered).toEqual(['greeting']);
		expect(representativeKeys(await second.node.switch.peers({ includeUnverified: true }))).toEqual([keyOf(representativeOf(first, 0))]);
	});
});

/** A representative configured from its environment, as the command builds one, on that network and in that mode. */
function startConfigured(network: string, mode: LedgerWriteMode): Promise<ServingNode> {
	return(sdkNodes.start({ ...NODE_ENVIRONMENT, KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode }));
}

/** A representative of the local network, posting over HTTP, whose genuine greeting the node under test is sent. */
async function senderGreeting(): Promise<JSONSerializableObject> {
	const sender = await sdkNodes.start({ ...NODE_ENVIRONMENT, KEETANET_LOCAL_NODE_SEED_INDEX: '1', KEETANET_LOCAL_NODE_PREFER_UPDATES: 'http' });
	return(await sender.node.switch.getOutgoingGreetingInfo());
}

function apiOf(serving: ServingNode): { readonly apiURL: string } {
	return({ apiURL: endpointsOf(serving.node).api.replace(/\/$/, '') });
}

describe('a node configured from its environment', function() {
	test.each(['dev', 'staging'])('serves no /p2p WebSocket on %s while it votes, the network being closed to peers', async function(network) {
		const serving = await startConfigured(network, 'read-write');

		await expect(opened(new WebSocket(p2pEndpointOf(serving.node)))).rejects.toThrow('did not open');
	});

	test.each(['dev', 'staging'])('refuses a message posted over HTTP on %s while it votes, handing the switch nothing and keeping no peer', async function(network) {
		const serving = await startConfigured(network, 'read-write');
		const greeting = await senderGreeting();
		const handle = vi.spyOn(serving.node.switch, 'recvMessageFromPeer');

		const answer = await postJSON(apiOf(serving), '/p2p/message', { message: peerMessage('hello', greeting, 0), greeting });

		expect(answer.status).toBe(200);
		expect(answer.body).toEqual({ success: false });
		expect(api.responseViolations(MESSAGE_ROUTE, answer.status, answer.body)).toEqual([]);
		expect(handle).not.toHaveBeenCalled();
		expect(await serving.node.switch.peers({ includeUnverified: true, includeStale: true })).toEqual([]);
		expect(await rememberedPeerArenas(serving.node.switch.config.kv)).toEqual([]);
	});

	test.each([
		{ network: 'local', mode: 'read-write' },
		{ network: 'dev', mode: 'read-only' },
		{ network: 'staging', mode: 'bootstrap-only' }
	] as const)('serves peers over /p2p and HTTP on $network in $mode mode, which the network is open to', async function({ network, mode }) {
		const serving = await startConfigured(network, mode);
		const greeting = await senderGreeting();
		const socket = new WebSocket(p2pEndpointOf(serving.node));
		await opened(socket);
		socket.close();
		const greeted = nextHandled(serving.node, 'greeting');

		const answer = await postJSON(apiOf(serving), '/p2p/message', { message: peerMessage('hello', greeting, 0), greeting });

		expect(answer.body).toEqual({ success: true });
		await greeted;
		expect(await serving.node.switch.peers({ includeUnverified: true })).toHaveLength(1);
		expect(await rememberedPeerArenas(serving.node.switch.config.kv)).toContain('potentialPeers');
	});
});

describe.each(driversUnderTest)('two representatives on the $name driver', function(driver) {
	test.each([
		{ transport: 'the WebSocket', useHTTPRepublish: false },
		{ transport: 'HTTP republish', useHTTPRepublish: true }
	])('apply on one a staple added on the other, sent over $transport', async function({ useHTTPRepublish }) {
		const { first, second } = await startPair({ driver, p2p: { useHTTPRepublish } });
		const greeted = nextHandled(second.node, 'greeting');
		await dial(first.node, second.node);
		await greeted;
		const staple = await sendStaple(first.network, 10n);
		const receiver = requireAt(first.network.users, 1);
		const applied = nextHandled(second.node, 'add');

		expect(await first.node.addToLedger(staple)).toBe(true);

		expect(await applied).toBe(true);
		expect(await second.node.ledger.getBalance(receiver, second.network.baseToken)).toBe(1010n);
		expect(await first.node.ledger.getBalance(receiver, first.network.baseToken)).toBe(1010n);
	});
});

describe('stopping', function() {
	/*
	 * A WebSocket hands each message to the switch without waiting for it
	 * [Keeta TS] index.js:72362-72369, and the switch writes the node's
	 * statistics once it is done [Keeta TS] index.js:72813-72815, so a node
	 * that stopped meanwhile would have them written to a closed store.
	 */
	test.each(driversUnderTest)('waits for a staple a peer sent over the WebSocket until the node has handled it, on $name', async function(driver) {
		const { first, second } = await startPair({ driver });
		await dial(first.node, second.node);
		const receiver = requireAt(first.network.users, 1);
		const { arrived, release } = holdStaplesInNode(second.node);

		expect(await first.node.addToLedger(await sendStaple(first.network, 10n))).toBe(true);
		await arrived;
		let finished = false;
		const stopped = second.node.stop().then(function() {
			finished = true;
		});
		await eventLoopTurns(STOPPING_TURNS);
		expect(finished).toBe(false);
		release();
		await stopped;

		expect(await second.node.ledger.getBalance(receiver, second.network.baseToken)).toBe(1010n);
	});

	/*
	 * A node passes on a staple it has added, dialing the peers it is not
	 * connected to [Keeta TS] index.js:71460-71463, 73241-73306, so a staple
	 * still being handled as the node stops dials after its connections were
	 * closed.
	 */
	test('lets no peer be dialed by a staple it is still handling as it stops', async function() {
		const register = vi.spyOn(lib.P2P.prototype, 'registerConnection');
		const weights = [1000n, 1000n, 1000n];
		const first = await nodes.start({ representativeWeights: weights, representative: 0 });
		const second = await nodes.start({ representativeWeights: weights, representative: 1 });
		const third = await nodes.start({ representativeWeights: weights, representative: 2 });
		await dial(second.node, third.node);
		await dial(first.node, second.node);
		const { arrived, release } = holdStaplesInNode(second.node);
		expect(await first.node.addToLedger(await sendStaple(first.network, 10n))).toBe(true);
		await arrived;

		const registeredBefore = register.mock.contexts.length;
		const stopped = second.node.stop();
		await eventLoopTurns(STOPPING_TURNS);
		release();
		await stopped;

		const registeredWhileStopping = register.mock.contexts.slice(registeredBefore).filter(function(context): boolean {
			return(context === second.node.switch);
		});
		expect(registeredWhileStopping).toEqual([]);
		expect(await second.node.ledger.getBalance(requireAt(first.network.users, 1), second.network.baseToken)).toBe(1010n);
	});

	test('logs a message from a peer that the node fails to handle, rather than leaving the failure to end the process', async function() {
		const { first, second } = await startPair();
		await dial(first.node, second.node);
		const failure = new Error('the node failed to handle the staple');
		vi.spyOn(second.node, 'recvMessageFromPeer').mockRejectedValue(failure);
		const logged = new Promise<unknown[]>(function(resolve) {
			const error = second.node.log.error.bind(second.node.log);
			vi.spyOn(second.node.log, 'error').mockImplementation(function(...args: Parameters<typeof error>): void {
				error(...args);
				resolve(args);
			});
		});

		expect(await first.node.addToLedger(await sendStaple(first.network, 10n))).toBe(true);

		expect(await logged).toEqual(['P2P', 'Handling a message from a peer failed:', failure]);
	});

	test('stops waiting for the messages peers sent after a bound, and says so', async function() {
		const { first, second } = await startPair();
		await dial(first.node, second.node);
		const messages = new SwitchMessages(second.node.switch, second.node.log);
		const { arrived, release } = holdStaplesInNode(second.node);
		const warn = vi.spyOn(second.node.log, 'warn');
		expect(await first.node.addToLedger(await sendStaple(first.network, 10n))).toBe(true);
		await arrived;

		// Only the bound's timer is faked; the clock freezeClock set is released with it.
		vi.useRealTimers();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		let settled = false;
		const settling = messages.settled().then(function() {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(MESSAGE_SETTLE_MILLISECONDS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		vi.useRealTimers();
		await settling;

		expect(warn).toHaveBeenCalledWith('P2P', `Stopped waiting for 1 messages from peers after ${String(MESSAGE_SETTLE_MILLISECONDS)} ms`);
		release();
	});

	test('waits for a message posted over HTTP until the switch has handled it', async function() {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		await dial(first.node, second.node);
		const receiver = requireAt(first.network.users, 1);
		const { arrived, release } = holdStaplesInNode(second.node);

		// The sender is answered before the message is handled.
		expect(await first.node.addToLedger(await sendStaple(first.network, 10n))).toBe(true);
		await arrived;
		let finished = false;
		const stopped = second.node.stop().then(function() {
			finished = true;
		});
		await eventLoopTurns(STOPPING_TURNS);
		expect(finished).toBe(false);
		release();
		await stopped;

		expect(await second.node.ledger.getBalance(receiver, second.network.baseToken)).toBe(1010n);
	});

	test('stops waiting for the messages posted over HTTP after the same bound, and says so', async function() {
		const { first, second } = await startPair({ p2p: { useHTTPRepublish: true } });
		await dial(first.node, second.node);
		const messages = trackedMessages(second.node);
		const { arrived, release } = holdStaplesInNode(second.node);
		const warn = vi.spyOn(second.node.log, 'warn');
		expect(await first.node.addToLedger(await sendStaple(first.network, 10n))).toBe(true);
		await arrived;

		// Only the bound's timer is faked; the clock freezeClock set is released with it.
		vi.useRealTimers();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		let settled = false;
		const settling = messages.settled().then(function() {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(MESSAGE_SETTLE_MILLISECONDS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		vi.useRealTimers();
		await settling;

		expect(warn).toHaveBeenCalledWith('P2P', `Stopped waiting for 1 messages from peers after ${String(MESSAGE_SETTLE_MILLISECONDS)} ms`);
		release();
	});

	test.each([
		{ transport: 'the WebSocket', useHTTPRepublish: false },
		{ transport: 'HTTP republish', useHTTPRepublish: true }
	])('leaves no server, socket or timer of two nodes peering over $transport', async function({ useHTTPRepublish }) {
		const handles = watchOpenHandles();
		const { first, second } = await startPair({ p2p: { useHTTPRepublish } });
		await dial(first.node, second.node);
		await dial(second.node, first.node);
		const applied = nextHandled(second.node, 'add');
		await first.node.addToLedger(await sendStaple(first.network, 10n));
		await applied;
		// A connection still waiting for its greeting when the node stops.
		const ungreeted = await rawPeerSocket(second.node);
		const ungreetedClosed = closed(ungreeted);

		await second.node.stop();
		await first.node.stop();
		await ungreetedClosed;

		expect(await handles.open()).toEqual([]);
	});
});
