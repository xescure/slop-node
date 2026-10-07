import { createHash } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BloomFilter } from '@keetanetwork/keetanet-client/lib/utils/bloom.js';
import type { Added, PassAnswer, PassRequest, PassStaple } from '../node/bootstrap-pass.js';
import { advanceClock } from './network.js';

const lib = KeetaNet.lib;

/** About the size of a staple's hash input that matters to a filter: distinct bytes per staple. */
const STAPLE_BYTES = 64;

/** A staple as a simulated peer holds it: when the peer applied it, and when its votes say it was made. */
export type SimulatedStaple = PassStaple & {
	readonly id: number;
	/** The moment the peer applied it, on the peer's clock. */
	readonly moment: number;
	/** The order the peer applied it in among staples of the same moment. */
	readonly sequence: number;
	timestamp(): Date;
};

/** The bytes of a staple: those of its blocks and of the votes on them, which another vote set on the same blocks changes. */
function stapleBytes(id: number, votes: number): ArrayBuffer {
	const bytes = Buffer.alloc(STAPLE_BYTES);
	for (let at = 0; at < STAPLE_BYTES; at += 32) {
		createHash('sha256').update(`staple:${String(id)}:${String(votes)}:${String(at)}`).digest().copy(bytes, at);
	}
	return(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function simulatedStaple(id: number, moment: number, sequence: number, timestamp: number, votes = 0): SimulatedStaple {
	const bytes = stapleBytes(id, votes);
	const name = `staple-${String(id)}`;
	return({
		id,
		moment,
		sequence,
		blocksHash: { toString: function(): string {
			return(name);
		} },
		toBytes: function(): ArrayBuffer {
			return(bytes);
		},
		timestamp: function(): Date {
			return(new Date(timestamp));
		}
	});
}

function compareApplied(left: SimulatedStaple, right: SimulatedStaple): number {
	if (left.moment !== right.moment) {
		return(left.moment - right.moment);
	}
	return(left.sequence - right.sequence);
}

/** Staples applied as the network makes them: so many a second, each timestamped by its voters' clocks. */
export type LiveTraffic = {
	readonly perSecond: number;
	/** How far ahead of the real time the voters' clocks run for the staple made at that real time. */
	readonly voterSkew: (madeAt: number) => number;
};

type LiveState = LiveTraffic & { readonly since: number; made: number };

/** Staples a peer commits after it has served pages from their moments: so many at each request, at moments up to that long before. */
export type LateCommits = {
	readonly perRequest: number;
	readonly within: number;
};

export type SimulatedPeerOptions = {
	/** How far the peer's clock runs ahead of the node's, negative when behind. */
	readonly clockOffset?: number;
	/** How long the peer takes to answer a request, during which the clock moves on. */
	readonly latency?: number;
	/**
	 * The most staples the peer puts in a page, whatever the limit: one that
	 * caps the limit, or one whose time for a request runs out once it holds
	 * that many [Keeta TS] index.js:69641-69647.
	 */
	readonly answersAtMost?: number;
};

/** A deterministic source of numbers below 1, so that a scenario runs the same each time. */
export function deterministicRandom(seed: number): () => number {
	let state = seed;
	return(function(): number {
		state = (state * 48271) % 2147483647;
		return(state / 2147483647);
	});
}

/**
 * A representative answering bootstrap pages as this node's API does: the
 * staples applied at or after the start, in the order applied (the moment,
 * then the sequence, as src/ledger/storage/memory/driver.ts getVotesAfter
 * orders them), leaving out those the filter names before counting towards
 * the limit [Keeta TS] index.js:69633-69702. The filter travels serialized
 * and is read back with the client's own Bloom functions, as
 * src/api/node.ts does.
 */
export class SimulatedPeer {
	readonly #applied: SimulatedStaple[] = [];
	readonly #clockOffset: number;
	readonly #latency: number;
	readonly #answersAtMost: number;
	readonly #filters = new Map<string, BloomFilter>();
	readonly #random = deterministicRandom(7);
	#nextID = 0;
	#nextSequence = 0;
	#live: LiveState | undefined;
	#lateCommits: LateCommits | undefined;
	#forcedFalsePositive: number | undefined;
	#requests = 0;

	constructor(options: SimulatedPeerOptions = {}) {
		this.#clockOffset = options.clockOffset ?? 0;
		this.#latency = options.latency ?? 25;
		this.#answersAtMost = options.answersAtMost ?? Number.POSITIVE_INFINITY;
	}

	/** Every staple the peer has applied, in the order applied. */
	get staples(): readonly SimulatedStaple[] {
		return(this.#applied);
	}

	get requests(): number {
		return(this.#requests);
	}

	/** The peer's clock. */
	now(): number {
		return(Date.now() + this.#clockOffset);
	}

	/** Applies a staple with the timestamp given, at the moment given or now on the peer's clock. */
	apply(timestamp: number, moment: number = this.now()): SimulatedStaple {
		const staple = simulatedStaple(this.#nextID++, moment, this.#nextSequence++, timestamp);
		let at = this.#applied.length;
		while (at > 0 && compareApplied(this.#applied[at - 1] ?? staple, staple) > 0) {
			at--;
		}
		this.#applied.splice(at, 0, staple);
		return(staple);
	}

	/** The same blocks as the staple, with another set of votes on them, as another representative may hold them. */
	otherVotesOn(staple: SimulatedStaple): SimulatedStaple {
		return(simulatedStaple(staple.id, staple.moment, staple.sequence, staple.timestamp().getTime(), 1));
	}

	/** Commits staples late at every request from now on, until stopped. */
	commitLate(late: LateCommits | undefined): void {
		this.#lateCommits = late;
	}

	/** Applies staples as they are made from now on, as a representative that is live does, until stopped. */
	goLive(traffic: LiveTraffic): void {
		this.#live = { ...traffic, since: Date.now(), made: 0 };
	}

	stopLive(): void {
		this.#catchUpLive();
		this.#live = undefined;
	}

	/** Makes every filter name this staple as well, as a false positive would, until cleared. */
	forceFalsePositive(staple: SimulatedStaple | undefined): void {
		this.#forcedFalsePositive = staple?.id;
	}

	async page(request: PassRequest): Promise<PassAnswer<SimulatedStaple>> {
		// Answering on a later turn of the event loop, as over a network, lets the test runner's own timers run.
		await new Promise(setImmediate);
		this.#requests++;
		advanceClock(this.#latency);
		this.#catchUpLive();
		this.#commitLate();
		const filter = this.#filterOf(request.bloomFilter);
		const start = request.start.getTime();
		const staples: SimulatedStaple[] = [];
		const limit = Math.min(request.limit, this.#answersAtMost);
		for (let at = this.#firstAtOrAfter(start); at < this.#applied.length && staples.length < limit; at++) {
			const staple = this.#applied[at];
			if (staple === undefined) {
				break;
			}
			if (this.#named(filter, staple)) {
				continue;
			}
			staples.push(staple);
		}
		return({ kind: 'page', staples });
	}

	#named(filter: BloomFilter | undefined, staple: SimulatedStaple): boolean {
		if (filter === undefined) {
			return(false);
		}
		return(staple.id === this.#forcedFalsePositive || filter.has(staple.toBytes()));
	}

	#filterOf(serialized: string | undefined): BloomFilter | undefined {
		if (serialized === undefined) {
			return(undefined);
		}
		let filter = this.#filters.get(serialized);
		if (filter === undefined) {
			filter = lib.Utils.Bloom.deserializeBloomFilter(serialized);
			this.#filters.clear();
			this.#filters.set(serialized, filter);
		}
		return(filter);
	}

	#firstAtOrAfter(moment: number): number {
		let low = 0;
		let high = this.#applied.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if ((this.#applied[middle]?.moment ?? moment) < moment) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		return(low);
	}

	#commitLate(): void {
		const late = this.#lateCommits;
		if (late === undefined) {
			return;
		}
		for (let count = 0; count < late.perRequest; count++) {
			const moment = this.now() - Math.ceil(this.#random() * late.within);
			this.apply(moment, moment);
		}
	}

	/** Applies the staples made since the last request, each at the real time it was made. */
	#catchUpLive(): void {
		const live = this.#live;
		if (live === undefined) {
			return;
		}
		const due = Math.floor((Date.now() - live.since) * live.perSecond / 1000);
		for (; live.made < due; live.made++) {
			const madeAt = live.since + Math.floor(live.made * 1000 / live.perSecond);
			this.apply(madeAt + live.voterSkew(madeAt), madeAt + this.#clockOffset);
		}
	}
}

/**
 * What a simulated node holds: each staple added, in the order added, with
 * the moment it added it. As a ledger does, it holds one staple per set of
 * blocks, and adds none whose blocks it holds.
 */
export class SimulatedNode {
	readonly #held = new Map<string, number>();
	readonly #order: { readonly staple: PassStaple; readonly moment: number }[] = [];
	#resent = 0;

	holds(staple: PassStaple): boolean {
		return(this.#held.has(staple.blocksHash.toString()));
	}

	get size(): number {
		return(this.#held.size);
	}

	/** The staples offered to add whose blocks were held already: what peers sent again. */
	get resent(): number {
		return(this.#resent);
	}

	add(staple: PassStaple): Promise<Added> {
		const key = staple.blocksHash.toString();
		if (this.#held.has(key)) {
			this.#resent++;
			return(Promise.resolve('held'));
		}
		this.#held.set(key, Date.now());
		this.#order.push({ staple, moment: Date.now() });
		return(Promise.resolve('added'));
	}

	/** The staples added at or after the moment, as many as asked for, in the order added. */
	held(from: Date, count: number): Promise<readonly PassStaple[]> {
		let low = 0;
		let high = this.#order.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if ((this.#order[middle]?.moment ?? from.getTime()) < from.getTime()) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		return(Promise.resolve(this.#order.slice(low, low + count).map(function(entry): PassStaple {
			return(entry.staple);
		})));
	}
}
