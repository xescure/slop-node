import { assertNever } from '../util/assert-never.js';
import { VOTE_KEY_TOLERANCE_MILLISECONDS, completes } from './bootstrap-pass.js';
import type { PassOutcome, RangeSetup } from './bootstrap-pass.js';
import type { QueueUse } from './bootstrap-retry.js';
import type { PeerResult, UpdateIO } from './bootstrap-update.js';
import { BOOTSTRAP_MARGIN_MILLISECONDS, VOTE_SLOP_MILLISECONDS } from './bootstrap-window.js';

/**
 * How much history the node must lack, from where it holds everything
 * before up to the horizon of a pass begun now, for its peers to read it in
 * ranges. Less is read by the passes from where they last reached, which
 * the first catch-up reads from one peer at a time.
 */
export const FAR_BEHIND_MILLISECONDS: number = 24 * 60 * 60_000;

/**
 * How far before the end of the range before it a range starts, and before
 * where it reached a range another peer takes on starts: at least twice the
 * tolerance two peers keyed by votes may each key a vote off from when it was
 * made, and the slop a vote may be timestamped ahead of the clocks, within
 * which a staple may need one keyed after it.
 */
export const RANGE_OVERLAP_MILLISECONDS: number = VOTE_KEY_TOLERANCE_MILLISECONDS + VOTE_SLOP_MILLISECONDS;

/**
 * How much of a range must be left for a peer that has none to take on
 * half of it: enough that the half taken on is at least twice the overlap it
 * reads again. A few minutes of dense history take a peer longer than an
 * update to read.
 */
const SPLIT_MILLISECONDS: number = 4 * RANGE_OVERLAP_MILLISECONDS;

/** The passes over a range that fail in a row before its peer leaves it to another. */
const FAILURES_BEFORE_BENCHING = 3;

/** How long a peer that left its range for failing reads none. */
const BENCH_MILLISECONDS: number = 30 * 60_000;

/** A stretch of history one peer at a time reads. */
export type BootstrapRange = {
	/**
	 * The node holds or has queued every staple the peers that read the range
	 * keyed from where it began up to this moment, but those a filter named
	 * by mistake.
	 */
	readonly reached: Date;
	/** The range is read once a pass over it is shown to have reached here. */
	readonly end: Date;
	/** The peer that reads it, if one does. */
	readonly peer: string | undefined;
};

/** How a peer has fared reading ranges: the passes that failed in a row, and until when it reads none. */
export type RangeStanding = {
	readonly failures: number;
	readonly benchedUntil: Date | undefined;
};

/** The history the node lacked when it was laid out in ranges, and what is left of it. */
export type RangeLayout = {
	/** Where the node held or had queued every staple before, on the peer it had reached furthest on. */
	readonly from: Date;
	/** The horizon of a pass begun when it was laid out. */
	readonly end: Date;
	/** The peer the node had reached furthest on, whose next deep re-scan reads the ranges again. */
	readonly deepScanPeer: string;
	/** The ranges not read yet, in order. */
	readonly ranges: readonly BootstrapRange[];
	readonly standings: Readonly<Record<string, RangeStanding>>;
};

/** How a pass over a range ended. */
export type RangeResult =
	/** It reached the range's end. */
	| 'completed'
	/** It reached its bound first, having moved on; the next update continues it. */
	| 'bounded'
	/** It failed, which counts against its peer. */
	| 'failed'
	/** The retry queue had no room for a staple it refused, so it stopped before it; it waits for room. */
	| 'throttled'
	/** The node stopped. */
	| 'stopped';

/** What a pass over a range is to read: where the passes over a peer the node has no progress on would start, besides the range. */
export type RangeTask = RangeSetup & { readonly from: Date };

export type ReadRange = (peer: string, task: RangeTask) => Promise<RangeResult>;

/** What the node hears of its ranges. */
export type RangeEvent =
	| { readonly kind: 'laid-out'; readonly layout: RangeLayout }
	/** The peer left its range for failing, and reads none until then. */
	| { readonly kind: 'benched'; readonly peer: string; readonly until: Date }
	/** Every range was read: the peers move on to the end less the overlap. */
	| { readonly kind: 'read'; readonly layout: RangeLayout };

/** What the ranges keep of the node and its peers. */
export type RangeIO = Pick<UpdateIO, 'readProgress' | 'writeProgress'> & {
	readLayout(): Promise<RangeLayout | undefined>;
	writeLayout(layout: RangeLayout | undefined): Promise<void>;
	/** Whether the retry queue stopped a pass from where the last reached, or over the earliest range (RetryQueue.saturated). */
	saturated(): Promise<boolean>;
	/** Whether the retry queue has room for a staple a pass over a range read ahead of the earliest refuses. */
	roomAhead(): Promise<boolean>;
	report(event: RangeEvent): void;
};

export function rangeResultOf(outcome: PassOutcome): RangeResult {
	if (completes(outcome)) {
		return('completed');
	}
	return('bounded');
}

function earlier(left: Date, right: Date): Date {
	return(new Date(Math.min(left.getTime(), right.getTime())));
}

function later(left: Date, right: Date): Date {
	return(new Date(Math.max(left.getTime(), right.getTime())));
}

function overlapBefore(moment: Date): Date {
	return(new Date(Math.max(0, moment.getTime() - RANGE_OVERLAP_MILLISECONDS)));
}

/** The range left for another peer, which starts the overlap before where its peer reached, as the two key a vote within twice the tolerance of each other. */
function handedOver(range: BootstrapRange): BootstrapRange {
	return({ reached: overlapBefore(range.reached), end: range.end, peer: undefined });
}

function isBenched(layout: RangeLayout, peer: string, now: number): boolean {
	return((layout.standings[peer]?.benchedUntil?.getTime() ?? 0) > now);
}

/**
 * The layout with a peer reading each range it can: the ranges whose peer
 * is gone or benched are left for another, a peer with no range takes one no
 * peer reads, the earliest first, and the earliest is read whatever else
 * is, by the peer reading the latest if no other is free; then each peer
 * still free takes on half of what is left of the range with the most left.
 * A benched peer reads ranges again only once every peer is benched.
 */
export function assigned(layout: RangeLayout, peers: readonly string[], now: number): RangeLayout {
	let readers = peers.filter(function(peer): boolean {
		return(!isBenched(layout, peer, now));
	});
	if (readers.length === 0) {
		readers = [...peers];
	}
	const ranges = layout.ranges.map(function(range): BootstrapRange {
		if (range.peer !== undefined && !readers.includes(range.peer)) {
			return(handedOver(range));
		}
		return(range);
	});
	const free = readers.filter(function(peer): boolean {
		return(!ranges.some(function(range): boolean {
			return(range.peer === peer);
		}));
	});
	ranges.forEach(function(range, index): void {
		const peer = free[0];
		if (range.peer === undefined && peer !== undefined) {
			ranges[index] = { ...range, peer };
			free.shift();
		}
	});
	const first = ranges[0];
	let latest = ranges.length - 1;
	while (latest > 0 && ranges[latest]?.peer === undefined) {
		latest--;
	}
	const taken = ranges[latest];
	if (first !== undefined && first.peer === undefined && latest > 0 && taken !== undefined) {
		ranges[0] = { ...first, peer: taken.peer };
		ranges[latest] = handedOver(taken);
	}
	for (const peer of free) {
		const widest = widestOf(ranges);
		const range = ranges[widest];
		if (range === undefined || range.end.getTime() - range.reached.getTime() < SPLIT_MILLISECONDS) {
			break;
		}
		const middle = range.reached.getTime() + Math.floor((range.end.getTime() - range.reached.getTime()) / 2);
		ranges.splice(widest, 1, { ...range, end: new Date(middle) }, { reached: overlapBefore(new Date(middle)), end: range.end, peer });
	}
	return({ ...layout, ranges });
}

/** The index of the range with the most left to read. */
function widestOf(ranges: readonly BootstrapRange[]): number {
	let widest = -1;
	let most = Number.NEGATIVE_INFINITY;
	ranges.forEach(function(range, index): void {
		const left = range.end.getTime() - range.reached.getTime();
		if (left > most) {
			most = left;
			widest = index;
		}
	});
	return(widest);
}

/**
 * The history the node lacks, laid out in one range per peer, if it is far
 * behind on every peer and past the beginning of time on one: from the
 * beginning of time, ranges laid out over the time before the history begins
 * would each read, from their start, the history after them.
 */
async function laidOut(peers: readonly string[], io: RangeIO): Promise<RangeLayout | undefined> {
	if (peers.length < 2) {
		return(undefined);
	}
	let deepScanPeer: string | undefined;
	let from = 0;
	for (const peer of peers) {
		const reached = (await io.readProgress(peer))?.reached.getTime() ?? 0;
		if (reached > from) {
			from = reached;
			deepScanPeer = peer;
		}
	}
	const end = Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS;
	if (deepScanPeer === undefined || end - from <= FAR_BEHIND_MILLISECONDS) {
		return(undefined);
	}
	const span = (end - from) / peers.length;
	const ranges = peers.map(function(_peer, index): BootstrapRange {
		let rangeEnd = end;
		if (index < peers.length - 1) {
			rangeEnd = Math.floor(from + (index + 1) * span);
		}
		return({ reached: overlapBefore(new Date(Math.floor(from + index * span))), end: new Date(rangeEnd), peer: undefined });
	});
	const layout: RangeLayout = { from: new Date(from), end: new Date(end), deepScanPeer, ranges, standings: {} };
	io.report({ kind: 'laid-out', layout });
	return(layout);
}

/**
 * Every peer the node has progress on moves on to the end of the ranges
 * less the overlap. The peer the node had reached furthest on keeps the
 * start of its next deep re-scan at or before where they began, or, when it
 * is gone, the first peer that has progress; the others' next deep re-scans
 * start at the latest where they now are, as after the first catch-up.
 */
async function movedOn(layout: RangeLayout, peers: readonly string[], io: RangeIO): Promise<void> {
	const reached = overlapBefore(layout.end);
	let deepScanPeer: string | undefined;
	for (const peer of [layout.deepScanPeer, ...peers]) {
		if (deepScanPeer === undefined && peers.includes(peer) && await io.readProgress(peer) !== undefined) {
			deepScanPeer = peer;
		}
	}
	for (const peer of peers) {
		const progress = await io.readProgress(peer);
		if (progress === undefined) {
			continue;
		}
		const next = later(progress.reached, reached);
		let deepScanFrom = later(progress.deepScanFrom, next);
		if (peer === deepScanPeer) {
			deepScanFrom = earlier(progress.deepScanFrom, overlapBefore(layout.from));
		}
		await io.writeProgress(peer, { ...progress, reached: next, deepScanFrom });
	}
	await io.writeLayout(undefined);
	io.report({ kind: 'read', layout });
}

/** A pass an update runs: over the range at that index of the layout, by its peer, adding to the queue as the use says. */
type Run = { readonly index: number; readonly peer: string; readonly use: QueueUse };

function standingAfter(standing: RangeStanding | undefined, result: RangeResult): RangeStanding {
	const current = standing ?? { failures: 0, benchedUntil: undefined };
	switch (result) {
		case 'completed':
		case 'bounded':
			return({ failures: 0, benchedUntil: undefined });
		case 'failed':
			return({ ...current, failures: current.failures + 1 });
		case 'throttled':
		case 'stopped':
			return(current);
		default:
			return(assertNever(result));
	}
}

/** The layout once the passes ended: the ranges read are dropped, and a peer whose passes failed too often in a row leaves its range and is benched. */
function settled(layout: RangeLayout, ended: readonly (readonly [Run, RangeResult])[], now: number, io: RangeIO): RangeLayout {
	const standings: Record<string, RangeStanding> = { ...layout.standings };
	const ranges: (BootstrapRange | undefined)[] = [...layout.ranges];
	for (const [run, result] of ended) {
		let standing = standingAfter(standings[run.peer], result);
		const range = ranges[run.index];
		if (result === 'completed') {
			ranges[run.index] = undefined;
		} else if (standing.failures >= FAILURES_BEFORE_BENCHING && range !== undefined) {
			const until = new Date(now + BENCH_MILLISECONDS);
			standing = { failures: 0, benchedUntil: until };
			ranges[run.index] = handedOver(range);
			io.report({ kind: 'benched', peer: run.peer, until });
		}
		standings[run.peer] = standing;
	}
	return({ ...layout, standings, ranges: ranges.filter(function(range): range is BootstrapRange {
		return(range !== undefined);
	}) });
}

function peerResultOf(result: RangeResult): PeerResult {
	switch (result) {
		case 'completed':
		case 'bounded':
			return('bounded');
		case 'failed':
		case 'throttled':
		case 'stopped':
			return('failed');
		default:
			return(assertNever(result));
	}
}

/** One update's passes over the ranges of the layout, each over its own peer, at once. */
async function readRanges(layout: RangeLayout, peers: readonly string[], io: RangeIO, read: ReadRange): Promise<ReadonlyMap<string, PeerResult>> {
	const now = Date.now();
	let current = assigned(layout, peers, now);
	// The passes record where they reached as they move on, so each write follows the one before.
	let written = io.writeLayout(current);
	const record = async (change: (layout: RangeLayout) => RangeLayout): Promise<void> => {
		current = change(current);
		const latest = current;
		written = written.then(function() {
			return(io.writeLayout(latest));
		});
		await written;
	};
	await written;
	const roomAhead = await io.roomAhead();
	const runs = current.ranges.flatMap(function(range, index): Run[] {
		let use: QueueUse = 'ahead';
		if (index === 0) {
			use = 'live';
		}
		if (range.peer === undefined || (use === 'ahead' && !roomAhead)) {
			return([]);
		}
		return([{ index, peer: range.peer, use }]);
	});
	const from = overlapBefore(current.from);
	const ended = await Promise.all(runs.map(async function(run): Promise<readonly [Run, RangeResult]> {
		const range = current.ranges[run.index];
		if (range === undefined) {
			return([run, 'failed']);
		}
		const result = await read(run.peer, {
			reached: range.reached,
			end: range.end,
			use: run.use,
			from,
			moved: function(start) {
				return(record(function(latest) {
					return({ ...latest, ranges: latest.ranges.map(function(each, index): BootstrapRange {
						if (index === run.index) {
							return({ ...each, reached: start });
						}
						return(each);
					}) });
				}));
			}
		});
		return([run, result]);
	}));
	await record(function(latest) {
		return(settled(latest, ended, now, io));
	});
	if (current.ranges.length === 0) {
		await movedOn(current, peers, io);
	}
	return(new Map(ended.map(function([run, result]): [string, PeerResult] {
		return([run.peer, peerResultOf(result)]);
	})));
}

/**
 * An update's passes while the node is far behind on every peer, which read
 * the history it lacks in ranges, one per peer, side by side, each peer at
 * its own pace, so that the peers read that history once between them, in
 * about the time one would take for its share; or nothing when the node is
 * not, and an update's passes over every peer from where the node last
 * reached on it run instead (src/node/bootstrap-update.ts).
 *
 * When. Every representative applies the same staples to its main ledger,
 * as the first catch-up relies on, so the node holds or has queued every
 * staple before the furthest moment it has reached on any peer. Once that is
 * past the beginning of time, and more than FAR_BEHIND_MILLISECONDS before
 * the horizon of a pass begun now, the stretch between the two is laid out
 * in one range per peer. While the passes from where the last reached are
 * stopped by a full retry queue, ranges are neither laid out nor read: those
 * passes then begin the deep re-scans that read again what the queued staples
 * need (src/node/bootstrap-pass.ts), and the ranges go on once the queue has
 * room again.
 *
 * A range. A pass over a range (bootstrapRange) is a pass from where the
 * range reached, with the range's end as its horizon and its end: it moves
 * its start on only as the rule of every pass allows, and the update records
 * each move. It completes once it is shown to hold or have queued every
 * staple keyed before the end but those a filter named, which only the
 * three ways any pass shows its horizon show (see Pass):
 * - its start moves to a moment T at or past the end: an answer from T lists
 *   a staple x of the page from the start S that shows T. From a peer keyed
 *   by when it applied them, as versions of this node before it keyed votes
 *   were, x's one key is at or after T, and the page listed every staple not
 *   named keyed before x's. From a peer keyed by votes in reads, as this node
 *   and the main network's representatives are, every vote of x was made at
 *   least the tolerance after T, so is keyed at or after T, and the page
 *   listed x for a read before which every read was listed in full, the
 *   reads running in key order from S: so every key in [S, T) was read, and
 *   every staple with a vote keyed there was listed, or named.
 * - the probe of the end lists such an x: the same, with T the end.
 * - a page from the start comes back empty, as further filters confirm: the
 *   peer holds no staple not named with a key from the start on, the end's
 *   included.
 * A staple whose votes lie on both sides of the end has a key before it, so
 *   the range lists it, and one after, so the next range lists it too: the
 *   node finds it held. Within a page a peer keyed by votes lists such a
 *   staple once per read holding one of its votes, and a page counts in full
 *   only up to the first listing of a staple it lists twice.
 *
 * Between ranges. Each range starts RANGE_OVERLAP_MILLISECONDS before the
 * end of the one before it, the first that much before where the node held
 * everything; a range another peer takes on starts that much before where it
 * reached; and once every range is read, the passes over each peer move on to
 * the end of the ranges less that much. Peers keyed by votes each key a vote
 * within the tolerance of when it was made, so within twice the tolerance,
 * less than the overlap, of each other: a vote that the peer reading up to a
 * moment keys at or after it, the peer reading on from there keys at or after
 * the overlap before it. So no staple with a vote falls between two stretches
 * read by different peers, and every staple with a vote made from where the
 * node held everything up to the end of the ranges is held, queued or named
 * by a filter. Peers keyed
 * by when they applied them key one staple at moments of their own, which may
 * lie further apart than the overlap; so the peer the node had reached
 * furthest on keeps the start of its next deep re-scan at or before where
 * the ranges began, and that deep re-scan, once a pass over the peer
 * completes, reads every range again with filters of its own, which also
 * recovers the staples a filter named by mistake, as the deep re-scans do
 * after any catch-up.
 *
 * Until every range is read, the update is not complete, and no pass over a
 * peer from where it last reached, nor deep re-scan, runs; the layout and
 * where each range reached are kept, so that the node resumes them after a
 * restart. Once every range is read, each peer the node has progress on
 * moves on, and the updates after read the peers from where they last
 * reached, the first catch-up from one peer at a time, which lays out
 * ranges again if the node is still far behind.
 *
 * The retry queue. Every pass adds to the node's one queue, as a staple may
 * need a staple of an earlier range, which only that range brings: it waits
 * queued meanwhile, and is offered again after each page that adds a staple.
 * The pass over the earliest range fills the queue up to the share of a pass
 * from where the last reached, nine tenths of it, and saturates it when it
 * finds no room, as such a pass does; the passes over the others fill at most
 * half the queue, and stop before a staple they refuse once it is that full,
 * skipping the updates after until it has room. So the earliest range, which
 * some peer always reads, has room for at least four tenths of the queue of
 * its own, which is where a pass from where the last reached would stand with
 * a queue that much smaller; as it brings what the others' staples need,
 * they leave the queue. A staple's dependencies have votes made before its
 * own, but for the slop a vote may be timestamped ahead of the clock, so a
 * range seldom needs a later one.
 *
 * Peers. Each peer reads at most one range in an update, paced as its
 * requests always are. A peer whose passes over a range fail
 * FAILURES_BEFORE_BENCHING times in a row leaves its range, reads none for
 * BENCH_MILLISECONDS, and the range is read by another. A peer with no range
 * takes on one no peer reads, the earliest first, or else half of what is
 * left of the range with the most left (assigned), so that peers whose
 * ranges held little history help with the rest.
 */
export async function updateRanges(peers: readonly string[], io: RangeIO, read: ReadRange): Promise<ReadonlyMap<string, PeerResult> | undefined> {
	if (await io.saturated()) {
		return(undefined);
	}
	let layout = await io.readLayout();
	if (layout !== undefined && layout.ranges.length === 0) {
		await movedOn(layout, peers, io);
		layout = undefined;
	}
	layout ??= await laidOut(peers, io);
	if (layout === undefined) {
		return(undefined);
	}
	return(await readRanges(layout, peers, io, read));
}
