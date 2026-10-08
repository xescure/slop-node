import type { Logger } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { P2PConnection, P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { P2PInternals, wrapSwitchConnections } from '../upstream/internals.js';
import type { SwitchConnectionMethods } from '../upstream/internals.js';

const LOG_SOURCE = 'P2P';

type Settled = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

function settled(): Settled {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>(function(resolve) {
		resolvePromise = resolve;
	});
	return({
		promise,
		resolve: function(): void {
			resolvePromise?.();
		}
	});
}

/** What the switch is doing with one WebSocket connection. */
type Tracked = {
	/** A dialed connection is registered twice: as it opens, and once dialing is done [Keeta TS] index.js:72336-72342, 73631. */
	registrations: number;
	/** Its socket has closed, or failed, so the switch must let go of it. */
	closed: boolean;
	/**
	 * A registration ends by adding the connection to the switch's own and to
	 * its store, even once the socket has closed [Keeta TS] index.js:72150, 72708-72731,
	 * so it must be unregistered after every one.
	 */
	mustUnregister: boolean;
	unregistering: Promise<void> | undefined;
	readonly released: Settled;
};

/**
 * The WebSocket connections a switch holds, until it lets go of each, so
 * that the store it writes to stays open until then. A connection is held
 * until its registrations and the unregistering after them have settled, and the
 * switch unregisters it only once its socket has closed
 * [Keeta TS] index.js:72324-72329, 72733-72750.
 */
export class SwitchConnections {
	readonly #log: Logger;
	readonly #tracked = new Map<P2PConnection, Tracked>();
	readonly #closedSockets = new WeakSet<P2PConnection>();
	readonly #released = new WeakSet<P2PConnection>();
	#stopping = false;

	constructor(p2pSwitch: P2PSwitch, log: Logger) {
		this.#log = log;
		wrapSwitchConnections(p2pSwitch, (upstream: SwitchConnectionMethods): SwitchConnectionMethods => {
			return({
				registerConnection: (connection: P2PConnection): Promise<void> => {
					return(this.#register(upstream, connection));
				},
				unregisterConnection: (connection: P2PConnection): Promise<void> => {
					return(this.#unregister(upstream, connection));
				}
			});
		});
	}

	async #register(upstream: SwitchConnectionMethods, connection: P2PConnection): Promise<void> {
		if (!P2PInternals.P2PWebSocket.isInstance(connection)) {
			await upstream.registerConnection(connection);
			return;
		}
		const tracked = this.#track(connection);
		tracked.registrations++;
		try {
			if (this.#stopping) {
				// Registering would greet the peer and add the connection to the switch and its store, only for it to be let go.
				if (!connection.abort) {
					await connection.close();
				}
				return;
			}
			await upstream.registerConnection(connection);
		} finally {
			tracked.registrations--;
			tracked.mustUnregister = true;
			this.#settle(upstream, connection, tracked);
		}
	}

	/**
	 * A socket's error is followed by its close, and each unregisters the
	 * connection [Keeta TS] index.js:72324-72329; the second, and any once the
	 * switch has let go, waits for the first rather than unregistering again.
	 */
	async #unregister(upstream: SwitchConnectionMethods, connection: P2PConnection): Promise<void> {
		if (!P2PInternals.P2PWebSocket.isInstance(connection)) {
			await upstream.unregisterConnection(connection);
			return;
		}
		this.#closedSockets.add(connection);
		let tracked = this.#tracked.get(connection);
		if (tracked === undefined) {
			if (this.#released.has(connection)) {
				return;
			}
			tracked = this.#track(connection);
		}
		if (!tracked.closed) {
			tracked.closed = true;
			tracked.mustUnregister = true;
			this.#settle(upstream, connection, tracked);
		}
		await tracked.released.promise;
	}

	#track(connection: P2PConnection): Tracked {
		const existing = this.#tracked.get(connection);
		if (existing !== undefined) {
			return(existing);
		}
		this.#released.delete(connection);
		const tracked: Tracked = {
			registrations: 0,
			closed: this.#closedSockets.has(connection),
			mustUnregister: false,
			unregistering: undefined,
			released: settled()
		};
		this.#tracked.set(connection, tracked);
		return(tracked);
	}

	/** Unregisters a closed connection once no registration is in flight, and lets it go once nothing is due. */
	#settle(upstream: SwitchConnectionMethods, connection: P2PConnection, tracked: Tracked): void {
		if (tracked.registrations > 0 || tracked.unregistering !== undefined || !tracked.closed) {
			return;
		}
		if (tracked.mustUnregister) {
			tracked.mustUnregister = false;
			tracked.unregistering = upstream.unregisterConnection(connection).catch((error: unknown): void => {
				this.#log.error(LOG_SOURCE, 'Unregistering a closed connection failed:', error);
			}).finally((): void => {
				tracked.unregistering = undefined;
				this.#settle(upstream, connection, tracked);
			});
			return;
		}
		this.#tracked.delete(connection);
		this.#released.add(connection);
		tracked.released.resolve();
	}

	/**
	 * Stopping the switch waits for its dials first [Keeta TS] index.js:71373-71376, 72674,
	 * and a dial waits up to seconds for the peer's greeting
	 * [Keeta TS] index.js:72145-72156, 72708, 73631-73632; the switch then
	 * closes only the connections it has taken [Keeta TS] index.js:72663-72673.
	 * So the connections still being registered, which carry nothing yet, are
	 * closed now, and any the switch registers from now on is closed instead.
	 */
	stopping(): Promise<void> {
		this.#stopping = true;
		return(this.#closeAll(function(tracked: Tracked): boolean {
			return(tracked.registrations > 0);
		}));
	}

	/**
	 * Closes every held connection that is not closing yet, then resolves once
	 * the switch has let go of every one, those it registers meanwhile included.
	 * Any connection the switch registers from then on is closed instead, until
	 * opened again: work of the switch that nothing waits for may still dial
	 * [Keeta TS] index.js:73211-73235, 73324.
	 */
	async closed(): Promise<void> {
		this.#stopping = true;
		await this.#closeAll(function(): boolean {
			return(true);
		});
		while (this.#tracked.size > 0) {
			await Promise.all([...this.#tracked.values()].map(function(tracked): Promise<void> {
				return(tracked.released.promise);
			}));
		}
	}

	/** Lets the switch register connections again, as the node runs. */
	open(): void {
		this.#stopping = false;
	}

	async #closeAll(select: (tracked: Tracked) => boolean): Promise<void> {
		const closing = [...this.#tracked].filter(function([connection, tracked]): boolean {
			return(!connection.abort && select(tracked));
		});
		await Promise.all(closing.map(function([connection]): Promise<void> {
			return(connection.close());
		}));
	}
}
