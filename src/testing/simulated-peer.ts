import { createHash } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BloomFilter } from '@keetanetwork/keetanet-client/lib/utils/bloom.js';
import type { PassAnswer, PassRequest, PassStaple } from '../node/bootstrap-pass.js';
import { RetryQueue } from '../node/bootstrap-retry.js';
import type { Added, Awaited, Offered, QueuedStaple, QueueBounds, RetryStore } from '../node/bootstrap-retry.js';
import { assertNever } from '../util/assert-never.js';
import { advanceClock, freezeClock } from './network.js';

const lib = KeetaNet.lib;

/** About the size of a staple's hash input that matters to a filter: distinct bytes per staple. */
export const SIMULATED_STAPLE_BYTES = 64;

/** A staple as a simulated peer holds it: when the peer applied it, and when its votes say it was made. */
export type SimulatedStaple = PassStaple & {
	readonly id: number;
	/** When each of its votes was made, on its voter's clock. */
	readonly votes: readonly { readonly validityFrom: Date }[];
	/** The moment the peer applied it, on the peer's clock. */
	readonly moment: number;
	/** The order the peer applied it in among staples of the same moment. */
	readonly sequence: number;
	/** The staples a ledger must hold before it accepts this one, by ID: genesis for the voting weight, a credit for the balance a debit spends. */
	readonly needs: readonly number[];
	timestamp(): Date;
};

/** The bytes of a staple: those of its blocks and of the votes on them, which another vote set on the same blocks changes. */
function stapleBytes(id: number, votes: number): ArrayBuffer {
	const bytes = Buffer.alloc(SIMULATED_STAPLE_BYTES);
	for (let at = 0; at < SIMULATED_STAPLE_BYTES; at += 32) {
		createHash('sha256').update(`staple:${String(id)}:${String(votes)}:${String(at)}`).digest().copy(bytes, at);
	}
	return(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function nameOf(id: number): string {
	return(`staple-${String(id)}`);
}

/** Each simulated staple by its bytes, which a retry queue keeps and decodes. */
const stapleOfBytes = new WeakMap<ArrayBuffer, SimulatedStaple>();

/** The staple of bytes a simulated staple gave. */
export function decodeSimulatedStaple(bytes: ArrayBuffer): SimulatedStaple {
	const staple = stapleOfBytes.get(bytes);
	if (staple === undefined) {
		throw(new Error('no simulated staple has these bytes'));
	}
	return(staple);
}

function simulatedStaple(id: number, moment: number, sequence: number, timestamp: number, needs: readonly number[], stamps: readonly number[], votes = 0): SimulatedStaple {
	const bytes = stapleBytes(id, votes);
	const name = nameOf(id);
	const staple: SimulatedStaple = {
		id,
		moment,
		sequence,
		needs,
		votes: stamps.map(function(stamp) {
			return({ validityFrom: new Date(stamp) });
		}),
		blocksHash: { toString: function(): string {
			return(name);
		} },
		toBytes: function(): ArrayBuffer {
			return(bytes);
		},
		timestamp: function(): Date {
			return(new Date(timestamp));
		}
	};
	stapleOfBytes.set(bytes, staple);
	return(staple);
}

function stampsOf(staple: SimulatedStaple): number[] {
	return(staple.votes.map(function(vote): number {
		return(vote.validityFrom.getTime());
	}));
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
	/**
	 * The most staples the peer reads for a request, those the filter names
	 * included, once it has one to send: one whose time for a request runs
	 * out [Keeta TS] index.js:69639-69647 while it builds and skips the
	 * staples the filter names, as the main network's representatives do.
	 */
	readonly readsAtMost?: number;
	/**
	 * The most staples the filter names that the peer leaves out before it has
	 * one to send, after which what stands in front of it gives up on the
	 * request, as a gateway answering 504 does: the peer runs out of time only
	 * once it has a staple to send [Keeta TS] index.js:69641-69647.
	 */
	readonly givesUpPastNamed?: number;
	/** Moments from and before which what stands in front of the peer gives up on every request from a start between them that carries a filter, however small. */
	readonly givesUpFilteredWithin?: { readonly from: number; readonly to: number };
	/** How the peer keys and lists its staples: by when it applied them, as earlier versions of this node did, unless told otherwise. */
	readonly keying?: SimulatedKeying;
	/** The clock the peer shares with others answering at the same time, unless it answers on the one clock of the test. */
	readonly clock?: ConcurrentClock;
	/** The moment on the node's clock from which the peer, or the way to it, fails every request. */
	readonly failsFrom?: number;
};

/**
 * How many turns of the event loop a pass that was answered takes at most to
 * send its next request: the node's own work between requests waits on
 * nothing else.
 */
const SETTLING_TURNS = 8;

/**
 * Time as peers answering at once see it: each answers one request at a
 * time, on a timeline of its own, and the node hears an answer once the
 * clock reaches its end, after every answer due before it. The clock moves on
 * only once every pass is waiting for an answer, so that passes over several
 * peers side by side take as long as the slowest, as over a network.
 */
export class ConcurrentClock {
	readonly #free = new Map<SimulatedPeer, number>();
	readonly #due: { readonly at: number; readonly order: number; readonly answer: () => void }[] = [];
	#order = 0;
	#moving = false;

	/** Answers the request at the moment the peer is free for it, the work moving the clock on from there as it answers, once the clock reaches where it ended. */
	async serve<Result>(peer: SimulatedPeer, work: () => Result): Promise<Result> {
		const arrived = Date.now();
		freezeClock(new Date(Math.max(arrived, this.#free.get(peer) ?? arrived)));
		const result = work();
		const ends = Date.now();
		freezeClock(new Date(arrived));
		this.#free.set(peer, ends);
		await new Promise<void>((resolve) => {
			this.#due.push({ at: ends, order: this.#order++, answer: resolve });
			this.#moveOn();
		});
		return(result);
	}

	#moveOn(): void {
		if (this.#moving) {
			return;
		}
		this.#moving = true;
		void this.#answerInTurn();
	}

	async #answerInTurn(): Promise<void> {
		while (this.#due.length > 0) {
			for (let turn = 0; turn < SETTLING_TURNS; turn++) {
				await new Promise(setImmediate);
			}
			this.#due.sort(function(left, right): number {
				return(left.at - right.at || left.order - right.order);
			});
			const next = this.#due.shift();
			if (next === undefined) {
				break;
			}
			if (next.at > Date.now()) {
				freezeClock(new Date(next.at));
			}
			next.answer();
		}
		this.#moving = false;
	}
}

/**
 * How a peer finds the staples to list from a start.
 *
 * 'applied': as versions of this node before it keyed votes did, each
 * staple once, at the moment it applied it, in the order applied.
 *
 * 'votes': as the main network's representatives and this node do
 * (src/ledger/storage/memory/driver.ts getVotesAfter), each vote at the moment
 * it was made: the peer reads the votes made at or after the start, in that
 * order, so many at a time, and lists the staple of each vote it read, once
 * per read [Keeta TS] index.js:69655-69676, in no order of its own within a
 * read; a staple whose votes two reads share is listed twice. A read holds
 * so many votes, or, as a representative's storage returns them, up to so
 * many more or fewer. Its time for a request runs out after so many reads,
 * once it has a staple to send [Keeta TS] index.js:69641-69647, and each read
 * takes so long.
 */
export type SimulatedKeying =
	| { readonly kind: 'applied' }
	| { readonly kind: 'votes'; readonly votesPerRead: number; readonly readsAtMost: number; readonly readMilliseconds: number; readonly keyedAt?: VoteKey; readonly readsVaryBy?: number };

/**
 * Where a peer keyed by votes keys a vote of a staple, by its index among
 * the staple's votes: the moment it was made, unless a peer keys it a little
 * off, or, outside what a pass allows, at when it received it.
 */
export type VoteKey = (made: number, staple: number, vote: number) => number;

/** The staples a peer lists for a request, and how many the filter named that it left out before it had one to send. */
type Listing = { readonly staples: SimulatedStaple[]; readonly leftOutFirst: number };

/** A vote as a peer keyed by votes holds it: its key, the moment it was made, and the staple it is in. */
type SimulatedVote = { readonly key: number; readonly made: number; readonly vote: number; readonly staple: SimulatedStaple };

function keyedWhenMade(made: number): number {
	return(made);
}

function compareVotes(left: SimulatedVote, right: SimulatedVote): number {
	if (left.key !== right.key) {
		return(left.key - right.key);
	}
	if (left.staple.id !== right.staple.id) {
		return(left.staple.id - right.staple.id);
	}
	return(left.vote - right.vote);
}

/** When the votes of a staple applied at a moment were made: its four voters' within a second before. */
function stampsBefore(id: number, moment: number): number[] {
	return([moment - 900, moment - 400 - (id * 91) % 300, moment - 150 - (id * 37) % 200, moment]);
}

/** A fixed order of no meaning, as a peer lists the staples of one read. */
function scrambled(id: number, read: number): number {
	return(createHash('sha256').update(`${String(id)}:${String(read)}`).digest().readUInt32BE(0));
}

/** A deterministic source of numbers below 1, so that a scenario runs the same each time. */
export function deterministicRandom(seed: number): () => number {
	let state = seed;
	return(function(): number {
		state = (state * 48271) % 2147483647;
		return(state / 2147483647);
	});
}

/**
 * A representative answering bootstrap pages as this node's API does, or
 * did before it keyed votes: the staples it holds a key at or after the
 * start for (SimulatedKeying), leaving out those the filter names before
 * counting towards the limit [Keeta TS] index.js:69633-69702. The filter travels serialized
 * and is read back with the client's own Bloom functions, as
 * src/api/node.ts does.
 */
export class SimulatedPeer {
	readonly #applied: SimulatedStaple[] = [];
	/** The votes of the staples applied, in the order made, for a peer keyed by votes. */
	readonly #votes: SimulatedVote[] = [];
	readonly #keying: SimulatedKeying;
	readonly #voteKey: VoteKey;
	readonly #clockOffset: number;
	readonly #latency: number;
	readonly #answersAtMost: number;
	readonly #readsAtMost: number;
	readonly #givesUpPastNamed: number;
	readonly #givesUpFilteredWithin: { readonly from: number; readonly to: number } | undefined;
	readonly #clock: ConcurrentClock | undefined;
	readonly #failsFrom: number;
	readonly #filters = new Map<string, BloomFilter>();
	readonly #random = deterministicRandom(7);
	#nextID = 0;
	#nextSequence = 0;
	#live: LiveState | undefined;
	#lateCommits: LateCommits | undefined;
	#forcedFalsePositive: number | undefined;
	#requests = 0;
	#served = 0;
	#gaveUp = 0;

	constructor(options: SimulatedPeerOptions = {}) {
		this.#clockOffset = options.clockOffset ?? 0;
		this.#latency = options.latency ?? 25;
		this.#answersAtMost = options.answersAtMost ?? Number.POSITIVE_INFINITY;
		this.#readsAtMost = options.readsAtMost ?? Number.POSITIVE_INFINITY;
		this.#givesUpPastNamed = options.givesUpPastNamed ?? Number.POSITIVE_INFINITY;
		this.#givesUpFilteredWithin = options.givesUpFilteredWithin;
		this.#clock = options.clock;
		this.#failsFrom = options.failsFrom ?? Number.POSITIVE_INFINITY;
		this.#keying = options.keying ?? { kind: 'applied' };
		this.#voteKey = keyedWhenMade;
		if (this.#keying.kind === 'votes' && this.#keying.keyedAt !== undefined) {
			this.#voteKey = this.#keying.keyedAt;
		}
	}

	/** Every staple the peer has applied, in the order applied. */
	get staples(): readonly SimulatedStaple[] {
		return(this.#applied);
	}

	get requests(): number {
		return(this.#requests);
	}

	/** The requests the peer gave up on. */
	get gaveUp(): number {
		return(this.#gaveUp);
	}

	/** The staples the peer has sent in all, its answers to probes included: what it uploaded. */
	get served(): number {
		return(this.#served);
	}

	/** The peer's clock. */
	now(): number {
		return(Date.now() + this.#clockOffset);
	}

	/** Applies a staple with the timestamp given, at the moment given or now on the peer's clock, which a ledger accepts once it holds those it needs. */
	apply(timestamp: number, moment: number = this.now(), needs: readonly number[] = []): SimulatedStaple {
		return(this.applyVoted(timestamp, moment, needs, stampsBefore(this.#nextID, timestamp)));
	}

	/** Applies a staple whose votes were made at the moments given: under a peer keyed by votes, where it is listed. */
	applyVoted(timestamp: number, moment: number, needs: readonly number[], stamps: readonly number[]): SimulatedStaple {
		return(this.#insert(simulatedStaple(this.#nextID++, moment, this.#nextSequence++, timestamp, needs, stamps)));
	}

	/** Applies, at the moment given on this peer's clock, the staple another peer applied: the same blocks with the same votes. */
	applyAlso(staple: SimulatedStaple, moment: number): SimulatedStaple {
		this.#nextID = Math.max(this.#nextID, staple.id + 1);
		return(this.#insert(simulatedStaple(staple.id, moment, this.#nextSequence++, staple.timestamp().getTime(), staple.needs, stampsOf(staple))));
	}

	#insert(staple: SimulatedStaple): SimulatedStaple {
		let at = this.#applied.length;
		while (at > 0 && compareApplied(this.#applied[at - 1] ?? staple, staple) > 0) {
			at--;
		}
		this.#applied.splice(at, 0, staple);
		stampsOf(staple).forEach((made, vote) => {
			const entry: SimulatedVote = { key: this.#voteKey(made, staple.id, vote), made, vote, staple };
			let place = this.#votes.length;
			while (place > 0 && compareVotes(this.#votes[place - 1] ?? entry, entry) > 0) {
				place--;
			}
			this.#votes.splice(place, 0, entry);
		});
		return(staple);
	}

	/** The same blocks as the staple, with another set of votes on them, as another representative may hold them. */
	otherVotesOn(staple: SimulatedStaple): SimulatedStaple {
		return(simulatedStaple(staple.id, staple.moment, staple.sequence, staple.timestamp().getTime(), staple.needs, stampsOf(staple), 1));
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
		let answer: PassAnswer<SimulatedStaple> | Error;
		const clock = this.#clock;
		if (clock === undefined) {
			answer = this.#answerOrFail(request);
		} else {
			answer = await clock.serve(this, () => {
				return(this.#answerOrFail(request));
			});
		}
		if (answer instanceof Error) {
			throw(answer);
		}
		return(answer);
	}

	/** The answer, or, once the peer fails, the failure, as long after the request as an answer would come. */
	#answerOrFail(request: PassRequest): PassAnswer<SimulatedStaple> | Error {
		if (Date.now() < this.#failsFrom) {
			return(this.#answer(request));
		}
		advanceClock(this.#latency);
		return(new Error(`the peer could not be reached from ${request.start.toISOString()}`));
	}

	#answer(request: PassRequest): PassAnswer<SimulatedStaple> {
		this.#requests++;
		advanceClock(this.#latency);
		this.#catchUpLive();
		this.#commitLate();
		const filter = this.#filterOf(request.bloomFilter);
		const keying = this.#keying;
		let listing: Listing;
		switch (keying.kind) {
			case 'applied':
				listing = this.#listApplied(request, filter);
				break;
			case 'votes':
				listing = this.#listVoted(request, filter, keying);
				break;
			default:
				return(assertNever(keying));
		}
		const stretch = this.#givesUpFilteredWithin;
		const start = request.start.getTime();
		const filteredWithin = stretch !== undefined && request.bloomFilter !== undefined && start >= stretch.from && start < stretch.to;
		if (listing.leftOutFirst > this.#givesUpPastNamed || filteredWithin) {
			this.#gaveUp++;
			return({ kind: 'gave-up', reason: `the peer gave up on a request from ${request.start.toISOString()}` });
		}
		this.#served += listing.staples.length;
		return({ kind: 'page', staples: listing.staples });
	}

	/** The staples of the votes keyed at or after the start, read as a representative reads them, up to the limit, or the peer's own if lower. */
	#listVoted(request: PassRequest, filter: BloomFilter | undefined, keying: SimulatedKeying & { readonly kind: 'votes' }): Listing {
		const staples: SimulatedStaple[] = [];
		let leftOutFirst = 0;
		const start = request.start.getTime();
		const limit = Math.min(request.limit, this.#answersAtMost);
		let at = this.#firstVoteAtOrAfter(start);
		let reads = 0;
		while (staples.length < limit && at < this.#votes.length) {
			// [Keeta TS] index.js:69655-69659
			const vary = keying.readsVaryBy ?? 0;
			const size = Math.min(keying.votesPerRead + scrambled(at, reads) % (2 * vary + 1) - vary, (limit - staples.length) * 32);
			const read = this.#votes.slice(at, at + size);
			const listed = [...new Set(read.map(function(vote): SimulatedStaple {
				return(vote.staple);
			}))].sort(function(left, right): number {
				return(scrambled(left.id, at) - scrambled(right.id, at));
			});
			at += size;
			reads++;
			for (const staple of listed) {
				if (staples.length >= limit) {
					break;
				}
				if (!this.#named(filter, staple)) {
					staples.push(staple);
				} else if (staples.length === 0) {
					leftOutFirst++;
				}
			}
			if (staples.length > 0 && reads >= keying.readsAtMost) {
				break;
			}
		}
		advanceClock(reads * keying.readMilliseconds);
		return({ staples, leftOutFirst });
	}

	#firstVoteAtOrAfter(moment: number): number {
		let low = 0;
		let high = this.#votes.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if ((this.#votes[middle]?.key ?? moment) < moment) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		return(low);
	}

	#listApplied(request: PassRequest, filter: BloomFilter | undefined): Listing {
		const start = request.start.getTime();
		const staples: SimulatedStaple[] = [];
		let leftOutFirst = 0;
		const limit = Math.min(request.limit, this.#answersAtMost);
		let read = 0;
		for (let at = this.#firstAtOrAfter(start); at < this.#applied.length && staples.length < limit; at++) {
			if (read >= this.#readsAtMost && staples.length > 0) {
				break;
			}
			const staple = this.#applied[at];
			if (staple === undefined) {
				break;
			}
			read++;
			if (this.#named(filter, staple)) {
				if (staples.length === 0) {
					leftOutFirst++;
				}
				continue;
			}
			staples.push(staple);
		}
		return({ staples, leftOutFirst });
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

/** The refusal of a staple whose voters lack weight [Keeta TS] index.js:69397-69400. */
export const SIMULATED_WEIGHT_REFUSAL = 'LEDGER_INSUFFICIENT_VOTING_WEIGHT';

/** The refusal of a staple that spends what its account does not hold. */
export const SIMULATED_BALANCE_REFUSAL = 'LEDGER_INVALID_BALANCE';

/**
 * What a simulated node holds: each staple added. As a ledger does, it
 * holds one staple per set of blocks, adds none whose blocks it holds, and
 * refuses one until it holds those it needs: for want of its voters'
 * weight, which the staples it needs give, unless it is one of those that
 * spend a balance they credit. It refuses for want of weight, too, a staple
 * once it holds one that moves weight away from the staple's voters, as the
 * ledger judges a staple by the weight it holds when it is added
 * [Keeta TS] index.js:69761-69779: a staple voted before a delegation moved
 * the weight is refused for good once the delegation is added before it.
 */
export class SimulatedNode {
	readonly #held = new Map<string, PassStaple>();
	readonly #spending: ReadonlySet<number>;
	readonly #outweighedBy: ReadonlyMap<number, readonly number[]>;
	#resent = 0;
	#refused = 0;

	/**
	 * The staples, by ID, refused for a balance rather than for weight while
	 * they lack what they need; and, by ID, the staples whose voters lose the
	 * weight they need to the staples named, by ID.
	 */
	constructor(spending: ReadonlySet<number> = new Set(), outweighedBy: ReadonlyMap<number, readonly number[]> = new Map()) {
		this.#spending = spending;
		this.#outweighedBy = outweighedBy;
	}

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

	/** The offers it refused for want of what the staple needs: each a transaction a ledger rolls back. */
	get refused(): number {
		return(this.#refused);
	}

	/** Adds a staple, which the node must accept. */
	async add(staple: SimulatedStaple): Promise<Added> {
		const offered = await this.offer(staple);
		switch (offered.kind) {
			case 'added':
				return('added');
			case 'refused':
				if (this.holds(staple)) {
					return('held');
				}
				throw(new Error(`the node refused staple ${staple.blocksHash.toString()}: ${offered.code}`));
			default:
				return(assertNever(offered));
		}
	}

	/** Offers a staple as a ledger is offered one: it refuses one whose blocks it holds, and one that needs a staple it lacks. */
	offer(staple: SimulatedStaple): Promise<Offered> {
		const key = staple.blocksHash.toString();
		if (this.#held.has(key)) {
			this.#resent++;
			return(Promise.resolve({ kind: 'refused', code: 'LEDGER_BLOCK_ALREADY_EXISTS' }));
		}
		const lacking = staple.needs.some((id) => {
			return(!this.#held.has(nameOf(id)));
		});
		const outweighed = (this.#outweighedBy.get(staple.id) ?? []).some((id) => {
			return(this.#held.has(nameOf(id)));
		});
		if (outweighed) {
			this.#refused++;
			return(Promise.resolve({ kind: 'refused', code: SIMULATED_WEIGHT_REFUSAL }));
		}
		if (lacking) {
			this.#refused++;
			if (this.#spending.has(staple.id)) {
				return(Promise.resolve({ kind: 'refused', code: SIMULATED_BALANCE_REFUSAL }));
			}
			return(Promise.resolve({ kind: 'refused', code: SIMULATED_WEIGHT_REFUSAL }));
		}
		this.#held.set(key, staple);
		return(Promise.resolve({ kind: 'added', landed: [key] }));
	}

	/** Whether it holds every staple named, as voters whose weight those staples give. */
	weightSuffices(voterSets: readonly (readonly string[])[]): Promise<readonly boolean[]> {
		return(Promise.resolve(voterSets.map((voters): boolean => {
			return(voters.every((voter) => {
				return(this.#held.has(voter));
			}));
		})));
	}

	/**
	 * The staples it holds with a vote made at or after the moment, as many as
	 * asked for, by the earliest such vote, as the node's own catch-up lists
	 * them (src/ledger/storage/memory/driver.ts getVotesAfter), each once.
	 */
	held(from: Date, count: number): Promise<readonly PassStaple[]> {
		const listed: { readonly staple: PassStaple; readonly vote: number }[] = [];
		for (const staple of this.#held.values()) {
			const since = staple.votes.map(function(vote): number {
				return(vote.validityFrom.getTime());
			}).filter(function(stamp): boolean {
				return(stamp >= from.getTime());
			});
			if (since.length > 0) {
				listed.push({ staple, vote: Math.min(...since) });
			}
		}
		listed.sort(function(left, right): number {
			return(left.vote - right.vote);
		});
		return(Promise.resolve(listed.slice(0, count).map(function(entry): PassStaple {
			return(entry.staple);
		})));
	}
}

/** A queue's store that a simulated node keeps in memory, and keeps across the queues built on it, as a restart does. */
export class SimulatedRetryStore implements RetryStore {
	readonly #entries = new Map<string, QueuedStaple>();
	#largest = 0;

	/** The most staples it held at once. */
	get largest(): number {
		return(this.#largest);
	}

	load(): Promise<QueuedStaple[]> {
		return(Promise.resolve([...this.#entries.values()]));
	}

	put(entry: QueuedStaple): Promise<void> {
		this.#entries.set(entry.key, entry);
		this.#largest = Math.max(this.#largest, this.#entries.size);
		return(Promise.resolve());
	}

	remove(key: string): Promise<void> {
		this.#entries.delete(key);
		return(Promise.resolve());
	}
}

/** A staple reported as refused for long, and how long it had been refused. */
export type RefusalReport = { readonly id: number; readonly code: string; readonly age: number };

/** The retry queue a node builds on its ledger, here on a simulated node, recording what it reports. */
export function simulatedRetries(node: SimulatedNode, store: SimulatedRetryStore, reports: RefusalReport[], bounds?: QueueBounds): RetryQueue<SimulatedStaple> {
	return(new RetryQueue<SimulatedStaple>({
		holds: function(staple): Promise<boolean> {
			return(Promise.resolve(node.holds(staple)));
		},
		offer: function(staple): Promise<Offered> {
			return(node.offer(staple));
		},
		decode: decodeSimulatedStaple,
		awaited: function(staple, code): Awaited {
			const needed = staple.needs.map(nameOf);
			if (code === SIMULATED_BALANCE_REFUSAL) {
				return({ kind: 'accounts', accounts: needed });
			}
			return({ kind: 'weight', voters: needed });
		},
		weightSuffices: function(voterSets): Promise<readonly boolean[]> {
			return(node.weightSuffices(voterSets));
		}
	}, store, function(entry, age): void {
		reports.push({ id: decodeSimulatedStaple(entry.bytes).id, code: entry.code, age });
	}, bounds));
}
