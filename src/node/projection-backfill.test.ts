import { describe, expect, test, vi } from 'vitest';
import type { Logger } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { ProjectionBackfill } from '../ledger/storage/postgres/driver.js';
import { BACKFILL_RETRY_MILLISECONDS, CAUGHT_UP_POLL_MILLISECONDS, pause, ProjectionBackfillRunner } from './projection-backfill.js';
import type { ProjectionBackfillIO } from './projection-backfill.js';

class RecordingLog implements Logger {
	readonly lines: string[] = [];

	log(..._input: unknown[]): void {
		// Only info and warnings are kept.
	}

	debug(..._input: unknown[]): void {
		// Only info and warnings are kept.
	}

	info(...input: unknown[]): void {
		this.lines.push(`info ${input.map(String).join(' ')}`);
	}

	warn(...input: unknown[]): void {
		this.lines.push(`warn ${input.map(String).join(' ')}`);
	}

	error(..._input: unknown[]): void {
		// Only info and warnings are kept.
	}
}

type Pause = { readonly milliseconds: number; readonly end: () => void };

/**
 * A node that is caught up or not as the case sets it, and a backfill of as
 * many batches as asked, which fails as often as asked first; its pauses end
 * only when the case ends them.
 */
class Surroundings {
	caughtUp = false;
	failures = 0;
	readonly batches: number;
	readonly log = new RecordingLog();
	readonly pauses: Pause[] = [];
	readonly runs: number[] = [];
	/** The batch, counted from 1, after which the node falls behind. */
	behindAfter: number | undefined;

	constructor(batches: number) {
		this.batches = batches;
	}

	get io(): ProjectionBackfillIO {
		return({
			caughtUp: () => {
				return(Promise.resolve(this.caughtUp));
			},
			backfill: async (progress) => {
				this.runs.push(0);
				if (this.failures > 0) {
					this.failures--;
					throw(new Error('the batch failed'));
				}
				for (let batch = 1; batch <= this.batches; batch++) {
					this.runs[this.runs.length - 1] = batch;
					if (batch === this.behindAfter) {
						this.caughtUp = false;
					}
					await progress(doneAfter(batch));
				}
				return(doneAfter(this.batches));
			},
			log: this.log,
			pause: (milliseconds, signal) => {
				return(new Promise<void>((resolve, reject) => {
					this.pauses.push({ milliseconds, end: resolve });
					signal.addEventListener('abort', function() {
						reject(new Error('the pause was stopped'));
					}, { once: true });
				}));
			}
		});
	}

	/** Ends the pause the backfill waits in, once it waits in one, and says how long it asked for. */
	async endPause(): Promise<number> {
		await vi.waitFor(() => {
			expect(this.pauses).not.toHaveLength(0);
		});
		const pause = this.pauses.shift();
		pause?.end();
		return(pause?.milliseconds ?? 0);
	}
}

function doneAfter(batch: number): ProjectionBackfill {
	return({ completeFrom: BigInt(100 - batch), staples: batch, operations: batch * 2 });
}

/** Lets every promise the runner is waiting on settle that can. */
async function settled(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) {
		await Promise.resolve();
	}
}

describe('the projection backfill beside a node', function() {
	test('waits until the node has caught up with its peers, then fills in every batch once and stops', async function() {
		const surroundings = new Surroundings(2);
		const runner = new ProjectionBackfillRunner(surroundings.io);

		expect(await surroundings.endPause()).toBe(CAUGHT_UP_POLL_MILLISECONDS);
		expect(await surroundings.endPause()).toBe(CAUGHT_UP_POLL_MILLISECONDS);
		expect(surroundings.runs).toEqual([]);
		surroundings.caughtUp = true;
		expect(await surroundings.endPause()).toBe(CAUGHT_UP_POLL_MILLISECONDS);

		await vi.waitFor(function() {
			expect(surroundings.log.lines.at(-1)).toBe('info PROJECTION Projection backfill done: 2 staples, 4 operations filled in; every staple from the one stored as 98 has its rows');
		});
		expect(surroundings.runs).toEqual([2]);
		expect(surroundings.log.lines).toEqual([
			'info PROJECTION Projection backfill waits until the node has caught up with its peers',
			'info PROJECTION Projection backfill goes on: the node has caught up with its peers',
			'info PROJECTION Projection backfill: 1 staples, 2 operations filled in; every staple from the one stored as 99 has its rows',
			'info PROJECTION Projection backfill: 2 staples, 4 operations filled in; every staple from the one stored as 98 has its rows',
			'info PROJECTION Projection backfill done: 2 staples, 4 operations filled in; every staple from the one stored as 98 has its rows'
		]);
		await runner.stop();
		expect(surroundings.pauses).toEqual([]);
	});

	test('pauses between batches while the node is behind its peers, and goes on once it has caught up', async function() {
		const surroundings = new Surroundings(3);
		surroundings.caughtUp = true;
		surroundings.behindAfter = 1;
		const runner = new ProjectionBackfillRunner(surroundings.io);

		expect(await surroundings.endPause()).toBe(CAUGHT_UP_POLL_MILLISECONDS);
		expect(await surroundings.endPause()).toBe(CAUGHT_UP_POLL_MILLISECONDS);
		expect(surroundings.runs).toEqual([1]);
		surroundings.caughtUp = true;
		await surroundings.endPause();

		await vi.waitFor(function() {
			expect(surroundings.runs).toEqual([3]);
		});
		await runner.stop();
	});

	test('logs a failed batch and tries it again after a pause', async function() {
		const surroundings = new Surroundings(1);
		surroundings.caughtUp = true;
		surroundings.failures = 1;
		const runner = new ProjectionBackfillRunner(surroundings.io);

		await vi.waitFor(function() {
			expect(surroundings.log.lines).toEqual([`warn PROJECTION Projection backfill failed; it is tried again in ${String(BACKFILL_RETRY_MILLISECONDS / 1000)} s: Error: the batch failed`]);
		});
		await settled();
		expect(surroundings.runs).toEqual([0]);
		expect(await surroundings.endPause()).toBe(BACKFILL_RETRY_MILLISECONDS);

		await vi.waitFor(function() {
			expect(surroundings.runs).toEqual([0, 1]);
		});
		await runner.stop();
	});

	test('hands the backfill a signal that aborts once it is stopped, and not before', async function() {
		const surroundings = new Surroundings(1);
		surroundings.caughtUp = true;
		let handed: AbortSignal | undefined;
		let release: (() => void) | undefined;
		const runner = new ProjectionBackfillRunner({
			...surroundings.io,
			backfill: async function(_progress, signal) {
				handed = signal;
				await new Promise<void>(function(resolve) {
					release = resolve;
				});
				return(doneAfter(1));
			}
		});
		await vi.waitFor(function() {
			expect(handed?.aborted).toBe(false);
		});

		const stopped = runner.stop();

		expect(handed?.aborted).toBe(true);
		release?.();
		await stopped;
	});

	test('stopped while it waits for the node, never backfills, and logs no failure', async function() {
		const surroundings = new Surroundings(1);
		const runner = new ProjectionBackfillRunner(surroundings.io);
		await vi.waitFor(function() {
			expect(surroundings.pauses).toHaveLength(1);
		});

		await runner.stop();

		surroundings.caughtUp = true;
		await settled();
		expect(surroundings.runs).toEqual([]);
		expect(surroundings.log.lines).toEqual(['info PROJECTION Projection backfill waits until the node has caught up with its peers']);
	});

	test('stopped while it waits to try a failed batch again, tries it no more', async function() {
		const surroundings = new Surroundings(1);
		surroundings.caughtUp = true;
		surroundings.failures = 1;
		const runner = new ProjectionBackfillRunner(surroundings.io);
		await vi.waitFor(function() {
			expect(surroundings.pauses).toHaveLength(1);
		});

		await runner.stop();

		await settled();
		expect(surroundings.runs).toEqual([0]);
	});

	test('stopped during a batch, begins no other, and logs no failure', async function() {
		const surroundings = new Surroundings(3);
		surroundings.caughtUp = true;
		let stopped: Promise<void> | undefined;
		const runner = new ProjectionBackfillRunner({
			...surroundings.io,
			backfill: async function(progress) {
				stopped = runner.stop();
				await progress(doneAfter(1));
				await progress(doneAfter(2));
				return(doneAfter(2));
			}
		});

		await vi.waitFor(function() {
			expect(stopped).toBeDefined();
		});
		await stopped;

		expect(surroundings.log.lines).toEqual(['info PROJECTION Projection backfill: 1 staples, 2 operations filled in; every staple from the one stored as 99 has its rows']);
	});
});

describe('a pause of the projection backfill', function() {
	test('ends after its time', async function() {
		const began = Date.now();

		await pause(20, new AbortController().signal);

		expect(Date.now() - began).toBeGreaterThanOrEqual(19);
	});

	test('fails once its signal aborts', async function() {
		const stopping = new AbortController();
		const paused = pause(60_000, stopping.signal);

		stopping.abort();

		await expect(paused).rejects.toMatchObject({ name: 'AbortError' });
	});
});
