import { describe, expect, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { P2PConnection, P2PPeer, P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { useSDKNodes } from '../testing/sdk.js';
import type { ServingNode } from '../testing/sdk.js';
import { P2PInternals } from '../upstream/internals.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { formatManualPeer, getConfigFromEnv, localNodeConfig, manualPeerOf } from './config.js';
import type { Environment } from './config.js';
import { LocalNode } from './local.js';

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
};

/** Records what every switch does with its connections, from before any node is built. */
function logConnections(): ConnectionLog {
	const register = vi.spyOn(lib.P2P.prototype, 'registerConnection');
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
			/* A dialed connection is registered twice: as it opens, and once dialing is done [Keeta TS] index.js:72336-72342, 73631. */
			return([...new Set(connections)]);
		},
		released: function(connection) {
			return(unregister.mock.calls.some(function([unregistered], index): boolean {
				return(unregistered === connection && unregister.mock.settledResults[index]?.type === 'fulfilled');
			}));
		}
	});
}

describe('peers configured through the environment', function() {
	test('are dialed only once the node runs, so that it greets them with where it listens', async function() {
		const first = await nodes.start(await nodes.environmentFor('memory'));
		const config = getConfigFromEnv(await nodes.environmentFor('memory', { ...SECOND, KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, true) }));
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
	 * [Keeta TS] index.js:73642-73645, and reads back as known only a record
	 * that carries a valid signature [Keeta TS] index.js:72532-72536, 71828-71867;
	 * the peer's own greeting leaves it among the unverified ones
	 * [Keeta TS] index.js:73563-73567.
	 */
	test('without a signature are reached, but stay unverified', async function() {
		const first = await nodes.start(await nodes.environmentFor('memory'));
		const second = await nodes.start(await nodes.environmentFor('memory', { ...SECOND, KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, false) }));

		await second.node.switch.wait();

		expect(await second.node.switch.peers()).toEqual([]);
		expect(representativeKeys(await second.node.switch.peers({ includeUnverified: true }))).toEqual([keyOf(first.representative)]);
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

	/*
	 * The switch closes its connections as it stops [Keeta TS] index.js:72663-72673,
	 * but unregisters each, writing to its store, only once the socket has
	 * closed [Keeta TS] index.js:72324-72329, 72733-72750.
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

	test('are told to post staples over HTTP when the node prefers it', async function() {
		const first = await nodes.start(await nodes.environmentFor('memory'));
		const second = await nodes.start(await nodes.environmentFor('memory', { ...SECOND, KEETANET_LOCAL_NODE_PREFER_UPDATES: 'http', KEETANET_LOCAL_NODE_MANUAL_PEERS: await peerSettingOf(first, true) }));

		await second.node.switch.wait();

		expect(representativeKeys(await first.node.switch.peers({ includeUnverified: true }))).toEqual([keyOf(second.representative)]);
		expect(await first.node.switch.peers({ includeUnverified: true })).toMatchObject([{ preferUpdates: 'http' }]);
	});
});
