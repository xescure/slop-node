import http from 'node:http';
import { onTestFinished } from 'vitest';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import { P2P_PATH } from '../node/peers.js';
import { P2PInternals } from '../upstream/internals.js';

/** A representative's endpoint that accepts a node's WebSocket and its greeting, and never greets back. */
export type SilentPeer = {
	/** The peer as KEETANET_LOCAL_NODE_MANUAL_PEERS names it, unsigned. */
	readonly setting: string;
	/** Resolves once a node that dialed the peer has greeted it, and so waits for the peer's greeting. */
	readonly greeted: Promise<void>;
};

/** Listens on the loopback interface until the test ends. */
export async function startSilentPeer(key: Account): Promise<SilentPeer> {
	const server = http.createServer();
	const sockets = new P2PInternals.WebSocketServer({ server, path: P2P_PATH, maxPayload: P2PInternals.P2P_WEBSOCKET_MAX_PAYLOAD_BYTES });
	const greeted = new Promise<void>(function(resolve) {
		sockets.on('connection', function(socket): void {
			socket.once('message', resolve);
		});
	});
	await new Promise<void>(function(resolve, reject) {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	onTestFinished(async function() {
		for (const socket of sockets.clients) {
			socket.terminate();
		}
		await new Promise<void>(function(resolve) {
			sockets.close(function() {
				resolve();
			});
		});
		server.closeAllConnections();
		await new Promise<void>(function(resolve) {
			server.close(function() {
				resolve();
			});
		});
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw(new Error('the silent peer has no port'));
	}
	const origin = `127.0.0.1:${String(address.port)}`;
	return({ setting: `${key.publicKeyString.get()}@http://${origin}/api|ws://${origin}${P2P_PATH}`, greeted });
}
