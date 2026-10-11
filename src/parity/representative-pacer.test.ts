import { describe, expect, test } from 'vitest';
import { startFakeAPI } from '../testing/fake-api.js';
import { pacedSource } from './api-source.js';
import type { APIAnswer } from './api-source.js';
import { RepresentativePacer } from './representative-pacer.js';
import type { PacerClock, ServedAnswer } from './representative-pacer.js';

const REP = 'https://rep1.example/api';
const OTHER_REP = 'https://rep2.example/api';

/** A clock that moves only as the pacer waits on it, recording each wait. */
function fakeClock(): PacerClock & { readonly waits: number[] } {
	let now = 0;
	const waits: number[] = [];
	return({
		waits,
		now(): number {
			return(now);
		},
		pause(milliseconds: number): Promise<void> {
			waits.push(milliseconds);
			now += milliseconds;
			return(Promise.resolve());
		}
	});
}

const OK: APIAnswer = { status: 200, body: {} };

function served(answer: APIAnswer, retryAfter: string | null = null): () => Promise<ServedAnswer> {
	return(function() {
		return(Promise.resolve({ answer, retryAfter }));
	});
}

/** A request that answers only once it is let go. */
function held(): { readonly request: () => Promise<ServedAnswer>; readonly started: () => boolean; readonly release: () => void } {
	let started = false;
	let release = function(): void {
		// Replaced once the request starts.
	};
	return({
		request() {
			started = true;
			return(new Promise<ServedAnswer>(function(resolve) {
				release = function() {
					resolve({ answer: OK, retryAfter: null });
				};
			}));
		},
		started: function() {
			return(started);
		},
		release: function() {
			release();
		}
	});
}

/** Lets every settled promise run on. */
async function settle(): Promise<void> {
	for (let round = 0; round < 10; round++) {
		await Promise.resolve();
	}
}

const RUNNING = new AbortController().signal;

describe('the representatives\' pacer', function() {
	test('keeps at most so many requests in flight to each representative, each other representative apart', async function() {
		const pacer = new RepresentativePacer({ concurrency: 4, gapMilliseconds: 0 }, fakeClock());
		const requests = Array.from({ length: 6 }, held);
		const answers = requests.map(function({ request }) {
			return(pacer.paced(REP, RUNNING, request));
		});
		const other = held();
		const otherAnswer = pacer.paced(OTHER_REP, RUNNING, other.request);
		await settle();
		expect(requests.map(function({ started }) {
			return(started());
		})).toEqual([true, true, true, true, false, false]);
		expect(other.started()).toBe(true);

		requests[0]?.release();
		await settle();
		expect(requests[4]?.started()).toBe(true);
		expect(requests[5]?.started()).toBe(false);
		for (const { release } of requests) {
			release();
			await settle();
		}
		other.release();
		expect(await Promise.all([...answers, otherAnswer])).toEqual(Array.from({ length: 7 }, function() {
			return(OK);
		}));
	});

	test('starts each request to a representative at least the gap after the one before it', async function() {
		const clock = fakeClock();
		const pacer = new RepresentativePacer({ concurrency: 4, gapMilliseconds: 250 }, clock);
		await pacer.paced(REP, RUNNING, served(OK));
		await pacer.paced(REP, RUNNING, served(OK));
		await pacer.paced(OTHER_REP, RUNNING, served(OK));
		expect(clock.waits).toEqual([250]);
	});

	test('backs off a representative that answers 429 or a gateway\'s 5xx: half the requests in flight and a wait that doubles up to 30 s', async function() {
		const clock = fakeClock();
		const pacer = new RepresentativePacer({ concurrency: 4, gapMilliseconds: 0 }, clock);
		expect(await pacer.paced(REP, RUNNING, served({ status: 504, body: 'gateway timeout' }))).toEqual({ status: 504, body: 'gateway timeout' });
		expect(pacer.standing()).toEqual({ [REP]: { concurrency: 2, backedOff: 1 } });
		await pacer.paced(REP, RUNNING, served({ status: 429, body: 'slow down' }));
		for (let failure = 0; failure < 6; failure++) {
			await pacer.paced(REP, RUNNING, served({ status: 503, body: 'unavailable' }));
		}
		await pacer.paced(REP, RUNNING, served(OK));
		expect(clock.waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
		expect(pacer.standing()).toEqual({ [REP]: { concurrency: 1, backedOff: 8 } });
	});

	test('takes the wait a representative names in Retry-After, in seconds or as a date', async function() {
		const clock = fakeClock();
		const pacer = new RepresentativePacer({ concurrency: 4, gapMilliseconds: 0 }, clock);
		await pacer.paced(REP, RUNNING, served({ status: 429, body: '' }, '7'));
		await pacer.paced(REP, RUNNING, served({ status: 429, body: '' }, new Date(7000 + 12_000).toUTCString()));
		await pacer.paced(REP, RUNNING, served(OK));
		expect(clock.waits).toEqual([7000, 12_000]);
	});

	test('does not back off for the API\'s own internal failure, which answers the request', async function() {
		const clock = fakeClock();
		const pacer = new RepresentativePacer({ concurrency: 4, gapMilliseconds: 0 }, clock);
		await pacer.paced(REP, RUNNING, served({ status: 500, body: { error: true, message: 'Internal error occurred (error ID: 1)' } }));
		await pacer.paced(REP, RUNNING, served(OK));
		expect(clock.waits).toEqual([]);
		expect(pacer.standing()).toEqual({ [REP]: { concurrency: 4, backedOff: 0 } });
	});

	test('backs off a representative whose request fails outright, and passes the failure on', async function() {
		const clock = fakeClock();
		const pacer = new RepresentativePacer({ concurrency: 4, gapMilliseconds: 0 }, clock);
		await expect(pacer.paced(REP, RUNNING, function() {
			return(Promise.reject(new Error('timed out')));
		})).rejects.toThrow('timed out');
		await pacer.paced(REP, RUNNING, served(OK));
		expect(clock.waits).toEqual([1000]);
	});

	test('steps back up by one request in flight after each run of successes, to the most allowed', async function() {
		const pacer = new RepresentativePacer({ concurrency: 4, gapMilliseconds: 0 }, fakeClock());
		await pacer.paced(REP, RUNNING, served({ status: 502, body: '' }));
		await pacer.paced(REP, RUNNING, served({ status: 502, body: '' }));
		expect(pacer.standing()[REP]?.concurrency).toBe(1);
		for (let success = 0; success < 20; success++) {
			await pacer.paced(REP, RUNNING, served(OK));
		}
		expect(pacer.standing()[REP]?.concurrency).toBe(3);
		for (let success = 0; success < 40; success++) {
			await pacer.paced(REP, RUNNING, served(OK));
		}
		expect(pacer.standing()).toEqual({ [REP]: { concurrency: 4, backedOff: 2 } });
	});

	test('sends nothing once stopped', async function() {
		const pacer = new RepresentativePacer({ concurrency: 4, gapMilliseconds: 0 }, fakeClock());
		const stopping = new AbortController();
		stopping.abort(new Error('stopped'));
		const request = held();
		await expect(pacer.paced(REP, stopping.signal, request.request)).rejects.toThrow('stopped');
		expect(request.started()).toBe(false);
	});

	test('paces a representative read over HTTP, backing off from a gateway\'s answer in its place', async function() {
		const api = await startFakeAPI();
		api.answer('/node/version', { status: 504, body: 'gateway timeout' });
		const pacer = new RepresentativePacer({ concurrency: 4, gapMilliseconds: 0 }, fakeClock());
		const source = pacedSource(api.endpoint, pacer, RUNNING);

		expect(await source.get('/node/version')).toEqual({ status: 504, body: 'gateway timeout' });
		expect(pacer.standing()).toEqual({ [api.endpoint]: { concurrency: 2, backedOff: 1 } });
		expect(api.requests).toEqual(['GET /node/version']);
	});
});
