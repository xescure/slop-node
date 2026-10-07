import type http from 'node:http';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { LedgerStorageBase, computeLedgerEffect, addTimeStatistic } from '@keetanetwork/keetanet-client/lib/ledger/common.js';
import type { computeEffectOfBlocks } from '@keetanetwork/keetanet-client/lib/ledger/effects.js';
import type { KVStorageProviderMemory } from '@keetanetwork/keetanet-client/lib/kv/kv_memory.js';
import type { IdempotentKey } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { P2PHttpConnection as HTTPConnectionClass, P2PPeerFromJSO, P2PPeerToJSO, P2PWebSocket } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { StatsPending as StatsPendingClass } from '@keetanetwork/keetanet-client/lib/stats.js';

export type LedgerInternalsAPI = {
	readonly LedgerStorageBase: typeof LedgerStorageBase;
	readonly computeEffectOfBlocks: typeof computeEffectOfBlocks;
	readonly computeLedgerEffect: typeof computeLedgerEffect;
	readonly addTimeStatistic: typeof addTimeStatistic;
	readonly IdempotentKey: typeof IdempotentKey;
};

const requiredInternals = {
	LedgerStorageBase: true,
	computeEffectOfBlocks: true,
	computeLedgerEffect: true,
	addTimeStatistic: true,
	IdempotentKey: true
} satisfies Record<keyof LedgerInternalsAPI, true>;

function findMissingInternals(candidate: object | undefined, required: object): string[] {
	return(Object.keys(required).filter(function(name) {
		return(candidate === undefined || Reflect.get(candidate, name) === undefined);
	}));
}

// The published package does not export these; patches/ adds them to lib.
const exposed: object | undefined = KeetaNet.lib.LedgerInternals;
const missing = findMissingInternals(exposed, requiredInternals);
if (missing.length > 0) {
	throw(new Error(`upstream ledger internals are not exposed: ${missing.join(', ')}`));
}

export const LedgerInternals: LedgerInternalsAPI = KeetaNet.lib.LedgerInternals;

export type KVInternalsAPI = {
	readonly KVStorageProviderMemory: typeof KVStorageProviderMemory;
};

const requiredKVInternals = {
	KVStorageProviderMemory: true
} satisfies Record<keyof KVInternalsAPI, true>;

// The published package exports no key-value store; patches/ adds the memory one to lib.
const exposedKV: object | undefined = KeetaNet.lib.KVInternals;
const missingKV = findMissingInternals(exposedKV, requiredKVInternals);
if (missingKV.length > 0) {
	throw(new Error(`upstream key-value internals are not exposed: ${missingKV.join(', ')}`));
}

export const KVInternals: KVInternalsAPI = KeetaNet.lib.KVInternals;

/** The parts of a socket of the bundled "ws" server that the node uses. */
export type BundledWebSocket = {
	once(event: 'close', listener: () => void): unknown;
	terminate(): void;
};

export type BundledWebSocketServerOptions = {
	readonly server: http.Server;
	readonly path: string;
	readonly maxPayload: number;
};

/** The parts of the bundled "ws" 8 WebSocketServer that the node uses. */
export type BundledWebSocketServer = {
	readonly clients: ReadonlySet<BundledWebSocket>;
	on(event: 'connection', listener: (socket: BundledWebSocket, request: http.IncomingMessage) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	close(callback: (error?: Error) => void): void;
};

export type BundledWebSocketServerConstructor = new (options: BundledWebSocketServerOptions) => BundledWebSocketServer;

export type P2PInternalsAPI = {
	readonly P2PWebSocket: typeof P2PWebSocket;
	readonly HTTPConnection: typeof HTTPConnectionClass;
	readonly P2PPeerFromJSO: typeof P2PPeerFromJSO;
	readonly P2PPeerToJSO: typeof P2PPeerToJSO;
	readonly P2P_WEBSOCKET_MAX_PAYLOAD_BYTES: number;
	readonly WebSocketServer: BundledWebSocketServerConstructor;
};

const requiredP2PInternals = {
	P2PWebSocket: true,
	HTTPConnection: true,
	P2PPeerFromJSO: true,
	P2PPeerToJSO: true,
	P2P_WEBSOCKET_MAX_PAYLOAD_BYTES: true,
	WebSocketServer: true
} satisfies Record<keyof P2PInternalsAPI, true>;

// The published package exports only the switch; patches/ adds its connection classes and the "ws" it bundles to lib.
const exposedP2P: object | undefined = KeetaNet.lib.P2PInternals;
const missingP2P = findMissingInternals(exposedP2P, requiredP2PInternals);
if (missingP2P.length > 0) {
	throw(new Error(`upstream peer-to-peer internals are not exposed: ${missingP2P.join(', ')}`));
}

/*
 * The client's typings name the server through "ws", whose types the package
 * does not ship, so it is checked to be the server class before it is given
 * the type of the parts the node uses.
 */
function isWebSocketServerConstructor(candidate: unknown): candidate is BundledWebSocketServerConstructor {
	return(typeof candidate === 'function' && candidate.name === 'WebSocketServer');
}

const exposedWebSocketServer: unknown = KeetaNet.lib.P2PInternals.WebSocketServer;
if (!isWebSocketServerConstructor(exposedWebSocketServer)) {
	throw(new Error('the exposed WebSocketServer is not the bundled "ws" server'));
}

export const P2PInternals: P2PInternalsAPI = {
	P2PWebSocket: KeetaNet.lib.P2PInternals.P2PWebSocket,
	HTTPConnection: KeetaNet.lib.P2PInternals.HTTPConnection,
	P2PPeerFromJSO: KeetaNet.lib.P2PInternals.P2PPeerFromJSO,
	P2PPeerToJSO: KeetaNet.lib.P2PInternals.P2PPeerToJSO,
	P2P_WEBSOCKET_MAX_PAYLOAD_BYTES: KeetaNet.lib.P2PInternals.P2P_WEBSOCKET_MAX_PAYLOAD_BYTES,
	WebSocketServer: exposedWebSocketServer
};

function isStatsPendingConstructor(candidate: unknown): candidate is typeof StatsPendingClass {
	return(typeof candidate === 'function' && candidate.name === 'StatsPending' && KeetaNet.lib.Stats.prototype instanceof candidate);
}

/*
 * Every storage transaction carries upstream's own pending-statistics
 * accumulator, which Stats.merge consumes on commit. The package exports only
 * its subclass Stats, so the class is reached as that export's parent.
 * [Keeta TS] index.js:74304-74352, 68952-68960
 */
const statsParent: unknown = Object.getPrototypeOf(KeetaNet.lib.Stats);
if (!isStatsPendingConstructor(statsParent)) {
	throw(new Error('upstream StatsPending is no longer the parent class of lib.Stats'));
}

export const StatsPending: typeof StatsPendingClass = statsParent;
