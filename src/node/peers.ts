import type http from 'node:http';
import type { Logger } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { P2PInternals } from '../upstream/internals.js';
import type { BundledUpgradeInfo, BundledWebSocket, BundledWebSocketServer } from '../upstream/internals.js';

/** Where peers reach the node's peer-to-peer WebSocket, on the API's own server. */
export const P2P_PATH = '/p2p';

const LOG_SOURCE = 'P2P';

/** The answer to an upgrade beyond the node's limit of sockets: the node can take the socket once another closes. */
export const PEER_SOCKETS_FULL_STATUS = 503;

/**
 * The node's "/p2p" WebSocket server. Each socket a peer opens is attached to
 * the switch as the switch's own dialer attaches the sockets it opens
 * [Keeta TS] index.js:73462, 73467-73491, with frames bounded as the dialer
 * bounds them [Keeta TS] index.js:72960, 73398-73400, and at most
 * maxSockets of them open at once.
 * [node-lite] adapted from LocalNode.run.
 */
export class PeerServer {
	readonly #server: BundledWebSocketServer;
	readonly #switch: P2PSwitch;
	readonly #log: Logger;

	constructor(server: http.Server, p2pSwitch: P2PSwitch, log: Logger, maxSockets: number) {
		this.#switch = p2pSwitch;
		this.#log = log;
		this.#server = new P2PInternals.WebSocketServer({
			server,
			path: P2P_PATH,
			maxPayload: P2PInternals.P2P_WEBSOCKET_MAX_PAYLOAD_BYTES,
			// Answered at once, so the server upgrades before the next socket is counted.
			verifyClient: (_info: BundledUpgradeInfo, callback: (verified: boolean, code?: number) => void): void => {
				callback(this.#server.clients.size < maxSockets, PEER_SOCKETS_FULL_STATUS);
			}
		});
		this.#server.on('connection', (socket: BundledWebSocket, request: http.IncomingMessage): void => {
			this.#attach(socket, request);
		});
		this.#server.on('error', (error: Error): void => {
			this.#log.error(LOG_SOURCE, 'The peer-to-peer server failed:', error);
		});
	}

	/**
	 * The switch registers the socket as it attaches it, and the node's
	 * SwitchConnections (src/node/connections.ts) holds it from then until the
	 * switch has let go of it, which the node waits for as it stops. A socket
	 * that closes before its greeting is unregistered by the switch before the
	 * switch has registered it, which it then does
	 * [Keeta TS] index.js:73472-73477, 73856-73879; SwitchConnections
	 * unregisters it once registered, as it does the sockets the switch dials.
	 */
	#attach(socket: BundledWebSocket, request: http.IncomingMessage): void {
		void P2PInternals.P2PWebSocket.connectToSwitch(socket, this.#switch, request.socket).catch((error: unknown): void => {
			this.#log.error(LOG_SOURCE, 'Attaching a peer\'s socket to the switch failed:', error);
		});
	}

	/**
	 * Stops accepting sockets and drops every open one. Dropping rather than
	 * closing them cleanly does not wait for peers that no longer answer.
	 */
	async close(): Promise<void> {
		const closed = new Promise<void>((resolve, reject): void => {
			this.#server.close(function(error?: Error): void {
				if (error !== undefined) {
					reject(error);
					return;
				}
				resolve();
			});
		});
		for (const socket of this.#server.clients) {
			socket.terminate();
		}
		await closed;
	}
}
