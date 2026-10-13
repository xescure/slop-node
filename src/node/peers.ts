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
 * [Keeta TS] index.js:72314, 72319-72343, with frames bounded as the dialer
 * bounds them [Keeta TS] index.js:71812, 72250-72252, and at most
 * maxSockets of them open at once.
 * [node-lite] adapted from LocalNode.run.
 */
export class PeerServer {
	readonly #server: BundledWebSocketServer;
	readonly #switch: P2PSwitch;
	readonly #log: Logger;
	/** Sockets the switch has not yet taken: it waits for each one's greeting first [Keeta TS] index.js:72708. */
	readonly #attaching = new Set<Promise<unknown>>();

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
	 * A socket that closes before its greeting is unregistered by the switch
	 * before the switch has registered it, which it then does
	 * [Keeta TS] index.js:72324-72329, 72708-72731; the node's SwitchConnections
	 * unregisters it once registered (src/node/connections.ts), as it does the
	 * sockets the switch dials.
	 */
	#attach(socket: BundledWebSocket, request: http.IncomingMessage): void {
		const attaching = P2PInternals.P2PWebSocket.connectToSwitch(socket, this.#switch, request.socket).catch((error: unknown): void => {
			this.#log.error(LOG_SOURCE, 'Attaching a peer\'s socket to the switch failed:', error);
		}).finally((): void => {
			this.#attaching.delete(attaching);
		});
		this.#attaching.add(attaching);
	}

	/**
	 * Stops accepting sockets and drops every open one, then waits until each
	 * has closed and the switch is done with it. Dropping rather than closing
	 * them cleanly does not wait for peers that no longer answer.
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
		await Promise.all(this.#attaching);
	}
}
