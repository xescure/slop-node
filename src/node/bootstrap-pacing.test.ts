import { afterEach, describe, expect, test, vi } from 'vitest';
import { PeerPacer } from './bootstrap-pacing.js';

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
});
