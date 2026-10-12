import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FIRST_THROTTLE_MILLISECONDS, LAST_THROTTLE_MILLISECONDS, PeerPacer, PeerThrottled } from './bootstrap-pacing.js';

const PEER = 'https://rep1.example/api';
const OTHER_PEER = 'https://rep2.example/api';

const INTERVAL = 1000;

/** A request whose start is recorded, and which ends when the test says. */
class HeldRequest {
	startedAt: number | undefined;
	readonly #finished: Promise<string>;
	#finish: ((value: string) => void) | undefined;

	constructor() {
		this.#finished = new Promise<string>((resolve) => {
			this.#finish = resolve;
		});
	}

	readonly run = (): Promise<string> => {
		this.startedAt = performance.now();
		return(this.#finished);
	};

	end(value: string): void {
		this.#finish?.(value);
	}
}

function useFakeClock(): number {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
	return(performance.now());
}

afterEach(function() {
	vi.useRealTimers();
});

describe('a peer pacer', function() {
	test('starts a request to a peer only the interval after the one before it ended', async function() {
		const began = useFakeClock();
		const pacer = new PeerPacer(INTERVAL);
		const first = new HeldRequest();
		const second = new HeldRequest();
		const firstAnswer = pacer.paced(PEER, new AbortController().signal, first.run);
		const secondAnswer = pacer.paced(PEER, new AbortController().signal, second.run);
		await vi.advanceTimersByTimeAsync(0);
		expect(first.startedAt).toBe(began);

		// The second waits while the first is in flight, however long it takes.
		await vi.advanceTimersByTimeAsync(5000);
		expect(second.startedAt).toBeUndefined();
		first.end('first');
		await expect(firstAnswer).resolves.toBe('first');
		const firstEnded = performance.now();

		await vi.advanceTimersByTimeAsync(INTERVAL - 1);
		expect(second.startedAt).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(second.startedAt).toBe(firstEnded + INTERVAL);
		second.end('second');
		await expect(secondAnswer).resolves.toBe('second');
	});

	test('does not wait when the interval has passed since the last request ended', async function() {
		const began = useFakeClock();
		const pacer = new PeerPacer(INTERVAL);
		const first = new HeldRequest();
		first.end('first');
		await pacer.paced(PEER, new AbortController().signal, first.run);
		await vi.advanceTimersByTimeAsync(INTERVAL);

		const second = new HeldRequest();
		const answer = pacer.paced(PEER, new AbortController().signal, second.run);
		await vi.advanceTimersByTimeAsync(0);
		expect(second.startedAt).toBe(began + INTERVAL);
		second.end('second');
		await answer;
	});

	test('paces each peer apart from the others', async function() {
		const began = useFakeClock();
		const pacer = new PeerPacer(INTERVAL);
		const first = new HeldRequest();
		const other = new HeldRequest();
		const firstAnswer = pacer.paced(PEER, new AbortController().signal, first.run);
		const otherAnswer = pacer.paced(OTHER_PEER, new AbortController().signal, other.run);
		await vi.advanceTimersByTimeAsync(0);
		expect([first.startedAt, other.startedAt]).toEqual([began, began]);
		first.end('first');
		other.end('other');
		await Promise.all([firstAnswer, otherAnswer]);
	});

	test('paces after a request that failed as after one that succeeded', async function() {
		useFakeClock();
		const pacer = new PeerPacer(INTERVAL);
		await expect(pacer.paced(PEER, new AbortController().signal, function(): Promise<string> {
			return(Promise.reject(new Error('refused')));
		})).rejects.toThrow('refused');
		const failedAt = performance.now();
		const next = new HeldRequest();
		const answer = pacer.paced(PEER, new AbortController().signal, next.run);
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(next.startedAt).toBe(failedAt + INTERVAL);
		next.end('next');
		await answer;
	});

	test('with an interval of 0, lets requests to one peer run at once and together', async function() {
		const began = useFakeClock();
		const pacer = new PeerPacer(0);
		const first = new HeldRequest();
		const second = new HeldRequest();
		const answers = [pacer.paced(PEER, new AbortController().signal, first.run), pacer.paced(PEER, new AbortController().signal, second.run)];
		await vi.advanceTimersByTimeAsync(0);
		expect([first.startedAt, second.startedAt]).toEqual([began, began]);
		first.end('first');
		second.end('second');
		await Promise.all(answers);
	});

	test('gives up waiting once stopped, without sending the request, and lets the next request wait its turn', async function() {
		useFakeClock();
		const pacer = new PeerPacer(INTERVAL);
		const first = new HeldRequest();
		first.end('first');
		await pacer.paced(PEER, new AbortController().signal, first.run);
		const stopping = new AbortController();
		const stopped = new HeldRequest();
		const answer = pacer.paced(PEER, stopping.signal, stopped.run);
		const rejected = expect(answer).rejects.toThrow(/stopped/);
		stopping.abort(new Error('stopped'));
		await rejected;
		expect(stopped.startedAt).toBeUndefined();

		const next = new HeldRequest();
		const nextAnswer = pacer.paced(PEER, new AbortController().signal, next.run);
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(next.startedAt).toBeDefined();
		next.end('next');
		await nextAnswer;
	});

	test('gives up the wait under way once stopped, with the reason it was stopped for, as an error', async function() {
		useFakeClock();
		const pacer = new PeerPacer(INTERVAL);
		const first = new HeldRequest();
		first.end('first');
		await pacer.paced(PEER, new AbortController().signal, first.run);
		const stopping = new AbortController();
		const waiting = new HeldRequest();
		const answer = pacer.paced(PEER, stopping.signal, waiting.run);
		const rejected = answer.then(function(): never {
			throw(new Error('expected the request to be given up'));
		}, function(error: unknown): unknown {
			return(error);
		});
		await vi.advanceTimersByTimeAsync(INTERVAL / 2);

		stopping.abort('shutting down');
		const error = await rejected;

		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ message: 'stopped while waiting to request a page', cause: 'shutting down' });
		// The wait's timer goes with it.
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(waiting.startedAt).toBeUndefined();

		const done = new HeldRequest();
		done.end('done');
		await pacer.paced(PEER, new AbortController().signal, done.run);
		const reason = new Error('stopped mid-wait');
		const stoppingAgain = new AbortController();
		const next = pacer.paced(PEER, stoppingAgain.signal, new HeldRequest().run);
		const rejectedAgain = expect(next).rejects.toBe(reason);
		await vi.advanceTimersByTimeAsync(0);
		stoppingAgain.abort(reason);
		await rejectedAgain;
	});

	test('sends no request once stopped, though it need not wait', async function() {
		useFakeClock();
		const pacer = new PeerPacer(INTERVAL);
		const stopping = new AbortController();
		const reason = new Error('stopped before');
		stopping.abort(reason);
		const unsent = new HeldRequest();

		await expect(pacer.paced(PEER, stopping.signal, unsent.run)).rejects.toBe(reason);

		expect(unsent.startedAt).toBeUndefined();
	});

	test('leaves no listener on the signal once each wait is over', async function() {
		useFakeClock();
		const pacer = new PeerPacer(INTERVAL);
		const signal = new AbortController().signal;
		const first = new HeldRequest();
		first.end('first');
		await pacer.paced(PEER, signal, first.run);
		for (const value of ['second', 'third']) {
			const request = new HeldRequest();
			request.end(value);
			// Each follows the one before at once, so it waits the interval.
			const answer = pacer.paced(PEER, signal, request.run);
			await vi.advanceTimersByTimeAsync(INTERVAL);
			await expect(answer).resolves.toBe(value);
		}

		expect(getEventListeners(signal, 'abort')).toEqual([]);
	});

	test('keeps a request made while others wait their turns behind the last of them', async function() {
		useFakeClock();
		const pacer = new PeerPacer(INTERVAL);
		const [first, second, third, fourth] = [new HeldRequest(), new HeldRequest(), new HeldRequest(), new HeldRequest()];
		const answers = [pacer.paced(PEER, new AbortController().signal, first.run), pacer.paced(PEER, new AbortController().signal, second.run), pacer.paced(PEER, new AbortController().signal, third.run)];
		await vi.advanceTimersByTimeAsync(0);
		first.end('first');
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(second.startedAt).toBeDefined();

		answers.push(pacer.paced(PEER, new AbortController().signal, fourth.run));
		await vi.advanceTimersByTimeAsync(10 * INTERVAL);
		expect([third.startedAt, fourth.startedAt]).toEqual([undefined, undefined]);
		second.end('second');
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(third.startedAt).toBeDefined();
		expect(fourth.startedAt).toBeUndefined();
		third.end('third');
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(fourth.startedAt).toBeDefined();
		fourth.end('fourth');
		expect(await Promise.all(answers)).toEqual(['first', 'second', 'third', 'fourth']);
	});
});

describe('a peer that asks the node to slow down', function() {
	test('is sent nothing until the wait it asked for has passed, each request failing at once meanwhile, and again after one succeeds', async function() {
		useFakeClock();
		const pacer = new PeerPacer(INTERVAL);
		const stopped = new AbortController().signal;
		let sent = 0;
		const request = function(): Promise<string> {
			sent++;
			return(Promise.resolve('answer'));
		};

		pacer.throttled(PEER, 60_000);

		await expect(pacer.paced(PEER, stopped, request)).rejects.toThrow(new PeerThrottled(PEER, 60_000));
		await vi.advanceTimersByTimeAsync(60_000 - 1);
		await expect(pacer.paced(PEER, stopped, request)).rejects.toThrow(PeerThrottled);
		await expect(pacer.paced(OTHER_PEER, stopped, request)).resolves.toBe('answer');
		expect(sent).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pacer.paced(PEER, stopped, request)).resolves.toBe('answer');
		expect(sent).toBe(2);
	});

	test('is left alone twice as long each time it asks again before a request succeeds, and no longer than the longest wait', async function() {
		useFakeClock();
		const pacer = new PeerPacer(0);
		const stopped = new AbortController().signal;
		const request = function(): Promise<string> {
			return(Promise.resolve('answer'));
		};
		const leftFor = async function(): Promise<number> {
			const failure: unknown = await pacer.paced(PEER, stopped, request).then(function(): unknown {
				return(undefined);
			}, function(error: unknown): unknown {
				return(error);
			});
			if (!(failure instanceof PeerThrottled)) {
				throw(new Error('expected the request not to be sent'));
			}
			return(failure.milliseconds);
		};

		pacer.throttled(PEER, undefined);
		expect(await leftFor()).toBe(FIRST_THROTTLE_MILLISECONDS);
		pacer.throttled(PEER, 1000);
		expect(await leftFor()).toBe(2 * FIRST_THROTTLE_MILLISECONDS);
		for (let time = 0; time < 10; time++) {
			pacer.throttled(PEER, undefined);
		}
		expect(await leftFor()).toBe(LAST_THROTTLE_MILLISECONDS);
		pacer.throttled(PEER, 10 * LAST_THROTTLE_MILLISECONDS);
		expect(await leftFor()).toBe(LAST_THROTTLE_MILLISECONDS);

		await vi.advanceTimersByTimeAsync(LAST_THROTTLE_MILLISECONDS);
		await expect(pacer.paced(PEER, stopped, request)).resolves.toBe('answer');
		pacer.throttled(PEER, undefined);
		expect(await leftFor()).toBe(FIRST_THROTTLE_MILLISECONDS);
		expect(new PeerThrottled(PEER, 4500).message).toBe(`the bootstrap asks ${PEER} nothing for 5 s more, as it asked the node to slow down`);
	});
});
