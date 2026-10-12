/** How long the node first leaves a peer that asked it to slow down without saying for how long; each time it asks again in a row, twice as long. */
export const FIRST_THROTTLE_MILLISECONDS = 5000;

/** The longest the node leaves a peer that asked it to slow down, whatever it asked. */
export const LAST_THROTTLE_MILLISECONDS: number = 10 * 60_000;

/** A request the node does not send, because the peer asked it to slow down and the wait has not passed. */
export class PeerThrottled extends Error {
	readonly endpoint: string;
	readonly milliseconds: number;

	constructor(endpoint: string, milliseconds: number) {
		super(`the bootstrap asks ${endpoint} nothing for ${String(Math.ceil(milliseconds / 1000))} s more, as it asked the node to slow down`);
		this.name = 'PeerThrottled';
		this.endpoint = endpoint;
		this.milliseconds = milliseconds;
	}
}

/** Why the wait ended early: the reason the signal was aborted with. */
function stopReason(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error) {
		return(reason);
	}
	return(new Error('stopped while waiting to request a page', { cause: reason }));
}

/** Resolves after that many milliseconds, or rejects once the signal is aborted. */
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
	return(new Promise<void>(function(resolve, reject) {
		if (signal.aborted) {
			reject(stopReason(signal));
			return;
		}
		const abort = function(): void {
			clearTimeout(timer);
			reject(stopReason(signal));
		};
		const timer = setTimeout(function() {
			signal.removeEventListener('abort', abort);
			resolve();
		}, milliseconds);
		signal.addEventListener('abort', abort, { once: true });
	}));
}

/**
 * Keeps the requests to each peer apart: one at a time, each starting at
 * least the interval after the one before it ended, so that a peer always has
 * that long without a request of this node's in flight, however long its
 * answers take. The live pass and the deep re-scan of one peer share its
 * turn. Time is read from the monotonic clock, which a change of the system
 * time does not move. An interval of 0 leaves requests as they come, as they
 * were without a pacer.
 *
 * A peer that asks the node to slow down, as one answering 429 or 503 does,
 * is sent nothing until the wait it asked for has passed, and no less than a
 * wait that doubles each time it asks again before a request succeeds: each
 * request meanwhile fails at once with PeerThrottled, rather than hold up the
 * update that sends it.
 */
export class PeerPacer {
	readonly #interval: number;
	/** For each peer, what the next request to it waits for: the end of the one before. */
	readonly #turns = new Map<string, Promise<void>>();
	readonly #lastEnded = new Map<string, number>();
	/** For each peer that asked the node to slow down, how often it has in a row, and until when it is sent nothing. */
	readonly #throttles = new Map<string, { readonly times: number; readonly until: number }>();

	constructor(minIntervalMilliseconds: number) {
		this.#interval = minIntervalMilliseconds;
	}

	/** The peer asked the node to slow down, for that long if it said. */
	throttled(endpoint: string, retryAfterMilliseconds: number | undefined): void {
		const times = (this.#throttles.get(endpoint)?.times ?? 0) + 1;
		const doubled = FIRST_THROTTLE_MILLISECONDS * 2 ** (times - 1);
		const wait = Math.min(Math.max(retryAfterMilliseconds ?? 0, doubled), LAST_THROTTLE_MILLISECONDS);
		this.#throttles.set(endpoint, { times, until: performance.now() + wait });
	}

	/** The request's answer, once its turn has come; stopping while it waits rejects without sending it, and so does a peer still to be left alone (PeerThrottled). */
	async paced<Answer>(endpoint: string, stopped: AbortSignal, request: () => Promise<Answer>): Promise<Answer> {
		// Before it takes a turn, which would keep the peer's next request waiting for nothing.
		this.#refuseWhileThrottled(endpoint);
		if (this.#interval === 0) {
			return(await this.#sent(endpoint, request));
		}
		const previous = this.#turns.get(endpoint) ?? Promise.resolve();
		let endTurn = function(): void {
			// Replaced as the promise is made.
		};
		const turn = previous.then(function() {
			return(new Promise<void>(function(resolve) {
				endTurn = resolve;
			}));
		});
		this.#turns.set(endpoint, turn);
		try {
			await previous;
			const wait = (this.#lastEnded.get(endpoint) ?? -Infinity) + this.#interval - performance.now();
			if (wait > 0) {
				await pause(wait, stopped);
			}
			stopped.throwIfAborted();
			try {
				return(await this.#sent(endpoint, request));
			} finally {
				this.#lastEnded.set(endpoint, performance.now());
			}
		} finally {
			endTurn();
			if (this.#turns.get(endpoint) === turn) {
				this.#turns.delete(endpoint);
			}
		}
	}

	#refuseWhileThrottled(endpoint: string): void {
		const left = (this.#throttles.get(endpoint)?.until ?? 0) - performance.now();
		if (left > 0) {
			throw(new PeerThrottled(endpoint, left));
		}
	}

	/** The request sent, unless the peer asked meanwhile to be left alone; one that succeeds ends the peer's doubling. */
	async #sent<Answer>(endpoint: string, request: () => Promise<Answer>): Promise<Answer> {
		this.#refuseWhileThrottled(endpoint);
		const answer = await request();
		this.#throttles.delete(endpoint);
		return(answer);
	}
}
