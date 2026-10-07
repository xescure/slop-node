import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { assertNever } from '../util/assert-never.js';

const LOOPBACK = '127.0.0.1';

/**
 * The process, of those given, that opened the connection the socket is the
 * proxy's end of, if any of them did.
 */
export type ConnectionOrigin = (socket: Socket, candidates: ReadonlySet<number>) => Promise<number | undefined>;

/** Which connections are passed on to the target. */
type Admission =
	| { readonly kind: 'all' }
	| { readonly kind: 'none' }
	| { readonly kind: 'not-from'; readonly processIDs: ReadonlySet<number> };

type Connection = {
	readonly client: Socket;
	upstream: Socket | undefined;
};

export type TCPProxyOptions = {
	/** The port on the loopback interface that connections are passed on to. */
	readonly target: number;
	readonly origin: ConnectionOrigin;
};

function ignoreError(): void {
	// A connection that fails is cut, which its close handler does.
}

function cut(connection: Connection): void {
	connection.client.destroy();
	connection.upstream?.destroy();
}

/**
 * Stands in front of a node at an address of its own, which the node
 * advertises, so that whatever reaches the node passes through it and can be
 * held, cut off or refused.
 */
export class TCPProxy {
	readonly port: number;
	readonly #server: Server;
	readonly #origin: ConnectionOrigin;
	readonly #connections = new Set<Connection>();
	/** Admitted while the target was not ready, in the order they came. */
	readonly #held = new Set<Connection>();
	#target: number;
	#holding = false;
	#admission: Admission = { kind: 'all' };

	private constructor(server: Server, port: number, options: TCPProxyOptions) {
		this.#server = server;
		this.port = port;
		this.#target = options.target;
		this.#origin = options.origin;
		server.on('connection', (client: Socket) => {
			this.#accept(client);
		});
	}

	static start(options: TCPProxyOptions): Promise<TCPProxy> {
		const server = createServer();
		return(new Promise(function(resolve, reject) {
			server.once('error', reject);
			server.listen(0, LOOPBACK, function() {
				server.off('error', reject);
				const address = server.address();
				if (address === null || typeof address === 'string') {
					reject(new Error(`the proxy has no TCP address: ${String(address)}`));
					return;
				}
				resolve(new TCPProxy(server, address.port, options));
			});
		}));
	}

	/** Passes new connections to another port, where the node listens after a restart. */
	setTarget(port: number): void {
		this.#target = port;
	}

	/** Keeps new connections waiting, while the node is not yet listening, instead of having them refused. */
	hold(): void {
		this.#holding = true;
	}

	/** Passes on the connections held, and new ones as they come. */
	release(): void {
		this.#holding = false;
		const held = [...this.#held];
		this.#held.clear();
		for (const connection of held) {
			this.#forward(connection);
		}
	}

	/** Cuts every connection, held ones too, and closes each new one at once, until unblocked. */
	block(): void {
		this.#admission = { kind: 'none' };
		for (const connection of this.#connections) {
			cut(connection);
		}
	}

	unblock(): void {
		this.#admission = { kind: 'all' };
	}

	/**
	 * Cuts the connections the processes opened, and closes theirs at once
	 * from now on; an empty set admits every process again.
	 */
	async refuseFrom(processIDs: ReadonlySet<number>): Promise<void> {
		if (processIDs.size === 0) {
			this.#admission = { kind: 'all' };
			return;
		}
		const admission: Admission = { kind: 'not-from', processIDs: new Set(processIDs) };
		this.#admission = admission;
		await Promise.all([...this.#connections].map(async (connection): Promise<void> => {
			if (!await this.#admits(admission, connection.client)) {
				cut(connection);
			}
		}));
	}

	async close(): Promise<void> {
		const closing = new Promise<void>((resolve) => {
			this.#server.close(function() {
				resolve();
			});
		});
		for (const connection of this.#connections) {
			cut(connection);
		}
		await closing;
	}

	#accept(client: Socket): void {
		const connection: Connection = { client, upstream: undefined };
		this.#connections.add(connection);
		client.on('error', ignoreError);
		client.once('close', () => {
			this.#connections.delete(connection);
			this.#held.delete(connection);
			cut(connection);
		});
		void this.#admit(connection);
	}

	async #admit(connection: Connection): Promise<void> {
		const admitted = await this.#admits(this.#admission, connection.client);
		// Blocking cuts every connection, those still being admitted as well.
		if (connection.client.destroyed) {
			return;
		}
		if (!admitted) {
			cut(connection);
			return;
		}
		if (this.#holding) {
			this.#held.add(connection);
			return;
		}
		this.#forward(connection);
	}

	async #admits(admission: Admission, client: Socket): Promise<boolean> {
		switch (admission.kind) {
			case 'all':
				return(true);
			case 'none':
				return(false);
			case 'not-from':
				return(await this.#origin(client, admission.processIDs) === undefined);
			default:
				return(assertNever(admission));
		}
	}

	/** The client's bytes wait in its socket, which is not read until it is piped. */
	#forward(connection: Connection): void {
		const { client } = connection;
		if (client.destroyed) {
			return;
		}
		const upstream = connect(this.#target, LOOPBACK);
		connection.upstream = upstream;
		upstream.on('error', ignoreError);
		upstream.once('close', function() {
			cut(connection);
		});
		client.pipe(upstream);
		upstream.pipe(client);
	}
}
