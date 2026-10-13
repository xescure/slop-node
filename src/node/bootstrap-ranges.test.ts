import { afterEach, describe, expect, test, vi } from 'vitest';
import { advanceClock, freezeClock } from '../testing/network.js';
import { MAX_PASS_MILLISECONDS } from './bootstrap-pass.js';
import type { PeerProgress } from './bootstrap-pass.js';
import { FAR_AHEAD_MILLISECONDS, FAR_BEHIND_MILLISECONDS, RANGE_OVERLAP_MILLISECONDS, assigned, updateRanges } from './bootstrap-ranges.js';
import type { BootstrapRange, RangeEvent, RangeIO, RangeLayout, RangeResult, RangeTask } from './bootstrap-ranges.js';
import { BOOTSTRAP_MARGIN_MILLISECONDS } from './bootstrap-window.js';

const NOW = Date.UTC(2026, 9, 9, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const END = NOW - BOOTSTRAP_MARGIN_MILLISECONDS;
const PEERS: readonly string[] = ['rep1', 'rep2', 'rep3', 'rep4'];

/** A range not read yet, as laid out, under that ID. */
function rangeOf(id: number, reached: number, end: number, peer: string | undefined): BootstrapRange {
	return({ id, reached: new Date(reached), end: new Date(end), peer, pace: { spent: 0, advanced: 0 } });
}

function kindsOf(events: readonly RangeEvent[]): string[] {
	return(events.map(function(event): string {
		return(event.kind);
	}));
}

/** Lets the passes under way take their turns, as a peer answering does. */
async function turns(count: number): Promise<void> {
	for (let turn = 0; turn < count; turn++) {
		await new Promise(setImmediate);
	}
}

function progressAt(reached: number, deepScanFrom = 0): PeerProgress {
	return({ reached: new Date(reached), caughtUp: false, deepScanFrom: new Date(deepScanFrom), nextDeepScan: new Date(NOW + HOUR), deepScan: undefined, keying: 'votes' });
}

/** What the node keeps of its peers and ranges, in memory, and the passes over ranges, which end as the script for each peer says. */
class Harness implements RangeIO {
	readonly progress = new Map<string, PeerProgress>();
	layout: RangeLayout | undefined;
	isSaturated = false;
	hasRoomAhead = true;
	readonly events: RangeEvent[] = [];
	readonly tasks: { readonly peer: string; readonly task: RangeTask }[] = [];
	script: (peer: string, task: RangeTask) => Promise<RangeResult> = function(): Promise<RangeResult> {
		return(Promise.resolve('bounded'));
	};

	readProgress(peer: string): Promise<PeerProgress | undefined> {
		return(Promise.resolve(this.progress.get(peer)));
	}

	writeProgress(peer: string, progress: PeerProgress): Promise<void> {
		this.progress.set(peer, progress);
		return(Promise.resolve());
	}

	readLayout(): Promise<RangeLayout | undefined> {
		return(Promise.resolve(this.layout));
	}

	writeLayout(layout: RangeLayout | undefined): Promise<void> {
		this.layout = layout;
		return(Promise.resolve());
	}

	saturated(): Promise<boolean> {
		return(Promise.resolve(this.isSaturated));
	}

	roomAhead(): Promise<boolean> {
		return(Promise.resolve(this.hasRoomAhead));
	}

	report(event: RangeEvent): void {
		this.events.push(event);
	}

	update(peers: readonly string[] = PEERS): ReturnType<typeof updateRanges> {
		return(updateRanges(peers, this, (peer, task) => {
			this.tasks.push({ peer, task });
			return(this.script(peer, task));
		}));
	}

	/** Each range as [peer, where it reached, its end], in order. */
	ranges(): (readonly [string | undefined, number, number])[] {
		return((this.layout?.ranges ?? []).map(function(range): readonly [string | undefined, number, number] {
			return([range.peer, range.reached.getTime(), range.end.getTime()]);
		}));
	}
}

describe('reading the history in ranges', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('lays out what the node lacks in one range per peer, each starting the overlap before the one before ends, once it is far behind on every peer', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		const from = NOW - 9 * DAY;
		harness.progress.set('rep2', progressAt(from));
		harness.progress.set('rep1', progressAt(from - 3 * DAY));

		const results = await harness.update();

		const span = (END - from) / 4;
		const ends = [from + span, from + 2 * span, from + 3 * span, END].map(Math.floor);
		expect(harness.ranges()).toEqual([
			['rep1', from - RANGE_OVERLAP_MILLISECONDS, ends[0]],
			['rep2', (ends[0] ?? 0) - RANGE_OVERLAP_MILLISECONDS, ends[1]],
			['rep3', (ends[1] ?? 0) - RANGE_OVERLAP_MILLISECONDS, ends[2]],
			['rep4', (ends[2] ?? 0) - RANGE_OVERLAP_MILLISECONDS, END]
		]);
		expect(harness.layout).toMatchObject({ from: new Date(from), end: new Date(END), deepScanPeer: 'rep2' });
		expect(harness.tasks.map(function({ peer, task }): [string, string, number] {
			return([peer, task.use, task.from.getTime()]);
		})).toEqual([
			['rep1', 'live', from - RANGE_OVERLAP_MILLISECONDS],
			['rep2', 'ahead', from - RANGE_OVERLAP_MILLISECONDS],
			['rep3', 'ahead', from - RANGE_OVERLAP_MILLISECONDS],
			['rep4', 'ahead', from - RANGE_OVERLAP_MILLISECONDS]
		]);
		expect(results).toEqual(new Map(PEERS.map(function(peer): [string, 'bounded'] {
			return([peer, 'bounded']);
		})));
		expect(harness.events.map(function(event): string {
			return(event.kind);
		})).toEqual(['laid-out']);
	});

	test('lays out nothing within a day of the present, from the beginning of time, with one peer, or while the retry queue stops the passes', async function() {
		freezeClock(new Date(NOW));
		const near = new Harness();
		near.progress.set('rep1', progressAt(END - FAR_BEHIND_MILLISECONDS));
		const fresh = new Harness();
		fresh.progress.set('rep1', progressAt(0));
		const alone = new Harness();
		alone.progress.set('rep1', progressAt(NOW - 9 * DAY));
		const full = new Harness();
		full.progress.set('rep1', progressAt(NOW - 9 * DAY));
		full.isSaturated = true;

		expect(await near.update()).toBeUndefined();
		expect(await fresh.update()).toBeUndefined();
		expect(await alone.update(['rep1'])).toBeUndefined();
		expect(await full.update()).toBeUndefined();
		expect([near, fresh, alone, full].map(function(harness): unknown {
			return(harness.layout);
		})).toEqual([undefined, undefined, undefined, undefined]);
	});

	test('records where each range reached as its pass moves on, and resumes the ranges kept rather than lay them out again', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		harness.progress.set('rep1', progressAt(NOW - 9 * DAY));
		harness.script = async function(peer, task): Promise<RangeResult> {
			if (peer === 'rep3') {
				await task.moved(new Date(task.reached.getTime() + HOUR));
			}
			return('bounded');
		};
		await harness.update();
		const third = harness.layout?.ranges[2];

		freezeClock(new Date(NOW + 10 * DAY));
		await harness.update();

		expect(harness.layout?.ranges[2]?.reached.getTime()).toBe((third?.reached.getTime() ?? 0) + HOUR);
		expect(harness.tasks.at(-2)).toMatchObject({ peer: 'rep3', task: { reached: third?.reached } });
		expect(harness.events.map(function(event): string {
			return(event.kind);
		})).toEqual(['laid-out']);
	});

	test('leaves the range of a peer whose passes failed three times in a row to a free peer, the overlap before where it reached, and benches the peer for half an hour', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		harness.progress.set('rep1', progressAt(NOW - 9 * DAY));
		harness.script = function(peer): Promise<RangeResult> {
			if (peer === 'rep2') {
				return(Promise.resolve('failed'));
			}
			if (peer === 'rep4') {
				return(Promise.resolve('throttled'));
			}
			return(Promise.resolve('bounded'));
		};
		await harness.update();
		const second = harness.layout?.ranges.find(function(range): boolean {
			return(range.id === 1);
		});
		await harness.update();
		await harness.update();
		const secondNow = function(): BootstrapRange | undefined {
			return(harness.layout?.ranges.find(function(range): boolean {
				return(range.id === 1);
			}));
		};

		expect(secondNow()).toMatchObject({ peer: undefined, reached: new Date((second?.reached.getTime() ?? 0) - RANGE_OVERLAP_MILLISECONDS), end: second?.end });
		expect(harness.events.at(-1)).toEqual({ kind: 'benched', peer: 'rep2', until: new Date(NOW + 30 * MINUTE) });
		expect(harness.layout?.standings['rep4']).toEqual({ failures: 0, benchedUntil: undefined });

		// The range waits for a peer: none is free, and it is not the earliest; the peer whose range read ahead found no room reads part of the earliest.
		await harness.update();
		expect(secondNow()?.peer).toBeUndefined();
		expect(harness.tasks.slice(-3).map(function({ peer, task }): [string, string] {
			return([peer, task.use]);
		})).toEqual([['rep1', 'live'], ['rep3', 'ahead'], ['rep4', 'live']]);
	});

	test('reads the earliest range whatever else is read, by the peer of the latest when no other is free', function() {
		const layout: RangeLayout = {
			from: new Date(NOW - 9 * DAY),
			end: new Date(END),
			deepScanPeer: 'rep1',
			ranges: [
				rangeOf(0, NOW - 9 * DAY, NOW - 6 * DAY, 'rep1'),
				rangeOf(1, NOW - 6 * DAY, NOW - 3 * DAY, 'rep2'),
				rangeOf(2, NOW - 3 * DAY, END, 'rep3')
			],
			standings: { rep1: { failures: 0, benchedUntil: new Date(NOW + MINUTE) } },
			fullQueueUpdates: 0,
			nextID: 3
		};

		expect(assigned(layout, ['rep1', 'rep2', 'rep3'], NOW).ranges.map(function(range): [string | undefined, number] {
			return([range.peer, range.reached.getTime()]);
		})).toEqual([
			['rep3', NOW - 9 * DAY - RANGE_OVERLAP_MILLISECONDS],
			['rep2', NOW - 6 * DAY],
			[undefined, NOW - 3 * DAY - RANGE_OVERLAP_MILLISECONDS]
		]);
		// A benched peer reads again once every peer is benched.
		expect(assigned({ ...layout, standings: { rep1: layout.standings['rep1'] ?? { failures: 0, benchedUntil: undefined }, rep2: { failures: 0, benchedUntil: new Date(NOW + MINUTE) }, rep3: { failures: 0, benchedUntil: new Date(NOW + MINUTE) } } }, ['rep1', 'rep2', 'rep3'], NOW).ranges.map(function(range): string | undefined {
			return(range.peer);
		})).toEqual(['rep1', 'rep2', 'rep3']);
	});

	test('gives a free peer half of what is left of the range with the most left, as long as that half is several overlaps long', async function() {
		freezeClock(new Date(NOW));
		const reached = NOW - 2 * DAY;
		const harness = new Harness();
		harness.layout = {
			from: new Date(NOW - 9 * DAY),
			end: new Date(END),
			deepScanPeer: 'rep1',
			ranges: [rangeOf(0, NOW - 5 * DAY, NOW - 4 * DAY, 'rep1'), rangeOf(1, reached, END, 'rep2')],
			standings: {},
			fullQueueUpdates: 0,
			nextID: 3
		};
		const middle = reached + Math.floor((END - reached) / 2);

		await harness.update(['rep1', 'rep2', 'rep3']);

		expect(harness.ranges()).toEqual([
			['rep1', NOW - 5 * DAY, NOW - 4 * DAY],
			['rep2', reached, middle],
			['rep3', middle - RANGE_OVERLAP_MILLISECONDS, END]
		]);
		expect(harness.events).toMatchObject([{ kind: 'split', peer: 'rep3', left: { peer: 'rep2', end: new Date(middle) }, taken: { id: 3, peer: 'rep3' } }]);
		// Each pass is told the range it reads, by its ID within the layout, the split-off part by the ID it took, so that it keeps its own page limit.
		expect(harness.tasks.map(function({ peer, task }): [string, number, number] {
			return([peer, task.id, task.layout.getTime()]);
		}).sort()).toEqual([['rep1', 0, NOW - 9 * DAY], ['rep2', 1, NOW - 9 * DAY], ['rep3', 3, NOW - 9 * DAY]]);

		const short = new Harness();
		short.layout = { ...harness.layout, ranges: [rangeOf(0, END - 3 * RANGE_OVERLAP_MILLISECONDS, END, 'rep1')] };
		await short.update(['rep1', 'rep2']);
		expect(short.ranges()).toEqual([['rep1', END - 3 * RANGE_OVERLAP_MILLISECONDS, END]]);
	});

	test('splits the range its passes would take longest to read what is left of at the pace they read it, not the widest', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		const dense = { ...rangeOf(0, NOW - 9 * DAY, NOW - 8 * DAY, 'rep1'), pace: { spent: 10 * MINUTE, advanced: MINUTE } };
		const sparse = { ...rangeOf(1, NOW - 8 * DAY, END, 'rep2'), pace: { spent: MINUTE, advanced: 3 * DAY } };
		harness.layout = { from: new Date(NOW - 9 * DAY), end: new Date(END), deepScanPeer: 'rep1', ranges: [dense, sparse], standings: {}, fullQueueUpdates: 0, nextID: 2 };

		await harness.update(['rep1', 'rep2', 'rep3']);

		const middle = NOW - 9 * DAY + 12 * HOUR;
		expect(harness.ranges().slice(0, 2)).toEqual([
			['rep1', NOW - 9 * DAY, middle],
			['rep3', middle - RANGE_OVERLAP_MILLISECONDS, NOW - 8 * DAY]
		]);
		expect(harness.events).toMatchObject([{ kind: 'split', taken: { pace: dense.pace } }]);
	});

	test('takes on, once its range is read, the later half of another within the same update, whose pass stops at its new end', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		const reached = NOW - 9 * DAY;
		harness.layout = {
			from: new Date(reached),
			end: new Date(END),
			deepScanPeer: 'rep1',
			ranges: [rangeOf(0, reached, NOW - 5 * DAY, 'rep1'), rangeOf(1, NOW - 5 * DAY, END, 'rep2')],
			standings: {},
			fullQueueUpdates: 0,
			nextID: 3
		};
		const ends: number[] = [];
		let completed = false;
		harness.script = async function(peer, task): Promise<RangeResult> {
			if (peer === 'rep2' && !completed) {
				completed = true;
				return('completed');
			}
			if (peer === 'rep1') {
				ends.push(task.end().getTime());
				await turns(20);
				ends.push(task.end().getTime());
			}
			return('bounded');
		};

		await harness.update(['rep1', 'rep2']);

		const middle = reached + Math.floor((NOW - 5 * DAY - reached) / 2);
		expect(ends).toEqual([NOW - 5 * DAY, middle]);
		expect(harness.tasks.map(function({ peer, task }): [string, number, number] {
			return([peer, task.reached.getTime(), task.end().getTime()]);
		})).toEqual([
			['rep1', reached, middle],
			['rep2', NOW - 5 * DAY, END],
			['rep2', middle - RANGE_OVERLAP_MILLISECONDS, NOW - 5 * DAY]
		]);
		expect(harness.ranges()).toEqual([
			['rep1', reached, middle],
			['rep2', middle - RANGE_OVERLAP_MILLISECONDS, NOW - 5 * DAY]
		]);
	});

	test('reads no range ahead of the earliest while the retry queue has no room for them, whose peers take on parts of the first day of the earliest instead', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		harness.progress.set('rep1', progressAt(NOW - 9 * DAY));
		harness.hasRoomAhead = false;

		expect(await harness.update()).toEqual(new Map(PEERS.map(function(peer): [string, 'bounded'] {
			return([peer, 'bounded']);
		})));
		const earliest = harness.layout?.ranges[0]?.reached.getTime() ?? 0;
		expect(harness.tasks.map(function({ peer, task }): [string, string, boolean] {
			return([peer, task.use, task.reached.getTime() < earliest + FAR_AHEAD_MILLISECONDS]);
		})).toEqual(PEERS.map(function(peer): [string, string, boolean] {
			return([peer, 'live', true]);
		}));
		expect(kindsOf(harness.events)).toEqual(['laid-out', 'split', 'split', 'split']);
		expect(harness.ranges().filter(function([, reached]): boolean {
			return(reached >= earliest + FAR_AHEAD_MILLISECONDS);
		}).map(function([peer]): string | undefined {
			return(peer);
		})).toEqual([undefined, undefined, undefined]);
	});

	test('reads, while the retry queue is full, only the ranges within a day of the earliest, and every fifth update the peers from where they last reached', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		harness.progress.set('rep1', progressAt(NOW - 9 * DAY));
		await harness.update();
		harness.isSaturated = true;
		harness.tasks.length = 0;

		for (let update = 1; update <= 4; update++) {
			expect(await harness.update()).toBeDefined();
			expect(harness.layout?.fullQueueUpdates).toBe(update);
		}
		const earliest = harness.layout?.ranges[0]?.reached.getTime() ?? 0;
		expect(harness.tasks.every(function({ task }): boolean {
			return(task.use === 'live' && task.reached.getTime() < earliest + FAR_AHEAD_MILLISECONDS);
		})).toBe(true);
		expect(new Set(harness.tasks.map(function({ peer }): string {
			return(peer);
		}))).toEqual(new Set(PEERS));

		expect(await harness.update()).toBeUndefined();
		expect(harness.layout?.fullQueueUpdates).toBe(0);
		expect(await harness.update()).toBeDefined();
		harness.isSaturated = false;
		await harness.update();
		expect(harness.layout?.fullQueueUpdates).toBe(0);
	});

	test('moves every peer it has progress on to the end of the ranges less the overlap once every range is read, the peer it had reached furthest on keeping its next deep re-scan back to where they began', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		const from = NOW - 9 * DAY;
		harness.progress.set('rep1', progressAt(from - DAY, from - 2 * DAY));
		harness.progress.set('rep2', progressAt(from, from - 5 * DAY));
		harness.progress.set('rep3', progressAt(from - DAY, from - DAY));
		harness.script = function(): Promise<RangeResult> {
			return(Promise.resolve('completed'));
		};

		await harness.update();

		const reached = END - RANGE_OVERLAP_MILLISECONDS;
		expect(harness.layout).toBeUndefined();
		expect(Object.fromEntries([...harness.progress].map(function([peer, progress]): [string, [number, number]] {
			return([peer, [progress.reached.getTime(), progress.deepScanFrom.getTime()]]);
		}))).toEqual({
			rep1: [reached, reached],
			rep2: [reached, from - 5 * DAY],
			rep3: [reached, reached]
		});
		expect(kindsOf(harness.events).filter(function(kind): boolean {
			return(kind !== 'split');
		})).toEqual(['laid-out', 'read']);
	});

	/** A layout of the ranges given, from nine days back up to the end. */
	function layoutOf(ranges: readonly BootstrapRange[], rest: Partial<RangeLayout> = {}): RangeLayout {
		return({ from: new Date(NOW - 9 * DAY), end: new Date(END), deepScanPeer: 'rep1', ranges, standings: {}, fullQueueUpdates: 0, nextID: ranges.length, ...rest });
	}

	function peersOf(layout: RangeLayout | undefined): (string | undefined)[] {
		return((layout?.ranges ?? []).map(function(range): string | undefined {
			return(range.peer);
		}));
	}

	test('reads again with a peer benched until the present', function() {
		const layout = layoutOf([rangeOf(0, NOW - 9 * DAY, NOW - 5 * DAY, 'rep1'), rangeOf(1, NOW - 5 * DAY, END, 'rep2')], { standings: { rep2: { failures: 0, benchedUntil: new Date(NOW) } } });

		expect(peersOf(assigned(layout, ['rep1', 'rep2'], NOW))).toEqual(['rep1', 'rep2']);
		expect(peersOf(assigned(layout, ['rep1', 'rep2'], NOW - 1))).toEqual(['rep1', undefined]);
	});

	test('reads a range that starts a day past the earliest as read ahead, and none such while the ranges read ahead wait', async function() {
		freezeClock(new Date(NOW));
		const earliest = NOW - 9 * DAY;
		const ranges = [rangeOf(0, earliest, earliest + DAY, 'rep1'), rangeOf(1, earliest + FAR_AHEAD_MILLISECONDS, END, 'rep2')];
		const reading = new Harness();
		reading.layout = layoutOf(ranges);
		const waiting = new Harness();
		waiting.layout = layoutOf(ranges);
		waiting.hasRoomAhead = false;

		await reading.update(['rep1', 'rep2']);
		await waiting.update(['rep1', 'rep2']);

		expect(reading.tasks.map(function({ peer, task }): [string, string] {
			return([peer, task.use]);
		})).toEqual([['rep1', 'live'], ['rep2', 'ahead']]);
		// Its own range waits, so it reads part of the earliest instead.
		expect(waiting.tasks.map(function({ peer, task }): [string, string, boolean] {
			return([peer, task.use, task.reached.getTime() < earliest + FAR_AHEAD_MILLISECONDS]);
		})).toEqual([['rep1', 'live', true], ['rep2', 'live', true]]);
	});

	test('hands the latest range\'s peer the earliest only once every peer reads a range of its own, and leaves the ranges as they are with no peer', function() {
		const ranges = [rangeOf(0, NOW - 9 * DAY, NOW - 6 * DAY, undefined), rangeOf(1, NOW - 6 * DAY, NOW - 3 * DAY, 'rep1'), rangeOf(2, NOW - 3 * DAY, END, undefined)];
		const layout = layoutOf(ranges);

		// A free peer takes the earliest on as the update runs.
		expect(assigned(layout, ['rep1', 'rep2'], NOW).ranges).toEqual(ranges);
		expect(assigned(layout, ['rep1'], NOW).ranges.map(function(range): [string | undefined, number] {
			return([range.peer, range.reached.getTime()]);
		})).toEqual([['rep1', NOW - 9 * DAY], [undefined, NOW - 6 * DAY - RANGE_OVERLAP_MILLISECONDS], [undefined, NOW - 3 * DAY]]);
		expect(assigned(layoutOf([rangeOf(0, NOW - 9 * DAY, END, undefined)]), [], NOW).ranges).toEqual([rangeOf(0, NOW - 9 * DAY, END, undefined)]);
	});

	test('lays out what the node lacks between two peers', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		harness.progress.set('rep1', progressAt(NOW - 9 * DAY));

		await harness.update(['rep1', 'rep2']);

		expect(peersOf(harness.layout)).toEqual(['rep1', 'rep2']);
	});

	test('keeps the start of the next deep re-scan back on the first peer it has progress on when the one it had reached furthest on has none', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		const from = NOW - 9 * DAY;
		harness.layout = layoutOf([rangeOf(0, from, END, 'rep2')], { from: new Date(from), deepScanPeer: 'rep1' });
		harness.progress.set('rep2', progressAt(from, from - DAY));
		harness.script = function(): Promise<RangeResult> {
			return(Promise.resolve('completed'));
		};

		await harness.update(['rep1', 'rep2']);

		expect(harness.progress.get('rep2')?.deepScanFrom).toEqual(new Date(from - DAY));
		expect(harness.progress.has('rep1')).toBe(false);
	});

	test('counts a stopped pass neither for its peer nor against it, and reports it as failed', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		harness.layout = layoutOf([rangeOf(0, NOW - 9 * DAY, NOW - 5 * DAY, 'rep1'), rangeOf(1, NOW - 5 * DAY, END, 'rep2')], { standings: { rep2: { failures: 2, benchedUntil: undefined } } });
		harness.script = function(peer): Promise<RangeResult> {
			if (peer === 'rep2') {
				return(Promise.resolve('stopped'));
			}
			return(Promise.resolve('bounded'));
		};

		expect(await harness.update(['rep1', 'rep2'])).toEqual(new Map([['rep1', 'bounded'], ['rep2', 'failed']]));

		expect(harness.layout.standings['rep2']).toEqual({ failures: 2, benchedUntil: undefined });
	});

	test('takes on no other range once a pass that read its own ended as the update\'s time ran out', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		harness.layout = layoutOf([rangeOf(0, NOW - 9 * DAY, NOW - DAY, 'rep1'), rangeOf(1, NOW - DAY, END, 'rep2')]);
		harness.script = function(peer): Promise<RangeResult> {
			if (peer === 'rep2') {
				advanceClock(MAX_PASS_MILLISECONDS);
				return(Promise.resolve('completed'));
			}
			return(Promise.resolve('bounded'));
		};

		await harness.update(['rep1', 'rep2']);

		expect(harness.tasks.map(function({ peer }): string {
			return(peer);
		})).toEqual(['rep1', 'rep2']);
		expect(kindsOf(harness.events)).toEqual([]);
	});

	test('leaves its own range for another once it takes on one near the earliest, and keeps it when it takes on none', async function() {
		freezeClock(new Date(NOW));
		const earliest = NOW - 9 * DAY;
		const taking = new Harness();
		taking.hasRoomAhead = false;
		taking.layout = layoutOf([rangeOf(0, earliest, earliest + 2 * RANGE_OVERLAP_MILLISECONDS, undefined), rangeOf(1, earliest + 2 * DAY, END, 'rep2'), rangeOf(2, earliest + DAY - HOUR, earliest + 2 * DAY, 'rep1')]);

		await taking.update(['rep1', 'rep2']);

		expect(taking.ranges().map(function([peer, reached]): [string | undefined, number] {
			return([peer, reached]);
		})).toEqual([['rep2', earliest], [undefined, earliest + 2 * DAY - RANGE_OVERLAP_MILLISECONDS], ['rep1', earliest + DAY - HOUR]]);

		const keeping = new Harness();
		keeping.hasRoomAhead = false;
		keeping.layout = layoutOf([rangeOf(0, earliest, earliest + 2 * RANGE_OVERLAP_MILLISECONDS, 'rep1'), rangeOf(1, earliest + 2 * DAY, END, 'rep2')]);

		await keeping.update(['rep1', 'rep2']);

		expect(peersOf(keeping.layout)).toEqual(['rep1', 'rep2']);
	});

	test('splits a range with exactly enough left to split, at a pace that takes longer than an update, and the first of two that take as long', async function() {
		freezeClock(new Date(NOW));
		const reached = NOW - 9 * DAY;
		const split = 4 * RANGE_OVERLAP_MILLISECONDS;
		const exact = new Harness();
		exact.layout = layoutOf([rangeOf(0, reached, reached + split, 'rep1')]);
		await exact.update(['rep1', 'rep2']);
		expect(kindsOf(exact.events)).toEqual(['split']);

		// A quarter of a millisecond of reading per millisecond of history leaves an update's worth to read.
		const quick = new Harness();
		quick.layout = layoutOf([{ ...rangeOf(0, reached, reached + 4 * MAX_PASS_MILLISECONDS, 'rep1'), pace: { spent: 0, advanced: 3000 } }]);
		await quick.update(['rep1', 'rep2']);
		expect(kindsOf(quick.events)).toEqual([]);

		const tied = new Harness();
		tied.layout = layoutOf([rangeOf(0, reached, reached + DAY, 'rep1'), rangeOf(1, reached + 2 * DAY, reached + 3 * DAY, 'rep2')]);
		await tied.update(['rep1', 'rep2', 'rep3']);
		expect(tied.events).toMatchObject([{ kind: 'split', left: { id: 0 } }]);
	});

	test('records the pace of a pass that read its range for as long as it could, and none of one that failed', async function() {
		freezeClock(new Date(NOW));
		const reached = NOW - 9 * DAY;
		const harness = new Harness();
		harness.layout = layoutOf([rangeOf(0, reached, NOW - 5 * DAY, 'rep1'), rangeOf(1, NOW - 5 * DAY, END, 'rep2')]);
		harness.script = async function(peer, task): Promise<RangeResult> {
			advanceClock(10_000);
			await task.moved(new Date(task.reached.getTime() + 5000));
			if (peer === 'rep2') {
				return('failed');
			}
			return('bounded');
		};

		await harness.update(['rep1', 'rep2']);

		expect(harness.layout.ranges.map(function(range): unknown {
			return(range.pace);
		})).toEqual([{ spent: 20_000, advanced: 5000 }, { spent: 0, advanced: 0 }]);
	});

	test('splits a range at the pace of the pass under way over it as well', async function() {
		freezeClock(new Date(NOW));
		const reached = NOW - 9 * DAY;
		const harness = new Harness();
		harness.layout = layoutOf([rangeOf(0, reached, NOW - DAY, 'rep1'), rangeOf(1, NOW - DAY, END, 'rep2')]);
		let release: (() => void) | undefined;
		const released = new Promise<void>(function(resolve) {
			release = resolve;
		});
		harness.script = async function(peer, task): Promise<RangeResult> {
			if (peer === 'rep1') {
				advanceClock(MINUTE);
				await task.moved(new Date(task.reached.getTime() + 6000));
				await released;
				return('bounded');
			}
			await turns(5);
			return('completed');
		};

		const update = harness.update(['rep1', 'rep2']);
		await turns(30);
		release?.();
		await update;

		expect(harness.events[0]).toMatchObject({ kind: 'split', peer: 'rep2', taken: { pace: { spent: MINUTE, advanced: 6000 } } });
	});

	test('moves the peers on from a layout kept with every range read, before it lays out any other', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		const from = NOW - 9 * DAY;
		harness.layout = layoutOf([], { from: new Date(from), deepScanPeer: 'rep1' });
		harness.progress.set('rep1', progressAt(from, from - DAY));

		expect(await harness.update(['rep1', 'rep2'])).toBeUndefined();

		expect(harness.layout).toBeUndefined();
		expect(harness.progress.get('rep1')).toMatchObject({ reached: new Date(END - RANGE_OVERLAP_MILLISECONDS), deepScanFrom: new Date(from - DAY) });
		expect(kindsOf(harness.events)).toEqual(['read']);
	});
});
