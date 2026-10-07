import type { P2PConnection, P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { P2PInternals } from '../upstream/internals.js';

type Held = {
	readonly released: Promise<void>;
	readonly release: () => void;
};

function held(): Held {
	let resolveReleased: (() => void) | undefined;
	const released = new Promise<void>(function(resolve) {
		resolveReleased = resolve;
	});
	return({
		released,
		release: function(): void {
			resolveReleased?.();
		}
	});
}

/**
 * The WebSocket connections a switch holds, until it lets go of each. The
 * switch closes them as it stops [Keeta TS] index.js:72663-72673, but
 * unregisters each, writing to its key-value store, only once the socket has
 * closed [Keeta TS] index.js:72324-72329, 72733-72750, which takes the peer's
 * answer to the closing handshake; the store must stay open until then.
 */
export class SwitchConnections {
	readonly #held = new Map<P2PConnection, Held>();
	/** A socket can close before the switch registers its connection [Keeta TS] index.js:72324-72342. */
	readonly #released = new WeakSet<P2PConnection>();

	constructor(p2pSwitch: P2PSwitch) {
		const register = p2pSwitch.registerConnection.bind(p2pSwitch);
		const unregister = p2pSwitch.unregisterConnection.bind(p2pSwitch);
		p2pSwitch.registerConnection = (connection: P2PConnection): Promise<void> => {
			this.#hold(connection);
			return(register(connection));
		};
		p2pSwitch.unregisterConnection = async (connection: P2PConnection): Promise<void> => {
			try {
				await unregister(connection);
			} finally {
				this.#release(connection);
			}
		};
	}

	/** A dialed connection is registered twice: as it opens, and once dialing is done [Keeta TS] index.js:72336-72342, 73631. */
	#hold(connection: P2PConnection): void {
		if (!P2PInternals.P2PWebSocket.isInstance(connection) || this.#released.has(connection) || this.#held.has(connection)) {
			return;
		}
		this.#held.set(connection, held());
	}

	#release(connection: P2PConnection): void {
		this.#released.add(connection);
		this.#held.get(connection)?.release();
		this.#held.delete(connection);
	}

	/**
	 * Resolves once the switch has let go of every connection it is closing.
	 * One it is not closing, such as one still waiting for a greeting as the
	 * switch stops, is not waited for, since nothing closes it.
	 */
	async closed(): Promise<void> {
		const closing = [...this.#held].filter(function([connection]): boolean {
			return(connection.abort);
		});
		await Promise.all(closing.map(function([, holding]): Promise<void> {
			return(holding.released);
		}));
	}
}
