import type { Logger } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { P2PConnection, P2PSwitch } from '@keetanetwork/keetanet-client/lib/p2p.js';
import { wrapSwitchReceive } from '../upstream/internals.js';
import type { SwitchReceiveMethod } from '../upstream/internals.js';

const LOG_SOURCE = 'P2P';

/**
 * How long stopping waits for the messages the switch is handling: handling
 * one can wait on the node's own messages to peers, which have no time limit
 * [Keeta TS] index.js:72203-72218, so a peer that never answers could
 * otherwise keep the node from stopping.
 */
export const MESSAGE_SETTLE_MILLISECONDS = 5000;

/**
 * The messages a switch is handling. A WebSocket hands each one to the switch
 * without waiting for it, and a failure then has no one to catch it
 * [Keeta TS] index.js:72362-72369; handling one adds to the ledger and writes
 * the node's statistics last [Keeta TS] index.js:72813-72815, 71409-71435. So
 * the node waits for them before its storage closes, and a failure is logged
 * and answered as a message not taken, rather than ending the process.
 */
export class SwitchMessages {
	readonly #log: Logger;
	readonly #handling = new Set<Promise<boolean>>();
	#refusing = false;

	constructor(p2pSwitch: P2PSwitch, log: Logger) {
		this.#log = log;
		wrapSwitchReceive(p2pSwitch, (upstream: SwitchReceiveMethod): SwitchReceiveMethod => {
			return({
				recvMessageFromPeer: (from: P2PConnection, buffer: Buffer | ArrayBuffer): Promise<boolean> => {
					if (this.#refusing) {
						return(Promise.resolve(false));
					}
					return(this.#track(upstream.recvMessageFromPeer(from, buffer)));
				}
			});
		});
	}

	/**
	 * Waits as settled does, then refuses every message until opened again:
	 * a socket the switch dials after the node stopped, with work nothing
	 * waits for [Keeta TS] index.js:73211-73235, 73324, still delivers what
	 * the peer sends before it closes, and handling a message writes the
	 * node's statistics [Keeta TS] index.js:72813-72815.
	 */
	async closed(): Promise<void> {
		await this.settled();
		this.#refusing = true;
	}

	/** Hands messages to the switch again, as the node runs. */
	open(): void {
		this.#refusing = false;
	}

	#track(handling: Promise<boolean>): Promise<boolean> {
		const tracked = handling.catch((error: unknown): boolean => {
			this.#log.error(LOG_SOURCE, 'Handling a message from a peer failed:', error);
			return(false);
		}).finally((): void => {
			this.#handling.delete(tracked);
		});
		this.#handling.add(tracked);
		return(tracked);
	}

	/** Resolves once no message is being handled, those that arrive meanwhile included, or once the bound has passed. */
	async settled(): Promise<void> {
		if (this.#handling.size === 0) {
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<'timed out'>(function(resolve) {
			timer = setTimeout(function() {
				resolve('timed out');
			}, MESSAGE_SETTLE_MILLISECONDS);
		});
		try {
			const outcome = await Promise.race([this.#allHandled(), timedOut]);
			if (outcome === 'timed out') {
				this.#log.warn(LOG_SOURCE, `Stopped waiting for ${String(this.#handling.size)} messages from peers after ${String(MESSAGE_SETTLE_MILLISECONDS)} ms`);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	async #allHandled(): Promise<'handled'> {
		while (this.#handling.size > 0) {
			await Promise.all(this.#handling);
		}
		return('handled');
	}
}
