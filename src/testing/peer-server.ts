import http from 'node:http';
import type { Socket } from 'node:net';
import { onTestFinished } from 'vitest';
import type { Logger } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { DEFAULT_PEER_LIMITS } from '../node/peer-limits.js';
import { P2P_PATH, PeerServer } from '../node/peers.js';

export type ServedSwitch = {
	readonly peers: PeerServer;
	readonly server: http.Server;
	/** Where a WebSocket reaches the switch. */
	readonly url: string;
};

/**
 * The switch served on "/p2p" of an HTTP server of the test's own, on the
 * loopback interface, closed as the test ends with every connection it took,
 * upgraded ones included, which closeAllConnections leaves open.
 */
export async function serveSwitch(p2pSwitch: P2PSwitch, log: Logger): Promise<ServedSwitch> {
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
	const peers = new PeerServer(server, p2pSwitch, log, DEFAULT_PEER_LIMITS.sockets);
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw(new Error('the server listens on no port'));
	}
	return({ peers, server, url: `ws://127.0.0.1:${String(address.port)}${P2P_PATH}` });
}

export function opened(socket: WebSocket): Promise<void> {
	return(new Promise<void>(function(resolve, reject) {
		socket.addEventListener('open', function() {
			resolve();
		}, { once: true });
		socket.addEventListener('error', function() {
			reject(new Error('the WebSocket did not open'));
		}, { once: true });
	}));
}
