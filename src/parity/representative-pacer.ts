import { answeredByAPI, isAnonymousFailure } from './api-source.js';
import type { APIAnswer } from './api-source.js';
import { messageOf } from './values.js';

/** How hard the parity tools read from each representative. */
export type RepresentativePacing = {
	/** The most requests in flight to one representative at a time. */
	readonly concurrency: number;
	/** How long after a request to a representative starts the next to it may start. */
	readonly gapMilliseconds: number;
};

/**
 * The main network's representatives serve the network's whole load, and
 * answer a few requests at a time from one client without strain; the
 * backoff below gives way as soon as one shows otherwise.
 */
export const DEFAULT_REPRESENTATIVE_PACING: RepresentativePacing = { concurrency: 4, gapMilliseconds: 0 };

/** A representative's answer with the wait its Retry-After header asks for, if any. */
export type ServedAnswer = { readonly answer: APIAnswer; readonly retryAfter: string | null };

/** The time the pacer reads, in milliseconds since the epoch, and how it waits. */
export type PacerClock = {
	now(): number;
	pause(milliseconds: number, stopped: AbortSignal): Promise<void>;
};

/** The first wait after a representative shows strain, doubled for each strain in a row up to the cap. */
const FIRST_BACKOFF_MILLISECONDS = 1000;

const MAX_BACKOFF_MILLISECONDS = 30_000;

/** Answers in a row without strain after which one more request may be in flight. */
const SUCCESSES_TO_STEP_UP = 10;

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Internal failures in a row with no code of the API, after which a
 * representative counts as strained. One such answer is the API's answer to
 * a request it cannot serve, such as a page of history from a start that
 * is no entry of it, which the parity tools rarely send, since they draw
 * their requests from what the follower holds; a run of them is the
 * representative failing under load, which answers in the same envelope.
 */
const ANONYMOUS_FAILURES_TO_STRAIN = 3;


/** The wait a Retry-After header asks for: a number of seconds, or a date. */
function retryAfterMilliseconds(header: string | null, now: number): number | undefined {
	if (header === null) {
		return(undefined);
	}
	if (/^[0-9]+$/.test(header.trim())) {
		return(Number(header.trim()) * MILLISECONDS_PER_SECOND);
	}
	const at = Date.parse(header);
	if (Number.isNaN(at)) {
		return(undefined);
	}
	return(Math.max(0, at - now));
}

/** Where one representative's requests stand. */
type Lane = {
	/** Requests it may have in flight now, at most the pacing's. */
	limit: number;
	inFlight: number;
	/** Requests waiting for one in flight to end. */
	readonly waiting: (() => void)[];
	/** When the next request may start, by the gap and any backoff. */
	nextStart: number;
	strainsInARow: number;
	successesInARow: number;
	anonymousFailuresInARow: number;
	backedOff: number;
};

/** How one representative is read now. */
export type LaneStanding = { readonly concurrency: number; readonly backedOff: number };

/**
 * Paces the requests the parity tools send to each representative: at most
 * so many in flight, each starting at least the gap after the one before
 * it. A representative that shows strain has its requests in flight halved,
 * down to one, and is left alone for a while that doubles with each strain
 * in a row, or for as long as it asks; each run of answers without strain
 * lets one more request be in flight again, up to the pacing's.
 */
export class RepresentativePacer {
	readonly #pacing: RepresentativePacing;
	readonly #clock: PacerClock;
	readonly #lanes = new Map<string, Lane>();
	readonly #strain: (endpoint: string, standing: LaneStanding, waitMilliseconds: number, why: string) => void;

	constructor(pacing: RepresentativePacing, clock: PacerClock, onStrain: (endpoint: string, standing: LaneStanding, waitMilliseconds: number, why: string) => void = function() {
		// Nothing is told of a strain unless asked for.
	}) {
		this.#pacing = pacing;
		this.#clock = clock;
		this.#strain = onStrain;
	}

	#laneOf(endpoint: string): Lane {
		let lane = this.#lanes.get(endpoint);
		if (lane === undefined) {
			lane = { limit: this.#pacing.concurrency, inFlight: 0, waiting: [], nextStart: -Infinity, strainsInARow: 0, successesInARow: 0, anonymousFailuresInARow: 0, backedOff: 0 };
			this.#lanes.set(endpoint, lane);
		}
		return(lane);
	}

	async #enter(lane: Lane, stopped: AbortSignal): Promise<void> {
		for (;;) {
			stopped.throwIfAborted();
			if (lane.inFlight >= lane.limit) {
				await new Promise<void>(function(resolve) {
					const woken = function(): void {
						stopped.removeEventListener('abort', woken);
						resolve();
					};
					lane.waiting.push(woken);
					stopped.addEventListener('abort', woken, { once: true });
				});
				continue;
			}
			const wait = lane.nextStart - this.#clock.now();
			if (wait > 0) {
				await this.#clock.pause(wait, stopped);
				continue;
			}
			lane.inFlight++;
			lane.nextStart = this.#clock.now() + this.#pacing.gapMilliseconds;
			return;
		}
	}

	/** Wakes as many waiting requests as may now start; each checks again once it runs. */
	#wake(lane: Lane): void {
		for (let free = lane.limit - lane.inFlight; free > 0; free--) {
			lane.waiting.shift()?.();
		}
	}

	#leave(lane: Lane): void {
		lane.inFlight--;
		this.#wake(lane);
	}

	#strained(endpoint: string, lane: Lane, retryAfter: string | null, why: string): void {
		lane.limit = Math.max(1, Math.floor(lane.limit / 2));
		const doubled = Math.min(MAX_BACKOFF_MILLISECONDS, FIRST_BACKOFF_MILLISECONDS * 2 ** lane.strainsInARow);
		const now = this.#clock.now();
		const wait = retryAfterMilliseconds(retryAfter, now) ?? doubled;
		lane.strainsInARow++;
		lane.successesInARow = 0;
		lane.backedOff++;
		lane.nextStart = Math.max(lane.nextStart, now + wait);
		this.#strain(endpoint, { concurrency: lane.limit, backedOff: lane.backedOff }, wait, why);
	}

	#succeeded(lane: Lane): void {
		lane.strainsInARow = 0;
		lane.successesInARow++;
		if (lane.successesInARow >= SUCCESSES_TO_STEP_UP) {
			lane.successesInARow = 0;
			lane.limit = Math.min(this.#pacing.concurrency, lane.limit + 1);
			this.#wake(lane);
		}
	}

	/** The request's answer, once its turn has come; stopping while it waits rejects without sending it. */
	async paced(endpoint: string, stopped: AbortSignal, request: () => Promise<ServedAnswer>): Promise<APIAnswer> {
		const lane = this.#laneOf(endpoint);
		await this.#enter(lane, stopped);
		let served: ServedAnswer;
		try {
			served = await request();
		} catch (error: unknown) {
			this.#strained(endpoint, lane, null, messageOf(error));
			throw(error);
		} finally {
			this.#leave(lane);
		}
		if (isAnonymousFailure(served.answer)) {
			lane.anonymousFailuresInARow++;
		} else {
			lane.anonymousFailuresInARow = 0;
		}
		if (!answeredByAPI(served.answer)) {
			this.#strained(endpoint, lane, served.retryAfter, `answered ${String(served.answer.status)}`);
		} else if (lane.anonymousFailuresInARow >= ANONYMOUS_FAILURES_TO_STRAIN) {
			lane.anonymousFailuresInARow = 0;
			this.#strained(endpoint, lane, served.retryAfter, `answered ${String(ANONYMOUS_FAILURES_TO_STRAIN)} internal failures in a row`);
		} else if (lane.anonymousFailuresInARow > 0) {
			// Too few to count as strain, and no sign the representative bears more either.
			lane.successesInARow = 0;
		} else {
			this.#succeeded(lane);
		}
		return(served.answer);
	}

	/** How each representative read so far is read now, and how often it was backed off from. */
	standing(): Readonly<Record<string, LaneStanding>> {
		return(Object.fromEntries([...this.#lanes].map(function([endpoint, lane]) {
			return([endpoint, { concurrency: lane.limit, backedOff: lane.backedOff }]);
		})));
	}
}
