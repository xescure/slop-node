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
 * How many staples a filter names at most. A filter is always made for this
 * many, so its size is fixed: about 40,000 bits at the rate below, which keeps
 * the request within the 8 KiB the client allows a URL
 * [Keeta TS] index.js:59614-59617 even when the filter is full.
 */
export const BLOOM_CAPACITY = 1200;

/**
 * A staple the filter names by mistake is one the peer leaves out
 * [Keeta TS] index.js:69686-69690. A pass loses one only when it then moves
 * its start past it, which the deep re-scan undoes; at this rate a catch-up
 * of a million staples expects to lose a tenth of one.
 */
export const BLOOM_ERROR_RATE = 1e-7;

/** What a filter reads of a staple: its bytes, as the peer tests them [Keeta TS] index.js:69686-69690. */
export type NamedStaple = {
	readonly blocksHash: { toString(): string };
	toBytes(): ArrayBuffer;
};

type Entry = {
	readonly bytes: ArrayBuffer;
	/** Sent by the peer since the start last moved, rather than held before the pass. */
	readonly received: boolean;
};

/**
 * The staples the next request's filter names, so that the peer sends only
 * staples the node lacks: those it held from the start when the pass began,
 * and those the peer has sent from the start. When there are more than a
 * filter holds, the earliest named are let go first, since the peer sends
 * staples in the order it applied them and the pass has moved past those
 * soonest; a staple let go is at worst sent again.
 */
export class NamedStaples {
	readonly #entries = new Map<string, Entry>();

	get size(): number {
		return(this.#entries.size);
	}

	names(staple: NamedStaple): boolean {
		return(this.#entries.has(staple.blocksHash.toString()));
	}

	/** Staples the node held when the pass began, from about its start. */
	hold(staples: readonly NamedStaple[]): void {
		for (const staple of staples) {
			this.#name(staple, false);
		}
	}

	/** A page the peer sent from the current start. */
	receive(page: readonly NamedStaple[]): void {
		for (const staple of page) {
			this.#name(staple, true);
		}
	}

	/**
	 * The start moved on to the moment of the page's staple at that index,
	 * which the page's earlier staples and everything sent before them
	 * precede, so the peer will not send them from there again.
	 */
	moveOn(page: readonly NamedStaple[], from: number): void {
		if (from > 0) {
			for (const [key, entry] of this.#entries) {
				if (entry.received) {
					this.#entries.delete(key);
				}
			}
		}
		this.receive(page.slice(from));
	}

	/** A filter of every staple named, made for BLOOM_CAPACITY staples with the seed given, or nothing when none is named. */
	serialize(seed: number): string | undefined {
		if (this.#entries.size === 0) {
			return(undefined);
		}
		const filter = lib.Utils.Bloom.BloomFilter.create(BLOOM_CAPACITY, BLOOM_ERROR_RATE);
		filter.seed = seed;
		for (const entry of this.#entries.values()) {
			filter.add(entry.bytes);
		}
		return(lib.Utils.Bloom.serializeBloomFilter(filter));
	}

	#name(staple: NamedStaple, received: boolean): void {
		const key = staple.blocksHash.toString();
		this.#entries.delete(key);
		this.#entries.set(key, { bytes: staple.toBytes(), received });
		for (const oldest of this.#entries.keys()) {
			if (this.#entries.size <= BLOOM_CAPACITY) {
				break;
			}
			this.#entries.delete(oldest);
		}
	}
}
