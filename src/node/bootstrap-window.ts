import { randomInt } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BloomFilter } from '@keetanetwork/keetanet-client/lib/utils/bloom.js';

/**
 * How far before the moment it has reached the node asks a peer again. A
 * peer orders its staples by the moment it applied each, and a transaction
 * that began earlier can commit later (schema/CONTRACT.md), while the
 * timestamps the node advances by are taken on the voters' clocks, not on
 * the peer's.
 */
export const BOOTSTRAP_OVERLAP_MILLISECONDS = 30_000;

/**
 * The most staples one filter names. At the rate below a full filter keeps
 * the request well under the 8 KiB the client allows a URL
 * [Keeta TS] index.js:59614-59617.
 */
export const BLOOM_CAPACITY = 800;

/**
 * A staple the filter names by mistake is one the peer leaves out
 * [Keeta TS] index.js:69686-69690, so the rate is low enough that a catch-up
 * of millions of staples is unlikely to meet one.
 */
export const BLOOM_ERROR_RATE = 1e-9;

const lib = KeetaNet.lib;

/** Seeds the filter takes: integers the hash functions read exactly. */
const SEED_LIMIT = 2 ** 31;

/** What the window reads of a staple. */
export type WindowStaple = {
	readonly blocksHash: { toString(): string };
	toBytes(): ArrayBuffer;
	timestamp(): Date;
};

type Known = {
	readonly bytes: ArrayBuffer;
	readonly timestamp: number;
	/** Sent since the start last moved; naming these in the filter is what makes each page bring something new. */
	readonly sinceStart: boolean;
};

/**
 * The latest timestamp of the page, or the clock if that is earlier: a peer
 * applies a staple only once its votes exist, so a vote timestamped ahead of
 * the clock was taken on a clock that runs fast, and must not carry the
 * start past staples the peer applies until then.
 */
function latestTimestamp(page: readonly WindowStaple[]): number {
	return(Math.min(Date.now(), Math.max(...page.map(function(staple): number {
		return(staple.timestamp().getTime());
	}))));
}

/**
 * Where one pass over a peer's staples has reached, and the staples the
 * peer may send again from there.
 *
 * A peer answers with the staples it applied at or after the start, in the
 * order it applied them [Keeta TS] index.js:69638-69700 (schema/CONTRACT.md,
 * getVotesAfter), and the node sees only each staple's timestamp. After a
 * page the start moves to the latest timestamp the page held, less the
 * overlap, and the filter names the staples the peer may send again from
 * there: those timestamped at or after the start, and every one sent since
 * the start last moved, so that a page that moves the start no further still
 * brings staples not seen before.
 */
export class BootstrapWindow {
	#start: number;
	readonly #known = new Map<string, Known>();

	/** The staples given are already held, so the peer need not send them. */
	constructor(start: Date, held: readonly WindowStaple[]) {
		this.#start = start.getTime();
		for (const staple of held) {
			this.#remember(staple, false);
		}
	}

	get start(): Date {
		return(new Date(this.#start));
	}

	/**
	 * Records the staples the peer sent from the current start, and moves the
	 * start on. Answers whether the page brought the pass further: a page
	 * that moves the start no further and holds only staples sent from it
	 * before means the peer ignores the filter, and would send them forever.
	 */
	advance(page: readonly WindowStaple[]): boolean {
		const brought = page.some((staple) => {
			return(this.#known.get(staple.blocksHash.toString())?.sinceStart !== true);
		});
		for (const staple of page) {
			this.#remember(staple, true);
		}
		if (page.length === 0) {
			return(false);
		}
		const latest = latestTimestamp(page);
		let next = Math.max(this.#start, latest - BOOTSTRAP_OVERLAP_MILLISECONDS);
		if (next === this.#start && this.#sentSinceStart().length >= BLOOM_CAPACITY) {
			// The staples sent from this start no longer fit one filter, so the start moves on without the overlap, or the peer would send them again forever.
			next = Math.max(this.#start + 1, latest);
		}
		if (next === this.#start) {
			return(brought);
		}
		this.#start = next;
		for (const [key, known] of this.#known) {
			if (known.timestamp < next) {
				this.#known.delete(key);
			} else {
				this.#known.set(key, { ...known, sinceStart: false });
			}
		}
		return(true);
	}

	/** The staples the peer need not send, or nothing when none is known. */
	filter(): BloomFilter | undefined {
		const named = this.#named();
		if (named.length === 0) {
			return(undefined);
		}
		const filter = lib.Utils.Bloom.BloomFilter.create(named.length, BLOOM_ERROR_RATE);
		// A fresh seed for each request names different staples by mistake, so no staple is left out of every pass.
		filter.seed = randomInt(SEED_LIMIT);
		for (const known of named) {
			filter.add(known.bytes);
		}
		return(filter);
	}

	/** Those sent since the start moved first, then the earliest, which a peer reaches first. */
	#named(): readonly Known[] {
		const others = [...this.#known.values()].filter(function(known): boolean {
			return(!known.sinceStart);
		}).sort(function(left, right): number {
			return(left.timestamp - right.timestamp);
		});
		return([...this.#sentSinceStart(), ...others].slice(0, BLOOM_CAPACITY));
	}

	#sentSinceStart(): Known[] {
		return([...this.#known.values()].filter(function(known): boolean {
			return(known.sinceStart);
		}));
	}

	#remember(staple: WindowStaple, sinceStart: boolean): void {
		this.#known.set(staple.blocksHash.toString(), { bytes: staple.toBytes(), timestamp: staple.timestamp().getTime(), sinceStart });
	}
}
