import { afterEach, describe, expect, test, vi } from 'vitest';
import { advanceClock, freezeClock } from '../testing/network.js';
import { decodeSimulatedStaple, SimulatedNode, SimulatedPeer, SimulatedRetryStore, simulatedRetries } from '../testing/simulated-peer.js';
import type { RefusalReport, SimulatedStaple } from '../testing/simulated-peer.js';
import { FIRST_BACKOFF_MILLISECONDS, MAX_QUEUED_BYTES, MAX_QUEUED_STAPLES, REPORT_REFUSED_AFTER_MILLISECONDS, RetryQueueFull, sizeOf } from './bootstrap-retry.js';
import type { QueueBounds, QueuedStaple } from './bootstrap-retry.js';
import type { NamedStaple } from './bootstrap-window.js';

const NOW = Date.UTC(2026, 9, 8, 12);
const MINUTE = 60_000;

/** Longer than any wait between two offers of a refused staple. */
const LAST_WAIT = 31 * MINUTE;

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

/** The IDs of simulated staples, as the queue names them by their bytes. */
function idsOf(list: readonly NamedStaple[]): number[] {
	return(list.map(function(staple): number {
		return(decodeSimulatedStaple(staple.toBytes()).id);
	}));
}

class Harness {
	readonly node: SimulatedNode;
	readonly store = new SimulatedRetryStore();
	readonly reports: RefusalReport[] = [];

	/** A node that refuses the staples of these IDs for a balance while they lack what they need, rather than for weight. */
	constructor(spending: ReadonlySet<number> = new Set()) {
		this.node = new SimulatedNode(spending);
	}

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
			expect(await queue.add(staple, 'deep')).toBe('queued');
		}
		expect(await queue.retry()).toBe(0);
		expect(await queue.add(at(list, 3), 'deep')).toBe('added');

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

		expect(await queue.add(refused, 'deep')).toBe('queued');
		expect(await queue.add(refused, 'deep')).toBe('queued');

		expect(offer).toHaveBeenCalledTimes(1);
		expect(idsOf(await queue.staples())).toEqual([refused.id]);
	});

	test('queues nothing of a staple whose record fails to be stored, nor keeps the room it took, so that the next pass sent it offers it again', async function() {
		const [refused] = staples([[1]]);
		if (refused === undefined) {
			throw(new Error('no staple'));
		}
		// The room the staple's record takes, read from a queue that stored it.
		const sizing = new Harness();
		expect(await sizing.queue().add(refused, 'deep')).toBe('queued');
		const [record] = await sizing.store.load();
		if (record === undefined) {
			throw(new Error('no record'));
		}
		const harness = new Harness();
		vi.spyOn(harness.store, 'put').mockRejectedValueOnce(new Error('the write failed'));
		const offer = vi.spyOn(harness.node, 'offer');
		const queue = harness.queue({ staples: 1, bytes: sizeOf(record) });

		await expect(queue.add(refused, 'deep')).rejects.toThrow('the write failed');
		expect(await queue.size()).toBe(0);

		expect(await queue.add(refused, 'deep')).toBe('queued');
		expect(offer).toHaveBeenCalledTimes(2);
		expect(idsOf(await queue.staples())).toEqual([refused.id]);
		expect((await harness.store.load()).length).toBe(1);
	});

	test('queues a staple two passes were sent at once only once', async function() {
		const [refused] = staples([[1]]);
		if (refused === undefined) {
			throw(new Error('no staple'));
		}
		const harness = new Harness();
		const queue = harness.queue({ staples: 1, bytes: 1024 * 1024 });

		expect(await Promise.all([queue.add(refused, 'deep'), queue.add(refused, 'deep')])).toEqual(['queued', 'queued']);

		expect(idsOf(await queue.staples())).toEqual([refused.id]);
		const [other] = staples([[], [1]]).slice(1);
		if (other === undefined) {
			throw(new Error('no staple'));
		}
		await expect(queue.add(other, 'deep')).rejects.toThrow(RetryQueueFull);
	});

	test('counts a staple whose blocks the ledger holds as held, and lets a queued one go once the ledger holds its blocks by other means', async function() {
		const [genesis, refused] = staples([[], [9]]);
		if (genesis === undefined || refused === undefined) {
			throw(new Error('no staples'));
		}
		freezeClock(new Date(NOW));
		const harness = new Harness();
		const queue = harness.queue();
		await harness.node.add(genesis);

		expect(await queue.add(genesis, 'deep')).toBe('held');
		expect(await queue.add(refused, 'deep')).toBe('queued');
		// Its blocks arrive with other votes, as over P2P, which nothing the queue watches for tells it.
		vi.spyOn(harness.node, 'holds').mockReturnValue(true);
		expect(await queue.retry()).toBe(0);

		advanceClock(FIRST_BACKOFF_MILLISECONDS);
		expect(await queue.retry()).toBe(1);
		expect(await queue.size()).toBe(0);
	});

	test('refuses a staple beyond its bound in staples or in bytes, and keeps none of it', async function() {
		const list = staples([[9], [9], [9]]);
		const byCount = new Harness();
		const countBound = byCount.queue({ staples: 2, bytes: 1024 * 1024 });
		await countBound.add(at(list, 0), 'deep');
		await countBound.add(at(list, 1), 'deep');

		await expect(countBound.add(at(list, 2), 'deep')).rejects.toThrow(RetryQueueFull);
		expect(await countBound.size()).toBe(2);
		expect(byCount.store.largest).toBe(2);

		const byBytes = new Harness();
		const sized = new Harness().queue();
		await sized.add(at(list, 0), 'deep');
		const [entry] = await sized.entries();
		if (entry === undefined) {
			throw(new Error('nothing queued'));
		}
		const bytesBound = byBytes.queue({ staples: 100, bytes: sizeOf(entry) });
		await bytesBound.add(at(list, 0), 'deep');
		await expect(bytesBound.add(at(list, 1), 'deep')).rejects.toThrow(RetryQueueFull);
		expect(await bytesBound.size()).toBe(1);
	});

	test('leaves a tenth of its bound to deep re-scans, and says it is saturated once that stops a pass from where the last reached, until a staple leaves it', async function() {
		const list = staples([[], ...Array.from({ length: 11 }, function(): number[] {
			return([0]);
		})]);
		const harness = new Harness();
		const queue = harness.queue({ staples: 10, bytes: 1024 * 1024 });
		for (const staple of list.slice(1, 10)) {
			expect(await queue.add(staple, 'live')).toBe('queued');
		}
		expect(queue.saturated()).toBe(false);

		await expect(queue.add(at(list, 10), 'live')).rejects.toThrow(RetryQueueFull);
		expect(queue.saturated()).toBe(true);
		expect(await queue.add(at(list, 10), 'deep')).toBe('queued');
		await expect(queue.add(at(list, 11), 'deep')).rejects.toThrow(RetryQueueFull);
		expect(await queue.size()).toBe(10);

		await harness.node.add(at(list, 0));
		expect(await queue.retry()).toBe(10);
		expect(queue.saturated()).toBe(false);
	});

	test('lets a pass over a range read ahead of the earliest fill half its bound, without saying it is saturated, and says whether each use finds room', async function() {
		const list = staples([[], ...Array.from({ length: 11 }, function(): number[] {
			return([0]);
		})]);
		const harness = new Harness();
		const queue = harness.queue({ staples: 10, bytes: 1024 * 1024 });
		for (const staple of list.slice(1, 6)) {
			expect(await queue.add(staple, 'ahead')).toBe('queued');
		}
		expect(await queue.hasRoom('ahead')).toBe(false);
		expect(await queue.hasRoom('live')).toBe(true);

		await expect(queue.add(at(list, 6), 'ahead')).rejects.toThrow(RetryQueueFull);
		expect(queue.saturated()).toBe(false);
		for (const staple of list.slice(6, 10)) {
			expect(await queue.add(staple, 'live')).toBe('queued');
		}
		expect(await queue.hasRoom('live')).toBe(false);
		expect(await queue.hasRoom('deep')).toBe(true);

		await harness.node.add(at(list, 0));
		expect(await queue.retry()).toBe(9);
		expect(await queue.hasRoom('ahead')).toBe(true);
	});

	test('keeps its staples in its store, so that a queue built on it after a restart applies them', async function() {
		const list = staples([[3], [3], [3], []]);
		const harness = new Harness();
		const before = harness.queue();
		for (const staple of list.slice(0, 3)) {
			await before.add(staple, 'deep');
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
		await queue.add(refused, 'deep');

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

	test('holds at most MAX_QUEUED_STAPLES and MAX_QUEUED_BYTES unless told otherwise, and says so when full', async function() {
		const list = staples([[], ...Array.from({ length: 901 }, function(): number[] {
			return([0]);
		})]);
		const queue = new Harness().queue();
		for (const staple of list.slice(1, 901)) {
			await queue.add(staple, 'live');
		}

		const full = await queue.add(at(list, 901), 'live').then(function(): never {
			throw(new Error('expected the queue to be full'));
		}, function(error: unknown): unknown {
			return(error);
		});

		expect(full).toBeInstanceOf(RetryQueueFull);
		expect(full).toMatchObject({ name: 'RetryQueueFull', message: `the ledger refused staple staple-901 while the bootstrap retry queue was full (it holds at most ${String(MAX_QUEUED_STAPLES - MAX_QUEUED_STAPLES / 10)} staples, ${String(MAX_QUEUED_BYTES - Math.ceil(MAX_QUEUED_BYTES / 10))} bytes)` });
	});

	test('counts what an entry holds in memory: its bytes and a public key for each account it names', function() {
		const entry: QueuedStaple = { key: 'k', bytes: new ArrayBuffer(10), queuedAt: 0, code: 'X', reported: false, awaited: { kind: 'unknown' } };

		expect(sizeOf(entry)).toBe(10);
		expect(sizeOf({ ...entry, awaited: { kind: 'weight', voters: ['a', 'b'] } })).toBe(10 + 2 * 128);
		expect(sizeOf({ ...entry, awaited: { kind: 'accounts', accounts: ['a', 'b', 'c'] } })).toBe(10 + 3 * 128);
	});

	test('leaves the deep re-scans a tenth of its bound in bytes, and a range read ahead half of it', async function() {
		const list = staples([[9], [9], [9], [9], [9], [9], [9], [9], [9], [9]]);
		const sizing = new Harness().queue();
		await sizing.add(at(list, 0), 'deep');
		const size = sizeOf((await sizing.entries())[0] ?? (function(): never {
			throw(new Error('nothing queued'));
		})());

		const live = new Harness().queue({ staples: 100, bytes: 10 * size });
		for (const staple of list.slice(0, 9)) {
			await live.add(staple, 'live');
		}
		expect(await live.hasRoom('live')).toBe(false);
		await expect(live.add(at(list, 9), 'live')).rejects.toThrow(RetryQueueFull);
		expect(await live.hasRoom('deep')).toBe(true);

		const ahead = new Harness().queue({ staples: 100, bytes: 10 * size });
		for (const staple of list.slice(0, 5)) {
			await ahead.add(staple, 'ahead');
		}
		await expect(ahead.add(at(list, 5), 'ahead')).rejects.toThrow(RetryQueueFull);
		expect(await ahead.hasRoom('ahead')).toBe(false);
		expect(await ahead.hasRoom('live')).toBe(true);
	});

	test('offers the ledger no staple whose blocks it holds, queued or not, and counts one the ledger came to hold as it refused it as held', async function() {
		const [genesis, refused, raced] = staples([[], [9], [9]]);
		if (genesis === undefined || refused === undefined || raced === undefined) {
			throw(new Error('no staples'));
		}
		freezeClock(new Date(NOW));
		const harness = new Harness();
		await harness.node.add(genesis);
		const queue = harness.queue();
		const offer = vi.spyOn(harness.node, 'offer');

		expect(await queue.add(genesis, 'deep')).toBe('held');
		expect(offer).not.toHaveBeenCalled();

		// Another pass adds its blocks as the ledger refuses it.
		const holds = vi.spyOn(harness.node, 'holds').mockReturnValueOnce(false).mockReturnValueOnce(true);
		expect(await queue.add(raced, 'deep')).toBe('held');
		expect(await queue.size()).toBe(0);
		holds.mockRestore();

		expect(await queue.add(refused, 'deep')).toBe('queued');
		offer.mockClear();
		vi.spyOn(harness.node, 'holds').mockReturnValue(true);
		advanceClock(FIRST_BACKOFF_MILLISECONDS);
		expect(await queue.retry()).toBe(1);
		expect(offer).not.toHaveBeenCalled();
	});

	test('lets a queued staple go that the ledger came to hold as it refused it again', async function() {
		const [refused] = staples([[9]]);
		if (refused === undefined) {
			throw(new Error('no staple'));
		}
		freezeClock(new Date(NOW));
		const harness = new Harness();
		const queue = harness.queue();
		await queue.add(refused, 'deep');
		advanceClock(FIRST_BACKOFF_MILLISECONDS);
		vi.spyOn(harness.node, 'holds').mockReturnValueOnce(false).mockReturnValueOnce(true);

		expect(await queue.retry()).toBe(1);
		expect(await queue.size()).toBe(0);
	});

	test('offers at once the staples awaiting an account a staple it applied lands on, in the same retry, and every staple awaiting it', async function() {
		// Two debits need a credit, refused for a balance, which needs genesis, refused for weight.
		const list = staples([[], [0], [1], [1]]);
		const harness = new Harness(new Set([2, 3]));
		const queue = harness.queue();
		for (const staple of list.slice(1)) {
			expect(await queue.add(staple, 'deep')).toBe('queued');
		}
		await harness.node.add(at(list, 0));

		expect(await queue.retry()).toBe(3);
		expect(harness.node.size).toBe(4);
	});

	test('keeps watching an account for a staple that still awaits it after another awaiting it left', async function() {
		const list = staples([[], [0], [1], [1]]);
		const harness = new Harness(new Set([2, 3]));
		const queue = harness.queue();
		freezeClock(new Date(NOW));
		for (const staple of list.slice(1)) {
			await queue.add(staple, 'deep');
		}
		// One debit arrives by other means and leaves the queue once its wait is over.
		const holds = vi.spyOn(harness.node, 'holds').mockImplementation(function(staple): boolean {
			return(staple.blocksHash.toString() === 'staple-2');
		});
		advanceClock(FIRST_BACKOFF_MILLISECONDS);
		await queue.retry();
		holds.mockRestore();
		expect(idsOf(await queue.staples()).sort()).toEqual([1, 3]);

		// Genesis lets the credit in, which lands on the account the other debit awaits.
		await harness.node.add(at(list, 0));
		expect(await queue.retry()).toBe(2);
		expect(idsOf(await queue.staples())).toEqual([]);
	});

	test('waits out the backoff for a staple an account it awaits landed on but the ledger refused again', async function() {
		// A debit needs a credit and a staple no peer has sent; the credit lands, and it is refused again for the other.
		const list = staples([[], [0], [0], [1, 9]]);
		const harness = new Harness(new Set([1, 2, 3]));
		const queue = harness.queue();
		freezeClock(new Date(NOW));
		await harness.node.add(at(list, 0));
		await harness.node.add(at(list, 2));
		expect(await queue.add(at(list, 3), 'deep')).toBe('queued');
		expect(await queue.add(at(list, 1), 'deep')).toBe('added');
		const offer = vi.spyOn(harness.node, 'offer');

		await queue.retry();
		await queue.retry();

		expect(offer).toHaveBeenCalledTimes(1);
		expect(await queue.size()).toBe(1);
	});

	test('records what a staple awaits once it is refused again for another reason, or when it was kept without it, and only then', async function() {
		const [refused] = staples([[9]]);
		if (refused === undefined) {
			throw(new Error('no staple'));
		}
		freezeClock(new Date(NOW));
		const harness = new Harness();
		const bytes = refused.toBytes();
		await harness.store.put({ key: 'staple-0', bytes, queuedAt: NOW, code: 'LEDGER_OTHER', reported: false, awaited: { kind: 'unknown' } });
		const queue = harness.queue();
		expect(await queue.size()).toBe(1);
		const put = vi.spyOn(harness.store, 'put');

		advanceClock(FIRST_BACKOFF_MILLISECONDS);
		await queue.retry();
		expect(put.mock.calls.map(function([entry]): unknown {
			return([entry.code, entry.awaited]);
		})).toEqual([['LEDGER_INSUFFICIENT_VOTING_WEIGHT', { kind: 'weight', voters: ['staple-9'] }]]);

		advanceClock(LAST_WAIT);
		await queue.retry();
		expect(put).toHaveBeenCalledTimes(1);
	});

	test.each<[string, string, QueuedStaple['awaited'], number]>([
		['for another reason, though what it awaits was kept', 'LEDGER_OTHER', { kind: 'weight', voters: ['staple-9'] }, 1],
		['for the same reason, as it was kept awaiting nothing the queue watches for', 'LEDGER_INSUFFICIENT_VOTING_WEIGHT', { kind: 'unknown' }, 1],
		['for the same reason, what it awaits kept', 'LEDGER_INSUFFICIENT_VOTING_WEIGHT', { kind: 'weight', voters: ['staple-9'] }, 0]
	])('records a staple refused again %s that many times', async function(_ignored: string, code: string, awaited: QueuedStaple['awaited'], records: number) {
		const [refused] = staples([[9]]);
		if (refused === undefined) {
			throw(new Error('no staple'));
		}
		freezeClock(new Date(NOW));
		const harness = new Harness();
		await harness.store.put({ key: 'staple-0', bytes: refused.toBytes(), queuedAt: NOW, code, reported: false, awaited });
		const queue = harness.queue();
		expect(await queue.size()).toBe(1);
		const put = vi.spyOn(harness.store, 'put');

		advanceClock(FIRST_BACKOFF_MILLISECONDS);
		await queue.retry();

		expect(put).toHaveBeenCalledTimes(records);
	});

	test('keeps counting an entry it records again once, so that its bound in bytes stays as it was', async function() {
		const list = staples([[9], [9]]);
		const sizing = new Harness().queue();
		await sizing.add(at(list, 0), 'deep');
		const size = sizeOf((await sizing.entries())[0] ?? (function(): never {
			throw(new Error('nothing queued'));
		})());
		freezeClock(new Date(NOW));
		const harness = new Harness();
		const queue = harness.queue({ staples: 100, bytes: 2 * size });
		await queue.add(at(list, 0), 'deep');

		// Reported, and so recorded again, after an hour.
		advanceClock(REPORT_REFUSED_AFTER_MILLISECONDS);
		await queue.retry();

		expect(await queue.add(at(list, 1), 'deep')).toBe('queued');
	});

	test('frees the room of a staple that left it', async function() {
		const list = staples([[], [0], [0]]);
		const sizing = new Harness().queue();
		await sizing.add(at(list, 1), 'deep');
		const size = sizeOf((await sizing.entries())[0] ?? (function(): never {
			throw(new Error('nothing queued'));
		})());
		const harness = new Harness();
		const queue = harness.queue({ staples: 100, bytes: size });
		await queue.add(at(list, 1), 'deep');
		await harness.node.add(at(list, 0));
		expect(await queue.retry()).toBe(1);

		expect(await queue.add(at(list, 2), 'deep')).toBe('added');
		expect(await queue.hasRoom('deep')).toBe(true);
	});

	test('loads its staples earliest refused first, named by the hash of their blocks, and loads again after a load that failed', async function() {
		const list = staples([[9], [9], [9]]);
		const harness = new Harness();
		for (const [index, staple] of list.entries()) {
			await harness.store.put({ key: staple.blocksHash.toString(), bytes: staple.toBytes(), queuedAt: NOW - index, code: 'LEDGER_OTHER', reported: false, awaited: { kind: 'unknown' } });
		}
		const load = vi.spyOn(harness.store, 'load').mockRejectedValueOnce(new Error('the store is down'));
		const queue = harness.queue();

		await expect(queue.size()).rejects.toThrow('the store is down');
		const named = await queue.staples();

		expect(load).toHaveBeenCalledTimes(2);
		expect(idsOf(named)).toEqual([2, 1, 0]);
		expect(named.map(function(staple): string {
			return(staple.blocksHash.toString());
		})).toEqual(['staple-2', 'staple-1', 'staple-0']);
	});
});
