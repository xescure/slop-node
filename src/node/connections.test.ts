import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Logger } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { P2PConnection, P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { requireAt } from '../ledger/storage/suite/support.js';
import { createTestNetwork } from '../testing/network.js';
import { opened, serveSwitch } from '../testing/peer-server.js';
import { SwitchConnections } from './connections.js';

const lib = KeetaNet.lib;

type Unregistering = (this: P2PSwitch, connection: P2PConnection) => Promise<void>;

function isUnregistering(candidate: unknown): candidate is Unregistering {
	return(typeof candidate === 'function');
}

type Registered = {
	readonly connection: P2PConnection;
	readonly registered: Promise<void>;
};

type Harness = {
	readonly connections: SwitchConnections;
	readonly p2pSwitch: P2PSwitch;
	readonly log: Logger;
	readonly url: string;
	/** Every registration of the switch, in turn, through the connections under test. */
	readonly registrations: readonly Registered[];
	/** Upstream's own unregistering, beneath the connections under test. */
	readonly unregister: MockInstance<Unregistering>;
	/** Holds upstream's unregistering of every connection from now on, until released. */
	readonly holdUnregistering: () => () => void;
};

/**
 * Connections held for the switch of a node that is no LocalNode, so that
 * they are the only ones, served on "/p2p" of a server of the test's own.
 */
async function harness(): Promise<Harness> {
	const unregisterConnection: unknown = Object.getOwnPropertyDescriptor(lib.P2P.prototype, 'unregisterConnection')?.value;
	if (!isUnregistering(unregisterConnection)) {
		throw(new Error('the switch has no unregisterConnection'));
	}
	let gate = Promise.resolve();
	const unregister = vi.spyOn(lib.P2P.prototype, 'unregisterConnection').mockImplementation(async function(this: P2PSwitch, connection: P2PConnection): Promise<void> {
		await gate;
		await unregisterConnection.call(this, connection);
	});
	onTestFinished(function() {
		unregister.mockRestore();
	});
	const network = await createTestNetwork({ representativeWeights: [1n] });
	const node = network.createNode(new MemoryLedgerStorage(), requireAt(network.representatives, 0));
	onTestFinished(async function() {
		await node.stop();
	});
	const connections = new SwitchConnections(node.switch, node.log);
	const register = node.switch.registerConnection.bind(node.switch);
	const registrations: Registered[] = [];
	node.switch.registerConnection = function(connection: P2PConnection): Promise<void> {
		const registered = register(connection);
		registrations.push({ connection, registered });
		return(registered);
	};
	const { url } = await serveSwitch(node.switch, node.log);
	return({
		connections,
		p2pSwitch: node.switch,
		log: node.log,
		url,
		registrations,
		unregister,
		holdUnregistering: function(): () => void {
			let release: () => void = function() {
				throw(new Error('internal error: released before holding'));
			};
			gate = new Promise<void>(function(resolve) {
				release = resolve;
			});
			return(release);
		}
	});
}

type PeerSocket = Registered & { readonly socket: WebSocket };

/** A socket opened to the switch, which the switch registers as it opens; a greeted one's registration ends with the greeting. */
async function socketTo(served: Harness, greeted: boolean): Promise<PeerSocket> {
	const index = served.registrations.length;
	const socket = new WebSocket(served.url);
	await opened(socket);
	const { connection, registered } = requireAt(served.registrations, index);
	if (greeted) {
		socket.send(JSON.stringify({ id: `greeting-${String(index)}`, greeting: { kind: lib.Node.Kind.PARTICIPANT }, ttl: 0 }));
		await registered;
	}
	return({ socket, connection, registered });
}

describe('the connections a switch holds', function() {
	test('are taken from the start, and let go of by the switch once their socket closes', async function() {
		const served = await harness();
		const { socket, connection } = await socketTo(served, true);

		expect(connection.abort).toBe(false);
		socket.close();

		await vi.waitFor(function() {
			expect(served.unregister).toHaveBeenCalledWith(connection);
		});
	});

	test('still being registered are closed as the node begins to stop, and no others', async function() {
		const served = await harness();
		const greeted = await socketTo(served, true);
		const registering = await socketTo(served, false);

		await served.connections.stopping();

		expect(registering.connection.abort).toBe(true);
		expect(greeted.connection.abort).toBe(false);
	});

	test('the switch registers once stopping are closed instead, until opened again', async function() {
		const served = await harness();
		await served.connections.stopping();

		const refused = await socketTo(served, false);
		await refused.registered;
		expect(refused.connection.abort).toBe(true);

		served.connections.open();
		const taken = await socketTo(served, true);
		expect(taken.connection.abort).toBe(false);
	});

	test('are all closed once the node stops, and those the switch registers after', async function() {
		const served = await harness();
		const registering = await socketTo(served, false);

		const closing = served.connections.closed();
		await vi.waitFor(function() {
			expect(registering.connection.abort).toBe(true);
		});
		await closing;

		const later = await socketTo(served, false);
		await later.registered;
		expect(later.connection.abort).toBe(true);
	});

	/* A dial registers its connection a second time once its first registration ends [Keeta TS] index.js:74778, even after its socket closed. */
	test('are unregistered once at a time, and again after a registration that follows', async function() {
		const served = await harness();
		const release = served.holdUnregistering();
		const { socket, connection } = await socketTo(served, true);
		socket.close();
		await vi.waitFor(function() {
			expect(served.unregister).toHaveBeenCalledTimes(1);
		});

		await served.p2pSwitch.registerConnection(connection);
		expect(served.unregister).toHaveBeenCalledTimes(1);
		release();

		await vi.waitFor(function() {
			expect(served.unregister).toHaveBeenCalledTimes(2);
		});
	});

	test('are unregistered after a registration that follows the switch letting go of them', async function() {
		const served = await harness();
		const { socket, connection } = await socketTo(served, true);
		socket.close();
		await vi.waitFor(function() {
			expect(served.unregister).toHaveBeenCalledTimes(1);
		});
		// Unregistering a connection the switch is letting go of waits until it has.
		await served.p2pSwitch.unregisterConnection(connection);

		await served.p2pSwitch.registerConnection(connection);

		await vi.waitFor(function() {
			expect(served.unregister).toHaveBeenCalledTimes(2);
		});
	});

	test('are let go of when the switch fails to unregister them, which is logged', async function() {
		const served = await harness();
		const failure = new Error('the switch failed to unregister the connection');
		served.unregister.mockRejectedValue(failure);
		const logged = vi.spyOn(served.log, 'error');
		const { socket, connection } = await socketTo(served, true);

		socket.close();

		await vi.waitFor(function() {
			expect(logged).toHaveBeenCalledWith('P2P', 'Unregistering a closed connection failed:', failure);
		});
		await served.p2pSwitch.unregisterConnection(connection);
	});
});
