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
 */
export class PeerPacer {
	readonly #interval: number;
	/** For each peer, what the next request to it waits for: the end of the one before. */
	readonly #turns = new Map<string, Promise<void>>();
	readonly #lastEnded = new Map<string, number>();

	constructor(minIntervalMilliseconds: number) {
		this.#interval = minIntervalMilliseconds;
	}

	/** The request's answer, once its turn has come; stopping while it waits rejects without sending it. */
	async paced<Answer>(endpoint: string, stopped: AbortSignal, request: () => Promise<Answer>): Promise<Answer> {
		if (this.#interval === 0) {
			return(await request());
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
				return(await request());
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
}
