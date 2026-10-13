import { describe, expect, test } from 'vitest';
import {
	KeyingRecord,
	KnownVotes,
	VOTE_KEY_TOLERANCE_MILLISECONDS,
	countedReach,
	listedForEarlierVotes,
	madeBetween,
	mayShowPast,
	reachOf,
	shownTarget,
	shows,
	wholeBelowOf
} from './bootstrap-evidence.js';
import type { Evidence, PeerKeying } from './bootstrap-evidence.js';
import { DEEP_SCAN_DEPTH_MILLISECONDS, DEEP_SCAN_PERIOD_MILLISECONDS, firstProgress, probesHorizonAfter, withDeepScanBegun } from './bootstrap-pass.js';
import type { PassEvent, PassStaple, PeerProgress } from './bootstrap-pass.js';
import { BOOTSTRAP_MARGIN_MILLISECONDS, stapleKey } from './bootstrap-window.js';

const TOLERANCE = VOTE_KEY_TOLERANCE_MILLISECONDS;

/** The most votes a peer reads at a time for a request [Keeta TS] index.js:70691-70695. */
const VOTES_PER_READ = 200;

/** A staple of its own name whose votes were made at the moments given. */
function stapleOf(name: string, stamps: readonly number[]): PassStaple {
	const bytes = new TextEncoder().encode(`${name}@${stamps.join(',')}`);
	return({
		blocksHash: { toString: function(): string {
			return(name);
		} },
		toBytes: function(): ArrayBuffer {
			return(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		},
		votes: stamps.map(function(stamp) {
			return({ validityFrom: new Date(stamp) });
		})
	});
}

function keyingOf(current: PeerKeying): KeyingRecord {
	return(new KeyingRecord(current, function(): Promise<void> {
		return(Promise.resolve());
	}, function(): void {
		// What the record reports is not looked at here.
	}));
}

function evidenceOf(page: readonly PassStaple[], keying: PeerKeying, rest: Partial<Pick<Evidence<PassStaple>, 'start' | 'wholeBelow' | 'countedTo'>> = {}): Evidence<PassStaple> {
	return({ page, start: 0, keying: keyingOf(keying), wholeBelow: page.length, countedTo: Number.NEGATIVE_INFINITY, ...rest });
}

describe('what a page shows of how far a peer read', function() {
	test('a staple is shown to be read up to the tolerance before its first vote', function() {
		expect(reachOf(stapleOf('a', [5000, 3000, 9000]))).toBe(3000 - TOLERANCE);
	});

	test('a staple none of whose votes was made at or after the tolerance before the start was listed for when the peer applied it', function() {
		const start = 100_000;
		const atTheTolerance = stapleOf('at', [start - TOLERANCE]);
		const oneVoteLater = stapleOf('later', [start - 5 * TOLERANCE, start + 5]);
		const earlier = stapleOf('earlier', [start - TOLERANCE - 1, start - 2 * TOLERANCE]);
		const alsoEarlier = stapleOf('also', [start - 3 * TOLERANCE]);

		expect(listedForEarlierVotes([atTheTolerance, oneVoteLater, earlier, alsoEarlier], start)).toBe(earlier);
		expect(listedForEarlierVotes([atTheTolerance, oneVoteLater], start)).toBeUndefined();
	});

	test.each<[string, number, number, number, number]>([
		['shorter than the limit and the longest answer: all of it', 5, 10, 10, 5],
		['as long as the limit: none of its last read', 5, 5, 10, 0],
		['as long as the longest answer: none of its last read', 5, 10, 5, 0],
		['longer than the longest answer: none of its last read', 5, 10, 3, 0],
		['longer than a read: all but its last read', VOTES_PER_READ + 50, VOTES_PER_READ + 50, 0, 50]
	])('a page counts in full only for the reads no limit cut, when it is %s', function(_ignored: string, length: number, limit: number, longest: number, whole: number) {
		const page = Array.from({ length }, function(_unused, index): PassStaple {
			return(stapleOf(`s${String(index)}`, [index]));
		});

		expect(wholeBelowOf(page, limit, longest)).toBe(whole);
	});

	test('a page counts in full up to the first listing of each staple it listed twice, the latest of them', function() {
		const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(function(name, index): PassStaple {
			return(stapleOf(name, [index]));
		});
		if (a === undefined || b === undefined || c === undefined || d === undefined) {
			throw(new Error('four staples are made'));
		}

		expect(wholeBelowOf([a, b, c, b, d], 5, 5)).toBe(2);
		expect(wholeBelowOf([a, b, a, c, b], 5, 5)).toBe(2);
		expect(wholeBelowOf([a, b, c, d], 4, 4)).toBe(0);
	});

	test('the votes a pass was listed tell whether one was made at or after a moment, or nothing of a staple it was not listed', function() {
		const known = new KnownVotes();
		const listed = stapleOf('listed', [10_000, 20_000]);
		known.learn([listed]);

		expect(known.mayBeMadeSince(stapleKey(listed), 20_000)).toBe(true);
		expect(known.mayBeMadeSince(stapleKey(listed), 15_000)).toBe(true);
		expect(known.mayBeMadeSince(stapleKey(listed), 20_001)).toBe(false);
		expect(known.mayBeMadeSince(stapleKey(stapleOf('unlisted', [1])), 20_001)).toBe(true);
	});

	test('counting back from the latest vote made in a stretch finds the vote that many before it, if the stretch holds that many', function() {
		const known = new KnownVotes();
		known.learn([stapleOf('a', [30, 50]), stapleOf('b', [10, 20]), stapleOf('c', [40])]);

		// The stretch [20, 50) holds the votes made at 20, 30 and 40.
		expect(known.countBack(1, 20, 50)).toBe(40);
		expect(known.countBack(2, 20, 50)).toBe(30);
		expect(known.countBack(3, 20, 50)).toBe(20);
		expect(known.countBack(4, 20, 50)).toBeUndefined();
		expect(known.countBack(3, 21, 50)).toBeUndefined();
		expect(known.countBack(1, 20, 51)).toBe(50);
	});

	test('the votes the peer holds show that the reads of a page cut in its last read were listed in full up to a moment, when enough of them lie between the start and its last staple', function() {
		const start = 1_000_000;
		const last = stapleOf('last', [start + 10 * TOLERANCE]);
		// Votes made from the tolerance after the start up to twice the tolerance before the last staple's first vote.
		const counted = Array.from({ length: VOTES_PER_READ }, function(_unused, index): PassStaple {
			return(stapleOf(`counted${String(index)}`, [start + TOLERANCE + index]));
		});
		const page = [stapleOf('first', [start + 9 * TOLERANCE]), stapleOf('second', [start + 2]), last];
		const knowing = function(staples: readonly PassStaple[]): KnownVotes {
			const known = new KnownVotes();
			known.learn(staples);
			return(known);
		};

		expect(countedReach(page, start, knowing(counted))).toBe(start + TOLERANCE - TOLERANCE);
		// One too few, however many lie before the stretch.
		expect(countedReach(page, start, knowing([...counted.slice(1), stapleOf('before', [start, start + TOLERANCE - 1])]))).toBe(Number.NEGATIVE_INFINITY);
		// One more, made in the last tolerance before the last staple's reach, does not count.
		expect(countedReach(page, start, knowing([...counted, stapleOf('after', [start + 8 * TOLERANCE + 500])]))).toBe(start + TOLERANCE - TOLERANCE);
		expect(countedReach([], start, knowing(counted))).toBe(Number.NEGATIVE_INFINITY);
	});
});

describe('whether a staple of a page shows the page read every key before a moment', function() {
	const early = stapleOf('early', [10_000 + TOLERANCE]);
	const late = stapleOf('late', [20_000 + TOLERANCE]);
	const page = [early, late];

	test('from a peer keyed by when it applied them, any staple listed from the moment does', function() {
		const evidence = evidenceOf(page, 'applied', { wholeBelow: 0 });

		expect(shows(evidence, 1, 50_000)).toBe(true);
		expect(shows(evidence, 2, 0)).toBe(false);
	});

	test('from a peer keyed by votes, one in the reads listed in full, or before what the votes counted show, and with every vote made the tolerance after the moment', function() {
		const evidence = evidenceOf(page, 'votes', { wholeBelow: 1, countedTo: 15_000 });

		expect(shows(evidence, 0, 10_000)).toBe(true);
		expect(shows(evidence, 0, 10_001)).toBe(false);
		expect(shows(evidence, 1, 15_000)).toBe(true);
		expect(shows(evidence, 1, 15_001)).toBe(false);
		expect(shows(evidence, 1, 20_001)).toBe(false);
		expect(shows(evidenceOf(page, 'unknown', { wholeBelow: 2, countedTo: 0 }), 1, 20_000)).toBe(true);
		expect(shows(evidenceOf(page, 'unknown', { wholeBelow: 2 }), 1, 20_001)).toBe(false);
	});

	test('from a peer that keys votes late, only one in the reads listed in full, whatever the votes counted show', function() {
		const evidence = evidenceOf(page, 'late-votes', { wholeBelow: 1, countedTo: 50_000 });

		expect(shows(evidence, 0, 10_000)).toBe(true);
		expect(shows(evidence, 0, 10_001)).toBe(false);
		expect(shows(evidence, 1, 15_000)).toBe(false);
	});

	test('the latest moment shown is where the next page is asked from, and the staple shown there earliest is the one asked about', function() {
		const shownAt = function(evidence: Evidence<PassStaple>): readonly [number, number] | undefined {
			const target = shownTarget(evidence);
			if (target === undefined) {
				return(undefined);
			}
			return([target.at, target.index]);
		};
		const at = function(moment: number, name: string): PassStaple {
			return(stapleOf(name, [moment + TOLERANCE]));
		};

		expect(shownAt(evidenceOf([at(100, 'a'), at(200, 'b')], 'votes'))).toEqual([200, 1]);
		// Past the reads listed in full, a staple shows no more than the votes counted do.
		expect(shownAt(evidenceOf([at(200, 'b')], 'votes', { wholeBelow: 0, countedTo: 50 }))).toEqual([50, 0]);
		expect(shownAt(evidenceOf([at(300, 'c'), at(100, 'a')], 'votes', { wholeBelow: 1, countedTo: 50 }))).toEqual([300, 0]);
		expect(shownAt(evidenceOf([at(100, 'a'), at(200, 'b')], 'votes', { wholeBelow: 1, countedTo: 50 }))).toEqual([100, 0]);
		// From a peer keyed by when it applied them the counted votes say nothing.
		expect(shownAt(evidenceOf([at(200, 'b')], 'applied', { wholeBelow: 0, countedTo: 50 }))).toEqual([200, 0]);
		// Of two staples that show the same moment, the one whose first vote was made earliest.
		expect(shownAt(evidenceOf([at(200, 'b'), at(100, 'a')], 'votes', { wholeBelow: 0, countedTo: 50 }))).toEqual([50, 1]);
		expect(shownAt(evidenceOf([at(100, 'a'), at(100, 'twin')], 'votes'))).toEqual([100, 0]);
		// Nothing at or before the start.
		expect(shownAt(evidenceOf([at(100, 'a')], 'votes', { start: 100 }))).toBeUndefined();
	});

	test('a page may show it read past its start when a staple shows a moment past it, or always from a peer keyed by when it applied them', function() {
		const before = stapleOf('before', [TOLERANCE]);

		expect(mayShowPast(evidenceOf([before], 'votes', { start: 10 }))).toBe(false);
		expect(mayShowPast(evidenceOf([before], 'applied', { start: 10 }))).toBe(true);
		expect(mayShowPast(evidenceOf([stapleOf('after', [100 + TOLERANCE])], 'votes', { start: 10 }))).toBe(true);
	});

	test('a staple the node lacked was made between the start and the moment when a vote of it was made within the tolerance of them', function() {
		const start = 100_000;
		const moment = 200_000;

		expect(madeBetween(stapleOf('first', [start - TOLERANCE]), start, moment)).toBe(true);
		expect(madeBetween(stapleOf('before', [start - TOLERANCE - 1]), start, moment)).toBe(false);
		expect(madeBetween(stapleOf('last', [moment + TOLERANCE - 1]), start, moment)).toBe(true);
		expect(madeBetween(stapleOf('after', [moment + TOLERANCE]), start, moment)).toBe(false);
		expect(madeBetween(stapleOf('one of two', [start - 5 * TOLERANCE, start]), start, moment)).toBe(true);
	});

	test('the horizon is probed after 2, 4, 8 and so on short pages in a row', function() {
		expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 16].map(probesHorizonAfter)).toEqual([false, true, false, true, false, false, false, true, false, true]);
	});
});

describe('what the passes learn of how a peer keys its staples', function() {
	const start = 100_000;
	const twice = stapleOf('twice', [start]);
	const forEarlier = stapleOf('earlier', [start - 2 * TOLERANCE]);
	const ordinary = stapleOf('ordinary', [start + 5]);

	test.each<[PeerKeying, string, readonly PassStaple[], PeerKeying]>([
		['unknown', 'a staple listed twice', [twice, twice], 'votes'],
		['unknown', 'a staple listed for earlier votes', [ordinary, forEarlier], 'applied'],
		['unknown', 'both', [forEarlier, twice, twice], 'late-votes'],
		['votes', 'a staple listed twice', [twice, twice], 'votes'],
		['votes', 'a staple listed for earlier votes', [ordinary, forEarlier], 'late-votes'],
		['applied', 'a staple listed twice', [twice, twice], 'late-votes'],
		['applied', 'a staple listed for earlier votes', [forEarlier], 'applied'],
		['late-votes', 'a staple listed twice', [twice, twice], 'late-votes'],
		['late-votes', 'a staple listed for earlier votes', [forEarlier], 'late-votes'],
		['unknown', 'neither', [ordinary], 'unknown']
	])('from %s, on %s, as %s', async function(current: PeerKeying, _ignored: string, staples: readonly PassStaple[], next: PeerKeying) {
		const changed: PeerKeying[] = [];
		const reported: PassEvent[] = [];
		const record = new KeyingRecord(current, function(keying): Promise<void> {
			changed.push(keying);
			return(Promise.resolve());
		}, function(event): void {
			reported.push(event);
		});

		await record.observe(staples, start);

		expect(record.current).toBe(next);
		const told: PeerKeying[] = [];
		if (next !== current) {
			told.push(next);
		}
		expect(changed).toEqual(told);
		const shown: PassEvent[] = [];
		if (next === 'late-votes' && current !== 'late-votes') {
			shown.push({ kind: 'late-votes', start: new Date(start), staple: (listedForEarlierVotes(staples, start) ?? staples[0])?.blocksHash.toString() ?? '' });
		}
		expect(reported).toEqual(shown);
	});
});

describe('the progress a pass begins with', function() {
	const now = 1_000_000_000_000;
	const due: PeerProgress = { reached: new Date(now - BOOTSTRAP_MARGIN_MILLISECONDS), caughtUp: true, deepScanFrom: new Date(now - 5 * DEEP_SCAN_DEPTH_MILLISECONDS), nextDeepScan: new Date(now), deepScan: undefined, keying: 'votes' };

	test('over a peer the node has no progress on starts where it is told, not caught up, its first deep re-scan due a period and its stagger later', function() {
		expect(firstProgress(now, 42, new Date(7))).toEqual({ reached: new Date(7), caughtUp: false, deepScanFrom: new Date(7), nextDeepScan: new Date(now + DEEP_SCAN_PERIOD_MILLISECONDS + 42), deepScan: undefined, keying: 'unknown' });
	});

	test('begins a deep re-scan once it is due on a peer the node has caught up on, from the depth back or where the passes since the last began, whichever is earlier', function() {
		const begun = { ...due, deepScanFrom: due.reached, nextDeepScan: new Date(now + DEEP_SCAN_PERIOD_MILLISECONDS) };

		expect(withDeepScanBegun(due, now, false)).toEqual({ ...begun, deepScan: { reached: due.deepScanFrom, horizon: new Date(now - BOOTSTRAP_MARGIN_MILLISECONDS) } });
		expect(withDeepScanBegun({ ...due, deepScanFrom: due.reached }, now, false)).toEqual({ ...begun, deepScan: { reached: new Date(now - DEEP_SCAN_DEPTH_MILLISECONDS), horizon: new Date(now - BOOTSTRAP_MARGIN_MILLISECONDS) } });
		// Never before the beginning of time.
		expect(withDeepScanBegun({ ...due, deepScanFrom: new Date(500), nextDeepScan: new Date(0) }, 1000, false).deepScan?.reached).toEqual(new Date(0));
	});

	test('begins none before it is due or while the node has not caught up on the peer, unless the queue stopped a pass, and keeps one under way', function() {
		const underWay = { ...due, deepScan: { reached: new Date(5), horizon: new Date(6) } };

		expect(withDeepScanBegun({ ...due, nextDeepScan: new Date(now + 1) }, now, false)).toEqual({ ...due, nextDeepScan: new Date(now + 1) });
		expect(withDeepScanBegun({ ...due, caughtUp: false }, now, false)).toEqual({ ...due, caughtUp: false });
		expect(withDeepScanBegun({ ...due, caughtUp: false, nextDeepScan: new Date(now + 1) }, now, true).deepScan).toBeDefined();
		expect(withDeepScanBegun(underWay, now, true)).toBe(underWay);
	});

	test('reads every staple twice that a peer commits within the late-commit bound, as the depth allows', function() {
		// A bound, two periods and two delays: the second deep re-scan to begin after a staple still starts before it.
		expect(DEEP_SCAN_DEPTH_MILLISECONDS).toBe((30 + 2 * (60 + 15)) * 60_000);
	});
});
