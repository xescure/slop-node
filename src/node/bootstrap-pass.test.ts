import { createHash } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BloomFilter } from '@keetanetwork/keetanet-client/lib/utils/bloom.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SimulatedNode, SimulatedPeer } from '../testing/simulated-peer.js';
import type { SimulatedKeying, SimulatedPeerOptions, SimulatedStaple } from '../testing/simulated-peer.js';
import { advanceClock, freezeClock } from '../testing/network.js';
import { assertNever } from '../util/assert-never.js';
import { VOTE_KEY_TOLERANCE_MILLISECONDS } from './bootstrap-evidence.js';
import type { PeerKeying } from './bootstrap-evidence.js';
import { DEEP_SCAN_DEPTH_MILLISECONDS, DEEP_SCAN_PERIOD_MILLISECONDS, LongestAnswer, PageLimit, PrimingWindow, MAX_PASS_MILLISECONDS, MAX_PASS_REQUESTS, bootstrapPeer, bootstrapRange, completes, firstProgress } from './bootstrap-pass.js';
import type { PassAnswer, PassEvent, PassOptions, PassOutcome, PassRequest, PeerIO, PeerOutcome, PeerProgress, RangeSetup } from './bootstrap-pass.js';
import type { QueueUse } from './bootstrap-retry.js';
import { BLOOM_CAPACITY, BLOOM_ERROR_RATE, BOOTSTRAP_MARGIN_MILLISECONDS, MAX_NAMED } from './bootstrap-window.js';

const lib = KeetaNet.lib;

const NOW = Date.UTC(2026, 9, 7, 12);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const EPOCH = new Date(0);

/** The traces of the passes over a range "how much a pass over a range asks of a peer" pins. */
const RANGE_TRACES: Readonly<Record<'votes' | 'unknown' | 'applied', Trace>> = {
	votes: { requests: 4, probes: 0, starts: 2, served: 2000, resent: 1, heldReads: [1200], digest: 167672040477705 },
	unknown: { requests: 4, probes: 0, starts: 2, served: 2000, resent: 1, heldReads: [1200], digest: 167672040477705 },
	applied: { requests: 4, probes: 0, starts: 2, served: 2000, resent: 1, heldReads: [1200], digest: 187298976035100 }
};

/** The traces of the passes "how much a pass asks of a peer" pins. */
const TRACES: Readonly<Record<'applied' | 'held' | 'votes' | 'late' | 'short' | 'votesHeld' | 'crowd' | 'crowdApplied' | 'crowdHeld' | 'crowdVotes' | 'lateVotes' | 'readsOut' | 'lateHeld', Trace>> = {
	applied: { requests: 18, probes: 0, starts: 4, served: 5003, resent: 3, heldReads: [1200], digest: 186180261100999 },
	held: { requests: 4, probes: 0, starts: 3, served: 2004, resent: 2004, heldReads: [1200, 951, 951], digest: 261710530049216 },
	votes: { requests: 12, probes: 0, starts: 3, served: 3002, resent: 2, heldReads: [1200], digest: 61473113644198 },
	late: { requests: 68, probes: 63, starts: 65, served: 4054, resent: 0, heldReads: [1200], digest: 82862574564010 },
	short: { requests: 135, probes: 7, starts: 5, served: 4743, resent: 3, heldReads: [1200], digest: 274051218990136 },
	votesHeld: { requests: 3, probes: 1, starts: 2, served: 10, resent: 10, heldReads: [1200], digest: 239466737070861 },
	crowd: { requests: 52, probes: 43, starts: 44, served: 6132, resent: 2000, heldReads: [1200, 951, 200, 1089], digest: 149205940462783 },
	crowdApplied: { requests: 52, probes: 43, starts: 44, served: 6132, resent: 2000, heldReads: [1200, 951, 200, 1089], digest: 140360043369356 },
	crowdHeld: { requests: 50, probes: 43, starts: 43, served: 4132, resent: 4000, heldReads: [1200, 201, 200, 1089], digest: 224903487159721 },
	crowdVotes: { requests: 10, probes: 2, starts: 4, served: 4304, resent: 1001, heldReads: [1200], digest: 27743548621431 },
	lateVotes: { requests: 8, probes: 0, starts: 5, served: 3004, resent: 4, heldReads: [1200], digest: 174936495550604 },
	readsOut: { requests: 24, probes: 4, starts: 19, served: 5021, resent: 17, heldReads: [1200], digest: 131596033642035 },
	lateHeld: { requests: 71, probes: 67, starts: 69, served: 2857, resent: 300, heldReads: [1200, 951, 1040], digest: 263339953179791 }
};

/** Passes whose filters take seeds from a fixed sequence, so that each run names the same staples by mistake. */
function passOptions(limit: number): PassOptions {
	let state = 1;
	return({ limit, seed: function(): number {
		state = (state * 48271) % 2147483647;
		return(state);
	} });
}

/** The outcome of an update with no deep re-scan under way. */
function liveOnly(live: PeerOutcome['live']): PeerOutcome {
	return({ live, deepScan: undefined });
}

type Recorded = PassRequest & { readonly served: number };

/** A pass's view of a peer and a node, recording each request and the progress written. */
class Harness {
	readonly node = new SimulatedNode();
	readonly requests: Recorded[] = [];
	readonly written: PeerProgress[] = [];
	readonly heldFrom: number[] = [];
	/** How many staples each read of what the node holds asked for. */
	readonly heldCounts: number[] = [];
	/** The use of each staple added, in order. */
	readonly uses: QueueUse[] = [];
	retries = 0;
	readonly events: PassEvent[] = [];
	readonly answers = new LongestAnswer();
	/** As wide as a filter, so that what a pass names of what the node holds is not cut short by the window the peer is read with. */
	priming = new PrimingWindow(BLOOM_CAPACITY);
	readonly pageLimit = new PageLimit(1000);
	progress: PeerProgress | undefined;
	readonly #answer: (request: PassRequest) => Promise<PassAnswer<SimulatedStaple>>;

	constructor(answer: (request: PassRequest) => Promise<PassAnswer<SimulatedStaple>>) {
		this.#answer = answer;
	}

	get io(): PeerIO<SimulatedStaple> {
		return({
			answers: this.answers,
			priming: this.priming,
			pageLimit: this.pageLimit,
			page: async (request) => {
				const answer = await this.#answer(request);
				let served = 0;
				if (answer.kind === 'page') {
					served = answer.staples.length;
				}
				this.requests.push({ ...request, served });
				return(answer);
			},
			held: (from, count) => {
				this.heldFrom.push(from.getTime());
				this.heldCounts.push(count);
				return(this.node.held(from, count));
			},
			add: (staple, use) => {
				this.uses.push(use);
				return(this.node.add(staple));
			},
			retry: () => {
				this.retries++;
				return(Promise.resolve());
			},
			saturated: function() {
				return(Promise.resolve(false));
			},
			report: (event) => {
				this.events.push(event);
			},
			readProgress: () => {
				return(Promise.resolve(this.progress));
			},
			writeProgress: (progress) => {
				this.progress = progress;
				this.written.push(progress);
				return(Promise.resolve());
			}
		});
	}

	/** The requests for pages, leaving out the probes for a single staple. */
	pages(): Recorded[] {
		return(this.requests.filter(function(request): boolean {
			return(request.limit > 1);
		}));
	}

	/** The starts asked from, each once, in the order first asked. */
	starts(): number[] {
		return([...new Set(this.requests.map(function(request): number {
			return(request.start.getTime());
		}))]);
	}
}

/** A peer that applied that many staples, one a second up to now. */
function peerWith(count: number, options: SimulatedPeerOptions = {}): SimulatedPeer {
	const peer = new SimulatedPeer(options);
	for (let index = 0; index < count; index++) {
		const madeAt = NOW - (count - index) * SECOND;
		peer.apply(madeAt, madeAt);
	}
	return(peer);
}

/** The staples of those given that the peer applied before the moment and the node neither holds nor has queued: those a pass that reached the moment lost. */
function lostBefore(staples: readonly SimulatedStaple[], harness: Harness, at: number): number[] {
	return(staples.filter(function(staple): boolean {
		return(staple.moment < at && !harness.node.holds(staple));
	}).map(function(staple): number {
		return(staple.id);
	}));
}

/**
 * That the node holds or has queued every staple the peer applied before
 * where the pass recorded it reached, and every staple the pass's outcome
 * claims: up to its horizon once it caught up, and all the peer applied
 * before it began once it drained the peer.
 */
function expectNoLoss(peer: SimulatedPeer, harness: Harness, live: PassOutcome): void {
	expect(lostBefore(peer.staples, harness, harness.progress?.reached.getTime() ?? NOW)).toEqual([]);
	let claimed = Number.NEGATIVE_INFINITY;
	switch (live.kind) {
		case 'drained':
			claimed = NOW;
			break;
		case 'caught-up':
			claimed = NOW - BOOTSTRAP_MARGIN_MILLISECONDS;
			break;
		case 'bounded':
			break;
		default:
			assertNever(live);
	}
	expect(lostBefore(peer.staples, harness, claimed)).toEqual([]);
}

/** A peer keyed by votes that answers at most 100 staples a request, with 2000 staples from two hours ago, 3 s apart, each voted on twice within the 300 ms before it. */
function shortVotedPeer(): SimulatedPeer {
	const peer = new SimulatedPeer({ answersAtMost: 100, keying: { kind: 'votes', votesPerRead: 200, readsAtMost: Number.POSITIVE_INFINITY, readMilliseconds: 0 } });
	for (let index = 0; index < 2000; index++) {
		const at = NOW - 2 * HOUR + index * 3 * SECOND;
		peer.applyVoted(at, at, [], [at - 300, at]);
	}
	return(peer);
}

/**
 * A peer keyed by votes that lists 40 votes a request, with 2000 staples from
 * an hour ago, 100 ms apart, each voted on four times within the 300 ms before
 * it, as a main network representative's dense history is; passes start
 * from an hour before them, from a peer known to key votes.
 */
function denseVotedPeer(): { peer: SimulatedPeer; first: number } {
	const peer = new SimulatedPeer({ keying: { kind: 'votes', votesPerRead: 20, readsAtMost: 2, readMilliseconds: 0 } });
	for (let index = 0; index < 2000; index++) {
		const at = NOW - HOUR + index * 100;
		peer.applyVoted(at, at, [], [at - 300, at - 200, at - 100, at]);
	}
	return({ peer, first: NOW - 2 * HOUR });
}

function pageOf(staples: readonly SimulatedStaple[]): Promise<PassAnswer<SimulatedStaple>> {
	return(Promise.resolve({ kind: 'page', staples }));
}

describe('a pass over a peer', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('asks again from the same start, naming what it was sent, until a page comes back empty', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(1200);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		expect(await bootstrapPeer(harness.io, passOptions(500))).toEqual(liveOnly({ kind: 'drained' }));

		expect(harness.requests.map(function(request) {
			return([request.start.getTime(), request.limit, request.bloomFilter !== undefined, request.served]);
		})).toEqual([[0, 500, false, 500], [0, 500, true, 500], [0, 500, true, 200], [0, 500, true, 0]]);
		expect(harness.node.size).toBe(1200);
	});

	test.each([['caps the limit', 300], ['runs out of time for a request', 37]])('holds every staple of a peer that %s, whose short pages are not the end', async function(_ignored: string, answersAtMost: number) {
		// Every staple precedes the horizon, so that only an empty page ends the pass.
		freezeClock(new Date(NOW + BOOTSTRAP_MARGIN_MILLISECONDS));
		const peer = peerWith(5000, { answersAtMost });
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'drained' }));

		expect(harness.node.size).toBe(5000);
		expect(harness.requests.at(-1)?.served).toBe(0);
	});

	test('moves its start on only to a moment it has proven the node holds every staple before', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(5000);
		const starts: number[] = [];
		const harness = new Harness(function(request) {
			if (request.limit > 1 && request.start.getTime() !== starts.at(-1)) {
				starts.push(request.start.getTime());
				const lacking = peer.staples.filter(function(staple): boolean {
					return(staple.moment < request.start.getTime() && !harness.node.holds(staple));
				});
				expect(lacking).toEqual([]);
			}
			return(peer.page(request));
		});

		expect(completes((await bootstrapPeer(harness.io, passOptions(300))).live)).toBe(true);

		expect(starts.length).toBeGreaterThan(2);
		expect(harness.node.size).toBe(5000);
	});

	test('names again what the node holds from each start it moves to, once a page repeated staples it held', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(5000);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		for (const staple of peer.staples) {
			freezeClock(new Date(staple.moment));
			await harness.node.add(staple);
		}
		freezeClock(new Date(NOW));

		expect(completes((await bootstrapPeer(harness.io, passOptions(1000))).live)).toBe(true);

		const moves = harness.written.map(function(progress): number {
			return(progress.reached.getTime());
		}).filter(function(reached): boolean {
			return(reached > 0);
		});
		expect(moves.length).toBeGreaterThan(1);
		expect(harness.heldFrom[0]).toBe(0);
		// A move recorded at the margin before the pass began went further, to where the node's clock and the peer's agree.
		for (const move of moves.filter(function(reached): boolean {
			return(reached < NOW - BOOTSTRAP_MARGIN_MILLISECONDS);
		})) {
			expect(harness.heldFrom).toContain(move);
		}
		// Of the 5000 staples the node held, the peer sent fewer than half again.
		expect(harness.node.resent).toBeLessThan(2500);
	});

	test.each([
		{ name: 'when it applied them', keying: { kind: 'applied' } },
		{ name: 'their votes', keying: { kind: 'votes', votesPerRead: 20, readsAtMost: 10, readMilliseconds: 450 } }
	] satisfies readonly { readonly name: string; readonly keying: SimulatedKeying }[])('names first, catching up, what the node holds with a vote made from where the last pass reached, which a peer keying staples by $name would send again', async function({ keying }) {
		freezeClock(new Date(NOW));
		// A year of history, which the node takes long after the peer applied it, from a peer whose time for a request runs out.
		const peer = new SimulatedPeer({ latency: 5 * SECOND, readsAtMost: 150, keying });
		for (let index = 0; index < 20_000; index++) {
			const madeAt = NOW - 365 * 24 * HOUR + index * 10 * SECOND;
			peer.apply(madeAt, madeAt);
		}
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		expect((await bootstrapPeer(harness.io, passOptions(1000))).live.kind).toBe('bounded');
		const reached = harness.progress?.reached.getTime();
		const resent = harness.node.resent;
		const before = harness.requests.length;
		const heldBefore = harness.heldFrom.length;
		expect((await bootstrapPeer(harness.io, passOptions(1000))).live.kind).toBe('bounded');
		expect(harness.heldFrom[heldBefore]).toBe(reached);
		// One a page at most, the staple that shows the move, where the peer sent 169 again when the node named the staples it took since it first asked from there by its own clock.
		const pages = harness.requests.slice(before).filter(function(request): boolean {
			return(request.limit > 1);
		});
		expect(harness.node.resent - resent).toBeLessThanOrEqual(pages.length);
	});

	test.each([1, 2, 3, 4, 5])('passes more staples at one moment than a filter and a page hold, checking with further filters before it concludes it holds them all (seed %i)', async function(seed: number) {
		freezeClock(new Date(NOW));
		const peer = new SimulatedPeer();
		const moment = NOW - MINUTE;
		// Made over the hour before, and released at once, as deferred staples are.
		for (let index = 0; index < 2500; index++) {
			peer.apply(moment - HOUR + index, moment);
		}
		for (let index = 0; index < 500; index++) {
			peer.apply(moment + 1 + index * 10, moment + 1 + index * 10);
		}
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		let state = seed;

		const { live } = await bootstrapPeer(harness.io, { limit: 1000, seed: function(): number {
			state = (state * 48271) % 2147483647;
			return(state);
		} });

		expect(completes(live)).toBe(true);
		expect(harness.node.size).toBe(3000);
		// The last start before the crowded moment, from which the pass reads the crowd, and then, once it names it all, checks with further filters before it moves past it.
		const pages = harness.pages();
		const crowdStart = Math.max(...pages.map(function(request): number {
			return(request.start.getTime());
		}).filter(function(start): boolean {
			return(start <= moment);
		}));
		const checks = pages.filter(function(request): boolean {
			return(request.start.getTime() === crowdStart && request.served < 1000);
		});
		expect(checks.length).toBeGreaterThan(0);
		expect(pages.some(function(request): boolean {
			return(request.start.getTime() > moment);
		})).toBe(true);
	});

	test('moves past more staples at one moment than a filter and a page hold, once a page reaches past them, before it names too many to go on', async function() {
		freezeClock(new Date(NOW));
		const peer = new SimulatedPeer();
		const moment = NOW - HOUR;
		// Made over the hour before, and released at once, as deferred staples are.
		for (let index = 0; index < 2500; index++) {
			peer.apply(moment - HOUR + index, moment);
		}
		for (let index = 0; index < MAX_NAMED; index++) {
			peer.apply(moment + 1 + index * 10, moment + 1 + index * 10);
		}
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		const outcome = await bootstrapPeer(harness.io, passOptions(1000));
		expect(completes(outcome.live)).toBe(true);

		expect(harness.node.size).toBe(2500 + MAX_NAMED);
		expect(harness.pages().some(function(request): boolean {
			return(request.start.getTime() > moment);
		})).toBe(true);
	});

	/*
	 * A peer keyed by votes lists the staples of a read in no order, so the
	 * staple it lists first from a moment says nothing of those before it; a
	 * pass that knows the peer is keyed so checks the move past the moment
	 * by the page's votes alone.
	 */
	test('passes more staples at one moment than a filter and a page hold on a peer keyed by votes that keeps applying staples', async function() {
		freezeClock(new Date(NOW));
		// Reads of 200 votes split the four votes of staples made close together, which the peer then lists twice in a page.
		const peer = new SimulatedPeer({ keying: { kind: 'votes', votesPerRead: 200, readsAtMost: Number.POSITIVE_INFINITY, readMilliseconds: 0 } });
		const moment = NOW - HOUR;
		function voted(at: number): readonly number[] {
			return([at - 300, at - 200, at - 100, at]);
		}
		for (let index = 0; index < 500; index++) {
			const at = moment - HOUR + index * SECOND;
			peer.applyVoted(at, at, [], voted(at));
		}
		for (let index = 0; index < 2500; index++) {
			peer.applyVoted(moment, moment, [], [moment, moment, moment, moment]);
		}
		for (let index = 0; index < 2000; index++) {
			const at = moment + SECOND + index * 10;
			peer.applyVoted(at, at, [], voted(at));
		}
		peer.goLive({ perSecond: 20, voterSkew: function(): number {
			return(0);
		} });
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(live).toEqual({ kind: 'caught-up' });
		expect(harness.progress?.keying).toBe('votes');
		// The first check of the move past the moment holds: it took 20 requests, two failed checks among them, when the staple listed first had to match too.
		expect(harness.requests.length).toBeLessThanOrEqual(12);
		// Named from the staple the peer lists first from each start the pass moves to, what the node holds is sent again only where reads split votes: a thousand more without them.
		expect(harness.node.resent).toBeLessThanOrEqual(1623);
		expect(peer.staples.filter(function(staple): boolean {
			return(staple.moment < NOW - BOOTSTRAP_MARGIN_MILLISECONDS && !harness.node.holds(staple));
		})).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	test('takes a staple on blocks the node holds with other votes as held, and names those votes from then on', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(10);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		const [first] = peer.staples;
		if (first === undefined) {
			throw(new Error('the peer holds no staple'));
		}
		await harness.node.add(peer.otherVotesOn(first));

		expect(await bootstrapPeer(harness.io, passOptions(4))).toEqual(liveOnly({ kind: 'drained' }));

		expect(harness.node.size).toBe(10);
		expect(harness.node.resent).toBe(1);
		expect(harness.requests.reduce(function(sum, request): number {
			return(sum + request.served);
		}, 0)).toBe(10);
	});

	test('ends the pass with an error once the peer sends a staple its filter named', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(3);
		const harness = new Harness(function(request) {
			return(peer.page({ ...request, bloomFilter: undefined }));
		});

		await expect(bootstrapPeer(harness.io, passOptions(2))).rejects.toThrow('which the filter named');

		expect(harness.requests.map(function(request): number {
			return(request.served);
		})).toEqual([2, 2]);
		expect(harness.progress?.caughtUp).toBe(false);
	});

	test('ends caught up on a peer that keeps applying staples, once a page reaches the margin before the pass began', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(500, { latency: 25 });
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		for (const staple of peer.staples) {
			await harness.node.add(staple);
		}
		peer.goLive({ perSecond: 100, voterSkew: function(): number {
			return(0);
		} });

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'caught-up' }));

		const before = peer.staples.filter(function(staple): boolean {
			return(staple.moment < NOW);
		});
		expect(before.every(function(staple): boolean {
			return(harness.node.holds(staple));
		})).toBe(true);
		// A few seconds, while the peer applied a hundred staples a second.
		expect(Date.now() - NOW).toBeLessThan(5 * SECOND);
	});

	test('asks for half as many staples whenever an answer is too large', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(300);
		const harness = new Harness(function(request) {
			if (request.limit > 250) {
				return(Promise.resolve({ kind: 'too-large' }));
			}
			return(peer.page(request));
		});

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'drained' }));

		expect(harness.pages().map(function(request): number {
			return(request.limit);
		})).toEqual([1000, 500, 250, 250, 250]);
		expect(harness.node.size).toBe(300);
	});

	test('fails when even a single staple is too large', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness(function() {
			return(Promise.resolve({ kind: 'too-large' }));
		});

		await expect(bootstrapPeer(harness.io, passOptions(4))).rejects.toThrow('larger than a page may be');

		expect(harness.requests.map(function(request): number {
			return(request.limit);
		})).toEqual([4, 2, 1]);
	});

	test('ends at its time bound against a peer it cannot drain, and records how far it reached', async function() {
		freezeClock(new Date(NOW));
		const endless = new SimulatedPeer();
		// Every page is full of staples never sent before, and no probe finds one of them.
		const harness = new Harness(function(request) {
			advanceClock(MINUTE);
			const staples = Array.from({ length: request.limit }, function(): SimulatedStaple {
				return(endless.apply(NOW, NOW));
			});
			return(pageOf(staples));
		});

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'bounded', reached: EPOCH }));

		expect(harness.requests.length).toBeLessThanOrEqual(MAX_PASS_MILLISECONDS / MINUTE + 1);
		expect(harness.progress).toEqual({ reached: EPOCH, caughtUp: false, deepScanFrom: EPOCH, nextDeepScan: new Date(NOW + DEEP_SCAN_PERIOD_MILLISECONDS), deepScan: undefined, keying: 'unknown' });
	});

	test('records, once it drains the peer, that the next pass starts the margin before this one began', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(10);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		await bootstrapPeer(harness.io, passOptions(1000));
		advanceClock(MINUTE);
		await bootstrapPeer(harness.io, passOptions(1000));

		const firstFloor = new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS);
		expect(harness.requests[2]?.start).toEqual(firstFloor);
		expect(harness.progress).toEqual({ reached: new Date(NOW + 50 + MINUTE - BOOTSTRAP_MARGIN_MILLISECONDS), caughtUp: true, deepScanFrom: EPOCH, nextDeepScan: new Date(NOW + DEEP_SCAN_PERIOD_MILLISECONDS), deepScan: undefined, keying: 'unknown' });
	});
});

describe('the staples a pass names ahead of its start', function() {
	test('halve each time the peer gives up, down to a floor, then go without a filter until a pass completes, and grow by passes', function() {
		const window = new PrimingWindow();
		const given: string[] = [];
		for (let gaveUp = 0; gaveUp < 5; gaveUp++) {
			given.push(`${window.gaveUp()} ${String(window.size)}`);
		}
		expect(given).toEqual(['halved 64', 'halved 32', 'halved 16', 'halved 8', 'unfiltered 8']);
		expect(window.unfiltered).toBe(true);

		window.passed(false);
		expect([window.unfiltered, window.size]).toEqual([true, 8]);
		window.passed(true);
		expect([window.unfiltered, window.size]).toEqual([false, 8]);
		window.passed(false);
		window.passed(true);
		expect(window.size).toBe(24);
		for (let pass = 0; pass < 20; pass++) {
			window.passed(false);
		}
		expect(window.size).toBe(128);
	});
});

describe('the staples a pass asks for in a page', function() {
	test('start where answers last fitted after one was too large, and grow by passes none was too large in, up to the cap', function() {
		const limit = new PageLimit(1000);
		limit.tooLarge();
		limit.answered(1);
		expect(limit.size).toBe(1000);
		limit.answered(32);
		limit.answered(500);
		expect(limit.size).toBe(32);
		limit.passed();
		expect(limit.size).toBe(32);
		limit.passed();
		limit.passed();
		expect(limit.size).toBe(96);
		limit.answered(64);
		expect(limit.size).toBe(96);
		for (let pass = 0; pass < 40; pass++) {
			limit.passed();
		}
		expect(limit.size).toBe(1000);
	});

	/*
	 * Every answer of more than 100 staples is too large. The first pass ends
	 * at its time bound within the history; the second reads the rest of it.
	 */
	test('start, after a pass that asked for fewer, where that pass found pages fit, and regrow after passes that found none too large', async function() {
		freezeClock(new Date(NOW));
		const { peer, first } = denseVotedPeer();
		let pass = 0;
		const limits: number[][] = [];
		const harness = new Harness(function(request) {
			if (request.limit > 1) {
				limits[pass]?.push(request.limit);
			}
			if (pass === 0 && harness.requests.length === 30) {
				advanceClock(MAX_PASS_MILLISECONDS);
			}
			if (request.limit > 100) {
				return(Promise.resolve({ kind: 'too-large' }));
			}
			return(peer.page(request));
		});
		harness.progress = { ...firstProgress(NOW, 0, new Date(first)), keying: 'votes' };
		const outcomes: PassOutcome[] = [];
		for (; pass < 4; pass++) {
			limits.push([]);
			outcomes.push((await bootstrapPeer(harness.io, passOptions(1000))).live);
		}

		expect(outcomes[0]?.kind).toBe('bounded');
		expect(limits[0]?.slice(0, 5)).toEqual([1000, 500, 250, 125, 63]);
		// The second reads on through the history, its moves included, at the limit the first ended at.
		expect(completes(outcomes[1] ?? { kind: 'bounded', reached: EPOCH })).toBe(true);
		expect(new Set(limits[1])).toEqual(new Set([63]));
		expect(limits[1]?.length).toBeGreaterThan(10);
		expect(harness.node.size).toBe(2000);
		expect(limits[2]?.[0]).toBe(95);
		expect(limits[3]?.slice(0, 2)).toEqual([127, 64]);
	});
});

describe('deep re-scans of a peer', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	const caughtUp: PeerProgress = { reached: new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS), caughtUp: true, deepScanFrom: new Date(NOW - 2 * DEEP_SCAN_DEPTH_MILLISECONDS), nextDeepScan: new Date(NOW), deepScan: undefined, keying: 'unknown' };

	test('begin once due, from where the passes since the last began started, alongside the pass from where it reached', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(10);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		harness.progress = caughtUp;

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual({ live: { kind: 'drained' }, deepScan: { kind: 'drained' } });

		expect(harness.starts().sort()).toEqual([caughtUp.deepScanFrom.getTime(), caughtUp.reached.getTime()].sort());
		expect(harness.written[0]).toEqual({ ...caughtUp, deepScanFrom: caughtUp.reached, nextDeepScan: new Date(NOW + DEEP_SCAN_PERIOD_MILLISECONDS), deepScan: { reached: caughtUp.deepScanFrom, horizon: new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS) } });
		expect(harness.progress).toMatchObject({ caughtUp: true, deepScanFrom: caughtUp.reached, deepScan: undefined });
	});

	test('complete only once the node holds every staple before their horizon, from a peer keyed by votes that answers short pages', async function() {
		freezeClock(new Date(NOW));
		const peer = shortVotedPeer();
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		const horizon = NOW - HOUR;
		harness.progress = { ...caughtUp, keying: 'votes', nextDeepScan: new Date(NOW + HOUR), deepScan: { reached: new Date(NOW - 3 * HOUR), horizon: new Date(horizon) } };

		const { deepScan } = await bootstrapPeer(harness.io, passOptions(500));

		expect(['drained', 'caught-up']).toContain(deepScan?.kind);
		expect(lostBefore(peer.staples, harness, horizon)).toEqual([]);
	});

	test('begin at least the depth back', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(10);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		harness.progress = { ...caughtUp, deepScanFrom: caughtUp.reached };

		await bootstrapPeer(harness.io, passOptions(1000));

		expect(harness.written[0]?.deepScan?.reached).toEqual(new Date(NOW - DEEP_SCAN_DEPTH_MILLISECONDS));
	});

	test.each([['before they are due', { nextDeepScan: new Date(NOW + 1) }], ['while the node has not caught up on the peer', { caughtUp: false }]])('do not begin %s', async function(_ignored: string, change: Partial<PeerProgress>) {
		freezeClock(new Date(NOW));
		const peer = peerWith(10);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		harness.progress = { ...caughtUp, ...change };

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'drained' }));

		expect(harness.starts()).toEqual([caughtUp.reached.getTime()]);
	});

	test('read on from where they reached, recording how far, up to their horizon', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(8000);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		const horizon = new Date(NOW - 4000 * SECOND);
		harness.progress = { ...caughtUp, nextDeepScan: new Date(NOW + DEEP_SCAN_PERIOD_MILLISECONDS), deepScan: { reached: EPOCH, horizon } };
		for (const staple of peer.staples) {
			await harness.node.add(staple);
		}

		const outcome = await bootstrapPeer(harness.io, passOptions(1000));

		expect(outcome.deepScan !== undefined && completes(outcome.deepScan)).toBe(true);
		expect(harness.written.at(-1)?.deepScan).toBeUndefined();
		const deepStarts = harness.written.flatMap(function(progress): number[] {
			if (progress.deepScan === undefined) {
				return([]);
			}
			return([progress.deepScan.reached.getTime()]);
		});
		expect(new Set(deepStarts).size).toBeGreaterThan(2);
	});
});

describe('a pass at the edges of what a peer answers', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	function gaveUp(): Promise<PassAnswer<SimulatedStaple>> {
		return(Promise.resolve({ kind: 'gave-up', reason: 'the gateway gave up' }));
	}

	test('fails when the peer gives up on a request that carried no filter, which naming fewer cannot help', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness(gaveUp);

		await expect(bootstrapPeer(harness.io, passOptions(10))).rejects.toThrow(new Error('the gateway gave up, though it carried no filter'));
	});

	test('halves the staples it names ahead of its start, and fails, when the peer gives up on a request that carried a filter', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(3);
		const harness = new Harness(function(request) {
			if (request.bloomFilter !== undefined) {
				return(gaveUp());
			}
			return(peer.page(request));
		});

		await expect(bootstrapPeer(harness.io, passOptions(1000))).rejects.toThrow(new Error(`the gateway gave up; the next pass names at most ${String(BLOOM_CAPACITY / 2)} staples the node holds ahead of its start`));

		expect(harness.priming.size).toBe(BLOOM_CAPACITY / 2);
	});

	test('asks again with no filter once the window is at its floor, and from then on, until a pass completes', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(3);
		const harness = new Harness(function(request) {
			if (request.bloomFilter !== undefined) {
				return(gaveUp());
			}
			return(peer.page(request));
		});
		harness.priming = new PrimingWindow(8);

		await bootstrapPeer(harness.io, passOptions(1000));

		expect(harness.node.size).toBe(3);
		const [first, givenUp, resent] = harness.requests;
		expect([first?.bloomFilter, givenUp?.bloomFilter === undefined, resent?.bloomFilter]).toEqual([undefined, false, undefined]);
		expect(resent).toMatchObject({ start: givenUp?.start, limit: givenUp?.limit });
		// Every page asked for from then on carries no filter.
		expect(harness.pages().slice(2).every(function(request): boolean {
			return(request.bloomFilter === undefined);
		})).toBe(true);
	});

	test('moves on read with no filter as far as its pages show it reached, from a peer it knows keys by when it applied them', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(3000);
		const harness = new Harness(function(request) {
			if (request.bloomFilter !== undefined) {
				return(gaveUp());
			}
			return(peer.page(request));
		});
		harness.priming = new PrimingWindow(8);
		harness.priming.gaveUp();
		harness.progress = { ...firstProgress(NOW, 0, EPOCH), keying: 'applied' };

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(completes(live)).toBe(true);
		expect(harness.node.size).toBe(3000);
		expect(harness.starts().length).toBeGreaterThan(2);
	});

	test('reports a peer it learns keys votes late', async function() {
		freezeClock(new Date(NOW));
		const twice = new SimulatedPeer().apply(NOW - HOUR, NOW - HOUR);
		const harness = new Harness(function(request) {
			if (request.limit === 1) {
				return(pageOf([]));
			}
			// Listed twice, as only a peer keyed by votes does, though made long before the start.
			return(pageOf([twice, twice]));
		});
		harness.progress = { reached: new Date(NOW - 10 * MINUTE), caughtUp: true, deepScanFrom: new Date(NOW - 10 * MINUTE), nextDeepScan: new Date(NOW + HOUR), deepScan: undefined, keying: 'unknown' };

		await bootstrapPeer(harness.io, passOptions(1000)).catch(function(): void {
			// The peer sends the staple again, which the filter named; what matters is what it learnt first.
		});

		expect(harness.events).toEqual([{ kind: 'late-votes', start: new Date(NOW - 10 * MINUTE), staple: twice.blocksHash.toString() }]);
		expect(harness.progress.keying).toBe('late-votes');
	});

	test('ends caught up with no request once it has reached the moment it began', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness(function(request) {
			return(peerWith(1).page(request));
		});
		harness.progress = { reached: new Date(NOW), caughtUp: true, deepScanFrom: new Date(NOW), nextDeepScan: new Date(NOW + HOUR), deepScan: undefined, keying: 'unknown' };

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'caught-up' }));

		expect(harness.requests).toEqual([]);
	});

	test('ends at its bound in requests against a peer it cannot drain', async function() {
		freezeClock(new Date(NOW));
		const endless = new SimulatedPeer();
		const harness = new Harness(function(request) {
			return(pageOf(Array.from({ length: request.limit }, function(): SimulatedStaple {
				return(endless.apply(NOW, NOW));
			})));
		});
		// Read with no filter, which a peer that gave up leaves it, each request costs the pass little.
		harness.priming = new PrimingWindow(8);
		harness.priming.gaveUp();

		expect((await bootstrapPeer(harness.io, passOptions(2))).live).toEqual({ kind: 'bounded', reached: EPOCH });

		expect(harness.requests).toHaveLength(MAX_PASS_REQUESTS);
	});

	test('offers again what the ledger refused after each page that added a staple, and once the pass ends', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(4);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		await bootstrapPeer(harness.io, passOptions(2));

		const adding = harness.requests.filter(function(request): boolean {
			return(request.served > 0);
		});
		expect(harness.retries).toBe(adding.length + 1);
	});

	test('adds what a pass from where the last reached is sent for the live share of the queue, and what a deep re-scan is sent for its own', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(2);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		harness.progress = { reached: new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS), caughtUp: true, deepScanFrom: EPOCH, nextDeepScan: new Date(NOW + HOUR), deepScan: { reached: EPOCH, horizon: new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS) }, keying: 'unknown' };

		await bootstrapPeer(harness.io, passOptions(1000));

		expect(new Set(harness.uses)).toEqual(new Set(['live', 'deep']));
		expect(harness.uses.filter(function(use): boolean {
			return(use === 'deep');
		})).toHaveLength(2);
	});

	test('fails with what failed the deep re-scan, or the retry it ends with, as an error, having recorded what each pass reached', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(2);
		const deepFrom = new Date(NOW - 2 * HOUR);
		// What fails the deep re-scan is no Error.
		const failed = vi.fn<() => Promise<PassAnswer<SimulatedStaple>>>().mockRejectedValue('the deep re-scan failed');
		const failing = new Harness(function(request) {
			if (request.start.getTime() === deepFrom.getTime()) {
				return(failed());
			}
			return(peer.page(request));
		});
		failing.progress = { reached: new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS), caughtUp: true, deepScanFrom: EPOCH, nextDeepScan: new Date(NOW + HOUR), deepScan: { reached: deepFrom, horizon: new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS) }, keying: 'unknown' };

		await expect(bootstrapPeer(failing.io, passOptions(1000))).rejects.toThrow(new Error('the deep re-scan failed'));
		expect(failing.progress.deepScan).toEqual({ reached: deepFrom, horizon: new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS) });

		const retrying = new Harness(function(request) {
			return(peer.page(request));
		});
		const io = retrying.io;
		await expect(bootstrapPeer({ ...io, retry: function(): Promise<void> {
			return(Promise.reject(new Error('the retry failed')));
		} }, passOptions(1000))).rejects.toThrow('the retry failed');
	});

	test('keeps a deep re-scan that reached its bound under way, and widens the window after a pass the peer did not give up on', async function() {
		freezeClock(new Date(NOW));
		const deepFrom = new Date(NOW - 2 * HOUR);
		const endless = new SimulatedPeer();
		const peer = peerWith(2);
		const harness = new Harness(function(request) {
			if (request.start.getTime() < NOW - BOOTSTRAP_MARGIN_MILLISECONDS - HOUR / 2) {
				advanceClock(MINUTE);
				return(pageOf(Array.from({ length: request.limit }, function(): SimulatedStaple {
					return(endless.apply(NOW - HOUR, NOW - HOUR));
				})));
			}
			return(peer.page(request));
		});
		harness.priming = new PrimingWindow(64);
		harness.priming.gaveUp();
		harness.progress = { reached: new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS), caughtUp: true, deepScanFrom: EPOCH, nextDeepScan: new Date(NOW + HOUR), deepScan: { reached: deepFrom, horizon: new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS) }, keying: 'unknown' };

		const outcome = await bootstrapPeer(harness.io, passOptions(1000));

		expect(outcome.deepScan?.kind).toBe('bounded');
		expect(harness.progress.deepScan).toBeDefined();
		expect(harness.priming.size).toBe(40);
	});
});

describe('a pass that must find how far its pages reached', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	/*
	 * A peer keyed by when it applied them that applied, an hour ago, a month
	 * of history: the votes of a page show no moment past its start, so the
	 * pass probes for one, galloping and then bisecting.
	 */
	test('probes for a moment each page is shown to have read up to, and moves its start there, holding every staple', async function() {
		freezeClock(new Date(NOW));
		const peer = new SimulatedPeer();
		const count = 3000;
		for (let index = 0; index < count; index++) {
			peer.apply(NOW - 30 * DAY + index * Math.floor(30 * DAY / count), NOW - HOUR + Math.floor(index / 20));
		}
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(completes(live)).toBe(true);
		expect(harness.node.size).toBe(count);
		const probes = harness.requests.filter(function(request): boolean {
			return(request.limit === 1 && request.start.getTime() < NOW - HOUR + count);
		});
		expect(probes.length).toBeGreaterThan(2);
		// Every start a page is asked from was shown to be read up to.
		const starts = harness.starts();
		for (const start of starts) {
			expect(peer.staples.filter(function(staple): boolean {
				return(staple.moment < start && !harness.node.holds(staple));
			})).toEqual([]);
		}
		expect(starts.length).toBeGreaterThan(2);
	});

	/*
	 * A peer keyed by when it applied them that applied, over the last hours,
	 * staples whose votes were made a month ago: no page shows how far it
	 * read, so each move is found by probes, which the pass sends first as far
	 * on from the start as its last move took it, doubling the distance until
	 * a probe reaches past the page.
	 */
	test('probes first, from each start it moves to, as far on as its last move took it', async function() {
		freezeClock(new Date(NOW));
		const peer = new SimulatedPeer();
		for (let index = 0; index < 8000; index++) {
			peer.apply(NOW - 30 * DAY + index, NOW - 3 * HOUR + index * SECOND);
		}
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		harness.progress = firstProgress(NOW, 0, new Date(NOW - 4 * HOUR));

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(completes(live)).toBe(true);
		expect(harness.node.size).toBe(8000);
		const pageStarts = [...new Set(harness.requests.filter(function(request): boolean {
			return(request.limit > 1);
		}).map(function(request): number {
			return(request.start.getTime());
		}))];
		const firstProbes = pageStarts.map(function(start): number | undefined {
			const after = harness.requests.reduce(function(last, request, index): number {
				if (request.limit > 1 && request.start.getTime() === start) {
					return(index);
				}
				return(last);
			}, -1);
			return(harness.requests.slice(after + 1).find(function(request): boolean {
				return(request.limit === 1);
			})?.start.getTime());
		});
		expect(pageStarts.length).toBeGreaterThan(3);
		expect(firstProbes.slice(1, -1)).toEqual(pageStarts.slice(1, -1).map(function(start, index): number {
			return(start + start - (pageStarts[index] ?? 0));
		}));
	});
});

/** More staples at one moment than a filter and a page hold, made over the hour before it, and some after it. */
function crowdPeer(): SimulatedPeer {
	const peer = new SimulatedPeer();
	const moment = NOW - MINUTE;
	for (let index = 0; index < 2500; index++) {
		peer.apply(moment - HOUR + index, moment);
	}
	for (let index = 0; index < 500; index++) {
		peer.apply(moment + 1 + index * 10, moment + 1 + index * 10);
	}
	return(peer);
}

/** What a pass asked: how many requests, pages and probes, from how many starts, how many staples it was sent and sent again, and a digest of every request in order, its start, limit, whether it carried a filter and what it was sent. */
type Trace = {
	readonly requests: number;
	readonly probes: number;
	readonly starts: number;
	readonly served: number;
	readonly resent: number;
	readonly heldReads: readonly number[];
	readonly digest: number;
};

function traceOf(harness: Harness): Trace {
	return({
		requests: harness.requests.length,
		probes: harness.requests.length - harness.pages().length,
		starts: harness.starts().length,
		served: harness.requests.reduce(function(sum, request): number {
			return(sum + request.served);
		}, 0),
		resent: harness.node.resent,
		heldReads: harness.heldCounts,
		digest: createHash('sha256').update(JSON.stringify(harness.requests.map(function(request): [number, number, string, number] {
			return([request.start.getTime(), request.limit, request.bloomFilter ?? '', request.served]);
		}))).digest().readUIntBE(0, 6)
	});
}

const DRAINED: PassOutcome = { kind: 'drained' };

const CAUGHT_UP: PassOutcome = { kind: 'caught-up' };

describe('how much a pass asks of a peer', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	/*
	 * Each pass below is deterministic, its filters seeded from a fixed
	 * sequence, so it asks exactly the same requests every time: the trace
	 * pins how many it asks and how many staples the peer sends again, which
	 * the rules for what a filter names and where the start moves decide.
	 */
	test.each<[string, () => SimulatedPeer, (harness: Harness, peer: SimulatedPeer) => Promise<void>, number, PassOutcome, Trace]>([
		['a history applied as it was made', function() {
			return(peerWith(5000));
		}, function() {
			return(Promise.resolve());
		}, 300, DRAINED, TRACES.applied],
		['a history the node holds already', function() {
			return(peerWith(5000));
		}, async function(harness, peer) {
			for (const staple of peer.staples) {
				freezeClock(new Date(staple.moment));
				await harness.node.add(staple);
			}
			freezeClock(new Date(NOW));
		}, 1000, DRAINED, TRACES.held],
		['a history keyed by votes whose pages a read cuts', function() {
			const peer = new SimulatedPeer({ keying: { kind: 'votes', votesPerRead: 200, readsAtMost: Number.POSITIVE_INFINITY, readMilliseconds: 0 } });
			for (let index = 0; index < 3000; index++) {
				const at = NOW - HOUR + index * SECOND;
				peer.applyVoted(at, at, [], [at - 300, at - 200, at - 100, at]);
			}
			return(peer);
		}, function() {
			return(Promise.resolve());
		}, 300, DRAINED, TRACES.votes],
		['a month of history applied an hour ago', function() {
			const peer = new SimulatedPeer();
			for (let index = 0; index < 3000; index++) {
				peer.apply(NOW - 30 * DAY + index * Math.floor(30 * DAY / 3000), NOW - HOUR + Math.floor(index / 20));
			}
			return(peer);
		}, function() {
			return(Promise.resolve());
		}, 1000, DRAINED, TRACES.late],
		['a peer whose time for a request runs out', function() {
			return(peerWith(5000, { answersAtMost: 37 }));
		}, function() {
			return(Promise.resolve());
		}, 1000, CAUGHT_UP, TRACES.short],
		['a peer keyed by votes whose time runs out on a history the node holds part of', function() {
			const peer = new SimulatedPeer({ keying: { kind: 'votes', votesPerRead: 20, readsAtMost: 10, readMilliseconds: 450 } });
			for (let index = 0; index < 4000; index++) {
				const madeAt = NOW - 30 * DAY + index * 10 * SECOND;
				peer.apply(madeAt, madeAt);
			}
			return(peer);
		}, async function(harness, peer) {
			for (const staple of peer.staples.slice(0, 1500)) {
				await harness.node.add(staple);
			}
		}, 1000, { kind: 'bounded', reached: EPOCH }, TRACES.votesHeld],
		['more staples at one moment than a filter and a page hold', function() {
			const peer = new SimulatedPeer();
			const moment = NOW - MINUTE;
			for (let index = 0; index < 2500; index++) {
				peer.apply(moment - HOUR + index, moment);
			}
			for (let index = 0; index < 500; index++) {
				peer.apply(moment + 1 + index * 10, moment + 1 + index * 10);
			}
			return(peer);
		}, function() {
			return(Promise.resolve());
		}, 1000, DRAINED, TRACES.crowd],
		['more staples at one moment than a filter and a page hold, from a peer it knows keys by when it applied them', crowdPeer, function(harness) {
			harness.progress = { ...firstProgress(NOW, 0, EPOCH), keying: 'applied' };
			return(Promise.resolve());
		}, 1000, DRAINED, TRACES.crowdApplied],
		['more staples at one moment than a filter and a page hold, which the node holds already', crowdPeer, async function(harness, peer) {
			for (const staple of peer.staples) {
				freezeClock(new Date(staple.moment));
				await harness.node.add(staple);
			}
			freezeClock(new Date(NOW));
		}, 1000, DRAINED, TRACES.crowdHeld],
		['more staples at one moment than a filter and a page hold, from a peer it takes to key by votes', crowdPeer, function(harness) {
			harness.progress = { ...firstProgress(NOW, 0, EPOCH), keying: 'votes' };
			return(Promise.resolve());
		}, 1000, DRAINED, TRACES.crowdVotes],
		['a history from a peer it knows keys votes late', function() {
			return(peerWith(3000));
		}, function(harness) {
			harness.progress = { ...firstProgress(NOW, 0, EPOCH), keying: 'late-votes' };
			return(Promise.resolve());
		}, 500, DRAINED, TRACES.lateVotes],
		['a peer whose time runs out reading what the filter names', function() {
			return(peerWith(5000, { readsAtMost: 300 }));
		}, function() {
			return(Promise.resolve());
		}, 1000, DRAINED, TRACES.readsOut],
		['a month of history applied an hour ago, half of which the node holds', function() {
			const peer = new SimulatedPeer();
			for (let index = 0; index < 3000; index++) {
				peer.apply(NOW - 30 * DAY + index * Math.floor(30 * DAY / 3000), NOW - HOUR + Math.floor(index / 20));
			}
			return(peer);
		}, async function(harness, peer) {
			for (const staple of peer.staples.slice(0, 1500)) {
				await harness.node.add(staple);
			}
		}, 1000, DRAINED, TRACES.lateHeld]
	])('reading %s', async function(_ignored: string, makePeer: () => SimulatedPeer, prepare: (harness: Harness, peer: SimulatedPeer) => Promise<void>, limit: number, outcome: PassOutcome, trace: Trace) {
		freezeClock(new Date(NOW));
		const peer = makePeer();
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		await prepare(harness, peer);

		const { live } = await bootstrapPeer(harness.io, passOptions(limit));

		expect(live).toEqual(outcome);
		expectNoLoss(peer, harness, live);
		expect(traceOf(harness)).toEqual(trace);
	});
});

describe('how much a pass over a range asks of a peer', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	/** A peer keyed by votes or by when it applied them, with an hour of history before the range's end and one after. */
	function historyPeer(keying: SimulatedKeying): SimulatedPeer {
		const peer = new SimulatedPeer({ keying });
		for (let index = 0; index < 2000; index++) {
			const at = NOW - 2 * HOUR + index * 3 * SECOND;
			peer.applyVoted(at, at, [], [at - 300, at]);
		}
		return(peer);
	}

	test.each<[string, SimulatedKeying, PeerKeying, Trace]>([
		['keyed by votes, as it knows', { kind: 'votes', votesPerRead: 200, readsAtMost: Number.POSITIVE_INFINITY, readMilliseconds: 0 }, 'votes', RANGE_TRACES.votes],
		['keyed by votes, as it does not know yet', { kind: 'votes', votesPerRead: 200, readsAtMost: Number.POSITIVE_INFINITY, readMilliseconds: 0 }, 'unknown', RANGE_TRACES.unknown],
		['keyed by when it applied them', { kind: 'applied' }, 'applied', RANGE_TRACES.applied]
	])('reading from a peer %s up to an end an hour back', async function(_ignored: string, keying: SimulatedKeying, known: PeerKeying, trace: Trace) {
		freezeClock(new Date(NOW));
		const peer = historyPeer(keying);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		harness.progress = { ...firstProgress(NOW, 0, EPOCH), keying: known };
		const end = NOW - HOUR;

		const outcome = await bootstrapRange(harness.io, { reached: new Date(NOW - 3 * HOUR), end: function(): Date {
			return(new Date(end));
		}, until: new Date(NOW + HOUR), use: 'ahead', moved: function(): Promise<void> {
			return(Promise.resolve());
		} }, passOptions(500));

		expect(completes(outcome)).toBe(true);
		expect(peer.staples.filter(function(staple): boolean {
			return(staple.moment < end && !harness.node.holds(staple));
		})).toEqual([]);
		expect(traceOf(harness)).toEqual(trace);
	});
});

/** How a peer's staples at one moment an hour ago, and after it, are laid out (mistakenCrowd). */
type CrowdLayout = {
	/** The staples at the moment, voted on then. */
	readonly crowd: number;
	/** How many of those stay out of answers, spread among them. */
	readonly hidden: number;
	/** The staples after the moment, each voted on as it was applied. */
	readonly after: number;
	readonly afterFrom: number;
	readonly spacing: number;
	readonly options: SimulatedPeerOptions;
	/** When the votes of the hidden staples were made, if not at the moment. */
	readonly hiddenVotes?: readonly number[];
};

/**
 * A peer whose staples at one moment, the moment the pass starts from, are
 * more than a filter holds. Some of them stay out of every answer until a
 * page from the moment, asked for with a filter that names more than a
 * filter holds, reaches past the moment, and then out of every answer to
 * that filter, as if it named them by mistake; every other filter, with a
 * seed of its own, lists them.
 */
function mistakenCrowd(keying: PeerKeying, layout: CrowdLayout): { whole: SimulatedPeer; harness: Harness; mistaken: () => string | undefined } {
	freezeClock(new Date(NOW));
	const whole = new SimulatedPeer(layout.options);
	const visible = new SimulatedPeer(layout.options);
	const moment = NOW - HOUR;
	let hidden = 0;
	for (let index = 0; index < layout.crowd; index++) {
		// Spread evenly: the staple is hidden when the count hidden so far falls behind its share.
		if (hidden < Math.ceil((index + 1) * layout.hidden / layout.crowd)) {
			hidden++;
			whole.applyVoted(moment, moment, [], layout.hiddenVotes ?? [moment]);
		} else {
			visible.applyAlso(whole.applyVoted(moment, moment, [], [moment]), moment);
		}
	}
	for (let index = 0; index < layout.after; index++) {
		const at = layout.afterFrom + index * layout.spacing;
		visible.applyAlso(whole.applyVoted(at, at, [], [at]), at);
	}
	const fullHashes = lib.Utils.Bloom.BloomFilter.create(BLOOM_CAPACITY, BLOOM_ERROR_RATE)._nbHashes;
	let mistaken: string | undefined;
	const harness = new Harness(async function(request) {
		if (mistaken !== undefined && request.bloomFilter !== mistaken) {
			return(await whole.page(request));
		}
		const answer = await visible.page(request);
		const crowded = request.bloomFilter !== undefined && lib.Utils.Bloom.deserializeBloomFilter(request.bloomFilter)._nbHashes < fullHashes;
		const pastMoment = answer.kind === 'page' && answer.staples.some(function(staple): boolean {
			return(staple.moment > moment);
		});
		if (mistaken === undefined && crowded && request.start.getTime() === moment && request.limit > 1 && pastMoment) {
			mistaken = request.bloomFilter;
		}
		return(answer);
	});
	harness.progress = { reached: new Date(moment), caughtUp: true, deepScanFrom: new Date(moment), nextDeepScan: new Date(NOW + HOUR), deepScan: undefined, keying };
	return({ whole, harness, mistaken: function(): string | undefined {
		return(mistaken);
	} });
}

/**
 * A peer whose 2101 staples at the moment an hour ago, voted on then, are more
 * than a filter holds, and which answers at most 700 a request; 30 staples
 * follow, 100 ms apart, then as many as asked for applied from 4 s past the
 * moment, 1 ms apart, whose votes were made half the tolerance before the
 * tolerance before the last of the 30 was voted on.
 */
function crowdEndingIn(late: number): { peer: SimulatedPeer; last: SimulatedStaple; moment: number } {
	freezeClock(new Date(NOW));
	const peer = new SimulatedPeer({ answersAtMost: 700 });
	const moment = NOW - HOUR;
	for (let index = 0; index < 2100; index++) {
		peer.applyVoted(moment, moment, [], [moment]);
	}
	const last = peer.applyVoted(moment, moment, [], [moment]);
	for (let index = 0; index < 30; index++) {
		const at = moment + 1 + index * 100;
		peer.applyVoted(at, at, [], [at]);
	}
	for (let index = 0; index < late; index++) {
		const at = moment + 4 * SECOND + index;
		peer.applyVoted(at, at, [], [moment + 2901 - VOTE_KEY_TOLERANCE_MILLISECONDS * 3 / 2]);
	}
	return({ peer, last, moment });
}

/**
 * A pass's view of the peer, starting from the staple's moment, in which
 * every answer to a filter `mistakes` picks, given a request and the peer's
 * answer, and every later answer to that filter, leaves out the staple, as
 * if the filter named it by mistake.
 */
function hidingFrom(peer: SimulatedPeer, staple: SimulatedStaple, mistakes: (request: PassRequest, answer: PassAnswer<SimulatedStaple>) => boolean, keying: PeerKeying): Harness {
	const mistaken = new Set<string>();
	const harness = new Harness(async function(request) {
		const answer = await peer.page(request);
		const filter = request.bloomFilter ?? '';
		if (mistakes(request, answer)) {
			mistaken.add(filter);
		}
		if (answer.kind !== 'page' || !mistaken.has(filter)) {
			return(answer);
		}
		return({ kind: 'page', staples: answer.staples.filter(function(listed): boolean {
			return(listed !== staple);
		}) });
	});
	harness.progress = { reached: new Date(staple.moment), caughtUp: true, deepScanFrom: new Date(staple.moment), nextDeepScan: new Date(NOW + HOUR), deepScan: undefined, keying };
	return(harness);
}

describe('a pass checking what it concludes', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	/*
	 * More staples at one moment than a filter holds, and nothing after them:
	 * the pass names them all, at a rate above the one it accepts, so an empty
	 * page from its start is checked with further filters before it ends.
	 */
	test('takes a staple a further filter finds after an empty page, and drains the peer only once filters whose rates multiply to the one it accepts find none', async function() {
		freezeClock(new Date(NOW));
		const peer = new SimulatedPeer();
		const moment = NOW - MINUTE;
		for (let index = 0; index < 2500; index++) {
			peer.apply(moment - HOUR + index, moment);
		}
		// A staple of its own, which a filter of the peer's named by mistake: its ID follows every one the peer holds.
		const other = new SimulatedPeer();
		for (let index = 0; index < 2500; index++) {
			other.apply(moment - HOUR + index, moment);
		}
		const hidden = other.apply(moment - 2 * HOUR, moment);
		// Right after the first empty page, the first further filter, with a seed of its own, finds it.
		let emptyPageFrom: number | undefined;
		let found = false;
		let foundAt = 0;
		const harness: Harness = new Harness(async function(request) {
			if (!found && request.limit === 1 && request.start.getTime() === emptyPageFrom) {
				found = true;
				foundAt = harness.requests.length;
				return({ kind: 'page', staples: [hidden] });
			}
			const answer = await peer.page(request);
			emptyPageFrom = undefined;
			if (request.limit > 1 && answer.kind === 'page' && answer.staples.length === 0) {
				emptyPageFrom = request.start.getTime();
			}
			return(answer);
		});

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'drained' }));

		expect(harness.node.holds(hidden)).toBe(true);
		expect(harness.node.size).toBe(2501);
		const afterFound = harness.requests.slice(foundAt + 1);
		// Another page from the start, then further filters again, before it ends.
		expect(afterFound.filter(function(request): boolean {
			return(request.limit > 1);
		}).length).toBeGreaterThan(0);
		expect(afterFound.at(-1)?.limit).toBe(1);
	});

	/*
	 * A peer applied 5000 staples at the moment the pass starts from, more
	 * than a filter holds, and then a staple every 10 ms. Until the pass
	 * names more of them than a filter holds, 3000 of them stay out of every
	 * answer, and then out of every answer to the first filter that names
	 * that many, as if that filter named them by mistake: the page it lists
	 * reaches past the moment, and a probe with it shows a move there. Further
	 * filters, each with a seed of its own, list them from the start, more
	 * than the pages that check the move hold, so the move is not sound until
	 * the pass has them all.
	 */
	test.each<[PeerKeying]>([['applied'], ['unknown'], ['votes']])('moves past a moment only once further filters show it lacks none of the staples there, from a peer it takes to key %s', async function(keying: PeerKeying) {
		freezeClock(new Date(NOW));
		const whole = new SimulatedPeer();
		const visible = new SimulatedPeer();
		const moment = NOW - HOUR;
		const hidden = new Set<number>();
		for (let index = 0; index < 5000; index++) {
			const staple = whole.applyVoted(moment, moment, [], [moment]);
			if (index % 5 < 3) {
				hidden.add(staple.id);
			} else {
				visible.applyAlso(staple, moment);
			}
		}
		for (let index = 0; index < 500; index++) {
			const at = moment + 1 + index * 10;
			visible.applyAlso(whole.applyVoted(at, at, [], [at]), at);
		}
		const fullHashes = lib.Utils.Bloom.BloomFilter.create(BLOOM_CAPACITY, BLOOM_ERROR_RATE)._nbHashes;
		let mistaken: number | undefined;
		// The page that checks a move, asked for right after the first staple from the moment, comes back too large once.
		let refused = false;
		let afterOne = false;
		const harness = new Harness(function(request) {
			const checking = afterOne && request.limit > 1;
			afterOne = request.limit === 1;
			if (checking && !refused) {
				refused = true;
				return(Promise.resolve({ kind: 'too-large' }));
			}
			let hides = mistaken === undefined;
			if (request.bloomFilter !== undefined) {
				const filter = lib.Utils.Bloom.deserializeBloomFilter(request.bloomFilter);
				if (mistaken === undefined && filter._nbHashes < fullHashes) {
					mistaken = filter.seed;
				}
				hides ||= filter.seed === mistaken;
			}
			if (hides) {
				return(visible.page(request));
			}
			return(whole.page(request));
		});
		harness.progress = { reached: new Date(moment), caughtUp: true, deepScanFrom: new Date(moment), nextDeepScan: new Date(NOW + HOUR), deepScan: undefined, keying };

		await bootstrapPeer(harness.io, passOptions(1000));

		expect(mistaken).toBeDefined();
		expect(whole.staples.filter(function(staple): boolean {
			return(!harness.node.holds(staple));
		}).length).toBe(0);
	});

	/*
	 * The peer answers at most 200 staples a request, and 2500 staples share
	 * one moment: short pages come back while the filter names them all, at
	 * a rate above the one the pass accepts, long before any page reaches
	 * past them.
	 */
	test('ends caught up on a peer whose short pages cross more staples at one moment than a filter holds only once it holds every staple before its horizon', async function() {
		freezeClock(new Date(NOW));
		const peer = new SimulatedPeer({ answersAtMost: 200 });
		const moment = NOW - HOUR;
		for (let index = 0; index < 2500; index++) {
			peer.applyVoted(moment, moment, [], [moment]);
		}
		for (let index = 0; index < 500; index++) {
			const at = moment + 1 + index * SECOND;
			peer.applyVoted(at, at, [], [at]);
		}
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(completes(live)).toBe(true);
		expectNoLoss(peer, harness, live);
	});

	/*
	 * 2500 staples share the moment the pass starts from, an hour ago, voted
	 * on then, after which the peer holds nothing; the first further filter,
	 * after the empty page, would find one more, but the pass's time runs out
	 * as the empty page comes back.
	 */
	test('ends at its bound at the start of an empty page it has no time left to check, rather than drain the peer', async function() {
		freezeClock(new Date(NOW));
		const peer = new SimulatedPeer();
		const other = new SimulatedPeer();
		const moment = NOW - HOUR;
		for (let index = 0; index < 2500; index++) {
			other.applyAlso(peer.applyVoted(moment, moment, [], [moment]), moment);
		}
		const hidden = other.applyVoted(moment, moment, [], [moment]);
		let emptyPage = false;
		const harness = new Harness(async function(request) {
			if (emptyPage && request.limit === 1 && request.start.getTime() === moment) {
				return({ kind: 'page', staples: [hidden] });
			}
			const answer = await peer.page(request);
			if (!emptyPage && request.start.getTime() === moment && request.limit > 1 && answer.kind === 'page' && answer.staples.length === 0) {
				emptyPage = true;
				advanceClock(MAX_PASS_MILLISECONDS);
			}
			return(answer);
		});
		harness.progress = { reached: new Date(moment), caughtUp: true, deepScanFrom: new Date(moment), nextDeepScan: new Date(NOW + HOUR), deepScan: undefined, keying: 'unknown' };

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(emptyPage).toBe(true);
		expect(live).toEqual({ kind: 'bounded', reached: new Date(moment) });
		expect(harness.progress.caughtUp).toBe(false);
		expectNoLoss(other, harness, live);
	});

	/*
	 * The peer answers at most 700 staples a request, so every page from the
	 * crowded start is short. The fourth, after which the pass probes its
	 * horizon, is the first whose filter, naming more than a filter holds,
	 * reaches past the moment, and so the one that names 300 of the crowd by
	 * mistake.
	 */
	test.each<[PeerKeying]>([['unknown'], ['applied'], ['votes'], ['late-votes']])('concludes neither that it has caught up nor that it may move past a moment on a filter that names more than it holds, from a peer it takes to key %s', async function(keying: PeerKeying) {
		const { whole, harness, mistaken } = mistakenCrowd(keying, { crowd: 2500, hidden: 300, after: 50, afterFrom: NOW - 5 * MINUTE, spacing: SECOND, options: { answersAtMost: 700 } });

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(mistaken()).toBeDefined();
		expectNoLoss(whole, harness, live);
	});

	/*
	 * The page that reaches past the moment lists only part of the 1500
	 * staples after it, so a further filter lists one first from where the
	 * page shows the pass reached; from the start, it lists first the staples
	 * the page's filter named by mistake, more than a page that checks holds.
	 */
	test.each<[PeerKeying]>([['unknown'], ['applied']])('moves past a moment only once each further filter lists first, from the start, the staple it lists first from there, from a peer it takes to key %s', async function(keying: PeerKeying) {
		const { whole, harness, mistaken } = mistakenCrowd(keying, { crowd: 5000, hidden: 3000, after: 1500, afterFrom: NOW - HOUR + 1, spacing: 10, options: {} });

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(mistaken()).toBeDefined();
		expectNoLoss(whole, harness, live);
	});

	/*
	 * The hidden staples' votes were made long before the start, as from a
	 * peer that keys votes late, which the pass has not learnt yet: a page
	 * that lists them lacked nothing made about the moments it checks, and
	 * shows nothing of how far it read.
	 */
	test('moves past a moment only once each further filter\'s page shows it read up to there, from a peer it takes to key votes', async function() {
		const { whole, harness, mistaken } = mistakenCrowd('votes', { crowd: 5000, hidden: 3000, after: 1500, afterFrom: NOW - HOUR + 1, spacing: 10, options: {}, hiddenVotes: [NOW - 3 * HOUR] });

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(mistaken()).toBeDefined();
		expectNoLoss(whole, harness, live);
	});

	/*
	 * The peer answers at most 700 staples a request: the third page, whose
	 * filter names more than a filter holds, lists every staple at the moment
	 * but the last, and shows no move. Every filter that checks a move to a
	 * millisecond past the moment names that last staple by mistake, and no
	 * other filter does.
	 */
	test.each<[PeerKeying]>([['applied'], ['unknown']])('moves past a moment only once a probe with the page\'s own filter shows the page reached past it, from a peer it takes to key %s', async function(keying: PeerKeying) {
		const { peer, last, moment } = crowdEndingIn(0);
		const harness = hidingFrom(peer, last, function(request): boolean {
			return(request.limit === 1 && request.start.getTime() === moment + 1);
		}, keying);

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expectNoLoss(peer, harness, live);
	});

	/*
	 * After the crowd, staples applied from 4 s past the moment whose votes
	 * were made within the tolerance before the moment a move is checked to,
	 * the tolerance before the last of the 30 was voted on. Keyed by when
	 * they were applied, they lie past that moment, so a further filter lists
	 * the same staple first from the start as from there; keyed by their
	 * votes, they lie before it, and a page that lists them lacked them. Each
	 * is voted on once, so no page shows which way the peer keys.
	 * The filter of the page that reaches past the moment, and every filter
	 * that checks a move, name the last staple of the crowd by mistake.
	 */
	test.each<[PeerKeying]>([['unknown'], ['votes']])('checks a move by the votes of what further filters list, from a peer it takes to key %s', async function(keying: PeerKeying) {
		const { peer, last, moment } = crowdEndingIn(3000);
		const fullHashes = lib.Utils.Bloom.BloomFilter.create(BLOOM_CAPACITY, BLOOM_ERROR_RATE)._nbHashes;
		let reachedPast = false;
		const harness = hidingFrom(peer, last, function(request, answer): boolean {
			if (request.limit === 1) {
				return(request.start.getTime() > moment);
			}
			const crowded = request.bloomFilter !== undefined && lib.Utils.Bloom.deserializeBloomFilter(request.bloomFilter)._nbHashes < fullHashes;
			const pastMoment = answer.kind === 'page' && answer.staples.some(function(staple): boolean {
				return(staple.moment > moment);
			});
			if (reachedPast || !crowded || request.start.getTime() !== moment || !pastMoment) {
				return(false);
			}
			reachedPast = true;
			return(true);
		}, keying);

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(reachedPast).toBe(true);
		expectNoLoss(peer, harness, live);
		// A peer keyed by when it applied them lists first from the start what it lists first from the moment, so a check asks for that first, unless the peer is known to key by votes.
		const firstFromMoment = harness.requests.filter(function(request, index): boolean {
			const next = harness.requests[index + 1];
			return(request.limit === 1 && next !== undefined && next.limit > 1 && next.start < request.start && next.bloomFilter === request.bloomFilter);
		});
		expect(firstFromMoment.length > 0).toBe(keying === 'unknown');
	});

	/*
	 * A peer keyed by when it applied them, which the pass takes to key votes,
	 * answering at most 700 staples a request: 1400 staples at the moment, then
	 * 1000 applied from a millisecond past it and voted on as applied, the first
	 * of them voted on much later, then 1500 applied from 5 s past it. The first
	 * filter to name the crowd leaves out the 1000, as if it named them by
	 * mistake, and its page shows a move past the moment. The page of the
	 * further filter that checks the move shows, by that first staple, that it
	 * read up to there, but lists 700 of the 1000, which the node lacked.
	 */
	test('moves past a moment only once each further filter\'s page lists no staple the node lacked with a vote made before there, from a peer it takes to key votes', async function() {
		freezeClock(new Date(NOW));
		const whole = new SimulatedPeer({ answersAtMost: 700 });
		const visible = new SimulatedPeer({ answersAtMost: 700 });
		const moment = NOW - HOUR;
		for (let index = 0; index < 1400; index++) {
			visible.applyAlso(whole.applyVoted(moment, moment, [], [moment]), moment);
		}
		for (let index = 0; index < 1000; index++) {
			const at = moment + 1 + index;
			let stamps = [at];
			if (index === 0) {
				stamps = [moment + MINUTE];
			}
			whole.applyVoted(at, at, [], stamps);
		}
		for (let index = 0; index < 1500; index++) {
			const at = moment + 5 * SECOND + index * 10;
			visible.applyAlso(whole.applyVoted(at, at, [], [at]), at);
		}
		const fullHashes = lib.Utils.Bloom.BloomFilter.create(BLOOM_CAPACITY, BLOOM_ERROR_RATE)._nbHashes;
		let mistaken: string | undefined;
		const harness = new Harness(async function(request) {
			if (mistaken !== undefined && request.bloomFilter !== mistaken) {
				return(await whole.page(request));
			}
			const crowded = request.bloomFilter !== undefined && lib.Utils.Bloom.deserializeBloomFilter(request.bloomFilter)._nbHashes < fullHashes;
			if (mistaken === undefined && crowded && request.start.getTime() === moment && request.limit > 1) {
				mistaken = request.bloomFilter;
			}
			return(await visible.page(request));
		});
		harness.progress = { reached: new Date(moment), caughtUp: true, deepScanFrom: new Date(moment), nextDeepScan: new Date(NOW + HOUR), deepScan: undefined, keying: 'votes' };

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(mistaken).toBeDefined();
		expectNoLoss(whole, harness, live);
	});

	test('fails with the retry it ends with, when nothing before it failed', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(3);
		const holding = new Harness(function(request) {
			return(peer.page(request));
		});
		for (const staple of peer.staples) {
			await holding.node.add(staple);
		}
		const failingRetry = function(): Promise<void> {
			return(Promise.reject(new Error('the retry failed')));
		};

		await expect(bootstrapPeer({ ...holding.io, retry: failingRetry }, passOptions(10))).rejects.toThrow('the retry failed');
		await expect(bootstrapRange({ ...holding.io, retry: failingRetry }, { reached: EPOCH, end: function(): Date {
			return(new Date(NOW - HOUR));
		}, until: new Date(NOW + HOUR), use: 'ahead', moved: function(): Promise<void> {
			return(Promise.resolve());
		} }, passOptions(10))).rejects.toThrow('the retry failed');
	});

	test('asks for fewer staples when the page from where the page before shows it reached is too large, and goes on from there', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(5000);
		let refused = false;
		const harness = new Harness(function(request) {
			if (!refused && request.limit > 1 && request.start.getTime() > 0) {
				refused = true;
				return(Promise.resolve({ kind: 'too-large' }));
			}
			return(peer.page(request));
		});

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(completes(live)).toBe(true);
		expect(harness.node.size).toBe(5000);
		expect(harness.pages().at(-1)?.limit).toBe(500);
	});

	/*
	 * A main network representative lists about forty staples of its dense
	 * history for a request, written as more than 4 MiB of JSON: the page from
	 * where the page before shows it reached is the one most often too large.
	 */
	test('asks again with fewer staples for the page from where a peer keyed by votes is shown to have reached, when it is too large, rather than probe one staple at a time', async function() {
		freezeClock(new Date(NOW));
		const { peer, first } = denseVotedPeer();
		let refused: number | undefined;
		const harness = new Harness(function(request) {
			if (refused === undefined && request.limit > 1 && request.start.getTime() > first) {
				refused = harness.requests.length;
				return(Promise.resolve({ kind: 'too-large' }));
			}
			return(peer.page(request));
		});
		harness.progress = { ...firstProgress(NOW, 0, new Date(first)), keying: 'votes' };

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(completes(live)).toBe(true);
		expect(harness.node.size).toBe(2000);
		const tooLarge = harness.requests[refused ?? -1];
		expect(tooLarge).toMatchObject({ limit: 1000 });
		expect(harness.requests[(refused ?? -1) + 1]).toMatchObject({ start: tooLarge?.start, limit: 500 });
	});

	test('asks again with half as many staples for as long as the page from where a page is shown to have read up to is too large, and goes on from there once one fits', async function() {
		freezeClock(new Date(NOW));
		const { peer, first } = denseVotedPeer();
		const harness = new Harness(function(request) {
			if (request.limit > 100 && request.start.getTime() > first) {
				return(Promise.resolve({ kind: 'too-large' }));
			}
			return(peer.page(request));
		});
		harness.progress = { ...firstProgress(NOW, 0, new Date(first)), keying: 'votes' };

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(completes(live)).toBe(true);
		expect(harness.node.size).toBe(2000);
		const moved = harness.pages().filter(function(request): boolean {
			return(request.start.getTime() > first);
		}).slice(0, 5);
		expect(moved.map(function(request): [number, number] {
			return([request.start.getTime(), request.limit]);
		})).toEqual([1000, 500, 250, 125, 63].map(function(limit): [number, number] {
			return([moved[0]?.start.getTime() ?? first, limit]);
		}));
		expect(moved.at(-1)?.served).toBeGreaterThan(0);
		expect(harness.pages().at(-1)?.limit).toBe(63);
	});

	/*
	 * With the window at its floor, the peer gives up on the second page from
	 * the first start, the first with a filter, after which, the second short
	 * page in a row, the pass probes its horizon.
	 */
	test('probes with no filter after a page from its start the peer gave up on the filter of', async function() {
		freezeClock(new Date(NOW));
		const { peer, first } = denseVotedPeer();
		let gaveUp: number | undefined;
		const harness = new Harness(function(request) {
			if (gaveUp === undefined && request.limit > 1 && request.bloomFilter !== undefined) {
				gaveUp = harness.requests.length;
				return(Promise.resolve({ kind: 'gave-up', reason: 'the gateway gave up' }));
			}
			return(peer.page(request));
		});
		harness.priming = new PrimingWindow(8);
		harness.progress = { ...firstProgress(NOW, 0, new Date(first)), keying: 'votes' };

		await bootstrapPeer(harness.io, passOptions(1000));

		expect(harness.node.size).toBe(2000);
		const since = harness.requests.slice(gaveUp ?? -1);
		expect(since.slice(0, 3).map(function(request): [number, number, boolean] {
			return([request.start.getTime(), request.limit, request.bloomFilter !== undefined]);
		})).toEqual([[first, 1000, true], [first, 1000, false], [NOW - BOOTSTRAP_MARGIN_MILLISECONDS, 1, false]]);
		expect(since.slice(1).filter(function(request): boolean {
			return(request.bloomFilter !== undefined);
		})).toEqual([]);
	});

	/*
	 * With the window at its floor, the peer gives up on the page from the
	 * second start the pass moves to, which is the fourth short page in a row,
	 * after which the pass probes its horizon; the page asked for again with
	 * no filter is too large.
	 */
	test('asks again with no filter for the page from where a page is shown to have read up to, when it is too large after the peer gave up on its filter', async function() {
		freezeClock(new Date(NOW));
		const { peer, first } = denseVotedPeer();
		const moves = new Set<number>();
		let gaveUp: number | undefined;
		const harness = new Harness(function(request) {
			if (request.limit > 1 && request.start.getTime() > first) {
				moves.add(request.start.getTime());
			}
			if (gaveUp === undefined && moves.size === 2 && request.bloomFilter !== undefined) {
				gaveUp = harness.requests.length;
				return(Promise.resolve({ kind: 'gave-up', reason: 'the gateway gave up' }));
			}
			if (gaveUp !== undefined && harness.requests.length === gaveUp + 1) {
				return(Promise.resolve({ kind: 'too-large' }));
			}
			return(peer.page(request));
		});
		harness.priming = new PrimingWindow(8);
		harness.progress = { ...firstProgress(NOW, 0, new Date(first)), keying: 'votes' };

		await bootstrapPeer(harness.io, passOptions(1000));

		expect(harness.node.size).toBe(2000);
		const since = harness.requests.slice(gaveUp ?? -1);
		expect(since.slice(0, 3).map(function(request): [number, number, boolean] {
			return([request.start.getTime(), request.limit, request.bloomFilter !== undefined]);
		})).toEqual([[1000, true], [1000, false], [500, false]].map(function([limit, filtered]): [number, number, boolean] {
			return([since[0]?.start.getTime() ?? first, Number(limit), Boolean(filtered)]);
		}));
		// The peer is read with no filter from then on, until a pass completes.
		expect(since.slice(1).filter(function(request): boolean {
			return(request.bloomFilter !== undefined);
		})).toEqual([]);
	});

	test('fails when the page from where a page is shown to have read up to is too large down to a single staple', async function() {
		freezeClock(new Date(NOW));
		const { peer, first } = denseVotedPeer();
		// Every answer from within the dense history but its first start is too large; the horizon lies past it.
		const dense = function(request: PassRequest): boolean {
			return(request.start.getTime() > first && request.start.getTime() < NOW - HOUR + 200 * SECOND);
		};
		const harness = new Harness(function(request) {
			if (dense(request)) {
				return(Promise.resolve({ kind: 'too-large' }));
			}
			return(peer.page(request));
		});
		harness.progress = { ...firstProgress(NOW, 0, new Date(first)), keying: 'votes' };

		await expect(bootstrapPeer(harness.io, passOptions(1000))).rejects.toThrow('the peer holds a staple larger than a page may be');

		const moved = harness.requests.filter(dense);
		expect(moved.map(function(request): [number, number] {
			return([request.start.getTime(), request.limit]);
		})).toEqual([1000, 500, 250, 125, 63, 32, 16, 8, 4, 2, 1].map(function(limit): [number, number] {
			return([moved[0]?.start.getTime() ?? first, limit]);
		}));
	});

	test('ends at its time bound, where it started, when the page from where a page is shown to have read up to is too large until then', async function() {
		freezeClock(new Date(NOW));
		const { peer, first } = denseVotedPeer();
		const harness = new Harness(function(request) {
			if (request.limit > 1 && request.start.getTime() > first) {
				advanceClock(MAX_PASS_MILLISECONDS);
				return(Promise.resolve({ kind: 'too-large' }));
			}
			return(peer.page(request));
		});
		harness.progress = { ...firstProgress(NOW, 0, new Date(first)), keying: 'votes' };

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(live).toEqual({ kind: 'bounded', reached: new Date(first) });
		expect(harness.requests.at(-1)).toMatchObject({ limit: 1000, served: 0 });
		expect(harness.requests.at(-1)?.start.getTime()).toBeGreaterThan(first);
	});

	test('learns over a range how the peer keys, and reports it, though the peer\'s progress is gone meanwhile', async function() {
		freezeClock(new Date(NOW));
		const twice = new SimulatedPeer().apply(NOW - HOUR, NOW - HOUR);
		const harness = new Harness(function() {
			return(pageOf([twice, twice]));
		});
		const written: PeerProgress[] = [];
		const io: PeerIO<SimulatedStaple> = {
			...harness.io,
			readProgress: function(): Promise<PeerProgress | undefined> {
				return(Promise.resolve(undefined));
			},
			writeProgress: function(progress): Promise<void> {
				written.push(progress);
				return(Promise.resolve());
			}
		};
		const start = new Date(NOW - 10 * MINUTE);

		await bootstrapRange(io, { reached: start, end: function(): Date {
			return(new Date(NOW));
		}, until: new Date(NOW + HOUR), use: 'ahead', moved: function(): Promise<void> {
			return(Promise.resolve());
		} }, { ...passOptions(10), stagger: 42, from: new Date(5) }).catch(function(): void {
			// The peer sends the staple again, which the filter named; what matters is what it learnt first.
		});

		expect(written.map(function(progress): PeerKeying {
			return(progress.keying);
		})).toEqual(['unknown', 'late-votes']);
		expect(written[1]).toEqual({ ...firstProgress(NOW, 42, new Date(5)), keying: 'late-votes' });
		expect(harness.events).toEqual([{ kind: 'late-votes', start, staple: twice.blocksHash.toString() }]);
	});
});

/** A peer it knows keys by when it applied them, with 2500 staples at the moment an hour ago it starts from, voted on 5 s before, and MAX_NAMED + 1000 after it, 100 ms apart; the next deep re-scan due in a day. */
function crowdThenMany(): { peer: SimulatedPeer; harness: Harness } {
	freezeClock(new Date(NOW));
	const peer = new SimulatedPeer();
	const moment = NOW - HOUR;
	for (let index = 0; index < 2500; index++) {
		peer.applyVoted(moment, moment, [], [moment - 5000]);
	}
	for (let index = 0; index < MAX_NAMED + 1000; index++) {
		const at = moment + 1 + index * 100;
		peer.applyVoted(at, at, [], [at - 5000]);
	}
	const harness = new Harness(function(request) {
		return(peer.page(request));
	});
	harness.progress = { reached: new Date(moment), caughtUp: true, deepScanFrom: new Date(moment), nextDeepScan: new Date(NOW + DAY), deepScan: undefined, keying: 'applied' };
	return({ peer, harness });
}

describe('passes that go on making progress', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	/*
	 * The peer reads at most 300 staples a request, those the filter names
	 * included, and 400 staples share one moment: each page after the
	 * first lists one staple, and none shows a move.
	 */
	test('drain a peer whose time runs out reading what the filter names at one moment, naming what each page sent', async function() {
		freezeClock(new Date(NOW));
		const peer = new SimulatedPeer({ readsAtMost: 300 });
		const moment = NOW - HOUR;
		for (let index = 0; index < 400; index++) {
			peer.applyVoted(moment, moment, [], [moment]);
		}
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(live).toEqual({ kind: 'drained' });
		expectNoLoss(peer, harness, live);
	});

	/*
	 * 2500 staples share the moment the pass starts from, from a peer it knows
	 * keys by when it applied them, and more than MAX_NAMED follow, so no page
	 * from the moment ever comes back empty: only a move past it, which
	 * further filters check by order, lets the passes go on.
	 */
	test('move past more staples at one moment than a filter holds, from a peer keyed by when it applied them that holds more than MAX_NAMED after them', async function() {
		const { harness } = crowdThenMany();

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(completes(live)).toBe(true);
		expect(harness.events).toEqual([]);
	});

	/*
	 * With the seeds passOptions draws, the full filter of one page the pass
	 * moves on by names a staple by mistake: the two hashes the client places
	 * its cells by agree, modulo the filter's size, with those of a staple the
	 * filter names, which is most of the rate a full filter names one at
	 * (bootstrap-window.ts, errorRateOf). The pass leaves it out; the deep
	 * re-scan, with filters of its own, reads it.
	 */
	test('read again, in the deep re-scan, a staple a full filter named by mistake that a pass moved past', async function() {
		const { peer, harness } = crowdThenMany();

		const { live } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(live).toEqual({ kind: 'drained' });
		const lost = peer.staples.filter(function(staple): boolean {
			return(!harness.node.holds(staple));
		});
		expect(lost.map(function(staple): number {
			return(staple.id);
		})).toEqual([20561]);
		// The filter that named it is full, and the staple's cells are those of a staple it names.
		const filters = harness.requests.flatMap(function(request): BloomFilter[] {
			if (request.bloomFilter === undefined) {
				return([]);
			}
			return([lib.Utils.Bloom.deserializeBloomFilter(request.bloomFilter)]);
		}).filter(function(filter): boolean {
			return(lost.every(function(staple): boolean {
				return(filter.has(staple.toBytes()));
			}));
		});
		expect(filters.map(function(filter): number {
			return(filter._nbHashes);
		})).toEqual([lib.Utils.Bloom.BloomFilter.create(BLOOM_CAPACITY, BLOOM_ERROR_RATE)._nbHashes]);
		const [filter] = filters;
		const cellsOf = function(staple: SimulatedStaple): string {
			return(filter?._hashing.getIndexes(staple.toBytes(), filter.size, filter._nbHashes, filter.seed).join() ?? '');
		};
		expect(peer.staples.filter(function(staple): boolean {
			return(lost.every(function(missed): boolean {
				return(staple !== missed && cellsOf(staple) === cellsOf(missed));
			}));
		}).map(function(staple): number {
			return(staple.id);
		})).toEqual([19856]);

		freezeClock(new Date(NOW + DAY));
		const { deepScan } = await bootstrapPeer(harness.io, passOptions(1000));

		expect(deepScan).toEqual({ kind: 'drained' });
		expect(lostBefore(peer.staples, harness, NOW)).toEqual([]);
	});
});

describe('a pass over more staples at one moment than it may name', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('ends at its start once it would name MAX_NAMED from there with no page shown to read past it, and reports it', async function() {
		freezeClock(new Date(NOW));
		const moment = NOW - HOUR;
		const peer = new SimulatedPeer();
		// Voted on at the moment they were applied, which shows no moment past it.
		for (let index = 0; index < MAX_NAMED + 1000; index++) {
			peer.applyVoted(moment, moment, [], [moment]);
		}
		// A probe a millisecond past the start for as many staples as a page holds comes back too large once.
		let refused = false;
		const harness = new Harness(function(request) {
			if (!refused && request.limit > 1 && request.start.getTime() === moment + 1) {
				refused = true;
				return(Promise.resolve({ kind: 'too-large' }));
			}
			return(peer.page(request));
		});
		harness.progress = { reached: new Date(moment), caughtUp: true, deepScanFrom: new Date(moment), nextDeepScan: new Date(NOW + HOUR), deepScan: undefined, keying: 'late-votes' };

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'bounded', reached: new Date(moment) }));
		expect(refused).toBe(true);

		expect(harness.events).toEqual([{ kind: 'crowded', start: new Date(moment) }]);
	});
});

describe('the seeds of a pass\'s filters', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('are drawn anew for each filter unless the pass is given them, so that a staple named by mistake once is not named by mistake again', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(3000);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		await bootstrapPeer(harness.io, { limit: 500 });

		const seeds = harness.requests.flatMap(function(request): number[] {
			if (request.bloomFilter === undefined) {
				return([]);
			}
			return([lib.Utils.Bloom.deserializeBloomFilter(request.bloomFilter).seed]);
		});
		expect(seeds.length).toBeGreaterThan(3);
		expect(new Set(seeds).size).toBe(seeds.length);
	});
});

describe('a pass over a range of a peer\'s history', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	function rangeOf(end: number, moved: number[], until = Number.POSITIVE_INFINITY): RangeSetup {
		return({
			reached: EPOCH,
			end: function(): Date {
				return(new Date(end));
			},
			until: new Date(until),
			use: 'ahead',
			moved: function(start): Promise<void> {
				moved.push(start.getTime());
				return(Promise.resolve());
			}
		});
	}

	test('reads up to the range\'s end, recording where it moved through the range, and only what it learns of how the peer keys in the peer\'s progress', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(3000);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		const moved: number[] = [];
		const end = NOW - 2000 * SECOND;

		const outcome = await bootstrapRange(harness.io, rangeOf(end, moved), { ...passOptions(500), stagger: 42, from: new Date(5) });

		expect(completes(outcome)).toBe(true);
		expect(moved.length).toBeGreaterThan(0);
		expect(harness.written.map(function(progress): number {
			return(progress.reached.getTime());
		})).toEqual([5]);
		expect(peer.staples.filter(function(staple): boolean {
			return(staple.moment < end && !harness.node.holds(staple));
		})).toEqual([]);
		expect(harness.written[0]).toEqual(firstProgress(NOW, 42, new Date(5)));
		expect(new Set(harness.uses)).toEqual(new Set(['ahead']));
	});

	/*
	 * Its pages short, the peer keyed by votes as the pass knows, and no
	 * staple of a page voted on at or past the end: the pass probes the end
	 * only once a page shows it may have read there.
	 */
	test('completes only once it holds every staple before the range\'s end, from a peer keyed by votes that answers short pages', async function() {
		freezeClock(new Date(NOW));
		const peer = shortVotedPeer();
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		harness.progress = { ...firstProgress(NOW, 0, EPOCH), keying: 'votes' };
		const end = NOW - HOUR;

		const outcome = await bootstrapRange(harness.io, { ...rangeOf(end, []), reached: new Date(NOW - 3 * HOUR) }, passOptions(500));

		expect(completes(outcome)).toBe(true);
		expect(lostBefore(peer.staples, harness, end)).toEqual([]);
	});

	test('ends at once, caught up, on a range it has read to its end, and at its bound once the update\'s time is up', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(10);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		expect(await bootstrapRange(harness.io, { ...rangeOf(0, []), reached: EPOCH }, passOptions(10))).toEqual({ kind: 'caught-up' });
		expect(await bootstrapRange(harness.io, rangeOf(NOW, [], NOW), passOptions(10))).toEqual({ kind: 'bounded', reached: EPOCH });
		expect(harness.requests).toEqual([]);
	});

	test('keeps the progress it finds, but for how the peer keys, and fails with what failed the pass or its retry', async function() {
		freezeClock(new Date(NOW));
		const twice = new SimulatedPeer().apply(NOW - HOUR, NOW - HOUR);
		const harness = new Harness(function() {
			return(pageOf([twice, twice]));
		});
		const kept: PeerProgress = { reached: new Date(7), caughtUp: true, deepScanFrom: new Date(8), nextDeepScan: new Date(9), deepScan: undefined, keying: 'unknown' };
		harness.progress = kept;

		await expect(bootstrapRange(harness.io, rangeOf(NOW, []), passOptions(10))).rejects.toThrow('which the filter named');

		expect(harness.progress).toEqual({ ...kept, keying: 'votes' });
		const io = new Harness(function(request) {
			return(peerWith(2).page(request));
		}).io;
		await expect(bootstrapRange({ ...io, retry: function(): Promise<void> {
			return(Promise.reject(new Error('the retry failed')));
		} }, rangeOf(NOW, []), passOptions(10))).rejects.toThrow('the retry failed');
	});

	test('widens the window after a pass the peer did not give up on', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness(function(request) {
			return(peerWith(2).page(request));
		});
		harness.priming = new PrimingWindow(64);
		harness.priming.gaveUp();

		await bootstrapRange(harness.io, rangeOf(NOW, []), passOptions(10));

		expect(harness.priming.size).toBe(40);
	});

	test('asks for as many staples as pages last fitted, and for more after a pass with no answer too large', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness(function(request) {
			return(peerWith(2).page(request));
		});
		harness.pageLimit.tooLarge();
		harness.pageLimit.answered(4);
		harness.pageLimit.passed();

		await bootstrapRange(harness.io, rangeOf(NOW, []), passOptions(10));

		expect(harness.requests[0]?.limit).toBe(4);
		expect(harness.pageLimit.size).toBe(36);
	});
});
