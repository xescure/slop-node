import { afterEach, describe, expect, test, vi } from 'vitest';
import { freezeClock } from '../testing/network.js';
import type { PeerProgress } from './bootstrap-pass.js';
import { FAR_BEHIND_MILLISECONDS, RANGE_OVERLAP_MILLISECONDS, assigned, updateRanges } from './bootstrap-ranges.js';
import type { RangeEvent, RangeIO, RangeLayout, RangeResult, RangeTask } from './bootstrap-ranges.js';
import { BOOTSTRAP_MARGIN_MILLISECONDS } from './bootstrap-window.js';

const NOW = Date.UTC(2026, 9, 9, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const END = NOW - BOOTSTRAP_MARGIN_MILLISECONDS;
const PEERS: readonly string[] = ['rep1', 'rep2', 'rep3', 'rep4'];

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
		const second = harness.layout?.ranges[1];
		await harness.update();
		await harness.update();

		expect(harness.ranges()[1]).toEqual([undefined, (second?.reached.getTime() ?? 0) - RANGE_OVERLAP_MILLISECONDS, second?.end.getTime()]);
		expect(harness.events.at(-1)).toEqual({ kind: 'benched', peer: 'rep2', until: new Date(NOW + 30 * MINUTE) });
		expect(harness.layout?.standings['rep4']).toEqual({ failures: 0, benchedUntil: undefined });

		// The range waits for a peer: none is free, and it is not the earliest.
		await harness.update();
		expect(harness.ranges()[1]?.[0]).toBeUndefined();
		expect(harness.tasks.slice(-3).map(function({ peer }): string {
			return(peer);
		})).toEqual(['rep1', 'rep3', 'rep4']);
	});

	test('reads the earliest range whatever else is read, by the peer of the latest when no other is free', function() {
		const layout: RangeLayout = {
			from: new Date(NOW - 9 * DAY),
			end: new Date(END),
			deepScanPeer: 'rep1',
			ranges: [
				{ reached: new Date(NOW - 9 * DAY), end: new Date(NOW - 6 * DAY), peer: 'rep1' },
				{ reached: new Date(NOW - 6 * DAY), end: new Date(NOW - 3 * DAY), peer: 'rep2' },
				{ reached: new Date(NOW - 3 * DAY), end: new Date(END), peer: 'rep3' }
			],
			standings: { rep1: { failures: 0, benchedUntil: new Date(NOW + MINUTE) } }
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

	test('gives a free peer half of what is left of the range with the most left, as long as that half is several overlaps long', function() {
		const reached = NOW - 2 * DAY;
		const layout: RangeLayout = {
			from: new Date(NOW - 9 * DAY),
			end: new Date(END),
			deepScanPeer: 'rep1',
			ranges: [
				{ reached: new Date(NOW - 5 * DAY), end: new Date(NOW - 4 * DAY), peer: 'rep1' },
				{ reached: new Date(reached), end: new Date(END), peer: 'rep2' }
			],
			standings: {}
		};
		const middle = reached + Math.floor((END - reached) / 2);

		expect(assigned(layout, ['rep1', 'rep2', 'rep3'], NOW).ranges.map(function(range): [string | undefined, number, number] {
			return([range.peer, range.reached.getTime(), range.end.getTime()]);
		})).toEqual([
			['rep1', NOW - 5 * DAY, NOW - 4 * DAY],
			['rep2', reached, middle],
			['rep3', middle - RANGE_OVERLAP_MILLISECONDS, END]
		]);
		const short: RangeLayout = { ...layout, ranges: [{ reached: new Date(END - 3 * RANGE_OVERLAP_MILLISECONDS), end: new Date(END), peer: 'rep1' }] };
		expect(assigned(short, ['rep1', 'rep2'], NOW).ranges).toEqual(short.ranges);
	});

	test('reads no range ahead of the earliest while the retry queue has no room for them', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness();
		harness.progress.set('rep1', progressAt(NOW - 9 * DAY));
		harness.hasRoomAhead = false;

		expect(await harness.update()).toEqual(new Map([['rep1', 'bounded']]));
		expect(harness.tasks.map(function({ peer, task }): [string, string] {
			return([peer, task.use]);
		})).toEqual([['rep1', 'live']]);
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
		expect(harness.events.map(function(event): string {
			return(event.kind);
		})).toEqual(['laid-out', 'read']);
	});
});
