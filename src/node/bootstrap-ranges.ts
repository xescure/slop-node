import { assertNever } from '../util/assert-never.js';
import { VOTE_KEY_TOLERANCE_MILLISECONDS } from './bootstrap-evidence.js';
import { MAX_PASS_MILLISECONDS, completes } from './bootstrap-pass.js';
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
 * How far past where the earliest range reached a range starts for it to
 * count as read ahead: what it reads is added only once every range before
 * it is read (src/node/bootstrap-stage.ts), so it waits while the stage holds
 * its bound, or the retry queue is full. Nearer, a range reads on from about
 * where the earliest stands, as one pass would, and the stage holds at most
 * this much of the history it reads past the earliest.
 */
export const FAR_AHEAD_MILLISECONDS: number = 24 * 60 * 60_000;

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

/**
 * The updates in a row that may read ranges while the retry queue is full
 * before one reads the peers from where they last reached instead, which
 * begins the deep re-scans that read again what the queued staples need
 * (src/node/bootstrap-pass.ts), should a filter have named it by mistake.
 */
const FULL_QUEUE_UPDATES_BEFORE_DEEP_SCAN = 4;

/**
 * How much reading and how much history a range's pace counts besides what
 * its passes measured, so that a range not read yet counts as read about as
 * fast as time passes, and a few seconds of reading outweigh that.
 */
const PACE_PRIOR_MILLISECONDS = 1000;

/**
 * How long the last pass over a range read, and how far it moved where the
 * range reached, which tells how long what is left takes: the history is
 * denser in some stretches than in others, so the last pass tells more of
 * what comes next than every pass before it.
 */
export type RangePace = {
	readonly spent: number;
	readonly advanced: number;
};

const UNREAD: RangePace = { spent: 0, advanced: 0 };

/** A stretch of history one peer at a time reads. */
export type BootstrapRange = {
	/** Names the range across splits and restarts, for the passes over it to record where they reached. */
	readonly id: number;
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
	/** The pace of the last pass over it, or, for one split off another and not read yet, over that one, the pass under way then included. */
	readonly pace: RangePace;
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
	/** The updates in a row that read ranges while the retry queue was full. */
	readonly fullQueueUpdates: number;
	/** The ID the next range split off another takes: none is used twice, so a pass over a range read and dropped never finds another under its ID. */
	readonly nextID: number;
};

/** How a pass over a range ended. */
export type RangeResult =
	/** It reached the range's end. */
	| 'completed'
	/** It reached its bound first, having moved on; the next update continues it. */
	| 'bounded'
	/** It failed, which counts against its peer. */
	| 'failed'
	/** The retry queue had no room for a staple it refused, so it stopped before it, or its peer asked the node to slow down; it waits, which counts against no one. */
	| 'throttled'
	/** The node stopped. */
	| 'stopped';

/** What a pass over a range is to read: where the passes over a peer the node has no progress on would start, besides the range. */
export type RangeTask = RangeSetup & { readonly from: Date };

export type ReadRange = (peer: string, task: RangeTask) => Promise<RangeResult>;

/** What the node hears of its ranges. */
export type RangeEvent =
	| { readonly kind: 'laid-out'; readonly layout: RangeLayout }
	/** The peer took on the later part of what was left of a range, which now ends where the part taken on begins, less the overlap. */
	| { readonly kind: 'split'; readonly peer: string; readonly left: BootstrapRange; readonly taken: BootstrapRange }
	/** The peer left its range for failing, and reads none until then. */
	| { readonly kind: 'benched'; readonly peer: string; readonly until: Date }
	/** Every range was read: the peers move on to the end less the overlap. */
	| { readonly kind: 'read'; readonly layout: RangeLayout };

/** What the ranges keep of the node and its peers. */
export type RangeIO = Pick<UpdateIO, 'readProgress' | 'writeProgress'> & {
	readLayout(): Promise<RangeLayout | undefined>;
	writeLayout(layout: RangeLayout | undefined): Promise<void>;
	/** Whether the retry queue stopped a pass from where the last reached, or over a range near the earliest (RetryQueue.saturated). */
	saturated(): Promise<boolean>;
	/** Whether a pass over a range read ahead may stage another staple: the stage holds less than its bound. */
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
	return({ ...range, reached: overlapBefore(range.reached), peer: undefined });
}

function isBenched(layout: RangeLayout, peer: string, now: number): boolean {
	return((layout.standings[peer]?.benchedUntil?.getTime() ?? 0) > now);
}

/** The peers that read ranges: those not benched, or every one once all are. */
function readersOf(layout: RangeLayout, peers: readonly string[], now: number): string[] {
	const readers = peers.filter(function(peer): boolean {
		return(!isBenched(layout, peer, now));
	});
	if (readers.length === 0) {
		return([...peers]);
	}
	return(readers);
}

/** Where a range starts being read ahead of the earliest: FAR_AHEAD_MILLISECONDS past where the earliest reached. */
function frontOf(layout: RangeLayout): number {
	return((layout.ranges[0]?.reached.getTime() ?? 0) + FAR_AHEAD_MILLISECONDS);
}

/** Which ranges an update reads: those near the earliest, and, unless the passes over them wait for room in the queue, those read ahead. */
type Throttle = { readonly front: number; readonly aheadRuns: boolean };

function runs(range: BootstrapRange, throttle: Throttle): boolean {
	return(throttle.aheadRuns || range.reached.getTime() < throttle.front);
}

function useOf(range: BootstrapRange, front: number): QueueUse {
	if (range.reached.getTime() < front) {
		return('live');
	}
	return('ahead');
}

/**
 * The layout with each range whose peer is gone or benched left for
 * another, and the earliest read whatever else is: when it has no peer and
 * every peer has a range it reads, the peer of the latest leaves that one
 * for it. The peers with none take ranges on as the update runs (Schedule).
 */
export function assigned(layout: RangeLayout, peers: readonly string[], now: number, throttle: Throttle = { front: Number.POSITIVE_INFINITY, aheadRuns: true }): RangeLayout {
	const readers = readersOf(layout, peers, now);
	const ranges = layout.ranges.map(function(range): BootstrapRange {
		if (range.peer !== undefined && !readers.includes(range.peer)) {
			return(handedOver(range));
		}
		return(range);
	});
	const busy = readers.every(function(peer): boolean {
		return(ranges.some(function(range): boolean {
			return(range.peer === peer && runs(range, throttle));
		}));
	});
	const first = ranges[0];
	let latest = ranges.length - 1;
	while (latest > 0 && ranges[latest]?.peer === undefined) {
		latest--;
	}
	const taken = ranges[latest];
	if (first !== undefined && first.peer === undefined && busy && latest > 0 && taken !== undefined) {
		ranges[0] = { ...first, peer: taken.peer };
		ranges[latest] = handedOver(taken);
	}
	return({ ...layout, ranges });
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
		return({ id: index, reached: overlapBefore(new Date(Math.floor(from + index * span))), end: new Date(rangeEnd), peer: undefined, pace: UNREAD });
	});
	const layout: RangeLayout = { from: new Date(from), end: new Date(end), deepScanPeer, ranges, standings: {}, fullQueueUpdates: 0, nextID: ranges.length };
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

/** The layout with the range of that ID changed as given, if it is still there. */
function withRange(layout: RangeLayout, id: number, change: (range: BootstrapRange) => BootstrapRange): RangeLayout {
	return({ ...layout, ranges: layout.ranges.map(function(range): BootstrapRange {
		if (range.id === id) {
			return(change(range));
		}
		return(range);
	}) });
}

/** A pass under way over a range: when it began, and where the range had reached then. */
type Running = { readonly since: number; readonly from: number };

/**
 * One update's passes over the ranges, each peer reading one range at a
 * time, all side by side: a peer whose range is read, or that has none it
 * may read, takes on another as long as the update lasts, MAX_PASS_MILLISECONDS
 * from its start, by when every pass reaches its bound, so that none waits on
 * one begun late; and the layout is written as each pass moves on and each
 * range changes hands.
 */
class Schedule {
	#layout: RangeLayout;
	readonly #peers: readonly string[];
	readonly #io: RangeIO;
	/** Whether the ranges read ahead run: not while the retry queue is full, nor once a pass over one found the stage full. */
	#aheadRuns: boolean;
	readonly #running = new Map<number, Running>();
	readonly #results = new Map<string, PeerResult>();
	readonly #began: number = Date.now();
	#written: Promise<void> = Promise.resolve();

	constructor(layout: RangeLayout, peers: readonly string[], io: RangeIO, aheadRuns: boolean) {
		this.#layout = layout;
		this.#peers = peers;
		this.#io = io;
		this.#aheadRuns = aheadRuns;
	}

	async run(read: ReadRange): Promise<ReadonlyMap<string, PeerResult>> {
		this.#layout = assigned(this.#layout, this.#peers, this.#began, this.#throttle());
		await this.#write();
		await Promise.all(readersOf(this.#layout, this.#peers, this.#began).map((peer) => {
			return(this.#work(peer, read));
		}));
		if (this.#layout.ranges.length === 0) {
			await movedOn(this.#layout, this.#peers, this.#io);
		}
		return(this.#results);
	}

	#throttle(): Throttle {
		return({ front: frontOf(this.#layout), aheadRuns: this.#aheadRuns });
	}

	/** The layout as it now stands, written after every write asked for before. */
	#write(): Promise<void> {
		const latest = this.#layout;
		this.#written = this.#written.then(() => {
			return(this.#io.writeLayout(latest));
		});
		return(this.#written);
	}

	/** The peer's passes in this update: one after another while each reads its range, as long as the update lasts. */
	async #work(peer: string, read: ReadRange): Promise<void> {
		for (let first = true; first || Date.now() - this.#began < MAX_PASS_MILLISECONDS; first = false) {
			const range = this.#claim(peer);
			if (range === undefined) {
				return;
			}
			await this.#write();
			const use = useOf(range, frontOf(this.#layout));
			const result = await this.#pass(peer, range, use, read);
			this.#results.set(peer, peerResultOf(result));
			// A pass over a range read ahead that found no room leaves the peer free for the ranges near the earliest, which the queue has room for.
			if (result === 'throttled' && use === 'ahead') {
				this.#aheadRuns = false;
				continue;
			}
			if (result !== 'completed') {
				return;
			}
		}
	}

	/**
	 * The range the peer reads next: its own, when it may read it now; else
	 * the earliest no peer reads that it may; else the later part of what is
	 * left of the range that would take longest to read, split off it, if
	 * that is longer than an update lasts. A peer that takes on another leaves
	 * its own, which it may not read now, to whichever may later.
	 */
	#claim(peer: string): BootstrapRange | undefined {
		const throttle = this.#throttle();
		const ranges = this.#layout.ranges;
		const own = ranges.find(function(range): boolean {
			return(range.peer === peer);
		});
		if (own !== undefined && runs(own, throttle)) {
			return(own);
		}
		const open = ranges.find(function(range): boolean {
			return(range.peer === undefined && runs(range, throttle));
		});
		let taken: BootstrapRange | undefined;
		if (open !== undefined) {
			const claimed: BootstrapRange = { ...open, peer };
			this.#layout = withRange(this.#layout, open.id, function(): BootstrapRange {
				return(claimed);
			});
			taken = claimed;
		} else {
			taken = this.#split(peer, throttle);
		}
		if (taken !== undefined && own !== undefined) {
			this.#layout = withRange(this.#layout, own.id, handedOver);
		}
		return(taken);
	}

	/**
	 * Splits the range that would take longest to read at the middle of what
	 * is left of it, up to where ranges are read ahead when those wait: its
	 * end moves there, and the peer takes on the rest, from the overlap before
	 * it, at the same pace. Nothing when no range has SPLIT_MILLISECONDS left
	 * to split.
	 */
	#split(peer: string, throttle: Throttle): BootstrapRange | undefined {
		let cap = Number.POSITIVE_INFINITY;
		if (!throttle.aheadRuns) {
			cap = throttle.front;
		}
		const now = Date.now();
		let slowest: BootstrapRange | undefined;
		let longest = 0;
		for (const range of this.#layout.ranges) {
			const left = Math.min(range.end.getTime(), cap) - range.reached.getTime();
			if (!runs(range, throttle) || left < SPLIT_MILLISECONDS) {
				continue;
			}
			const takes = left * this.#readingPerHistory(range, now);
			// A peer taking on part of a range spends a few requests before it moves on, which a range read before the update ends does not repay.
			if (takes > longest && takes > MAX_PASS_MILLISECONDS) {
				longest = takes;
				slowest = range;
			}
		}
		if (slowest === undefined) {
			return(undefined);
		}
		const reached = slowest.reached.getTime();
		const middle = new Date(reached + Math.floor((Math.min(slowest.end.getTime(), cap) - reached) / 2));
		const id = this.#layout.nextID;
		const piece: BootstrapRange = { id, reached: overlapBefore(middle), end: slowest.end, peer, pace: this.#paceOf(slowest, now) };
		const left: BootstrapRange = { ...slowest, end: middle };
		const at = this.#layout.ranges.indexOf(slowest);
		const ranges = [...this.#layout.ranges];
		ranges.splice(at, 1, left, piece);
		this.#layout = { ...this.#layout, ranges, nextID: id + 1 };
		this.#io.report({ kind: 'split', peer, left, taken: piece });
		return(piece);
	}

	/** The pace of the passes over the range: the last, and the one under way. */
	#paceOf(range: BootstrapRange, now: number): RangePace {
		const running = this.#running.get(range.id);
		if (running === undefined) {
			return(range.pace);
		}
		return({ spent: range.pace.spent + now - running.since, advanced: range.pace.advanced + Math.max(0, range.reached.getTime() - running.from) });
	}

	/** How long the passes over the range read per millisecond of history they moved on. */
	#readingPerHistory(range: BootstrapRange, now: number): number {
		const { spent, advanced } = this.#paceOf(range, now);
		return((spent + PACE_PRIOR_MILLISECONDS) / (advanced + PACE_PRIOR_MILLISECONDS));
	}

	/** A pass by the peer over the range, adding to the queue as the use says, which the layout then records as it ended: its pace, the range dropped once read, and the peer benched once it failed too often in a row. */
	async #pass(peer: string, range: BootstrapRange, use: QueueUse, read: ReadRange): Promise<RangeResult> {
		const id = range.id;
		const since = Date.now();
		const from = range.reached.getTime();
		this.#running.set(id, { since, from });
		const result = await read(peer, {
			id,
			reached: range.reached,
			end: () => {
				return(this.#layout.ranges.find(function(each): boolean {
					return(each.id === id);
				})?.end ?? range.end);
			},
			until: new Date(this.#began + MAX_PASS_MILLISECONDS),
			use,
			from: overlapBefore(this.#layout.from),
			moved: (start) => {
				this.#layout = withRange(this.#layout, id, function(each): BootstrapRange {
					return({ ...each, reached: start });
				});
				return(this.#write());
			}
		});
		this.#running.delete(id);
		const now = Date.now();
		// A pass that failed or found no room read for less than its bound, which says little of the pace.
		if (result === 'completed' || result === 'bounded') {
			this.#layout = withRange(this.#layout, id, function(each): BootstrapRange {
				return({ ...each, pace: { spent: now - since, advanced: Math.max(0, each.reached.getTime() - from) } });
			});
		}
		this.#settle(peer, id, result, now);
		await this.#write();
		return(result);
	}

	#settle(peer: string, id: number, result: RangeResult, now: number): void {
		let standing = standingAfter(this.#layout.standings[peer], result);
		let ranges = this.#layout.ranges;
		if (result === 'completed') {
			ranges = ranges.filter(function(range): boolean {
				return(range.id !== id);
			});
		} else if (standing.failures >= FAILURES_BEFORE_BENCHING) {
			const until = new Date(now + BENCH_MILLISECONDS);
			standing = { failures: 0, benchedUntil: until };
			ranges = ranges.map(function(range): BootstrapRange {
				if (range.id === id) {
					return(handedOver(range));
				}
				return(range);
			});
			this.#io.report({ kind: 'benched', peer, until });
		}
		this.#layout = { ...this.#layout, ranges, standings: { ...this.#layout.standings, [peer]: standing } };
	}
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
 * in one range per peer. While the retry queue is full, no ranges are laid
 * out; ranges laid out are read on as the queue allows (see The retry
 * queue).
 *
 * A range. A pass over a range (bootstrapRange) is a pass from where the
 * range reached, with the range's end as its horizon and its end: it moves
 * its start on only as the rule of every pass allows, and the update records
 * each move. It completes once it is shown to hold or have queued every
 * staple keyed before the end but those a filter named, which only the
 * three ways any pass shows its horizon show (see Pass); "held" here counts
 * a staple staged to be added (src/node/bootstrap-stage.ts), which the node
 * keeps as durably:
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
 * A split. A peer with no range it may read takes on the later part of
 * another: of the ranges it may read, the one whose passes, at the pace they
 * have read it so far, would take longest to read what is left of it. That
 * range, [A, E) of its peer P, which has reached R, is split at M, the middle
 * of [R, E): its end moves to M, and the peer takes on [M - overlap, E),
 * which has reached M - overlap. Each piece is a range as any other: P's
 * completes once a pass over it is shown to have reached M, as above, and the
 * other once one is shown to have reached E. Between the two lies the
 * overlap, as between any two ranges, so no staple with a vote falls between
 * them. P's pass under way when its range is split reads the end anew each
 * time it checks it, and what shows that it reached E shows that it reached
 * M; it may have moved past M, or have added staples keyed after M from a
 * page it read before it checked, which stays held, or queued, where the
 * other peer finds it when it reads that stretch again: it adds nothing
 * twice, and moves on as it would past staples it was sent and held. A range
 * whose recorded reach is at or past its end is read: the move that got it
 * there is the first of the three ways a pass shows its end. The layout
 * records both pieces as the split is made, so a restart resumes them.
 *
 * Until every range is read, the update is not complete, and no pass over a
 * peer from where it last reached, nor deep re-scan, runs, but for the
 * updates that yield to them while the queue is full; the layout and
 * where each range reached are kept, so that the node resumes them after a
 * restart. Once every range is read, each peer the node has progress on
 * moves on, and the updates after read the peers from where they last
 * reached, the first catch-up from one peer at a time, which lays out
 * ranges again if the node is still far behind.
 *
 * Staging. The passes over the ranges add nothing to the ledger: they stage
 * what they read, and the node adds the staged staples in the order of their
 * votes, those made before where the range that reached least has reached,
 * as one pass from the beginning would (src/node/bootstrap-stage.ts), since
 * the ledger judges each staple by the voting weight it holds when the staple
 * is added. Once every range is read, every staged staple is added. The
 * passes over the ranges that start within FAR_AHEAD_MILLISECONDS of where
 * the earliest reached, the earliest among them, stage whatever they read;
 * the passes over the ranges read further ahead stop before a staple once the
 * stage holds its bound. While it does, or while the retry queue the node
 * adds through is saturated, the ranges read ahead wait, and the peers that
 * would read them take on parts of the ranges near the earliest instead,
 * split no later than FAR_AHEAD_MILLISECONDS past it, so that every peer
 * reads the history the frontier waits for. Should the queue stay
 * saturated, every FULL_QUEUE_UPDATES_BEFORE_DEEP_SCAN updates in a row
 * that read ranges are followed by one over every peer from where it last
 * reached, which stages what it reads too, and begins the deep re-scans that
 * read again a staple a filter named by mistake that the queued ones need;
 * the ranges go on after it.
 *
 * Peers. Each peer reads one range at a time, paced as its requests always
 * are, and one whose pass read its range takes on another as long as the
 * update lasts, about as long as a pass may. A peer whose passes over a range
 * fail FAILURES_BEFORE_BENCHING times in a row leaves its range, reads none
 * for BENCH_MILLISECONDS, and the range is read by another. The earliest
 * range is read whatever else is (assigned).
 */
export async function updateRanges(peers: readonly string[], io: RangeIO, read: ReadRange): Promise<ReadonlyMap<string, PeerResult> | undefined> {
	const saturated = await io.saturated();
	let layout = await io.readLayout();
	if (layout !== undefined && layout.ranges.length === 0) {
		await movedOn(layout, peers, io);
		layout = undefined;
	}
	if (layout === undefined && !saturated) {
		layout = await laidOut(peers, io);
	}
	if (layout === undefined) {
		return(undefined);
	}
	let fullQueueUpdates = 0;
	if (saturated) {
		if (layout.fullQueueUpdates >= FULL_QUEUE_UPDATES_BEFORE_DEEP_SCAN) {
			await io.writeLayout({ ...layout, fullQueueUpdates: 0 });
			return(undefined);
		}
		fullQueueUpdates = layout.fullQueueUpdates + 1;
	}
	const aheadRuns = !saturated && await io.roomAhead();
	return(await new Schedule({ ...layout, fullQueueUpdates }, peers, io, aheadRuns).run(read));
}
