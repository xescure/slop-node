import { afterEach, describe, expect, test, vi } from 'vitest';
import { advanceClock, freezeClock } from '../testing/network.js';
import { SimulatedNode, SimulatedPeer, SimulatedRetryStore, simulatedRetries } from '../testing/simulated-peer.js';
import type { RefusalReport, SimulatedStaple } from '../testing/simulated-peer.js';
import { REPORT_REFUSED_AFTER_MILLISECONDS, RetryQueueFull } from './bootstrap-retry.js';
import type { QueueBounds } from './bootstrap-retry.js';

const NOW = Date.UTC(2026, 9, 8, 12);
const MINUTE = 60_000;

/** Staples made a second apart, each needing those its index lists, by index. */
function staples(needs: readonly (readonly number[])[]): SimulatedStaple[] {
	const peer = new SimulatedPeer();
	return(needs.map(function(each, index): SimulatedStaple {
		return(peer.apply(NOW + index * 1000, NOW + index * 1000, each));
	}));
}

function at(list: readonly SimulatedStaple[], index: number): SimulatedStaple {
	const staple = list[index];
	if (staple === undefined) {
		throw(new Error(`no staple at ${String(index)}`));
	}
	return(staple);
}

function idsOf(list: readonly SimulatedStaple[]): number[] {
	return(list.map(function(staple): number {
		return(staple.id);
	}));
}

class Harness {
	readonly node = new SimulatedNode();
	readonly store = new SimulatedRetryStore();
	readonly reports: RefusalReport[] = [];

	queue(bounds?: QueueBounds): ReturnType<typeof simulatedRetries> {
		return(simulatedRetries(this.node, this.store, this.reports, bounds));
	}
}

describe('a bootstrap retry queue', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('queues a staple the ledger refuses, and applies it with those it lets through, round after round, once what it needs arrives', async function() {
		// A debit needs a transfer, which needs a credit, which needs genesis, which comes last.
		const list = staples([[1], [2], [3], []]);
		const harness = new Harness();
		const queue = harness.queue();

		for (const staple of list.slice(0, 3)) {
			expect(await queue.add(staple)).toBe('queued');
		}
		expect(await queue.retry()).toBe(0);
		expect(await queue.add(at(list, 3))).toBe('added');

		expect(await queue.retry()).toBe(3);
		expect(await queue.size()).toBe(0);
		expect(harness.node.size).toBe(4);
	});

	test('leaves a staple queued already to the retries rather than offer it again', async function() {
		const [refused] = staples([[1]]);
		if (refused === undefined) {
			throw(new Error('no staple'));
		}
		const harness = new Harness();
		const offer = vi.spyOn(harness.node, 'offer');
		const queue = harness.queue();

		expect(await queue.add(refused)).toBe('queued');
		expect(await queue.add(refused)).toBe('queued');

		expect(offer).toHaveBeenCalledTimes(1);
		expect(idsOf(await queue.staples())).toEqual([refused.id]);
	});

	test('queues a staple two passes were sent at once only once', async function() {
		const [refused] = staples([[1]]);
		if (refused === undefined) {
			throw(new Error('no staple'));
		}
		const harness = new Harness();
		const queue = harness.queue({ staples: 1, bytes: refused.toBytes().byteLength });

		expect(await Promise.all([queue.add(refused), queue.add(refused)])).toEqual(['queued', 'queued']);

		expect(idsOf(await queue.staples())).toEqual([refused.id]);
		const [other] = staples([[], [1]]).slice(1);
		if (other === undefined) {
			throw(new Error('no staple'));
		}
		await expect(queue.add(other)).rejects.toThrow(RetryQueueFull);
	});

	test('counts a staple whose blocks the ledger holds as held, and lets a queued one go once the ledger holds its blocks by other means', async function() {
		const [genesis, refused] = staples([[], [9]]);
		if (genesis === undefined || refused === undefined) {
			throw(new Error('no staples'));
		}
		const harness = new Harness();
		const queue = harness.queue();
		await harness.node.add(genesis);

		expect(await queue.add(genesis)).toBe('held');
		expect(await queue.add(refused)).toBe('queued');
		// Its blocks arrive with other votes, as over P2P.
		vi.spyOn(harness.node, 'holds').mockReturnValue(true);

		expect(await queue.retry()).toBe(1);
		expect(await queue.size()).toBe(0);
	});

	test('refuses a staple beyond its bound in staples or in bytes, and keeps none of it', async function() {
		const list = staples([[9], [9], [9]]);
		const byCount = new Harness();
		const countBound = byCount.queue({ staples: 2, bytes: 1024 * 1024 });
		await countBound.add(at(list, 0));
		await countBound.add(at(list, 1));

		await expect(countBound.add(at(list, 2))).rejects.toThrow(RetryQueueFull);
		expect(await countBound.size()).toBe(2);
		expect(byCount.store.largest).toBe(2);

		const byBytes = new Harness();
		const bytesBound = byBytes.queue({ staples: 100, bytes: at(list, 0).toBytes().byteLength });
		await bytesBound.add(at(list, 0));
		await expect(bytesBound.add(at(list, 1))).rejects.toThrow(RetryQueueFull);
		expect(await bytesBound.size()).toBe(1);
	});

	test('keeps its staples in its store, so that a queue built on it after a restart applies them', async function() {
		const list = staples([[3], [3], [3], []]);
		const harness = new Harness();
		const before = harness.queue();
		for (const staple of list.slice(0, 3)) {
			await before.add(staple);
		}

		const after = harness.queue();
		expect(idsOf(await after.staples())).toEqual(idsOf(list.slice(0, 3)));
		await harness.node.add(at(list, 3));

		expect(await after.retry()).toBe(3);
		expect(await harness.store.load()).toEqual([]);
	});

	test('reports a staple still refused an hour after it was queued once, across restarts, and keeps it queued', async function() {
		freezeClock(new Date(NOW));
		const [refused] = staples([[7]]);
		if (refused === undefined) {
			throw(new Error('no staple'));
		}
		const harness = new Harness();
		const queue = harness.queue();
		await queue.add(refused);

		advanceClock(REPORT_REFUSED_AFTER_MILLISECONDS - MINUTE);
		await queue.retry();
		expect(harness.reports).toEqual([]);

		advanceClock(MINUTE);
		await queue.retry();
		advanceClock(MINUTE);
		await queue.retry();
		await harness.queue().retry();

		expect(harness.reports).toEqual([{ id: refused.id, code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT', age: REPORT_REFUSED_AFTER_MILLISECONDS }]);
		expect(idsOf(await harness.queue().staples())).toEqual([refused.id]);
	});
});
