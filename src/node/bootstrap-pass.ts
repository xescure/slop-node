import { randomInt } from 'node:crypto';
import { assertNever } from '../util/assert-never.js';
import type { Added } from './bootstrap-retry.js';
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
export const DEEP_SCAN_DELAY_MILLISECONDS: number = 15 * 60_000;

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
export const LATE_COMMIT_BOUND_MILLISECONDS: number = 30 * 60_000;

/** How far before it begins a deep re-scan starts at least, for the bound above to hold. */
export const DEEP_SCAN_DEPTH_MILLISECONDS: number = LATE_COMMIT_BOUND_MILLISECONDS + 2 * (DEEP_SCAN_PERIOD_MILLISECONDS + DEEP_SCAN_DELAY_MILLISECONDS);

/** Seeds a filter takes: integers its hash functions read exactly. */
const SEED_LIMIT = 2 ** 31;

export type PassStaple = NamedStaple;

/** A request for a page of a peer's staples: those it applied at or after start, less those the filter names, at most limit. */
export type PassRequest = {
	readonly start: Date;
	readonly limit: number;
	readonly bloomFilter: string | undefined;
};

export type PassAnswer<Staple extends PassStaple> =
	| { readonly kind: 'page'; readonly staples: readonly Staple[] }
	/** The answer was larger than a page may be, so fewer staples must be asked for. */
	| { readonly kind: 'too-large' };

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
};

/** How a pass reaches the peer and the node. */
export type PeerIO<Staple extends PassStaple> = {
	page(request: PassRequest): Promise<PassAnswer<Staple>>;
	/** Staples the node has queued for retry, and then those it added at or after the moment, on its own clock, the earliest first. */
	held(from: Date, count: number): Promise<readonly NamedStaple[]>;
	/** Adds the staple, or queues it for retry when the ledger refuses it (src/node/bootstrap-retry.ts), failing only when there is no room. */
	add(staple: Staple): Promise<Added>;
	/** Offers the ledger again the staples it refused, round after round while a round applies any. */
	retry(): Promise<void>;
	readProgress(): Promise<PeerProgress | undefined>;
	writeProgress(progress: PeerProgress): Promise<void>;
};

export type PassOptions = {
	/** The most staples a page holds; halved for the rest of the pass whenever an answer is too large. */
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

/** The horizon of a pass that begins at the moment given: the margin before. */
function floorOf(now: number): Date {
	return(new Date(Math.max(0, now - BOOTSTRAP_MARGIN_MILLISECONDS)));
}

function firstProgress(now: number, stagger: number, from: Date): PeerProgress {
	return({ reached: from, caughtUp: false, deepScanFrom: from, nextDeepScan: new Date(now + DEEP_SCAN_PERIOD_MILLISECONDS + stagger), deepScan: undefined });
}

/**
 * Begins a deep re-scan once one is due and the node has caught up on the
 * peer: from DEEP_SCAN_DEPTH_MILLISECONDS back, or from where the passes
 * since the last one began started, if earlier, so that the first re-reads
 * the first catch-up.
 */
function withDeepScanBegun(progress: PeerProgress, now: number): PeerProgress {
	if (progress.deepScan !== undefined || !progress.caughtUp || now < progress.nextDeepScan.getTime()) {
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

/** What the node made of the staples of a page: whether it held any already, and whether it added any. */
type Taken = { readonly held: boolean; readonly added: boolean };

/**
 * One pass over a peer's staples, from a start up to a horizon.
 *
 * A peer answers with the staples it applied at or after the start, in the
 * order it applied them, leaving out those the filter names before it
 * counts to the limit [Keeta TS] index.js:69633-69702. Its answer is a
 * prefix of those staples, but it may be shorter than the limit while more
 * follow, when its time for the request runs out
 * [Keeta TS] index.js:69641-69647 or it caps the limit. The pass learns no
 * moment: a staple's timestamp is taken on its voters' clocks, and a peer
 * may apply a staple any time after it was made.
 *
 * Progress is made by exclusion: the next request asks from the same start,
 * with a filter that names everything sent from it as well as what the node
 * held or queued, so that the peer sends only staples the node lacks. Only
 * an empty page shows that the peer had nothing more.
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
 * A filter names a fixed number of staples, so before a page would overfill
 * it, the start moves on, but only to a moment the page is proven to have
 * reached. A probe asks for one staple from a later moment with the same
 * filter: the peer answers with the first staple not named that it applied
 * at or after that moment, and when that is a staple of the page, the page
 * reached that moment, so it held every staple not named from the start up
 * to it, each of which the node now holds or has queued; the page's staples
 * before the one answered precede the moment, and those from it on do not.
 * Probes gallop up from the start and then bisect, until the staples from
 * the moment found fit the filter with room for a page.
 *
 * The start moves on after short pages too, the second of them in a row
 * and on, once the filter names staples the peer sent from it; one short
 * page is most often the last before an empty one. A peer cuts a page short when its time for the
 * request runs out [Keeta TS] index.js:69641-69647, and it spends that time
 * on the staples the filter names as well, which it reads before it leaves
 * them out [Keeta TS] index.js:69686-69690: from a start that stays put,
 * every page reads again all that was sent from it, and pages shrink to a
 * handful of staples. So probes look for a moment as far into the page as
 * EARLY_REACH_SHARE, and the filter then names only the page's staples from
 * there. The same probe at the horizon, after short pages, shows the pass
 * has caught up while the peer keeps applying staples, when no page is
 * ever empty.
 *
 * A pass completes once the node is shown to hold or have queued every
 * staple before its horizon, the margin before the pass began: the next
 * pass starts there whatever this one reads past it, so no more needs to be
 * shown. It probes the horizon only after short pages, which a peer answers
 * once the pass has read up to the present, and so reads that far all the
 * same, unless the peer answers short pages throughout, when the next
 * passes bring the rest. It stops earlier only when its start reaches its end: the moment it
 * began, for a pass from where the last reached, and the horizon, for a
 * deep re-scan, which need not read the present. The horizon must not be
 * the moment the pass began: the probe needs a staple the peer applied at
 * or after it, and a peer whose clock runs behind the node's by more than a
 * pass lasts has applied none while the pass runs, whereas the margin
 * allows for a clock that far behind.
 *
 * A filter names a staple it was not given at a small rate, and a conclusion
 * that the node holds or has queued every staple up to a moment is wrong
 * when the filter named one it lacks. When more staples share the start's moment than a
 * filter and a page hold, no page reaches past them; the filter then names
 * all of them at a higher rate, and once a page reaches past that moment
 * the start moves a millisecond on. Such a conclusion is checked with
 * further filters, each with a seed of its own, until the rates multiply to
 * ACCEPTED_ERROR_RATE: with each, the first staple not named from the start
 * must be the first from the moment concluded.
 *
 * A staple the peer applies during the pass at a moment the pass has moved
 * past is left to the next pass, which starts the margin before this one
 * began.
 */
class Pass<Staple extends PassStaple> {
	readonly #io: PeerIO<Staple>;
	readonly #began = Date.now();
	readonly #horizon: number;
	readonly #end: number;
	readonly #seed: () => number;
	readonly #moved: (start: Date) => Promise<void>;
	readonly #named = new NamedStaples();
	#start: number;
	#limit: number;
	#requests = 0;
	/** How far the start last moved, from which probes look next. */
	#step = FIRST_STEP_MILLISECONDS;

	/** The end is at or after the horizon: the pass stops reading once its start reaches it. */
	constructor(io: PeerIO<Staple>, start: Date, horizon: Date, end: Date, options: PassOptions, moved: (start: Date) => Promise<void>) {
		this.#io = io;
		this.#start = start.getTime();
		this.#horizon = horizon.getTime();
		this.#end = end.getTime();
		this.#limit = options.limit;
		this.#seed = options.seed ?? function(): number {
			return(randomInt(SEED_LIMIT));
		};
		this.#moved = moved;
	}

	async run(): Promise<PassOutcome> {
		await this.#hold();
		let shortPages = 0;
		for (;;) {
			if (this.#start >= this.#end) {
				return({ kind: 'caught-up' });
			}
			if (this.#exhausted()) {
				return({ kind: 'bounded', reached: new Date(this.#start) });
			}
			const filter = this.#named.filter(this.#seed());
			const page = await this.#request(this.#start, this.#limit, filter.serialized);
			if (page === undefined) {
				this.#limit = Math.ceil(this.#limit / 2);
				continue;
			}
			const taken = await this.#take(page);
			if (taken.added) {
				await this.#io.retry();
			}
			const held = taken.held;
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
			if (probesHorizonAfter(shortPages) && await this.#reachesHorizon(page, filter)) {
				return({ kind: 'caught-up' });
			}
			const fits = this.#named.size + page.length <= BLOOM_CAPACITY;
			const early = fits && shortPages >= 2 && this.#named.received > 0;
			if (fits && !early) {
				this.#named.receive(page);
				continue;
			}
			if (filter.errorRate <= ACCEPTED_ERROR_RATE) {
				const reach = await this.#reach(page, filter.serialized, early);
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
				return({ kind: 'bounded', reached: new Date(this.#start) });
			}
			this.#named.receive(page);
			if (filter.errorRate > ACCEPTED_ERROR_RATE) {
				await this.#passMoment(page, filter, held);
			}
		}
	}

	#exhausted(): boolean {
		return(this.#requests >= MAX_PASS_REQUESTS || Date.now() - this.#began >= MAX_PASS_MILLISECONDS);
	}

	/**
	 * Names, as far as there is room, the staples the node has queued, which
	 * the peer would otherwise send again, and those it added from the start
	 * on, by its own clock, the likeliest to be those the peer sends from
	 * there. Given the first staple the peer sends from the start, it
	 * names them from that staple on, and none when the node added it
	 * elsewhere in its order, as it does staples it bootstrapped long after
	 * their moments, which the peer would send all the same.
	 */
	async #hold(first?: NamedStaple): Promise<void> {
		const room = BLOOM_CAPACITY - this.#named.size;
		if (room <= 0) {
			return;
		}
		const held = await this.#io.held(new Date(this.#start), room);
		if (first === undefined) {
			this.#named.hold(held);
			return;
		}
		const key = stapleKey(first);
		const at = held.findIndex(function(staple): boolean {
			return(stapleKey(staple) === key);
		});
		if (at >= 0) {
			this.#named.hold(held.slice(at));
		}
	}

	/** The page, or nothing when it was too large and fewer staples can be asked for. */
	async #request(start: number, limit: number, bloomFilter: string | undefined): Promise<readonly Staple[] | undefined> {
		this.#requests++;
		const answer = await this.#io.page({ start: new Date(start), limit, bloomFilter });
		switch (answer.kind) {
			case 'page':
				return(answer.staples);
			case 'too-large':
				if (limit === 1) {
					throw(new Error('the peer holds a staple larger than a page may be'));
				}
				return(undefined);
			default:
				return(assertNever(answer));
		}
	}

	/**
	 * Adds or queues the staples a peer sent. A peer that sends a staple the
	 * filter named ignores the filter, and would send it again forever; one
	 * that sends blocks the node holds with other votes does not, and the
	 * filter names those votes from then on.
	 */
	async #take(page: readonly Staple[]): Promise<Taken> {
		const named = page.find((staple) => {
			return(this.#named.names(staple));
		});
		if (named !== undefined) {
			throw(new Error(`the peer sent staple ${named.blocksHash.toString()}, which the filter named, so it does not leave out what a filter names`));
		}
		let held = false;
		let added = false;
		for (const staple of page) {
			const outcome = await this.#io.add(staple);
			switch (outcome) {
				case 'added':
					added = true;
					break;
				case 'held':
					held = true;
					break;
				case 'queued':
					break;
				default:
					assertNever(outcome);
			}
		}
		return({ held, added });
	}

	/**
	 * The start moves on. When the page repeated staples the node held, the
	 * filter is filled again with the staples it holds from the new start, so
	 * that the peer sends fewer of them again: it then holds more than room
	 * for a page, so the next page moves the start on again.
	 */
	async #moveTo(reach: Reach, page: readonly Staple[], held: boolean): Promise<void> {
		this.#named.moveOn(page, reach.from);
		this.#step = reach.start - this.#start;
		this.#start = reach.start;
		await this.#moved(new Date(this.#start));
		if (held) {
			await this.#hold(page[reach.from]);
		}
	}

	/**
	 * Moves the start a millisecond on, past the staples that share its
	 * moment, once the page reached past them, as checked with further
	 * filters. Only a millisecond, so that a staple the peer applies
	 * meanwhile at a moment the pass has read past is unlikely to stand in
	 * the way of the check.
	 */
	async #passMoment(page: readonly Staple[], filter: Filter, held: boolean): Promise<void> {
		const next = this.#start + 1;
		const from = await this.#probe(next, filter.serialized, positionsOf(page));
		if (from !== undefined && await this.#confirm(next, filter.errorRate)) {
			await this.#moveTo({ start: next, from }, page, held);
		}
	}

	/** Whether the node holds or has queued every staple before the horizon: shown once the start has moved past it, or by the page, with no staple not named before it, reaching it. */
	async #reachesHorizon(page: readonly Staple[], filter: Filter): Promise<boolean> {
		if (this.#start >= this.#horizon) {
			return(true);
		}
		if (filter.errorRate > ACCEPTED_ERROR_RATE) {
			return(false);
		}
		return(await this.#probe(this.#horizon, filter.serialized, positionsOf(page)) !== undefined);
	}

	/**
	 * Whether a conclusion that the node holds or has queued every staple from
	 * the start up to the moment given, or to the end when none is, drawn
	 * from a filter of that error rate, holds with further filters until
	 * their rates multiply to ACCEPTED_ERROR_RATE. A staple a further filter finds is added, and
	 * the conclusion is not drawn.
	 */
	async #confirm(to: number | undefined, errorRate: number): Promise<boolean> {
		let uncertainty = errorRate;
		while (uncertainty > ACCEPTED_ERROR_RATE) {
			if (this.#exhausted()) {
				return(false);
			}
			const filter = this.#named.filter(this.#seed());
			let beyond: Staple | undefined;
			if (to !== undefined) {
				beyond = await this.#first(to, filter.serialized);
			}
			const first = await this.#first(this.#start, filter.serialized);
			if (first !== undefined && (beyond === undefined || stapleKey(first) !== stapleKey(beyond))) {
				if ((await this.#take([first])).added) {
					await this.#io.retry();
				}
				this.#named.receive([first]);
				return(false);
			}
			if (first === undefined && beyond !== undefined) {
				// Applied between the two requests: the next page brings it.
				return(false);
			}
			uncertainty *= filter.errorRate;
		}
		return(true);
	}

	async #first(at: number, bloomFilter: string | undefined): Promise<Staple | undefined> {
		return((await this.#request(at, 1, bloomFilter))?.[0]);
	}

	/**
	 * The furthest moment found that the page reached, with the staples of
	 * the page from it on few enough to name, or, early, after a short page
	 * that fits the filter, at most the share of it EARLY_REACH_SHARE leaves.
	 */
	async #reach(page: readonly Staple[], bloomFilter: string | undefined, early: boolean): Promise<Reach | undefined> {
		const positions = positionsOf(page);
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
			const from = await this.#probe(at, bloomFilter, positions);
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

	/** The index in the page of the first staple not named that the peer applied at or after the moment, if it is one of the page's. */
	async #probe(at: number, bloomFilter: string | undefined, positions: ReadonlyMap<string, number>): Promise<number | undefined> {
		const first = await this.#first(at, bloomFilter);
		if (first === undefined) {
			return(undefined);
		}
		return(positions.get(stapleKey(first)));
	}
}

/**
 * Whether to probe the horizon after that many short pages in a row: after
 * 2, 4, 8 and so on. A peer that keeps applying staples sends short pages
 * once the pass has caught up, and so does one that answers short pages
 * while far behind, where probing after each would double the requests.
 */
function probesHorizonAfter(shortPages: number): boolean {
	return(shortPages >= 2 && Number.isInteger(Math.log2(shortPages)));
}

function positionsOf(page: readonly NamedStaple[]): Map<string, number> {
	return(new Map(page.map(function(staple, index): [string, number] {
		return([stapleKey(staple), index]);
	})));
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
 * passes.
 */
export async function bootstrapPeer<Staple extends PassStaple>(io: PeerIO<Staple>, options: PassOptions): Promise<PeerOutcome> {
	const began = Date.now();
	const floor = floorOf(began);
	let progress = withDeepScanBegun(await io.readProgress() ?? firstProgress(began, options.stagger ?? 0, options.from ?? EPOCH), began);
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
	const live = new Pass(io, progress.reached, floor, new Date(began), options, function(start) {
		return(record(function(current) {
			return({ ...current, reached: earlier(start, floor) });
		}));
	});
	const deepScan = progress.deepScan;
	let deep: Pass<Staple> | undefined;
	if (deepScan !== undefined) {
		deep = new Pass(io, deepScan.reached, deepScan.horizon, deepScan.horizon, options, function(start) {
			return(record(function(current) {
				return({ ...current, deepScan: { reached: start, horizon: deepScan.horizon } });
			}));
		});
	}
	const [liveResult, deepResult] = await Promise.allSettled([live.run(), deep?.run()]);
	// Whatever the passes did, the staples they queued, and those queued before, are offered again, which also makes room in a queue that was full.
	const [retried] = await Promise.allSettled([io.retry()]);
	const liveOutcome = outcomeOf(liveResult);
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
