import { randomInt } from 'node:crypto';
import { assertNever } from '../util/assert-never.js';
import { BLOOM_CAPACITY, BOOTSTRAP_MARGIN_MILLISECONDS, NamedStaples, PEER_CLOCK_SKEW_MILLISECONDS } from './bootstrap-window.js';
import type { NamedStaple } from './bootstrap-window.js';

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

/** How far past the start the first probe of a pass looks. */
const FIRST_STEP_MILLISECONDS = 1000;

/** Completed passes over a peer between deep re-scans: an hour at LocalNode's period. */
export const DEEP_SCAN_EVERY = 60;

/** How far before where it has reached a deep re-scan starts at least, for peers whose clocks ran further off than the margin allows. */
export const DEEP_SCAN_DEPTH_MILLISECONDS: number = 60 * 60_000;

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

/** What the node keeps of its passes over one peer. */
export type PeerProgress = {
	/**
	 * The node holds every staple the peer applied before this moment, on
	 * the peer's clock, save those a filter named by mistake.
	 */
	readonly reached: Date;
	/** The earliest start of a pass since the last deep re-scan, which the next one goes back to. */
	readonly deepScanFrom: Date;
	/** Passes completed since the last deep re-scan. */
	readonly completions: number;
	/** Whether a deep re-scan is under way, which passes continue until one completes. */
	readonly deepScanning: boolean;
};

/** How a pass reaches the peer and the node. */
export type PeerIO<Staple extends PassStaple> = {
	page(request: PassRequest): Promise<PassAnswer<Staple>>;
	/** Staples the node added at or after the moment, on its own clock, the earliest first. */
	held(from: Date, count: number): Promise<readonly NamedStaple[]>;
	add(staple: Staple): Promise<void>;
	readProgress(): Promise<PeerProgress | undefined>;
	writeProgress(progress: PeerProgress): Promise<void>;
};

export type PassOptions = {
	/** The most staples a page holds; halved for the rest of the pass whenever an answer is too large. */
	readonly limit: number;
	readonly seed?: () => number;
};

export type PassOutcome =
	/** A page came back short: the node held, as the pass ended, every staple the peer had applied from where it began. */
	| { readonly kind: 'drained' }
	/** The pass reached its bound with the peer not yet drained; the next one starts from where it reached. */
	| { readonly kind: 'bounded'; readonly reached: Date };

const EPOCH = new Date(0);

const FIRST_PROGRESS: PeerProgress = { reached: EPOCH, deepScanFrom: EPOCH, completions: 0, deepScanning: false };

function earlier(left: Date, right: Date): Date {
	return(new Date(Math.min(left.getTime(), right.getTime())));
}

/** Where the next pass starts: where the last reached, or, once enough have completed, further back for a deep re-scan. */
function nextProgress(stored: PeerProgress | undefined): PeerProgress {
	const progress = stored ?? FIRST_PROGRESS;
	if (progress.deepScanning) {
		return(progress);
	}
	if (progress.completions >= DEEP_SCAN_EVERY) {
		const from = new Date(Math.max(0, Math.min(progress.deepScanFrom.getTime(), progress.reached.getTime() - DEEP_SCAN_DEPTH_MILLISECONDS)));
		return({ reached: from, deepScanFrom: from, completions: 0, deepScanning: true });
	}
	return({ ...progress, deepScanFrom: earlier(progress.deepScanFrom, progress.reached) });
}

/** What a page's staples were proven to reach: the start moves to that moment, which every staple of the page from that index on is at or after. */
type Reach = { readonly start: number; readonly from: number };

/**
 * One pass over a peer's staples, from a start.
 *
 * A peer answers with the staples it applied at or after the start, in the
 * order it applied them, leaving out those the filter names before it
 * counts to the limit [Keeta TS] index.js:69633-69702. The pass learns no
 * moment: a staple's timestamp is taken on its voters' clocks, and a peer
 * may apply a staple any time after it was made.
 *
 * Progress is made by exclusion: the next request asks from the same start,
 * with a filter that names everything sent from it as well as what the node
 * held, so that the peer sends only staples the node lacks. A pass ends when
 * a page comes back short, since the peer then had nothing more.
 *
 * A filter names a fixed number of staples, so before a page would overfill
 * it, the start moves on, but only to a moment the page is proven to have
 * reached. A probe asks for one staple from a later moment with the same
 * filter: the peer answers with the first staple not named that it applied
 * at or after that moment, and when that is a staple of the page, the page
 * reached that moment, so it held every staple not named from the start up
 * to it; the page's staples before the one answered precede the moment, and
 * those from it on do not. Probes gallop up from the start and then bisect,
 * until the staples from the moment found fit the filter with room for a
 * page.
 *
 * A staple the peer applies during the pass at a moment the pass has moved
 * past is left to the next pass, which starts the margin before this one
 * began.
 */
class Pass<Staple extends PassStaple> {
	readonly #io: PeerIO<Staple>;
	readonly #began = Date.now();
	readonly #seed: () => number;
	readonly #moved: (start: Date) => Promise<void>;
	readonly #named = new NamedStaples();
	#start: number;
	#limit: number;
	#requests = 0;
	/** How far the start last moved, from which probes look next. */
	#step = FIRST_STEP_MILLISECONDS;

	constructor(io: PeerIO<Staple>, start: Date, options: PassOptions, moved: (start: Date) => Promise<void>) {
		this.#io = io;
		this.#start = start.getTime();
		this.#limit = options.limit;
		this.#seed = options.seed ?? function(): number {
			return(randomInt(SEED_LIMIT));
		};
		this.#moved = moved;
	}

	async run(): Promise<PassOutcome> {
		this.#named.hold(await this.#io.held(new Date(Math.max(0, this.#start - BOOTSTRAP_MARGIN_MILLISECONDS)), BLOOM_CAPACITY));
		for (;;) {
			if (this.#exhausted()) {
				return({ kind: 'bounded', reached: new Date(this.#start) });
			}
			const bloomFilter = this.#named.serialize(this.#seed());
			const page = await this.#request(this.#start, this.#limit, bloomFilter);
			if (page === undefined) {
				this.#limit = Math.ceil(this.#limit / 2);
				continue;
			}
			this.#refuseNamed(page);
			for (const staple of page) {
				await this.#io.add(staple);
			}
			if (page.length < this.#limit) {
				return({ kind: 'drained' });
			}
			if (this.#named.size + page.length <= BLOOM_CAPACITY) {
				this.#named.receive(page);
				continue;
			}
			const reach = await this.#reach(page, bloomFilter);
			if (reach === undefined) {
				// Nothing proves the page reached past the start: it is named in place of the earliest named, and the bound ends a pass that cannot move on.
				this.#named.receive(page);
				continue;
			}
			this.#named.moveOn(page, reach.from);
			this.#step = reach.start - this.#start;
			this.#start = reach.start;
			await this.#moved(new Date(this.#start));
		}
	}

	#exhausted(): boolean {
		return(this.#requests >= MAX_PASS_REQUESTS || Date.now() - this.#began >= MAX_PASS_MILLISECONDS);
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

	/** A peer that sends a staple the filter named ignores the filter, and would send it again forever. */
	#refuseNamed(page: readonly Staple[]): void {
		const named = page.find((staple) => {
			return(this.#named.names(staple));
		});
		if (named !== undefined) {
			throw(new Error(`the peer sent staple ${named.blocksHash.toString()}, which the filter named, so it does not leave out what a filter names`));
		}
	}

	/** The furthest moment found that the page reached, with the staples of the page from it on few enough to name. */
	async #reach(page: readonly Staple[], bloomFilter: string | undefined): Promise<Reach | undefined> {
		const positions = new Map(page.map(function(staple, index): [string, number] {
			return([staple.blocksHash.toString(), index]);
		}));
		const enough = page.length - Math.max(1, BLOOM_CAPACITY - this.#limit);
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
		const first = (await this.#request(at, 1, bloomFilter))?.[0];
		if (first === undefined) {
			return(undefined);
		}
		return(positions.get(first.blocksHash.toString()));
	}
}

/**
 * One pass over a peer, from where the last reached. While it moves on the
 * node records how far it has reached, less the margin, so that an
 * interrupted pass resumes there; once it drains the peer, the next pass
 * starts the margin before this one began.
 *
 * Every DEEP_SCAN_EVERY completed passes, the next starts again from the
 * earliest start of the passes since the last deep re-scan, and at least
 * DEEP_SCAN_DEPTH_MILLISECONDS before where it reached, which recovers
 * staples a filter named by mistake and those of a peer whose clock ran
 * further off than the margin allows.
 */
export async function bootstrapPeer<Staple extends PassStaple>(io: PeerIO<Staple>, options: PassOptions): Promise<PassOutcome> {
	const floor = new Date(Math.max(0, Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS));
	let progress = nextProgress(await io.readProgress());
	await io.writeProgress(progress);
	const pass = new Pass(io, progress.reached, options, async function(start): Promise<void> {
		progress = { ...progress, reached: earlier(start, floor) };
		await io.writeProgress(progress);
	});
	const outcome = await pass.run();
	if (outcome.kind === 'drained') {
		if (progress.deepScanning) {
			progress = { reached: floor, deepScanFrom: floor, completions: 0, deepScanning: false };
		} else {
			progress = { ...progress, reached: floor, completions: progress.completions + 1 };
		}
		await io.writeProgress(progress);
	}
	return(outcome);
}
