import { createHash } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';

const lib = KeetaNet.lib;

/**
 * How far ahead of the clock that reads it a vote may be timestamped
 * [Keeta TS] index.js:80373-80375, 80653.
 */
export const VOTE_SLOP_MILLISECONDS = 60_000;

/** How far a peer's clock may run behind or ahead of the node's before a staple can be missed until the next deep re-scan. */
export const PEER_CLOCK_SKEW_MILLISECONDS = 300_000;

/**
 * How far before the moment a pass began the next pass over the same peer
 * starts. A peer may apply a staple after the pass has read past its moment
 * for two reasons: the moment is taken as the peer's transaction begins but
 * the staple is visible only once it commits, which the vote slop bounds
 * generously, and the peer's clock may run behind the node's.
 */
export const BOOTSTRAP_MARGIN_MILLISECONDS: number = VOTE_SLOP_MILLISECONDS + PEER_CLOCK_SKEW_MILLISECONDS;

/**
 * How many staples a filter names at the error rate below. A filter is
 * always as large as one made for this many, about 40,000 bits, which keeps
 * the request within the 8 KiB the client allows a URL
 * [Keeta TS] index.js:59614-59617 even when the filter is full.
 */
export const BLOOM_CAPACITY = 1200;

/**
 * The rate a full filter's cells are sized for: that every cell of a staple
 * it was not given is set. A staple the filter names by mistake is one the
 * peer leaves out [Keeta TS] index.js:69686-69690; the filter names one at a
 * higher rate in all (errorRateOf).
 */
export const BLOOM_ERROR_RATE = 1e-7;

/**
 * The most staples a filter names. Past BLOOM_CAPACITY the filter keeps its
 * size and names more at a higher error rate, about 0.4 here, which only
 * more requests with other seeds bring back down; a pass that would name
 * more ends at its bound instead.
 */
export const MAX_NAMED = 20_000;

const FULL_FILTER = lib.Utils.Bloom.BloomFilter.create(BLOOM_CAPACITY, BLOOM_ERROR_RATE);

const FILTER_BITS = FULL_FILTER.size;

const FULL_FILTER_HASHES = FULL_FILTER._nbHashes;

/** The hash functions a filter of FILTER_BITS uses for that many staples: as many as make it least likely to name another by mistake. */
function hashesFor(named: number): number {
	if (named <= BLOOM_CAPACITY) {
		return(FULL_FILTER_HASHES);
	}
	return(Math.max(1, Math.round(FILTER_BITS / named * Math.LN2)));
}

/**
 * How likely a filter of FILTER_BITS naming that many staples is to name
 * another by mistake: that every cell of the staple is set, or that its
 * cells are those of a staple the filter names. The client places a staple's
 * cells by the low 32 bits of two hashes of its bytes
 * [Keeta TS] index.js:26784-26786, 90743-90745, 90799-90809, 90820-90842, so
 * a staple whose two hashes agree with a named staple's modulo the filter's
 * size is named on every cell, which with FILTER_BITS cells happens once in
 * FILTER_BITS squared for each staple named: about 7.4e-7 for a full filter,
 * seven times what its cells are sized for.
 */
function errorRateOf(named: number): number {
	const hashes = hashesFor(named);
	return((1 - Math.exp(-hashes * named / FILTER_BITS)) ** hashes + named / FILTER_BITS ** 2);
}

/**
 * The error rate a pass accepts for a conclusion that it holds every staple
 * up to a moment: that of one full filter, about 8.4e-7. Filters that name
 * more are each less certain, so the conclusion rests on several, each with
 * a seed of its own, whose rates multiply. A pass that concludes on one
 * filter leaves out a staple it lacks at about this rate, about one in a
 * catch-up of a million staples; the deep re-scans read every staple again
 * with filters of their own (src/node/bootstrap-pass.ts, bootstrapPeer), so
 * a staple is lost only when both err, at about the square of it.
 */
export const ACCEPTED_ERROR_RATE: number = errorRateOf(BLOOM_CAPACITY);

/** What a filter reads of a staple: its bytes, as the peer tests them [Keeta TS] index.js:69686-69690. */
export type NamedStaple = {
	readonly blocksHash: { toString(): string };
	toBytes(): ArrayBuffer;
};

const keys = new WeakMap<NamedStaple, string>();

/**
 * What tells staples apart for a filter: their bytes. Two staples on the same
 * blocks with other votes differ, so a filter that names one leaves the
 * other in.
 */
export function stapleKey(staple: NamedStaple): string {
	let key = keys.get(staple);
	if (key === undefined) {
		key = createHash('sha256').update(new Uint8Array(staple.toBytes())).digest('base64');
		keys.set(staple, key);
	}
	return(key);
}

/** A filter as sent, and how likely it is to name by mistake a staple it was not given. */
export type Filter = {
	readonly serialized: string | undefined;
	readonly errorRate: number;
};

/**
 * The staples the next request's filter names, so that the peer sends only
 * staples the node lacks.
 *
 * Those the peer sent from the current start must be named, or the peer
 * sends them again; they are let go only when the start moves past them.
 * Those the node held already are named only while there is room, the
 * earliest first, since the peer sends staples in the order it applied them;
 * one left out is at worst sent again.
 */
export class NamedStaples {
	readonly #received = new Map<string, ArrayBuffer>();
	readonly #held = new Map<string, ArrayBuffer>();

	/** The staples the peer sent from the current start. */
	get received(): number {
		return(this.#received.size);
	}

	get size(): number {
		return(this.#received.size + this.#held.size);
	}

	/** Whether the filter names exactly this staple, bytes and all. */
	names(staple: NamedStaple): boolean {
		const key = stapleKey(staple);
		return(this.#received.has(key) || this.#held.has(key));
	}

	/** Staples the node holds, from about the start on, earliest first; named as far as there is room. */
	hold(staples: readonly NamedStaple[]): void {
		for (const staple of staples) {
			if (this.size >= BLOOM_CAPACITY) {
				break;
			}
			const key = stapleKey(staple);
			if (!this.#received.has(key)) {
				this.#held.set(key, staple.toBytes());
			}
		}
	}

	/** Staples the peer sent from the current start, which make room for themselves among those held. */
	receive(staples: readonly NamedStaple[]): void {
		for (const staple of staples) {
			const key = stapleKey(staple);
			this.#held.delete(key);
			this.#received.set(key, staple.toBytes());
		}
		const excess = this.size - BLOOM_CAPACITY;
		if (excess > 0) {
			for (const key of [...this.#held.keys()].slice(-excess)) {
				this.#held.delete(key);
			}
		}
	}

	/**
	 * The start moved on to a moment the page was shown to reach, and the
	 * peer may list the staples given from there again, but, for staples the
	 * peer applied late, none it sent before the page; one it does is at
	 * worst sent again. Those held were named for the old start.
	 */
	moveOn(staples: readonly NamedStaple[]): void {
		this.#received.clear();
		this.#held.clear();
		this.receive(staples);
	}

	/** Names the staple no more, so that the peer lists it. */
	forget(staple: NamedStaple): void {
		const key = stapleKey(staple);
		this.#received.delete(key);
		this.#held.delete(key);
	}

	/**
	 * Names, as far as there is room, what another names too, the peer may
	 * list from a later start again, by the staple's key (stapleKey): what
	 * the peer sent from its start, and then what the node held.
	 */
	carry(other: NamedStaples, mayListAgain: (key: string) => boolean): void {
		const carried = [...other.#received, ...other.#held].filter(function([key]): boolean {
			return(mayListAgain(key));
		});
		for (const [key, bytes] of carried) {
			if (this.size >= BLOOM_CAPACITY) {
				break;
			}
			if (!this.#received.has(key)) {
				this.#held.set(key, bytes);
			}
		}
	}

	/** A filter of every staple named with the seed given, or none when none is named. */
	filter(seed: number): Filter {
		const named = this.size;
		if (named === 0) {
			return({ serialized: undefined, errorRate: 0 });
		}
		const filter = new lib.Utils.Bloom.BloomFilter(FILTER_BITS, hashesFor(named));
		filter.seed = seed;
		for (const bytes of [...this.#received.values(), ...this.#held.values()]) {
			filter.add(bytes);
		}
		return({ serialized: lib.Utils.Bloom.serializeBloomFilter(filter), errorRate: errorRateOf(named) });
	}
}
