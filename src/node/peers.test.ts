import http from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { P2PConnection } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { useLocalNodes } from '../testing/local-node.js';
import { P2PInternals } from '../upstream/internals.js';
import type { LocalNode } from './local.js';
import { DEFAULT_PEER_LIMITS } from './peer-limits.js';
import { P2P_PATH, PeerServer } from './peers.js';

const nodes = useLocalNodes();

/** Turns of the event loop in which closing has run out of anything to do but wait. */
const CLOSING_TURNS = 50;

async function eventLoopTurns(count: number): Promise<void> {
	for (let turn = 0; turn < count; turn++) {
		await new Promise<void>(function(resolve) {
			setImmediate(resolve);
		});
	}
}

/**
 * An HTTP server of the test's own on the loopback interface, closed as the
 * test ends with every connection it took, upgraded ones included, which
 * closeAllConnections leaves open.
 */
async function listeningServer(): Promise<http.Server> {
	const server = http.createServer();
	const sockets = new Set<Socket>();
	server.on('connection', function(socket: Socket): void {
		sockets.add(socket);
	});
	await new Promise<void>(function(resolve, reject) {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	onTestFinished(async function() {
		for (const socket of sockets) {
			socket.destroy();
		}
		await new Promise<void>(function(resolve) {
			server.close(function() {
				resolve();
			});
		});
	});
	return(server);
}

/** The node's switch served on "/p2p" of a server of the test's own, the node itself not running. */
async function peerServerOf(node: LocalNode): Promise<{ readonly peers: PeerServer; readonly server: http.Server; readonly url: string }> {
	const server = await listeningServer();
	const peers = new PeerServer(server, node.switch, node.log, DEFAULT_PEER_LIMITS.sockets);
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw(new Error('the server listens on no port'));
	}
	return({ peers, server, url: `ws://127.0.0.1:${String(address.port)}${P2P_PATH}` });
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

describe('the peer-to-peer server', function() {
	test('logs a failure of the server, rather than leaving the failure to end the process', async function() {
		const { node } = await nodes.create();
		const { server } = await peerServerOf(node);
		const logged = vi.spyOn(node.log, 'error');
		const failure = new Error('the server failed');

		server.emit('error', failure);

		expect(logged).toHaveBeenCalledWith('P2P', 'The peer-to-peer server failed:', failure);
	});

	test('logs a socket the switch fails to take', async function() {
		const { node } = await nodes.create();
		const { url } = await peerServerOf(node);
		const failure = new Error('the switch failed to take the socket');
		vi.spyOn(P2PInternals.P2PWebSocket, 'connectToSwitch').mockRejectedValue(failure);
		const logged = vi.spyOn(node.log, 'error');

		const socket = new WebSocket(url);
		await opened(socket);

		await vi.waitFor(function() {
			expect(logged).toHaveBeenCalledWith('P2P', 'Attaching a peer\'s socket to the switch failed:', failure);
		});
		socket.close();
	});

	test('waits as it closes until the switch has done taking each socket', async function() {
		const { node } = await nodes.create();
		const { peers, url } = await peerServerOf(node);
		const register = node.switch.registerConnection.bind(node.switch);
		let started: () => void = function() {
			throw(new Error('internal error: registered before the test waited'));
		};
		const registering = new Promise<void>(function(resolve) {
			started = resolve;
		});
		let release: () => void = function() {
			throw(new Error('internal error: released before the registration started'));
		};
		const held = new Promise<void>(function(resolve) {
			release = resolve;
		});
		vi.spyOn(node.switch, 'registerConnection').mockImplementation(async function(connection: P2PConnection): Promise<void> {
			started();
			await held;
			await register(connection);
		});
		const socket = new WebSocket(url);
		await opened(socket);
		await registering;

		let finished = false;
		const closing = peers.close().then(function() {
			finished = true;
		});
		await eventLoopTurns(CLOSING_TURNS);
		const closedBeforeTaken = finished;
		release();
		await closing;

		expect(closedBeforeTaken).toBe(false);
	});

	test('answers a failure to close the server', async function() {
		const { node } = await nodes.create();
		const { peers } = await peerServerOf(node);
		await peers.close();

		await expect(peers.close()).rejects.toThrow('The server is not running');
	});
});
