import { randomInt } from 'node:crypto';
import { assertNever } from '../util/assert-never.js';
import { KeyingRecord, KnownVotes, VOTE_KEY_TOLERANCE_MILLISECONDS, countedReach, madeBetween, mayShowPast, shownTarget, shows, stampsOf, wholeBelowOf } from './bootstrap-evidence.js';
import type { Evidence, PeerKeying } from './bootstrap-evidence.js';
import type { Added, QueueUse } from './bootstrap-retry.js';
import { ACCEPTED_ERROR_RATE, BLOOM_CAPACITY, BOOTSTRAP_MARGIN_MILLISECONDS, MAX_NAMED, NamedStaples, PEER_CLOCK_SKEW_MILLISECONDS, stapleKey } from './bootstrap-window.js';
import type { Filter, NamedStaple } from './bootstrap-window.js';

/** The requests one pass over a peer makes at most, pages and probes alike; the next update resumes where it ended. */
export const MAX_PASS_REQUESTS = 2000;

/**
 * How long one pass over a peer runs at most, besides the request under way
 * when the time is up. An update waits for every pass, so this bounds how
 * long a slow peer delays the next update for the others.
 */
export const MAX_PASS_MILLISECONDS: number = 2 * 60_000;

/**
 * The probes spent on proving how far one page reached. Galloping up from
 * the beginning of time to the present and bisecting back to a millisecond
 * takes about 70, which only the first page of a pass may need: later pages
 * start from how far the page before reached.
 */
const MAX_PROBES_PER_PAGE = 96;

/**
 * How much of a short page a move on from it leaves behind at least, so
 * that the filter names at most the rest from the new start.
 */
const EARLY_REACH_SHARE = 3 / 4;

/** How far past the start the first probe of a pass looks. */
const FIRST_STEP_MILLISECONDS = 1000;

/** How often a deep re-scan of each peer begins, once the node has caught up on it. */
export const DEEP_SCAN_PERIOD_MILLISECONDS: number = 60 * 60_000;

/** How late a deep re-scan may begin after it is due for the bound below to hold: the node catches up on the peer by then. */
const DEEP_SCAN_DELAY_MILLISECONDS: number = 15 * 60_000;

/**
 * How long after its moment a peer may commit a staple, or how far its clock
 * may run off, for the node to read the staple at least twice, each time
 * with a filter of its own, so that one naming it by mistake loses nothing.
 *
 * A staple committed at c at a moment m is read by every deep re-scan that
 * begins at some b with c <= b and m < b - margin, the moment it reads up
 * to, and starts at or before m. Deep re-scans begin at most a period and a
 * delay apart and start at least the depth before they begin, so:
 * - committed within this bound of its moment, a staple is read by the
 *   first two deep re-scans that begin after max(c, m + margin): the second
 *   begins by that plus twice a period and a delay, and starts at most the
 *   depth before, which is at most m, the margin being within this bound;
 * - committed later, but within the depth less a period and a delay
 *   (1 h 45 min), it is read once, by the first of them;
 * - committed later still, it may never be read.
 * One committed within the margin of its moment is read by a pass from
 * where the last reached as well.
 *
 * This holds while the passes from where the last reached complete, so that
 * each deep re-scan begins within the delay of being due, and while each
 * deep re-scan completes within a period. Against a peer they do not, the
 * node reads staples only once, and those committed later than the margin
 * not at all, until they do again.
 */
const LATE_COMMIT_BOUND_MILLISECONDS: number = 30 * 60_000;

/** How far before it begins a deep re-scan starts at least, for the bound above to hold. */
export const DEEP_SCAN_DEPTH_MILLISECONDS: number = LATE_COMMIT_BOUND_MILLISECONDS + 2 * (DEEP_SCAN_PERIOD_MILLISECONDS + DEEP_SCAN_DELAY_MILLISECONDS);

/**
 * The most staples a peer has listed in one answer since the node began
 * reading it: a limit of the peer's own, below the one asked for, is at
 * least that, as long as the peer does not lower it while the node runs.
 */
export class LongestAnswer {
	#longest = 0;

	get longest(): number {
		return(this.#longest);
	}

	saw(length: number): void {
		this.#longest = Math.max(this.#longest, length);
	}
}

/**
 * Whether passes over the peer send it a filter, and how many staples the
 * node holds they name in it ahead of where they ask from (PeerIO.held),
 * learned from the peer's answers.
 *
 * A peer tests every staple it reads against the filter, and runs out of
 * time for a request only once it has a staple to send
 * [Keeta TS] index.js:69641-69647, so one sent a filter may read on until
 * something in front of it gives up, as a gateway that answers 504 does, or
 * until the node stops waiting. So the window halves whenever the peer gives
 * up, down to PRIMING_FLOOR, and the pass fails; it grows by PRIMING_STEP
 * after each pass over the peer the peer did not give up on, up to the cap.
 * Once the peer gives up on a request with the window at the floor, the
 * request is sent again with no filter at all, and so is every request to
 * the peer from then on, until a pass over it completes; the window then
 * opens again from the floor. Read with no filter, a page from the start is
 * never empty, so a pass shows it holds everything before its horizon only
 * by staples the peer applied after the horizon: against a peer that applies
 * none, passes stay without a filter, holding all they read, until it does.
 *
 * Naming fewer, or nothing, loses nothing: a pass concludes only that the
 * node holds or has queued what it was sent or its filter named, and a
 * staple left unnamed is sent, and found held. It costs only what the peer
 * sends again.
 */
export class PrimingWindow {
	readonly #cap: number;
	#size: number;
	#unfiltered = false;

	/** Opens at the cap, PRIMING_CAP unless another is given. */
	constructor(cap: number = PRIMING_CAP) {
		this.#cap = cap;
		this.#size = cap;
	}

	get size(): number {
		return(this.#size);
	}

	/** Whether requests to the peer carry no filter. */
	get unfiltered(): boolean {
		return(this.#unfiltered);
	}

	/** The peer gave up on a request that carried a filter: answers whether to send it again with none, the window being at its floor already. */
	gaveUp(): 'unfiltered' | 'halved' {
		if (this.#size <= PRIMING_FLOOR) {
			this.#unfiltered = true;
			return('unfiltered');
		}
		this.#size = Math.max(PRIMING_FLOOR, Math.floor(this.#size / 2));
		return('halved');
	}

	/** A pass over the peer ended, at its bound or complete, without the peer giving up on it. */
	passed(complete: boolean): void {
		if (this.#unfiltered) {
			this.#unfiltered = !complete;
			return;
		}
		this.#size = Math.min(this.#cap, this.#size + PRIMING_STEP);
	}
}

/**
 * How many staples passes over the peer ask for in a page, learned from its
 * answers, as the priming window is (PrimingWindow). A pass halves its own
 * limit whenever an answer is too large; the next pass starts at the limit
 * of the pages that then fitted, so that it does not halve its way down
 * again, and once a pass over the peer gets no answer too large the passes
 * after it ask for PAGE_LIMIT_STEP more, up to the cap.
 */
export class PageLimit {
	readonly #cap: number;
	#size: number;
	#tooLarge = false;

	/** Opens at the cap, which a pass lowers further to the limit it is given (PassOptions.limit). */
	constructor(cap: number) {
		this.#cap = cap;
		this.#size = cap;
	}

	/** Where the next pass over the peer starts. */
	get size(): number {
		return(this.#size);
	}

	/** An answer was too large. */
	tooLarge(): void {
		this.#tooLarge = true;
	}

	/** A page of that many staples came back; one of a single staple says nothing of how many fit. */
	answered(limit: number): void {
		if (this.#tooLarge && limit > 1) {
			this.#size = Math.min(this.#size, limit);
		}
	}

	/** A pass over the peer ended, at its bound or complete. */
	passed(): void {
		if (!this.#tooLarge) {
			this.#size = Math.min(this.#cap, this.#size + PAGE_LIMIT_STEP);
		}
		this.#tooLarge = false;
	}
}

/**
 * About as many staples as MAX_PAGE_BYTES holds of the main network's
 * densest history, where about 36 of 115 KB fit: there a pass asks for a
 * page too large about every other pass, rather than five times in each,
 * and elsewhere the limit regrows to its cap within about thirty passes.
 */
const PAGE_LIMIT_STEP = 32;

/** What a pass reports of a peer, for the node to log. */
export type PassEvent =
	/** The peer was first seen to key votes later than VOTE_KEY_TOLERANCE_MILLISECONDS after they were made, listing this staple from the start given. */
	| { readonly kind: 'late-votes'; readonly start: Date; readonly staple: string }
	/** A pass named MAX_NAMED staples from the start given with nothing to show that its pages read past it, and ended there. */
	| { readonly kind: 'crowded'; readonly start: Date };

/**
 * The most staples the node holds a pass names ahead of the start: about as
 * many as a main network representative reads past, at about 20 votes and
 * half a second a read, well within the time its gateway allows a request.
 */
const PRIMING_CAP = 128;

/** The fewest held staples a pass names ahead of the start, however often the peer gave up. */
const PRIMING_FLOOR = 8;

/** How many more held staples passes name after each pass the peer did not give up on. */
const PRIMING_STEP = 8;

/** Seeds a filter takes: integers its hash functions read exactly. */
const SEED_LIMIT = 2 ** 31;

/** A staple as a pass reads it: its bytes, and when its votes were made. */
export type PassStaple = NamedStaple & {
	readonly votes: readonly { readonly validityFrom: Date }[];
};

/** A request for a page of a peer's staples: those it applied at or after start, less those the filter names, at most limit. */
export type PassRequest = {
	readonly start: Date;
	readonly limit: number;
	readonly bloomFilter: string | undefined;
};

export type PassAnswer<Staple extends PassStaple> =
	| { readonly kind: 'page'; readonly staples: readonly Staple[] }
	/** The answer was larger than a page may be, so fewer staples must be asked for. */
	| { readonly kind: 'too-large' }
	/** The peer, or what stands in front of it, gave up on the request, or the node stopped waiting for it, as the reason says (PrimingWindow). */
	| { readonly kind: 'gave-up'; readonly reason: string };

/** A deep re-scan under way: it reads the peer again from where it has reached up to the horizon, the margin before it began. */
export type DeepScan = {
	readonly reached: Date;
	readonly horizon: Date;
};

/** What the node keeps of its passes over one peer. */
export type PeerProgress = {
	/**
	 * The node holds, or has queued for retry, every staple the peer applied
	 * before this moment, on the peer's clock, save those a filter named by
	 * mistake and those committed later than the margin allows.
	 */
	readonly reached: Date;
	/** Whether the last pass held or queued every staple the peer had applied before the margin before it began. */
	readonly caughtUp: boolean;
	/** Where the next deep re-scan starts at the latest: where the passes since the last one began started. */
	readonly deepScanFrom: Date;
	readonly nextDeepScan: Date;
	readonly deepScan: DeepScan | undefined;
	readonly keying: PeerKeying;
};

/** How a pass reaches the peer and the node. */
export type PeerIO<Staple extends PassStaple> = {
	page(request: PassRequest): Promise<PassAnswer<Staple>>;
	/**
	 * Staples the node has queued for retry, and then those it holds with a
	 * vote made at or after the moment, as its own catch-up lists them
	 * (CONTRACT D8): those a peer keyed by votes lists from there.
	 */
	held(from: Date, count: number): Promise<readonly NamedStaple[]>;
	/** Adds the staple, or queues it for retry when the ledger refuses it (src/node/bootstrap-retry.ts), failing only when there is no room for the pass adding it. */
	add(staple: Staple, use: QueueUse): Promise<Added>;
	/** Offers the ledger again the staples it refused, round after round while a round applies any. */
	retry(): Promise<void>;
	/** Whether the queue stopped a pass from where the last reached, and none of its staples has left it since. */
	saturated(): Promise<boolean>;
	report(event: PassEvent): void;
	/** Kept for as long as the node reads the peer. */
	readonly answers: LongestAnswer;
	/** Kept for as long as the node reads the peer. */
	readonly priming: PrimingWindow;
	/** Kept for as long as the node reads the peer. */
	readonly pageLimit: PageLimit;
	readProgress(): Promise<PeerProgress | undefined>;
	writeProgress(progress: PeerProgress): Promise<void>;
};

export type PassOptions = {
	/** The most staples a page holds; a pass starts lower as the peer's PageLimit has it, and halves its own for the rest of the pass whenever an answer is too large. */
	readonly limit: number;
	/**
	 * How much later than a period after the node first reads a peer its
	 * first deep re-scan of it is due, below DEEP_SCAN_PERIOD_MILLISECONDS,
	 * so that the deep re-scans of several peers do not all fall at once.
	 */
	readonly stagger?: number;
	/**
	 * Where the passes over a peer the node has no progress on start: the
	 * beginning of time, unless the node is known to hold everything before
	 * (src/node/bootstrap-update.ts).
	 */
	readonly from?: Date;
	readonly seed?: () => number;
};

export type PassOutcome =
	/** An empty page came back: the node held or queued every staple the peer had applied from the start. */
	| { readonly kind: 'drained' }
	/** The node was shown to hold or have queued every staple the peer applied before the pass's horizon, the margin before it began. */
	| { readonly kind: 'caught-up' }
	/** The pass reached its bound first; the next one starts from where it reached. */
	| { readonly kind: 'bounded'; readonly reached: Date };

/** The outcome of an update's passes over a peer: the pass from where the last reached, and the deep re-scan under way, if any. */
export type PeerOutcome = {
	readonly live: PassOutcome;
	readonly deepScan: PassOutcome | undefined;
};

const EPOCH = new Date(0);

const UNFILTERED: Filter = { serialized: undefined, errorRate: 0 };

function earlier(left: Date, right: Date): Date {
	return(new Date(Math.min(left.getTime(), right.getTime())));
}

/** Whether the pass showed the node holds or has queued every staple it was to read: it did, unless it reached its bound first. */
export function completes(outcome: PassOutcome): boolean {
	switch (outcome.kind) {
		case 'drained':
		case 'caught-up':
			return(true);
		case 'bounded':
			return(false);
		default:
			return(assertNever(outcome));
	}
}

function outcomeOf(result: PromiseSettledResult<PassOutcome | undefined>): PassOutcome | undefined {
	switch (result.status) {
		case 'fulfilled':
			return(result.value);
		case 'rejected':
			return(undefined);
		default:
			return(assertNever(result));
	}
}

function failureOf(result: PromiseRejectedResult): Error {
	const reason: unknown = result.reason;
	if (reason instanceof Error) {
		return(reason);
	}
	return(new Error(String(reason)));
}

/** A moment that stays where it is, as a pass reads its horizon and end. */
function fixed(moment: Date): () => number {
	const at = moment.getTime();
	return(function(): number {
		return(at);
	});
}

/** The horizon of a pass that begins at the moment given: the margin before. */
function floorOf(now: number): Date {
	return(new Date(Math.max(0, now - BOOTSTRAP_MARGIN_MILLISECONDS)));
}

export function firstProgress(now: number, stagger: number, from: Date): PeerProgress {
	return({ reached: from, caughtUp: false, deepScanFrom: from, nextDeepScan: new Date(now + DEEP_SCAN_PERIOD_MILLISECONDS + stagger), deepScan: undefined, keying: 'unknown' });
}

/**
 * Begins a deep re-scan once one is due and the node has caught up on the
 * peer, or at once when the retry queue stopped a pass from where the last
 * reached: from DEEP_SCAN_DEPTH_MILLISECONDS back, or from where the passes
 * since the last one began started, if earlier, so that the first re-reads
 * the first catch-up. The queued staples may need a staple a pass missed
 * before; a pass from where the last reached that the queue stops never
 * completes, and only a deep re-scan reads that far back.
 */
export function withDeepScanBegun(progress: PeerProgress, now: number, saturated: boolean): PeerProgress {
	if (progress.deepScan !== undefined) {
		return(progress);
	}
	if (!saturated && (!progress.caughtUp || now < progress.nextDeepScan.getTime())) {
		return(progress);
	}
	const from = new Date(Math.max(0, Math.min(progress.deepScanFrom.getTime(), now - DEEP_SCAN_DEPTH_MILLISECONDS)));
	return({
		...progress,
		deepScanFrom: progress.reached,
		nextDeepScan: new Date(now + DEEP_SCAN_PERIOD_MILLISECONDS),
		deepScan: { reached: from, horizon: floorOf(now) }
	});
}

/** What a page's staples were proven to reach: the start moves to that moment, which every staple of the page from that index on is at or after. */
type Reach = { readonly start: number; readonly from: number };

/** What the node made of each staple of a page, and whether it held any before the page and added any. */
type Taken = { readonly outcomes: readonly Added[]; readonly held: boolean; readonly added: boolean };

/** A page the peer answered, what it shows, and the filter the request that drew it carried: none once the peer gave up on one (PrimingWindow). */
type Answered<Staple extends PassStaple> = { readonly staples: readonly Staple[]; readonly evidence: Evidence<Staple>; readonly bloomFilter: string | undefined };

/** The filter the answer was asked with: the one given, unless the request was sent again with none, the peer having given up on it. */
function sentWith<Staple extends PassStaple>(filter: Filter, answer: Answered<Staple>): Filter {
	if (answer.bloomFilter === undefined) {
		return(UNFILTERED);
	}
	return(filter);
}

/** A page asked for from the start, what it shows, and the filter it was asked with, which the node has taken. */
type Listed<Staple extends PassStaple> = { readonly staples: readonly Staple[]; readonly evidence: Evidence<Staple>; readonly filter: Filter; readonly taken: Taken };

/**
 * One pass over a peer's staples, from a start up to a horizon.
 *
 * A peer keys the staples it applied by moments, and answers a request with
 * the staples it holds a key at or after the start for, reading keys in
 * their order, so many at a time, and listing the staples of those it read,
 * leaving out those the filter names, until the limit, or until its time for
 * the request runs out once it has one to send
 * [Keeta TS] index.js:69633-69702. Peers key in one of two ways:
 * - by when they applied them, as versions of this node before it keyed
 *   votes did: each staple once, at the moment it applied it, listed in the
 *   order of their keys;
 * - by votes, as the main network's representatives and this node do
 *   (CONTRACT D8): each vote at the moment it was made, as the vote says, to
 *   within VOTE_KEY_TOLERANCE_MILLISECONDS either way for a representative,
 *   exactly for this node: a staple has a key per vote, and is listed once
 *   per read holding one of them, in no order within a read that the pass
 *   relies on.
 * Either way, a page lists every staple not named with a key among those
 * read, which run from the start up to a key the pass does not learn, and an
 * empty page shows the peer had no staple not named from the start on.
 *
 * A peer stops between reads when its time runs out, but within a read when
 * it reaches the limit: the one asked for, or a lower one of its own, which
 * the pass does not know. So a page counts only for the reads it listed in
 * full (wholeBelowOf): all of it when it is shorter than the limit asked for
 * and than the longest answer the peer gave before (LongestAnswer), since a
 * limit of the peer's own is at least that, and otherwise the staples before the last
 * MAX_VOTES_PER_READ, and those up to the first listing of a staple it
 * listed twice, which a later read listed again. Beyond those, its last read
 * began after any moment that has MAX_VOTES_PER_READ votes the peer holds
 * keyed between it and the last staple's first vote (countedReach), so every
 * read of a key before that moment was listed in full too.
 *
 * The pass learns which way the peer keys from what it lists (PeerKeying): a
 * staple listed twice in one answer comes only from a peer keyed by votes,
 * and a staple listed from a start none of whose votes was made at or after
 * the tolerance before it only from one keyed by when it applied them, or from one
 * that keys votes later than the tolerance after they were made, as it would
 * keying them when it received them. One that does both keys votes late.
 *
 * Progress is made by exclusion: the next request asks from the same start,
 * with a filter that names everything sent from it as well as what the node
 * held or queued, so that the peer sends only staples the node lacks.
 *
 * Every staple sent is taken before the pass goes on: added, found held, or,
 * when the ledger refuses it, as it does a staple whose dependencies the
 * peer applied later, queued for retry (src/node/bootstrap-retry.ts), where
 * it stays, durably, until the ledger accepts it or holds its blocks. So
 * whatever the pass concludes the node holds, it holds or has queued, which
 * loses nothing: a queued staple is offered again after each page that adds
 * a staple and at the end of each pass, for as long as it takes. A staple
 * the queue has no room for is not taken, and the pass fails before it
 * moves past it.
 *
 * A filter names a fixed number of staples, and a peer that runs out of time
 * spends it on the staples the filter names as well, which it reads before
 * it leaves them out [Keeta TS] index.js:69686-69690, so the start moves on,
 * but only to a moment the page is shown to have read up to: from the start
 * S to T only on an answer from T, with any filter, that lists a staple x of
 * the page that shows T (shows), which, as far as the pass knows how the
 * peer keys, means:
 * - keyed by when it applied them, x's one key is at or after T, and the page,
 *   listing x, listed every staple not named keyed before it, wherever the
 *   page was cut;
 * - keyed by votes, every vote of x was made at least the tolerance after
 *   T, so is keyed at or after T, and the page listed x for one of them in a
 *   read before which every read was listed in full: x is in the reads the
 *   page listed in full, or T is before the moment the page's votes show its
 *   reads were listed in full up to;
 * - not known, both;
 * - keyed by votes late, the second, but only with x in reads the page
 *   listed in full: that argument needs no vote keyed less than the
 *   tolerance after it was made, which such a peer breaks, but only that
 *   none is keyed more than the tolerance before.
 * Either way the node holds or has queued every staple keyed from S up to T
 * but those the page's filter named.
 *
 * The page's votes say where to look: x is shown, by an answer that lists
 * it, to reach the tolerance before its first vote. So once short pages call
 * for the start to move, the next page is asked for from the latest such
 * moment of the page, with a filter that names the page but x: when it lists
 * x, the start moves there and the answer is the next page, taken like any
 * other; a representative lists x whenever it reads its key, so a catch-up
 * from one asks about one request per page. When it does not, as from this
 * node serving staples whose votes were made long before it applied them,
 * the answer is set aside, and probes ask for one staple from later moments
 * with the page's own filter, galloping up from the start and then
 * bisecting, until one lists a staple of the page that shows the moment and
 * leaves few enough staples of the page from it on to name.
 *
 * The start moves on after short pages, the second of them in a row and on,
 * once the filter names staples the peer sent from it; one short page is
 * most often the last before an empty one. From a start that stays put,
 * every page reads again all that was sent from it, and pages shrink to a
 * handful of staples. The same evidence at the horizon, after short pages,
 * shows the pass has caught up while the peer keeps applying staples, when
 * no page is ever empty.
 *
 * A pass completes once the node is shown to hold or have queued every
 * staple before its horizon, the margin before the pass began: the next
 * pass starts there whatever this one reads past it, so no more needs to be
 * shown. It probes the horizon only after short pages, which a peer answers
 * once the pass has read up to the present, and so reads that far all the
 * same, unless the peer answers short pages throughout, when the next
 * passes bring the rest. It stops earlier only when its start reaches its
 * end: the moment it began, for a pass from where the last reached, and the
 * horizon, for a deep re-scan and a pass over a range, which need not read
 * the present: for those, the start reaching the horizon is a move to it, and
 * the probe of the horizon shows it as a move would, so either shows the node
 * holds or has queued every staple keyed before the horizon but those the
 * filters named (src/node/bootstrap-ranges.ts). The horizon
 * must not be the moment the pass began: the probe needs a staple the peer
 * applied at or after it, and a peer whose clock runs behind the node's by
 * more than a pass lasts has applied none while the pass runs, whereas the
 * margin allows for a clock that far behind.
 *
 * A filter names a staple it was not given at a small rate, and a conclusion
 * that the node holds or has queued every staple up to a moment is wrong
 * when the filter named one it lacks. When more staples share the start's
 * moment than a filter and a page hold, no page reaches past them; the
 * filter then names all of them at a higher rate, and once a page reaches
 * past that moment the start moves on, as far as the page shows, or a
 * millisecond. Such a conclusion is checked with further filters, each with
 * a seed of its own, until the rates multiply to ACCEPTED_ERROR_RATE: with
 * each, a page from the start must show it read up to that moment and list
 * no staple the node lacked with a vote made about then, from a peer keyed
 * by votes, and list first the first staple from the moment, from one keyed
 * by when it applied them. A peer that keys votes late gives no such check, as a
 * staple the node lacked may have its votes made anywhere before; a pass
 * that names MAX_NAMED staples from one start ends there, and reports it.
 *
 * A staple the peer applies during the pass at a moment the pass has moved
 * past is left to the next pass, which starts the margin before this one
 * began.
 */
class Pass<Staple extends PassStaple> {
	readonly #io: PeerIO<Staple>;
	readonly #began = Date.now();
	readonly #horizon: () => number;
	readonly #end: () => number;
	readonly #until: number;
	readonly #seed: () => number;
	readonly #moved: (start: Date) => Promise<void>;
	readonly #use: QueueUse;
	readonly #keying: KeyingRecord;
	readonly #known = new KnownVotes();
	#named = new NamedStaples();
	#start: number;
	#limit: number;
	#requests = 0;
	/** How far the start last moved, from which probes look next. */
	#step = FIRST_STEP_MILLISECONDS;

	constructor(io: PeerIO<Staple>, setup: PassSetup, options: PassOptions) {
		this.#io = io;
		this.#start = setup.start.getTime();
		this.#horizon = setup.horizon;
		this.#end = setup.end;
		this.#until = setup.until;
		this.#limit = Math.min(options.limit, io.pageLimit.size);
		this.#seed = options.seed ?? function(): number {
			return(randomInt(SEED_LIMIT));
		};
		this.#use = setup.use;
		this.#keying = setup.keying;
		this.#moved = setup.moved;
	}

	async run(): Promise<PassOutcome> {
		await this.#hold();
		let shortPages = 0;
		let next: Listed<Staple> | undefined;
		for (;;) {
			if (this.#start >= this.#end()) {
				return({ kind: 'caught-up' });
			}
			if (this.#exhausted()) {
				return({ kind: 'bounded', reached: new Date(this.#start) });
			}
			let listed = next;
			next = undefined;
			if (listed === undefined) {
				listed = await this.#list();
				if (listed === undefined) {
					continue;
				}
			}
			const { staples: page, evidence, filter } = listed;
			const held = listed.taken.held;
			if (page.length === 0) {
				if (await this.#confirm(undefined, filter.errorRate)) {
					return({ kind: 'drained' });
				}
				continue;
			}
			const short = page.length < this.#limit;
			if (short) {
				shortPages++;
			} else {
				shortPages = 0;
			}
			if (probesHorizonAfter(shortPages) && await this.#reachesHorizon(evidence, filter)) {
				return({ kind: 'caught-up' });
			}
			// Read with no filter, the peer sends the same page from the same start again, so only a move makes progress.
			const fits = !this.#io.priming.unfiltered && this.#named.size + page.length <= BLOOM_CAPACITY;
			// A page cut by the peer's own limit read no further for the staples the filter names, so it calls for no early move.
			const early = fits && shortPages >= 2 && this.#named.received > 0 && evidence.wholeBelow === page.length;
			if (fits && !early) {
				this.#named.receive(page);
				continue;
			}
			if (filter.errorRate <= ACCEPTED_ERROR_RATE) {
				next = await this.#moveAsShown(evidence, held);
				if (next !== undefined) {
					continue;
				}
				let reach: Reach | undefined;
				if (mayShowPast(evidence)) {
					reach = await this.#reach(evidence, filter.serialized, early);
				}
				if (reach !== undefined) {
					await this.#moveTo(reach, page, held);
					continue;
				}
			}
			if (fits) {
				this.#named.receive(page);
				continue;
			}
			// Nothing proves the page reached past the start, as when more staples share its moment than a filter holds: the filter names them all, at a higher error rate, until a page reaches past that moment.
			if (this.#named.received + page.length > MAX_NAMED) {
				this.#io.report({ kind: 'crowded', start: new Date(this.#start) });
				return({ kind: 'bounded', reached: new Date(this.#start) });
			}
			this.#named.receive(page);
			if (filter.errorRate > ACCEPTED_ERROR_RATE) {
				await this.#passMoment(evidence, filter, held);
			}
		}
	}

	/** The filter naming those staples, or none once the peer is read without one (PrimingWindow), which names nothing by mistake. */
	#filterOf(named: NamedStaples): Filter {
		if (this.#io.priming.unfiltered) {
			return(UNFILTERED);
		}
		return(named.filter(this.#seed()));
	}

	#exhausted(): boolean {
		const now = Date.now();
		return(this.#requests >= MAX_PASS_REQUESTS || now - this.#began >= MAX_PASS_MILLISECONDS || now >= this.#until);
	}

	/** A page from the start, taken, or nothing when it was too large, and fewer staples are asked for from then on. */
	async #list(): Promise<Listed<Staple> | undefined> {
		const filter = this.#filterOf(this.#named);
		const answer = await this.#request(this.#start, this.#limit, filter.serialized);
		if (answer === undefined) {
			return(undefined);
		}
		return({ staples: answer.staples, evidence: answer.evidence, filter: sentWith(filter, answer), taken: await this.#takeAll(answer.staples) });
	}

	/**
	 * Names, as far as there is room, the staples the node has queued, which
	 * the peer would otherwise send again, then those it holds with a vote
	 * made from the start on, which the node lists as a peer keyed by votes
	 * does (PeerIO.held), whenever it took them: those the peer sends from
	 * there. Given the first staple the peer sends from the start, it names
	 * each from that staple on, and none when the node lists it elsewhere in
	 * its order, which the peer would send all the same.
	 */
	async #hold(first?: NamedStaple): Promise<void> {
		await this.#holdInto(this.#named, this.#start, first);
	}

	/** Names, for the start given, what the node holds from there, as #hold does for the current one, as many as the peer's priming window allows. */
	async #holdInto(named: NamedStaples, start: number, first?: NamedStaple): Promise<void> {
		const room = Math.min(BLOOM_CAPACITY - named.size, this.#io.priming.size);
		if (room <= 0) {
			return;
		}
		const held = await this.#io.held(new Date(start), room);
		if (first === undefined) {
			named.hold(held);
			return;
		}
		const key = stapleKey(first);
		const at = held.findIndex(function(staple): boolean {
			return(stapleKey(staple) === key);
		});
		if (at >= 0) {
			named.hold(held.slice(at));
		}
	}

	/**
	 * The answer from the moment, and what it shows of how far the peer read
	 * for it, which the pass learns how the peer keys from first; nothing when
	 * it was too large, and fewer staples are asked for from then on.
	 */
	async #request(start: number, limit: number, bloomFilter: string | undefined): Promise<Answered<Staple> | undefined> {
		this.#requests++;
		const answer = await this.#io.page({ start: new Date(start), limit, bloomFilter });
		switch (answer.kind) {
			case 'page':
				break;
			case 'too-large':
				this.#io.pageLimit.tooLarge();
				if (limit === 1) {
					throw(new Error('the peer holds a staple larger than a page may be'));
				}
				this.#limit = Math.min(this.#limit, Math.ceil(limit / 2));
				return(undefined);
			case 'gave-up':
				return(await this.#afterGivingUp(answer.reason, start, limit, bloomFilter));
			default:
				return(assertNever(answer));
		}
		this.#io.pageLimit.answered(limit);
		const staples = answer.staples;
		await this.#keying.observe(staples, start);
		this.#known.learn(staples);
		const evidence: Evidence<Staple> = {
			page: staples,
			start,
			keying: this.#keying,
			wholeBelow: wholeBelowOf(staples, limit, this.#io.answers.longest),
			countedTo: Number.NEGATIVE_INFINITY
		};
		this.#io.answers.saw(staples.length);
		switch (this.#keying.current) {
			case 'unknown':
			case 'votes':
				if (evidence.wholeBelow < staples.length) {
					return({ staples, evidence: { ...evidence, countedTo: countedReach(staples, start, this.#known) }, bloomFilter });
				}
				break;
			case 'applied':
			case 'late-votes':
				break;
			default:
				return(assertNever(this.#keying.current));
		}
		return({ staples, evidence, bloomFilter });
	}

	/** Sends the request again with no filter once the window is at its floor (PrimingWindow); otherwise the pass fails, having halved it. */
	async #afterGivingUp(reason: string, start: number, limit: number, bloomFilter: string | undefined): Promise<Answered<Staple> | undefined> {
		if (bloomFilter === undefined) {
			throw(new Error(`${reason}, though it carried no filter`));
		}
		const narrowed = this.#io.priming.gaveUp();
		switch (narrowed) {
			case 'unfiltered':
				return(await this.#request(start, limit, undefined));
			case 'halved':
				throw(new Error(`${reason}; the next pass names at most ${String(this.#io.priming.size)} staples the node holds ahead of its start`));
			default:
				return(assertNever(narrowed));
		}
	}

	/**
	 * Adds or queues the staples a peer sent. A peer that sends a staple the
	 * filter named ignores the filter, and would send it again forever; one
	 * that sends blocks the node holds with other votes does not, and the
	 * filter names those votes from then on.
	 */
	async #take(page: readonly Staple[], named: NamedStaples = this.#named, resent?: string): Promise<Taken> {
		// A request sent with no filter named nothing, which the peer then sends all the same.
		const unfiltered = this.#io.priming.unfiltered;
		const sent = page.find(function(staple) {
			return(!unfiltered && named.names(staple));
		});
		if (sent !== undefined) {
			throw(new Error(`the peer sent staple ${sent.blocksHash.toString()}, which the filter named, so it does not leave out what a filter names`));
		}
		const outcomes: Added[] = [];
		const listed = new Set<string>();
		let held = false;
		for (const staple of page) {
			const added = await this.#io.add(staple, this.#use);
			outcomes.push(added);
			// A peer keyed by votes lists a staple again for another read in the same page, and one asked for again lists the staple that shows a move, which say nothing of what else the node held before.
			const key = stapleKey(staple);
			held ||= added === 'held' && !listed.has(key) && key !== resent;
			listed.add(key);
		}
		return({ outcomes, held, added: outcomes.includes('added') });
	}

	/** Takes the staples, and offers the ledger again those it refused once any was added. */
	async #takeAll(page: readonly Staple[], named?: NamedStaples, resent?: string): Promise<Taken> {
		const taken = await this.#take(page, named, resent);
		if (taken.added) {
			await this.#io.retry();
		}
		return(taken);
	}

	/**
	 * Moves the start to the latest moment the page's votes say it read up
	 * to, if that is later, once the next page, asked for from there with
	 * fewer staples for as long as it is too large, lists the staple that
	 * says so, and answers that page; nothing when it does not, and the
	 * answer is set aside. The next page's filter names the page's staples
	 * the peer may list from there but that one, and, as far as there is
	 * room, when the page repeated staples the node held, those it holds
	 * from there, and those named for the start.
	 */
	async #moveAsShown(evidence: Evidence<Staple>, held: boolean): Promise<Listed<Staple> | undefined> {
		const target = shownTarget(evidence);
		const page = evidence.page;
		const shownStaple = page[target?.index ?? -1];
		if (target === undefined || shownStaple === undefined) {
			return(undefined);
		}
		const shownKey = stapleKey(shownStaple);
		// The peer may list from there again the staples of the page whose votes were made about then or later and, keyed by when it applied them, those last in the page.
		const tail = Math.floor(page.length * EARLY_REACH_SHARE);
		const named = new NamedStaples();
		named.receive(page.filter(function(staple, index): boolean {
			return(stapleKey(staple) !== shownKey && (index >= tail || stampsOf(staple).some(function(stamp): boolean {
				return(stamp >= target.at - VOTE_KEY_TOLERANCE_MILLISECONDS);
			})));
		}));
		if (held) {
			await this.#holdInto(named, target.at);
		}
		// Of what the peer sent from the start, a peer keyed by votes lists from there again only the staples with a vote made about then or later; one keyed by when it applied them lists those that sort after the moment, which those votes tell only of staples it applied about when they were made.
		const known = this.#known;
		const keying = this.#keying.current;
		named.carry(this.#named, function(key): boolean {
			return(keying === 'applied' || known.mayBeMadeSince(key, target.at - VOTE_KEY_TOLERANCE_MILLISECONDS));
		});
		named.forget(shownStaple);
		const filter = this.#filterOf(named);
		// Set aside for being too large, the answer would leave the move to probes, which gallop from the start one staple at a time.
		let answer = await this.#request(target.at, this.#limit, filter.serialized);
		while (answer === undefined && !this.#exhausted()) {
			// The request before may have been sent again with no filter, the peer having given up on it (PrimingWindow), as are all after it.
			let bloomFilter = filter.serialized;
			if (this.#io.priming.unfiltered) {
				bloomFilter = undefined;
			}
			answer = await this.#request(target.at, this.#limit, bloomFilter);
		}
		if (answer === undefined) {
			return(undefined);
		}
		const listedAgain = answer.staples.some(function(staple): boolean {
			return(stapleKey(staple) === shownKey);
		});
		if (!listedAgain) {
			return(undefined);
		}
		const taken = await this.#takeAll(answer.staples, named, shownKey);
		named.receive(answer.staples);
		this.#named = named;
		await this.#advance(target.at);
		return({ staples: answer.staples, evidence: answer.evidence, filter: sentWith(filter, answer), taken });
	}

	async #advance(start: number): Promise<void> {
		this.#step = start - this.#start;
		this.#start = start;
		await this.#moved(new Date(start));
	}

	/**
	 * The start moves on. The filter names the page's staples from the one
	 * answered on, and those whose votes were made at about the new start or
	 * later, which a peer keyed by votes lists in no order. When the page
	 * repeated staples the node held, the filter is filled again with the
	 * staples it holds from the new start, so that the peer sends fewer of
	 * them again: it then holds more than room for a page, so the next page
	 * moves the start on again.
	 */
	async #moveTo(reach: Reach, page: readonly Staple[], held: boolean): Promise<void> {
		this.#named.moveOn(page.filter(function(staple, index): boolean {
			return(index >= reach.from || stampsOf(staple).some(function(stamp): boolean {
				return(stamp >= reach.start - VOTE_KEY_TOLERANCE_MILLISECONDS);
			}));
		}));
		await this.#advance(reach.start);
		if (held) {
			await this.#hold(page[reach.from]);
		}
	}

	/**
	 * Moves the start past the staples that share its moment, once the page
	 * reached past them, as checked with further filters: to the latest
	 * moment the page's votes show, or else only a millisecond on, so that a
	 * staple the peer applies meanwhile at a moment the pass has read past is
	 * unlikely to stand in the way of the check. A staple whose votes were
	 * made about the start shows no moment past it: the page moves past it
	 * once it lists staples after it.
	 */
	async #passMoment(evidence: Evidence<Staple>, filter: Filter, held: boolean): Promise<void> {
		const next = shownTarget(evidence)?.at ?? this.#start + 1;
		// From a peer keyed by when it applied them, the staple that shows the moment may come after others whose votes were made about then.
		const from = await this.#probe(next, filter.serialized, evidence, this.#limit);
		if (from !== undefined && await this.#confirm(next, filter.errorRate)) {
			await this.#moveTo({ start: next, from }, evidence.page, held);
		}
	}

	/**
	 * Whether the node holds or has queued every staple before the horizon:
	 * shown once the start has moved past it, or by the page, with no staple
	 * not named before it, reaching it. A pass whose horizon is its end, a
	 * deep re-scan or a pass over a range, sends no probe when no staple of
	 * the page could show the horizon, as none can once the peer is known to
	 * key by votes and the votes of the page were made before it: its horizon
	 * lies in the past, and the peer would read, for each probe, through the
	 * staples the node holds past it. A pass from where the last reached
	 * probes a horizon just before the present, past which the peer holds
	 * little.
	 */
	async #reachesHorizon(evidence: Evidence<Staple>, filter: Filter): Promise<boolean> {
		const horizon = this.#horizon();
		if (this.#start >= horizon) {
			return(true);
		}
		if (filter.errorRate > ACCEPTED_ERROR_RATE) {
			return(false);
		}
		const mayShow = evidence.page.some(function(_staple, index): boolean {
			return(shows(evidence, index, horizon));
		});
		if (!mayShow && this.#end() === horizon && evidence.keying.current !== 'unknown') {
			return(false);
		}
		return(await this.#probe(horizon, filter.serialized, evidence) !== undefined);
	}

	/**
	 * Whether a conclusion that the node holds or has queued every staple from
	 * the start up to the moment given, or to the end when none is, drawn
	 * from a filter of that error rate, holds with further filters until
	 * their rates multiply to ACCEPTED_ERROR_RATE. A staple a further filter
	 * finds is taken, and the conclusion is not drawn.
	 *
	 * Up to the end, a further filter holds when the peer lists no staple from
	 * the start. Up to a moment, see #confirmUpTo.
	 */
	async #confirm(to: number | undefined, errorRate: number): Promise<boolean> {
		let uncertainty = errorRate;
		while (uncertainty > ACCEPTED_ERROR_RATE) {
			if (this.#exhausted()) {
				return(false);
			}
			const filter = this.#filterOf(this.#named);
			if (to === undefined) {
				const first = await this.#first(this.#start, filter.serialized);
				if (first !== undefined) {
					await this.#takeAll([first]);
					this.#named.receive([first]);
					return(false);
				}
			} else if (!await this.#confirmUpTo(to, filter)) {
				return(false);
			}
			uncertainty *= filter.errorRate;
		}
		return(true);
	}

	/**
	 * Whether a further filter holds up to the moment: a page from the start
	 * lists first the staple listed first from the moment, which keying by
	 * when it applied them requires, and shows it read up to the moment and
	 * lists no staple the node lacked with a vote made about the moments
	 * between, which keying by votes requires, each as far as the pass knows
	 * how the peer keys. A peer that keys votes late gives no such check.
	 */
	async #confirmUpTo(to: number, filter: Filter): Promise<boolean> {
		const keying = this.#keying.current;
		let byOrder: boolean;
		let byVotes: boolean;
		switch (keying) {
			case 'unknown':
				byOrder = true;
				byVotes = true;
				break;
			case 'applied':
				byOrder = true;
				byVotes = false;
				break;
			case 'votes':
				byOrder = false;
				byVotes = true;
				break;
			case 'late-votes':
				return(false);
			default:
				return(assertNever(keying));
		}
		let beyond: Staple | undefined;
		if (byOrder) {
			beyond = await this.#first(to, filter.serialized);
		}
		const answer = await this.#request(this.#start, this.#limit, filter.serialized);
		if (answer === undefined) {
			return(false);
		}
		const { staples: listed, evidence } = answer;
		const [first] = listed;
		if (first === undefined) {
			// Applied between the two requests, if anything was: the next page brings it.
			return(!byOrder || beyond === undefined);
		}
		const { outcomes } = await this.#takeAll(listed);
		this.#named.receive(listed);
		const start = this.#start;
		if (byOrder && (beyond === undefined || stapleKey(first) !== stapleKey(beyond))) {
			return(false);
		}
		if (!byVotes) {
			return(true);
		}
		const lacked = listed.some(function(staple, index): boolean {
			return(outcomes[index] !== 'held' && madeBetween(staple, start, to));
		});
		const reads = listed.some(function(_staple, index): boolean {
			return(shows(evidence, index, to));
		});
		return(reads && !lacked);
	}

	async #first(at: number, bloomFilter: string | undefined): Promise<Staple | undefined> {
		return((await this.#request(at, 1, bloomFilter))?.staples[0]);
	}

	/**
	 * The furthest moment found that the page reached, with the staples of
	 * the page from it on few enough to name, or, early, after a short page
	 * that fits the filter, at most the share of it EARLY_REACH_SHARE leaves.
	 */
	async #reach(evidence: Evidence<Staple>, bloomFilter: string | undefined, early: boolean): Promise<Reach | undefined> {
		const page = evidence.page;
		// At least one staple of the page precedes the moment, so that those sent before the page do too and can be let go.
		let enough = Math.max(1, page.length - Math.max(1, BLOOM_CAPACITY - this.#limit));
		if (early) {
			enough = Math.max(1, Math.min(page.length - 1, Math.ceil(page.length * EARLY_REACH_SHARE)));
		}
		// The peer applies no staple at a moment its clock has not reached.
		const ceiling = Date.now() + PEER_CLOCK_SKEW_MILLISECONDS;
		let reach: Reach | undefined;
		let reached = this.#start;
		let unreached: number | undefined;
		let step = this.#step;
		for (let probes = 0; probes < MAX_PROBES_PER_PAGE && !this.#exhausted(); probes++) {
			let at: number;
			if (unreached === undefined) {
				at = Math.min(reached + step, ceiling);
				step *= 2;
			} else {
				at = reached + Math.floor((unreached - reached) / 2);
			}
			if (at <= reached) {
				break;
			}
			const from = await this.#probe(at, bloomFilter, evidence);
			if (from === undefined) {
				unreached = at;
				continue;
			}
			reached = at;
			reach = { start: at, from };
			if (from >= enough) {
				break;
			}
		}
		return(reach);
	}

	/**
	 * The index in the page of the first staple of the page that the peer
	 * lists from the moment, of as many as asked for, and that shows the page
	 * reached the moment, if one does.
	 */
	async #probe(moment: number, bloomFilter: string | undefined, evidence: Evidence<Staple>, limit = 1): Promise<number | undefined> {
		const answer = await this.#request(moment, limit, bloomFilter);
		if (answer === undefined) {
			return(undefined);
		}
		const listed = new Set(answer.staples.map(stapleKey));
		const index = evidence.page.findIndex(function(staple, at): boolean {
			return(listed.has(stapleKey(staple)) && shows(evidence, at, moment));
		});
		if (index < 0) {
			return(undefined);
		}
		return(index);
	}
}

/** Where a pass starts and ends, how it takes what it is sent, and what it shares with the other pass over the peer. */
type PassSetup = {
	readonly start: Date;
	/** As it stands when the pass checks it; a pass over a range whose end moves earlier as another peer takes on part of it reads the new one. */
	readonly horizon: () => number;
	/** At or after the horizon: the pass stops reading once its start reaches it, as it stands then. */
	readonly end: () => number;
	/** When the pass reaches its bound at the latest, besides MAX_PASS_MILLISECONDS after it began. */
	readonly until: number;
	readonly use: QueueUse;
	readonly keying: KeyingRecord;
	readonly moved: (start: Date) => Promise<void>;
};

/**
 * Whether to probe the horizon after that many short pages in a row: after
 * 2, 4, 8 and so on. A peer that keeps applying staples sends short pages
 * once the pass has caught up, and so does one that answers short pages
 * while far behind, where probing after each would double the requests.
 */
export function probesHorizonAfter(shortPages: number): boolean {
	return(shortPages >= 2 && Number.isInteger(Math.log2(shortPages)));
}

/**
 * An update's passes over a peer: one from where the last reached, which
 * reads on to the present and holds, once it completes, every staple the
 * peer applied before the margin before it began, and alongside it the deep
 * re-scan under way, if any.
 *
 * While the first moves on, the node records how far it has reached, less
 * the margin, so that an interrupted pass resumes there; once it completes,
 * the next starts the margin before it began.
 *
 * Every DEEP_SCAN_PERIOD_MILLISECONDS, staggered across peers, a deep
 * re-scan reads the peer again from DEEP_SCAN_DEPTH_MILLISECONDS back up to
 * the margin before it began, over as many updates as it takes, which
 * recovers staples a filter named by mistake and staples committed later or
 * by a clock further off than the margin allows. What it leaves of the
 * margin, the passes from where the last reached read, and so does the next
 * deep re-scan, which starts at least the depth less a period and a delay
 * before this one began, long before the margin. So every staple is read,
 * after it is applied, by two passes with filters of their own: a pass from
 * where the last reached and a deep re-scan, or, for one committed later
 * than the margin allows but within LATE_COMMIT_BOUND_MILLISECONDS, two deep
 * re-scans, which overlap for that. A staple a filter of one named by
 * mistake is read by the other.
 *
 * Read means held or queued: a staple the ledger refused stays queued until
 * it applies, and is retried at the end of the update's passes too. One
 * still refused after REPORT_REFUSED_AFTER_MILLISECONDS is reported once
 * (src/node/bootstrap-retry.ts) and stays queued; it does not hold up the
 * passes. A queue so full that it stops the passes from where the last
 * reached, as staples needing one a pass missed fill it, begins a deep
 * re-scan at once, which has a share of the queue of its own, and reads
 * that staple again.
 *
 * Both passes learn how the peer keys its staples from its answers, and the
 * node keeps that with its progress.
 */
export async function bootstrapPeer<Staple extends PassStaple>(io: PeerIO<Staple>, options: PassOptions): Promise<PeerOutcome> {
	const began = Date.now();
	const floor = floorOf(began);
	let progress = withDeepScanBegun(await io.readProgress() ?? firstProgress(began, options.stagger ?? 0, options.from ?? EPOCH), began, await io.saturated());
	// Both passes record their progress, so each write follows the one before.
	let written = io.writeProgress(progress);
	const record = async (change: (current: PeerProgress) => PeerProgress): Promise<void> => {
		progress = change(progress);
		const latest = progress;
		written = written.then(function() {
			return(io.writeProgress(latest));
		});
		await written;
	};
	await written;
	const keying = new KeyingRecord(progress.keying, function(learned) {
		return(record(function(current) {
			return({ ...current, keying: learned });
		}));
	}, function(event) {
		io.report(event);
	});
	const live = new Pass(io, {
		start: progress.reached,
		horizon: fixed(floor),
		end: fixed(new Date(began)),
		until: Number.POSITIVE_INFINITY,
		use: 'live',
		keying,
		moved: function(start) {
			return(record(function(current) {
				return({ ...current, reached: earlier(start, floor) });
			}));
		}
	}, options);
	const deepScan = progress.deepScan;
	let deep: Pass<Staple> | undefined;
	if (deepScan !== undefined) {
		deep = new Pass(io, {
			start: deepScan.reached,
			horizon: fixed(deepScan.horizon),
			end: fixed(deepScan.horizon),
			until: Number.POSITIVE_INFINITY,
			use: 'deep',
			keying,
			moved: function(start) {
				return(record(function(current) {
					return({ ...current, deepScan: { reached: start, horizon: deepScan.horizon } });
				}));
			}
		}, options);
	}
	const [liveResult, deepResult] = await Promise.allSettled([live.run(), deep?.run()]);
	// Whatever the passes did, the staples they queued, and those queued before, are offered again, which also makes room in a queue that was full.
	const [retried] = await Promise.allSettled([io.retry()]);
	const liveOutcome = outcomeOf(liveResult);
	if (liveOutcome !== undefined) {
		io.priming.passed(completes(liveOutcome));
		io.pageLimit.passed();
	}
	const deepOutcome = outcomeOf(deepResult);
	await record(function(current) {
		let next: PeerProgress = { ...current, caughtUp: false };
		if (liveOutcome !== undefined && completes(liveOutcome)) {
			next = { ...next, reached: floor, caughtUp: true };
		}
		if (deepOutcome !== undefined && completes(deepOutcome)) {
			next = { ...next, deepScan: undefined };
		}
		return(next);
	});
	if (liveResult.status === 'rejected') {
		throw(failureOf(liveResult));
	}
	if (deepResult.status === 'rejected') {
		throw(failureOf(deepResult));
	}
	if (retried.status === 'rejected') {
		throw(failureOf(retried));
	}
	return({ live: liveResult.value, deepScan: deepResult.value });
}

/** A range of a peer's history a pass reads (src/node/bootstrap-ranges.ts). */
export type RangeSetup = {
	/** Where the node holds or has queued every staple the range's peers keyed from where it began. */
	readonly reached: Date;
	/** The range's end as it stands, which moves earlier when another peer takes on the later part of what is left of it. */
	readonly end: () => Date;
	/** When the update the pass runs in ends: a pass begun late in it, by a peer that took on another range, reaches its bound by then, as the others do. */
	readonly until: Date;
	readonly use: QueueUse;
	readonly moved: (start: Date) => Promise<void>;
};

/**
 * An update's pass over a range of the peer's history: a pass from where the
 * range reached with the range's end as its horizon and its end, which
 * completes once it is shown to hold or have queued every staple the peer
 * keyed before the end, as any pass is (see Pass), and records where it
 * reached through the setup, not in the peer's progress. The end is read
 * anew each time the pass checks it: what shows the pass reached an end
 * shows it reached every earlier one, so a pass whose end moved earlier
 * completes once it reaches the new one, or at once when it reached past it
 * already. The node keeps
 * what the pass learns of how the peer keys in the peer's progress, which
 * it begins as from the moment PassOptions.from gives when it has none.
 */
export async function bootstrapRange<Staple extends PassStaple>(io: PeerIO<Staple>, range: RangeSetup, options: PassOptions): Promise<PassOutcome> {
	const began = Date.now();
	let progress = await io.readProgress();
	if (progress === undefined) {
		progress = firstProgress(began, options.stagger ?? 0, options.from ?? EPOCH);
		await io.writeProgress(progress);
	}
	const keying = new KeyingRecord(progress.keying, async function(learned) {
		const current = await io.readProgress() ?? firstProgress(began, options.stagger ?? 0, options.from ?? EPOCH);
		await io.writeProgress({ ...current, keying: learned });
	}, function(event) {
		io.report(event);
	});
	const end = function(): number {
		return(range.end().getTime());
	};
	const pass = new Pass(io, { start: range.reached, horizon: end, end, until: range.until.getTime(), use: range.use, keying, moved: range.moved }, options);
	const [result] = await Promise.allSettled([pass.run()]);
	// As after the passes over a peer, the staples queued are offered again whatever the pass did.
	const [retried] = await Promise.allSettled([io.retry()]);
	if (result.status === 'rejected') {
		throw(failureOf(result));
	}
	io.priming.passed(completes(result.value));
	io.pageLimit.passed();
	if (retried.status === 'rejected') {
		throw(failureOf(retried));
	}
	return(result.value);
}
