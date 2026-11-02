import { describe, expect, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { P2PConnection, P2PPeer, P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { NO_REPRESENTATIVES, TEST_NETWORK_SEEDS } from '../testing/network.js';
import { useSDKNodes } from '../testing/sdk.js';
import type { ServingNode } from '../testing/sdk.js';
import { startSilentPeer } from '../testing/silent-peer.js';
import { P2PInternals } from '../upstream/internals.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { formatManualPeer, getConfigFromEnv, localNodeConfig, manualPeerOf } from './config.js';
import type { Environment } from './config.js';
import { LocalNode } from './local.js';
import { closeStorage, nodeResourcesOf, openStorage } from './storage.js';

const lib = KeetaNet.lib;

const nodes = useSDKNodes();

/** A second representative of the seed the first node votes with. */
const SECOND: Environment = { KEETANET_LOCAL_NODE_SEED_INDEX: '1' };

function keyOf(account: Account): string {
	return(account.publicKeyString.get());
}

function representativeKeys(peers: readonly P2PPeer[]): string[] {
	return(peers.flatMap(function(peer): string[] {
		if (peer.kind !== lib.Node.Kind.REPRESENTATIVE) {
			return([]);
		}
		return([keyOf(peer.key)]);
	}).sort());
}

/** The node as another names it in KEETANET_LOCAL_NODE_MANUAL_PEERS, signed or not. */
async function peerSettingOf(serving: ServingNode, signed: boolean): Promise<string> {
	const peer = manualPeerOf(await serving.node.switch.getOutgoingGreetingInfo());
	if (peer === undefined) {
		throw(new Error('the node advertises no valid peer record'));
	}
	if (signed) {
		return(formatManualPeer(peer));
	}
	return(`${keyOf(peer.key)}@${peer.endpoints.api}|${peer.endpoints.p2p}`);
}

type ConnectionLog = {
	/** The WebSocket connections the switch registered. */
	readonly registered: (p2pSwitch: P2PSwitch) => readonly P2PConnection[];
	/** Whether the switch has finished unregistering the connection. */
	readonly released: (connection: P2PConnection) => boolean;
	/** Whether every registration of the connection has settled, and an unregistering started after the last one has finished. */
	readonly settled: (connection: P2PConnection) => boolean;
	/** How often the switch itself unregistered the connection. */
	readonly timesUnregistered: (connection: P2PConnection) => number;
	/** Whether the connection was closing as each of its registrations ended. */
	readonly closingAsRegistered: (connection: P2PConnection) => readonly boolean[];
};

type Registration = (this: P2PSwitch, connection: P2PConnection) => Promise<void>;

function isRegistration(candidate: unknown): candidate is Registration {
	return(typeof candidate === 'function');
}

/** Records what every switch does with its connections, from before any node is built. */
function logConnections(): ConnectionLog {
	const registerConnection: unknown = Object.getOwnPropertyDescriptor(lib.P2P.prototype, 'registerConnection')?.value;
	if (!isRegistration(registerConnection)) {
		throw(new Error('the switch has no registerConnection'));
	}
	const closingAsRegistered = new Map<P2PConnection, boolean[]>();
	const register = vi.spyOn(lib.P2P.prototype, 'registerConnection').mockImplementation(async function(this: P2PSwitch, connection: P2PConnection): Promise<void> {
		await registerConnection.call(this, connection);
		closingAsRegistered.set(connection, [...closingAsRegistered.get(connection) ?? [], connection.abort]);
	});
	const unregister = vi.spyOn(lib.P2P.prototype, 'unregisterConnection');
	onTestFinished(function() {
		vi.restoreAllMocks();
	});
	return({
		registered: function(p2pSwitch) {
			const connections = register.mock.calls.flatMap(function([connection], index): P2PConnection[] {
				if (register.mock.contexts[index] !== p2pSwitch || !P2PInternals.P2PWebSocket.isInstance(connection)) {
					return([]);
				}
				return([connection]);
			});
			/* A dialed connection is registered twice: as it opens, and once dialing is done [Keeta TS] index.js:73484-73490, 74779. */
			return([...new Set(connections)]);
		},
		released: function(connection) {
			return(unregister.mock.calls.some(function([unregistered], index): boolean {
				return(unregistered === connection && unregister.mock.settledResults[index]?.type === 'fulfilled');
			}));
		},
		settled: function(connection) {
			const registrations: number[] = [];
			for (const [index, [registered]] of register.mock.calls.entries()) {
				if (registered !== connection) {
					continue;
				}
				if (register.mock.settledResults[index]?.type !== 'fulfilled') {
					return(false);
				}
				registrations.push(register.mock.invocationCallOrder[index] ?? Infinity);
			}
			const lastRegistration = Math.max(...registrations);
			return(unregister.mock.calls.some(function([unregistered], index): boolean {
				return(unregistered === connection && unregister.mock.settledResults[index]?.type === 'fulfilled' && (unregister.mock.invocationCallOrder[index] ?? 0) > lastRegistration);
			}));
		},
		closingAsRegistered: function(connection) {
			return(closingAsRegistered.get(connection) ?? []);
		},
		timesUnregistered: function(connection) {
			return(unregister.mock.calls.filter(function([unregistered]): boolean {
				return(unregistered === connection);
			}).length);
		}
	});
}

describe('peers configured through the environment', function() {
	test('are dialed only once the node runs, so that it greets them with where it listens', async function() {
		const first = await nodes.start(await nodes.environmentFor('memory'));
		const config = getConfigFromEnv(await nodes.environmentFor('memory', { ...SECOND, KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, true) }), NO_REPRESENTATIVES);
		const second = new LocalNode(localNodeConfig(config, { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() }));
		onTestFinished(function() {
			return(second.stop());
		});

		await second.switch.wait();
		expect(await second.switch.config.kv.getAll('knownPeers')).toEqual({});
		expect(await first.node.switch.config.kv.getAll('potentialPeers')).toEqual({});

		await second.run();
		await second.switch.wait();
		expect(representativeKeys(await second.switch.peers())).toEqual([keyOf(first.representative)]);
		const [greeted, ...others] = await first.node.switch.peers({ includeUnverified: true });
		expect(others).toEqual([]);
		expect(greeted).toMatchObject({ endpoints: second.config.endpoints });
		expect(representativeKeys([greeted ?? { kind: lib.Node.Kind.PARTICIPANT, id: '' }])).toEqual([keyOf(config.representative)]);
	});

	/*
	 * After dialing, the switch records a manual peer as given
	 * [Keeta TS] index.js:74790-74793, and reads back as known only a record
	 * that carries a valid signature [Keeta TS] index.js:73680-73684, 72976-73015.
	 * The peer's greeting is signed by its own key, which proves the record.
	 */
	test('without a signature are reached, and verified by the advertisement they greet with', async function() {
		const first = await nodes.start(await nodes.environmentFor('memory'));
		const second = await nodes.start(await nodes.environmentFor('memory', { ...SECOND, KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, false) }));

		await second.node.switch.wait();

		const [verified, ...others] = await second.node.switch.peers();
		expect(others).toEqual([]);
		expect(verified).toEqual(manualPeerOf(await first.node.switch.getOutgoingGreetingInfo()));
		expect(representativeKeys(await first.node.switch.peers({ includeUnverified: true }))).toEqual([keyOf(second.representative)]);
	});

	test('are dialed by a node voting on the test network, where this node may vote with peers, and greet it back', async function() {
		const onTest: Environment = { KEETANET_LOCAL_NODE_NETWORK: 'test', KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-write' };
		const first = await nodes.start(await nodes.environmentFor('postgres', onTest));
		const second = await nodes.start(await nodes.environmentFor('postgres', { ...onTest, ...SECOND, KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, true) }));

		await second.node.switch.wait();

		expect(representativeKeys(await second.node.switch.peers())).toEqual([keyOf(first.representative)]);
		expect(representativeKeys(await first.node.switch.peers({ includeUnverified: true }))).toEqual([keyOf(second.representative)]);
	});

	test('are remembered across a restart when the node keeps its state in Postgres', async function() {
		const first = await nodes.start(await nodes.environmentFor('memory'));
		const environment = await nodes.environmentFor('postgres', SECOND);
		const second = await nodes.start({ ...environment, KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, true) });
		await second.node.switch.wait();
		await second.stop();

		const restarted = await nodes.start(environment);

		expect(restarted.node.config.manualPeers).toEqual([]);
		expect(representativeKeys(await restarted.node.switch.peers())).toEqual([keyOf(first.representative)]);
	});

	test('are listed after a restart that finds a record without a signature beside the greeting signed by the peer', async function() {
		const first = await nodes.start(await nodes.environmentFor('memory'));
		const environment = await nodes.environmentFor('postgres', SECOND);
		const second = await nodes.start({ ...environment, KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, true) });
		await second.node.switch.wait();
		await second.stop();

		// As a node that recorded the peer before it kept greetings left its store.
		const advertisement = await first.node.switch.getOutgoingGreetingInfo();
		const peer = manualPeerOf(advertisement);
		if (peer === undefined) {
			throw(new Error('the node advertises no valid peer record'));
		}
		const key = keyOf(peer.key);
		const storage = openStorage(getConfigFromEnv(environment, NO_REPRESENTATIVES).storage);
		if (storage.kind !== 'postgres') {
			throw(new Error('the node keeps no store of its own'));
		}
		await storage.kv.set('knownPeers', key, P2PInternals.P2PPeerToJSO({ kind: peer.kind, key: peer.key, endpoints: peer.endpoints, preferUpdates: peer.preferUpdates, certificate: null }));
		await storage.kv.set('potentialPeers', key, advertisement);
		await closeStorage(storage);
		// Gone, so that no new greeting records it again.
		await first.stop();

		const restarted = await nodes.start(environment);

		expect(representativeKeys(await restarted.node.switch.peers())).toEqual([keyOf(first.representative)]);
	});

	/*
	 * The switch closes its connections as it stops [Keeta TS] index.js:73811-73821,
	 * but unregisters each, writing to its store, only once the socket has
	 * closed [Keeta TS] index.js:73472-73477, 73881-73898.
	 */
	test('let the node stop only once its switch is done with them, so that nothing is written to a closed store', async function() {
		const connections = logConnections();
		const first = await nodes.start(await nodes.environmentFor('memory'));
		const second = await nodes.start(await nodes.environmentFor('postgres', { ...SECOND, KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, true) }));
		await second.node.switch.wait();
		const dialed = connections.registered(second.node.switch);
		expect(dialed).toHaveLength(1);

		await second.stop();

		expect(dialed.map(connections.released)).toEqual([true]);
	});

	/*
	 * A dial waits for the peer's greeting before the switch takes the
	 * connection [Keeta TS] index.js:73293-73304, 73856, and stopping waits for
	 * the dial [Keeta TS] index.js:72501-72504 but closes only the connections
	 * the switch has taken [Keeta TS] index.js:73811-73821; the registration
	 * then adds the connection to the switch and its store anyway
	 * [Keeta TS] index.js:73856-73879.
	 */
	test('still waiting for a greeting are closed as the node stops, so that nothing is written to a closed store', async function() {
		const connections = logConnections();
		const peer = await startSilentPeer(lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 1));
		const config = getConfigFromEnv(await nodes.environmentFor('postgres', { KEETANET_LOCAL_NODE_MANUAL_PEERS: peer.setting }), NO_REPRESENTATIVES);
		const storage = openStorage(config.storage);
		if (storage.kind !== 'postgres') {
			throw(new Error('the node keeps no store in Postgres'));
		}
		const writes = vi.spyOn(storage.kv, 'set');
		const node = new LocalNode(localNodeConfig(config, nodeResourcesOf(storage, new lib.Log())));
		await node.run();
		await peer.greeted;

		await node.stop();
		await closeStorage(storage);

		const [dialed, ...others] = connections.registered(node.switch);
		expect(others).toEqual([]);
		if (dialed === undefined) {
			throw(new Error('the node dialed no one'));
		}
		// The registration ended because the connection was closed, not because the greeting never came; the dial's second is not passed on.
		expect(connections.closingAsRegistered(dialed)).toEqual([true]);
		expect(connections.settled(dialed)).toBe(true);
		expect(writes.mock.settledResults.map(function(result): string {
			return(result.type);
		})).not.toContain('incomplete');
		expect(writes.mock.settledResults.map(function(result): string {
			return(result.type);
		})).not.toContain('rejected');
	});

	/* A socket's error is followed by its close, and each unregisters the connection [Keeta TS] index.js:73472-73477. */
	test('are unregistered once, however often the switch is told to', async function() {
		const connections = logConnections();
		const first = await nodes.start(await nodes.environmentFor('memory'));
		const second = await nodes.start(await nodes.environmentFor('memory', { ...SECOND, KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, true) }));
		await second.node.switch.wait();
		const [dialed] = connections.registered(second.node.switch);
		if (dialed === undefined) {
			throw(new Error('the node dialed no one'));
		}
		const p2pSwitch = second.node.switch;
		const unregister = p2pSwitch.unregisterConnection.bind(p2pSwitch);
		let told = 0;
		const toldOnClose = new Promise<void>(function(resolve) {
			vi.spyOn(p2pSwitch, 'unregisterConnection').mockImplementation(function(connection: P2PConnection): Promise<void> {
				if (connection === dialed) {
					told++;
				}
				// The test tells the switch twice, as a socket's error would; its close tells it the third time.
				if (told === 3) {
					resolve();
				}
				return(unregister(connection));
			});
		});

		await Promise.all([p2pSwitch.unregisterConnection(dialed), p2pSwitch.unregisterConnection(dialed), dialed.close()]);
		await toldOnClose;

		expect(connections.timesUnregistered(dialed)).toBe(1);
	});

	test('are told to post staples over HTTP when the node prefers it', async function() {
		const first = await nodes.start(await nodes.environmentFor('memory'));
		const second = await nodes.start(await nodes.environmentFor('memory', { ...SECOND, KEETANET_LOCAL_NODE_PREFER_UPDATES: 'http', KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, true) }));

		await second.node.switch.wait();

		expect(representativeKeys(await first.node.switch.peers({ includeUnverified: true }))).toEqual([keyOf(second.representative)]);
		expect(await first.node.switch.peers({ includeUnverified: true })).toMatchObject([{ preferUpdates: 'http' }]);
	});
});
