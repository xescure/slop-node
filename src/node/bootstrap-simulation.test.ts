import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConcurrentClock, SimulatedNode, SimulatedPeer, SimulatedRetryStore, simulatedRetries } from '../testing/simulated-peer.js';
import type { LiveTraffic, RefusalReport, SimulatedKeying, SimulatedPeerOptions, SimulatedStaple, VoteKey } from '../testing/simulated-peer.js';
import { advanceClock, freezeClock } from '../testing/network.js';
import { DEEP_SCAN_PERIOD_MILLISECONDS, LongestAnswer, PrimingWindow, MAX_PASS_MILLISECONDS, MAX_PASS_REQUESTS, VOTE_KEY_TOLERANCE_MILLISECONDS, bootstrapPeer, bootstrapRange, completes } from './bootstrap-pass.js';
import type { PassEvent, PassOptions, PassOutcome, PeerIO, PeerOutcome, PeerProgress } from './bootstrap-pass.js';
import { RANGE_OVERLAP_MILLISECONDS, rangeResultOf, updateRanges } from './bootstrap-ranges.js';
import type { RangeEvent, RangeLayout, RangeResult } from './bootstrap-ranges.js';
import { backoffAfter, FIRST_BACKOFF_MILLISECONDS, LAST_BACKOFF_MILLISECONDS, REPORT_REFUSED_AFTER_MILLISECONDS, RetryQueueFull } from './bootstrap-retry.js';
import type { QueueBounds, RetryQueue } from './bootstrap-retry.js';
import { nextUpdateDelay, updatePeers } from './bootstrap-update.js';
import type { PeerResult } from './bootstrap-update.js';
import { BLOOM_CAPACITY, BOOTSTRAP_MARGIN_MILLISECONDS } from './bootstrap-window.js';
import { assertNever } from '../util/assert-never.js';

/*
 * Catch-ups against a simulated representative that pages and filters as
 * this node's API does, or as that of its versions keyed by when they applied
 * staples did, with the client's own Bloom filters, under the
 * conditions that make a peer's moments diverge from staple timestamps.
 */

const NOW = Date.UTC(2026, 9, 7, 12);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long the node waits between updates, as LocalNode does by default. */
const PERIOD = MINUTE;

/** A representative's largest page. */
const LIMIT = 1000;

/** How much later than the real time a peer answers, which is how the clock moves within a pass. */
const LATENCY = 25;

type UpdateRecord = {
	readonly outcome: PeerOutcome;
	readonly requests: number;
	readonly elapsed: number;
};

/** Traffic whose voters' clocks agree with the peer's. */
function steady(perSecond: number): LiveTraffic {
	return({ perSecond, voterSkew: function(): number {
		return(0);
	} });
}

/** A deterministic source of filter seeds, so that a run names the same staples by mistake each time. */
function seeds(): () => number {
	let state = 1;
	return(function(): number {
		state = (state * 48271) % 2147483647;
		return(state);
	});
}

/** What a follower keeps across a restart: its ledger, its retry queue's store, and its progress on each peer. */
type Kept = {
	readonly node: SimulatedNode;
	readonly retryStore: SimulatedRetryStore;
	readonly progress: Map<SimulatedPeer, PeerProgress>;
};

/** A simulated node with the retry queue it keeps for the staples its ledger refuses, and its progress on each peer. */
class Follower {
	readonly node: SimulatedNode;
	readonly retryStore: SimulatedRetryStore;
	readonly reports: RefusalReport[] = [];
	readonly retries: RetryQueue<SimulatedStaple>;
	readonly progress: Map<SimulatedPeer, PeerProgress>;
	readonly events: PassEvent[] = [];
	readonly #bounds: QueueBounds | undefined;
	readonly #answers = new Map<SimulatedPeer, LongestAnswer>();
	readonly #priming = new Map<SimulatedPeer, PrimingWindow>();
	readonly #seed = seeds();

	constructor(bounds?: QueueBounds, kept: Kept = { node: new SimulatedNode(), retryStore: new SimulatedRetryStore(), progress: new Map() }) {
		this.node = kept.node;
		this.retryStore = kept.retryStore;
		this.progress = kept.progress;
		this.#bounds = bounds;
		this.retries = simulatedRetries(this.node, this.retryStore, this.reports, bounds);
	}

	/** The follower after a restart: what it keeps, and nothing it learned while it ran. */
	restarted(): Follower {
		return(new Follower(this.#bounds, { node: this.node, retryStore: this.retryStore, progress: this.progress }));
	}

	/** How a pass over the peer reaches it and this node. */
	io(peer: SimulatedPeer): PeerIO<SimulatedStaple> {
		let answers = this.#answers.get(peer);
		if (answers === undefined) {
			answers = new LongestAnswer();
			this.#answers.set(peer, answers);
		}
		return({
			answers,
			priming: this.priming(peer),
			page: function(request) {
				return(peer.page(request));
			},
			held: async (from, count) => {
				const queued = (await this.retries.staples()).slice(0, count);
				return([...queued, ...await this.node.held(from, count - queued.length)]);
			},
			add: (staple, use) => {
				return(this.retries.add(staple, use));
			},
			retry: async () => {
				await this.retries.retry();
			},
			saturated: () => {
				return(Promise.resolve(this.retries.saturated()));
			},
			report: (event) => {
				this.events.push(event);
			},
			readProgress: () => {
				return(Promise.resolve(this.progress.get(peer)));
			},
			writeProgress: (progress) => {
				this.progress.set(peer, progress);
				return(Promise.resolve());
			}
		});
	}

	/** How passes over the peer name what the node holds, kept across them. */
	priming(peer: SimulatedPeer): PrimingWindow {
		let priming = this.#priming.get(peer);
		if (priming === undefined) {
			priming = new PrimingWindow();
			this.#priming.set(peer, priming);
		}
		return(priming);
	}

	options(from: Date = new Date(0)): PassOptions {
		return({ limit: LIMIT, seed: this.#seed, from });
	}
}

class Scenario {
	readonly peer: SimulatedPeer;
	readonly follower: Follower;
	readonly node: SimulatedNode;
	readonly updates: UpdateRecord[] = [];
	/** Staples the peer applies while each update reads it, and only then, so that a busy peer takes hours of updates without millions of staples. */
	trafficWhileRead: LiveTraffic | undefined;
	/** Where the passes over the peer start before any has moved on. */
	from = new Date(0);

	/** The staples, by ID, that the node refuses for a balance rather than for weight while they lack what they need. */
	constructor(options: SimulatedPeerOptions = {}, bounds?: QueueBounds, spending: ReadonlySet<number> = new Set()) {
		this.peer = new SimulatedPeer({ latency: LATENCY, keying, ...options });
		this.follower = new Follower(bounds, { node: new SimulatedNode(spending), retryStore: new SimulatedRetryStore(), progress: new Map() });
		this.node = this.follower.node;
	}

	/** One update: a pass over the peer, and the deep re-scan under way alongside, if any. */
	async update(): Promise<PeerOutcome> {
		const requests = this.peer.requests;
		const began = Date.now();
		if (this.trafficWhileRead !== undefined) {
			this.peer.goLive(this.trafficWhileRead);
		}
		const outcome = await bootstrapPeer(this.follower.io(this.peer), this.follower.options(this.from));
		if (this.trafficWhileRead !== undefined) {
			this.peer.stopLive();
		}
		this.updates.push({ outcome, requests: this.peer.requests - requests, elapsed: Date.now() - began });
		return(outcome);
	}

	/** Updates back to back until a pass holds every staple the peer had applied when it began, as a node catching up does. */
	async untilComplete(updates: number): Promise<void> {
		for (let update = 0; update < updates; update++) {
			if (completes((await this.update()).live)) {
				return;
			}
		}
		throw(new Error(`no pass completed within ${String(updates)} updates`));
	}

	/**
	 * Updates as the client schedules them (nextUpdateDelay) until a pass
	 * completes, and answers how long that took and how much of it the node
	 * spent waiting between updates.
	 */
	async onScheduleUntilComplete(updates: number): Promise<{ readonly took: number; readonly waited: number }> {
		const began = Date.now();
		let waited = 0;
		for (let update = 0; update < updates; update++) {
			const { live } = await this.update();
			if (completes(live)) {
				return({ took: Date.now() - began, waited });
			}
			const delay = nextUpdateDelay([resultOf(live)], PERIOD);
			advanceClock(delay);
			waited += delay;
		}
		throw(new Error(`no pass completed within ${String(updates)} updates`));
	}

	/**
	 * Updates until a pass completes, at once after one that ended at its
	 * bound and a period after one the peer gave up on, as the client schedules
	 * them, and answers how many it gave up on.
	 */
	async untilCompleteThroughFailures(updates: number): Promise<number> {
		let failed = 0;
		for (let update = 0; update < updates; update++) {
			let live: PassOutcome;
			try {
				({ live } = await this.update());
			} catch (error: unknown) {
				// Only a pass the peer gave up on is expected to fail.
				if (!(error instanceof Error) || !error.message.includes('gave up')) {
					throw(error);
				}
				failed++;
				advanceClock(PERIOD);
				continue;
			}
			if (completes(live)) {
				return(failed);
			}
		}
		throw(new Error(`no pass completed within ${String(updates)} updates, ${String(failed)} of which failed`));
	}

	/** Updates on the period for that long. */
	async periodically(duration: number): Promise<void> {
		for (let waited = 0; waited < duration; waited += PERIOD) {
			advanceClock(PERIOD);
			await this.update();
		}
	}

	/** Updates on the period for that long, as the client does whether or not an update failed. */
	async periodicallyThroughFailures(duration: number): Promise<void> {
		for (let waited = 0; waited < duration; waited += PERIOD) {
			advanceClock(PERIOD);
			try {
				await this.update();
			} catch (error: unknown) {
				if (!(error instanceof RetryQueueFull)) {
					throw(error);
				}
			}
		}
	}

	/**
	 * Updates on the period until a deep re-scan has run that many times,
	 * which answers what was missing before the update that ran it last.
	 */
	async untilDeepScans(count: number): Promise<readonly number[]> {
		for (let update = 0; update < 3 * DEEP_SCAN_PERIOD_MILLISECONDS / PERIOD; update++) {
			const missing = this.missing();
			advanceClock(PERIOD);
			await this.update();
			if (this.deepScans().length === count) {
				return(missing);
			}
		}
		throw(new Error(`no ${String(count)} deep re-scans ran`));
	}

	/** The staples the peer holds and the node does not. */
	missing(): readonly number[] {
		return(this.peer.staples.filter((staple) => {
			return(!this.node.holds(staple));
		}).map(function(staple): number {
			return(staple.id);
		}));
	}

	/** Every update ended within the bounds of its two passes, and none hung. */
	expectEveryUpdateBounded(): void {
		for (const update of this.updates) {
			expect(update.requests).toBeLessThanOrEqual(2 * MAX_PASS_REQUESTS);
			expect(update.elapsed).toBeLessThanOrEqual(MAX_PASS_MILLISECONDS + 2 * LATENCY);
		}
	}

	liveOutcomes(): readonly PassOutcome['kind'][] {
		return(this.updates.map(function(update): PassOutcome['kind'] {
			return(update.outcome.live.kind);
		}));
	}

	deepScans(): readonly PassOutcome[] {
		return(this.updates.flatMap(function(update): PassOutcome[] {
			if (update.outcome.deepScan === undefined) {
				return([]);
			}
			return([update.outcome.deepScan]);
		}));
	}
}

function resultOf(outcome: PassOutcome): PeerResult {
	if (completes(outcome)) {
		return('completed');
	}
	return('bounded');
}

function noSkew(): number {
	return(0);
}

function noNeeds(): readonly number[] {
	return([]);
}

/** What a network of peers keeps of a follower's updates in the follower's store besides its progress: the horizon of the first pass that completed, and its ranges. */
type NetworkStore = { caughtUp: Date | undefined; layout: RangeLayout | undefined };

/** A pass over a range an update ran, and how it ended. */
type RangeRun = { readonly peer: string; readonly result: RangeResult };

/** Several peers a follower bootstraps from, by name, as an update over every peer reads them, in ranges while far behind (src/node/bootstrap-update.ts, src/node/bootstrap-ranges.ts). */
class SimulatedNetwork {
	readonly #follower: Follower;
	readonly #peers: ReadonlyMap<string, SimulatedPeer>;
	readonly #store: NetworkStore;
	readonly rangeEvents: RangeEvent[] = [];
	readonly rangeRuns: RangeRun[] = [];
	/** The passes from where the node last reached that failed. */
	failures = 0;

	constructor(follower: Follower, peers: ReadonlyMap<string, SimulatedPeer>, store: NetworkStore = { caughtUp: undefined, layout: undefined }) {
		this.#follower = follower;
		this.#peers = peers;
		this.#store = store;
	}

	/** The network as a follower that restarted reads it: from what its store kept. */
	restarted(): SimulatedNetwork {
		return(new SimulatedNetwork(this.#follower.restarted(), this.#peers, this.#store));
	}

	get follower(): Follower {
		return(this.#follower);
	}

	get layout(): RangeLayout | undefined {
		return(this.#store.layout);
	}

	/** One update over every peer, which answers how each pass ended, in the peers' order: a pass that fails, as the client logs it, as failed. */
	async update(): Promise<PeerResult[]> {
		const follower = this.#follower;
		const store = this.#store;
		const peerNamed = (name: string): SimulatedPeer => {
			const peer = this.#peers.get(name);
			if (peer === undefined) {
				throw(new Error(`no peer is named ${name}`));
			}
			return(peer);
		};
		const progressIO = {
			readProgress: function(name: string): Promise<PeerProgress | undefined> {
				return(Promise.resolve(follower.progress.get(peerNamed(name))));
			},
			writeProgress: function(name: string, progress: PeerProgress): Promise<void> {
				follower.progress.set(peerNamed(name), progress);
				return(Promise.resolve());
			}
		};
		const names = [...this.#peers.keys()];
		const results = await updateRanges(names, {
			...progressIO,
			readLayout: function() {
				return(Promise.resolve(store.layout));
			},
			writeLayout: function(layout) {
				store.layout = layout;
				return(Promise.resolve());
			},
			saturated: function() {
				return(Promise.resolve(follower.retries.saturated()));
			},
			roomAhead: function() {
				return(follower.retries.hasRoom('ahead'));
			},
			report: (event) => {
				this.rangeEvents.push(event);
			}
		}, async (name, task): Promise<RangeResult> => {
			let result: RangeResult;
			try {
				result = rangeResultOf(await bootstrapRange(follower.io(peerNamed(name)), task, follower.options(task.from)));
			} catch (error: unknown) {
				result = 'failed';
				if (error instanceof RetryQueueFull) {
					result = 'throttled';
				}
			}
			this.rangeRuns.push({ peer: name, result });
			return(result);
		}) ?? await updatePeers(names, {
			...progressIO,
			readCaughtUp: function() {
				return(Promise.resolve(store.caughtUp));
			},
			writeCaughtUp: function(horizon) {
				store.caughtUp = horizon;
				return(Promise.resolve());
			}
		}, this.#peers.size, async (name, from): Promise<PeerResult> => {
			try {
				const { live } = await bootstrapPeer(follower.io(peerNamed(name)), follower.options(from));
				return(resultOf(live));
			} catch {
				this.failures++;
				return('failed');
			}
		});
		return(names.map(function(name): PeerResult {
			return(results.get(name) ?? 'failed');
		}));
	}

	/** The staples the peers sent in all. */
	served(): number {
		let served = 0;
		for (const peer of this.#peers.values()) {
			served += peer.served;
		}
		return(served);
	}

	/** The staples some peer holds and the node does not. */
	missing(): readonly number[] {
		const missing = new Set<number>();
		for (const peer of this.#peers.values()) {
			for (const staple of peer.staples) {
				if (!this.#follower.node.holds(staple)) {
					missing.add(staple.id);
				}
			}
		}
		return([...missing]);
	}
}

/** History the peer applied as it was made, so many a second, ending at the moment given, each staple needing those named by ID. */
function liveHistory(peer: SimulatedPeer, count: number, perSecond: number, endingAt: number, voterSkew: (index: number) => number = noSkew, needs: (index: number) => readonly number[] = noNeeds): void {
	const spacing = 1000 / perSecond;
	for (let index = 0; index < count; index++) {
		const madeAt = Math.floor(endingAt - (count - index) * spacing);
		peer.apply(madeAt + voterSkew(index), madeAt, needs(index));
	}
}

/** The staple the peer applied at that index of its order. */
function stapleAt(peer: SimulatedPeer, index: number): SimulatedStaple {
	const staple = peer.staples[index];
	if (staple === undefined) {
		throw(new Error(`the peer applied no staple at ${String(index)}`));
	}
	return(staple);
}

/** The ID of a staple no peer applies: one that needs it is refused forever. */
const NEVER_APPLIED = -1;

/**
 * History a peer applied in an order that is not causal, as the main
 * network's representatives serve theirs: genesis, which gives voting
 * weight to every staple after it, comes fifth; debits come before the
 * credits they spend, some a page and a filter later; a token's sends come
 * before its supply; and one staple waits on a chain of three.
 */
function outOfOrderHistory(peer: SimulatedPeer, count: number, endingAt: number): void {
	const genesis = 4;
	const needs = new Map<number, number[]>();
	function need(index: number, on: number): void {
		needs.set(index, [...needs.get(index) ?? [], on]);
	}
	for (let index = 0; index < count; index++) {
		if (index !== genesis) {
			need(index, genesis);
		}
	}
	for (let debit = 100; debit < count - 1500; debit += 40) {
		need(debit, debit + 1 + (debit % 3) * 700);
	}
	const supply = count - 500;
	for (let send = supply - 400; send < supply - 380; send++) {
		need(send, supply);
	}
	need(600, 700);
	need(700, 800);
	need(800, count - 1);
	const spacing = 100;
	for (let index = 0; index < count; index++) {
		const madeAt = endingAt - (count - index) * spacing;
		peer.apply(madeAt, madeAt, needs.get(index) ?? []);
	}
}

/*
 * Each scenario sends hundreds to thousands of requests through the client's
 * own Bloom filters, which cost about 15 ms each to build and to test a page
 * against, so they are given more time than the suite's default.
 */
/**
 * How the peers of a scenario key and list their staples: by when they
 * applied them, as earlier versions of this node did, or by votes, in reads
 * of at most 200 votes, as this node and the main network's representatives
 * do, with reads quick enough not to bound passes in time.
 */
const ORDERINGS: readonly (readonly [string, SimulatedKeying])[] = [
	['lists staples in the order it applied them', { kind: 'applied' }],
	['lists staples by their votes\' timestamps', { kind: 'votes', votesPerRead: 200, readsAtMost: Number.POSITIVE_INFINITY, readMilliseconds: 0 }]
];

let keying: SimulatedKeying = { kind: 'applied' };

/**
 * A peer whose time for a request runs out once it has read about that many
 * staples, those the filter names included: counted in staples, or, keyed
 * by votes, in reads of about four votes a staple.
 */
function outOfTimeAfter(staples: number): SimulatedPeerOptions {
	switch (keying.kind) {
		case 'applied':
			return({ readsAtMost: staples });
		case 'votes':
			return({ keying: { ...keying, readsAtMost: Math.max(1, Math.round(staples * 4 / keying.votesPerRead)) } });
		default:
			return(assertNever(keying));
	}
}

/**
 * A peer whose time for a request runs out once it has listed about that
 * many staples: one keyed by when it applied them cuts the list there, and one keyed
 * by votes stops after the read that brings it there, in reads of about
 * four votes a staple.
 */
function outOfTimeHolding(staples: number): SimulatedPeerOptions {
	switch (keying.kind) {
		case 'applied':
			return({ answersAtMost: staples });
		case 'votes':
			return({ keying: { ...keying, readsAtMost: Math.max(1, Math.round(staples * 4 / keying.votesPerRead)) } });
		default:
			return(assertNever(keying));
	}
}

describe.each(ORDERINGS)('bootstrapping against a simulated peer that %s', { timeout: 120_000 }, function(_ignored: string, scenarioKeying: SimulatedKeying) {
	beforeEach(function() {
		keying = scenarioKeying;
	});

	afterEach(function() {
		vi.useRealTimers();
	});

	test('holds every staple of a peer that applies 100 a second during the catch-up', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario();
		liveHistory(scenario.peer, 10_000, 100, NOW);
		scenario.peer.goLive(steady(100));

		await scenario.untilComplete(10);
		scenario.peer.stopLive();
		await scenario.untilComplete(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryUpdateBounded();
	});

	test('holds every staple of a peer that applied its history long after it was made, as one that bootstrapped does', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario();
		const count = 10_000;
		// Made over a month, applied within a second an hour ago, twenty to a millisecond.
		for (let index = 0; index < count; index++) {
			scenario.peer.apply(NOW - 30 * DAY + index * Math.floor(30 * DAY / count), NOW - HOUR + Math.floor(index / 20));
		}

		await scenario.untilComplete(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryUpdateBounded();
	});

	test('holds every staple whose voters\' clocks ran up to 60 s ahead', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario();
		liveHistory(scenario.peer, 10_000, 50, NOW - HOUR, function(index): number {
			return((index * 7919) % MINUTE);
		});
		scenario.peer.goLive({ perSecond: 20, voterSkew: function(madeAt): number {
			return(madeAt % MINUTE);
		} });

		await scenario.untilComplete(10);
		await scenario.periodically(5 * PERIOD);
		scenario.peer.stopLive();
		await scenario.untilComplete(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryUpdateBounded();
	});

	test('holds every staple of a peer whose clock runs minutes behind the node\'s', async function() {
		freezeClock(new Date(NOW));
		const behind = -4 * MINUTE;
		const scenario = new Scenario({ clockOffset: behind });
		liveHistory(scenario.peer, 2000, 10, NOW + behind);
		// The peer votes too, on its own clock.
		scenario.peer.goLive({ perSecond: 10, voterSkew: function(): number {
			return(behind);
		} });

		await scenario.update();
		await scenario.periodically(10 * PERIOD);
		scenario.peer.stopLive();
		await scenario.untilComplete(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryUpdateBounded();
	});

	test.each([['caps the limit', { answersAtMost: 400 }], ['runs out of time for a request', undefined]])('holds every staple of a peer that %s, whose pages come back short', async function(_ignored: string, capped: SimulatedPeerOptions | undefined) {
		freezeClock(new Date(NOW));
		const scenario = new Scenario(capped ?? outOfTimeHolding(100));
		liveHistory(scenario.peer, 20_000, 100, NOW - HOUR);

		await scenario.untilComplete(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryUpdateBounded();
	});

	test('holds every staple of a peer whose time for a request runs out on the staples the filter names too, in about as many requests as pages of its history', async function() {
		freezeClock(new Date(NOW));
		const reads = 150;
		const scenario = new Scenario(outOfTimeAfter(reads));
		const count = 20_000;
		liveHistory(scenario.peer, count, 10, NOW - HOUR);

		await scenario.untilComplete(10);

		expect(scenario.missing()).toEqual([]);
		const requests = scenario.updates.reduce(function(sum, update): number {
			return(sum + update.requests);
		}, 0);
		expect(requests).toBeLessThan(4 * count / reads);
		scenario.expectEveryUpdateBounded();
	});

	/*
	 * A main network representative answers a page of about 140 staples in
	 * about 2.8 s, and the node rests 1 s before its next request to it, so
	 * a catch-up runs pass after pass, each ended by its bound in time.
	 */
	test('catches up pass after pass with no wait between them while the peer is ahead, as long as its passes take', async function() {
		freezeClock(new Date(NOW));
		const latency = 3800;
		const scenario = new Scenario({ latency, ...outOfTimeAfter(140) });
		const count = 20_000;
		liveHistory(scenario.peer, count, 10, NOW - HOUR);

		const { took, waited } = await scenario.onScheduleUntilComplete(20);

		expect(scenario.missing()).toEqual([]);
		const bounded = scenario.updates.length - 1;
		expect(bounded).toBeGreaterThan(3);
		expect(waited).toBe(0);
		const passes = scenario.updates.reduce(function(sum, update): number {
			return(sum + update.elapsed);
		}, 0);
		expect(took).toBe(passes);
		// Waiting the period after each bounded pass would have taken a third as long again.
		expect(took + bounded * PERIOD).toBeGreaterThan(1.3 * took);
		for (const update of scenario.updates) {
			// A request under way when the bound falls is answered.
			expect(update.elapsed).toBeLessThanOrEqual(MAX_PASS_MILLISECONDS + latency);
		}
	});

	test('holds every staple of a peer that holds blocks the node holds with other votes', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario();
		liveHistory(scenario.peer, 3000, 10, NOW - HOUR);
		for (const staple of scenario.peer.staples.slice(1000, 1100)) {
			await scenario.node.add(scenario.peer.otherVotesOn(staple));
		}

		await scenario.untilComplete(5);

		expect(scenario.missing()).toEqual([]);
		expect(scenario.updates.map(function(update): string {
			return(update.outcome.live.kind);
		})).toEqual(['drained']);
	});

	test('holds every staple of a peer that applied more at one moment than a filter and a page hold, as one releasing deferred staples does', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario();
		const burst = BLOOM_CAPACITY + LIMIT + 800;
		liveHistory(scenario.peer, 1000, 10, NOW - 2 * HOUR);
		for (let index = 0; index < burst; index++) {
			scenario.peer.apply(NOW - 3 * HOUR + index, NOW - HOUR);
		}
		liveHistory(scenario.peer, 1000, 10, NOW);

		await scenario.untilComplete(5);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryUpdateBounded();
	});

	test('holds every staple of a peer that serves its history out of causal order', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario();
		outOfOrderHistory(scenario.peer, 3000, NOW - HOUR);

		await scenario.untilComplete(10);

		expect(scenario.missing()).toEqual([]);
		expect(await scenario.follower.retries.size()).toBe(0);
		expect(scenario.follower.reports).toEqual([]);
		scenario.expectEveryUpdateBounded();
	});

	test('keeps a staple its ledger refuses forever queued, reports it once after an hour, and catches up on every other staple meanwhile', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario();
		liveHistory(scenario.peer, 1500, 10, NOW - 2 * HOUR);
		const refused = scenario.peer.apply(NOW - 2 * HOUR, NOW - 2 * HOUR, [NEVER_APPLIED]);
		liveHistory(scenario.peer, 1500, 10, NOW - HOUR);
		scenario.peer.goLive(steady(10));

		await scenario.untilComplete(10);
		expect(scenario.missing()).toContain(refused.id);
		await scenario.periodically(REPORT_REFUSED_AFTER_MILLISECONDS + 10 * PERIOD);
		scenario.peer.stopLive();
		await scenario.untilComplete(3);

		expect(scenario.missing()).toEqual([refused.id]);
		expect((await scenario.follower.retries.staples()).map(function(queued): string {
			return(queued.blocksHash.toString());
		})).toEqual([refused.blocksHash.toString()]);
		expect(scenario.follower.reports.map(function({ id, code }): string {
			return(`${String(id)} ${code}`);
		})).toEqual([`${String(refused.id)} LEDGER_INSUFFICIENT_VOTING_WEIGHT`]);
		expect(scenario.follower.reports[0]?.age).toBeGreaterThanOrEqual(REPORT_REFUSED_AFTER_MILLISECONDS);
		expect(scenario.liveOutcomes().slice(1).every(function(kind): boolean {
			return(kind !== 'bounded');
		})).toBe(true);
		scenario.expectEveryUpdateBounded();
	});

	test('offers a staple refused for want of weight again only once its voters have the weight, however many pages come before the staple that gives it', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario({ answersAtMost: 50 });
		const count = 800;
		const genesis = count - 1;
		// Every other staple needs genesis's weight, and the rest need nothing, so that every page adds some.
		const waiting = function(index: number): boolean {
			return(index % 2 === 0 && index !== genesis);
		};
		liveHistory(scenario.peer, count, 10, NOW - HOUR, noSkew, function(index): readonly number[] {
			if (waiting(index)) {
				return([genesis]);
			}
			return([]);
		});

		await scenario.untilComplete(10);

		expect(scenario.missing()).toEqual([]);
		expect(await scenario.follower.retries.size()).toBe(0);
		// Each staple is refused at most as it arrives, and offered again only once genesis has given its voters weight.
		expect(scenario.node.refused).toBeLessThanOrEqual(count / 2);
	});

	test('offers a staple refused for a balance again once a staple lands on an account it names, long before its wait has passed', async function() {
		freezeClock(new Date(NOW));
		const debits = Array.from({ length: 50 }, function(_unused, index): number {
			return(index * 10);
		});
		const scenario = new Scenario({ answersAtMost: 50 }, undefined, new Set(debits));
		liveHistory(scenario.peer, 1000, 10, NOW - HOUR, noSkew, function(index): readonly number[] {
			if (debits.includes(index)) {
				return([index + 500]);
			}
			return([]);
		});

		const began = Date.now();
		await scenario.untilComplete(10);

		expect(scenario.missing()).toEqual([]);
		expect(scenario.node.refused).toBe(debits.length);
		expect(Date.now() - began).toBeLessThan(FIRST_BACKOFF_MILLISECONDS);
	});

	test('offers a staple that stays refused again after a wait that doubles with each refusal, up to the longest, however often passes run', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario({ answersAtMost: 50 });
		liveHistory(scenario.peer, 500, 10, NOW - HOUR);
		scenario.peer.apply(NOW - HOUR, NOW - HOUR, [NEVER_APPLIED]);
		liveHistory(scenario.peer, 500, 10, NOW - MINUTE);

		await scenario.untilComplete(10);
		const refusedAtFirst = scenario.node.refused;
		await scenario.periodically(2 * HOUR);

		let waits = 0;
		let offers = 0;
		for (let refusals = 1; waits + backoffAfter(refusals) <= 2 * HOUR; refusals++) {
			waits += backoffAfter(refusals);
			offers++;
		}
		// Updates run every minute, so each offer comes within a minute of when it is due.
		expect(scenario.node.refused - refusedAtFirst).toBeGreaterThanOrEqual(offers - 1);
		expect(scenario.node.refused - refusedAtFirst).toBeLessThanOrEqual(offers + 1);
		expect(backoffAfter(offers)).toBe(LAST_BACKOFF_MILLISECONDS);
	});

	test('fails a pass rather than move past a refused staple its full queue has no room for, and moves on once the queue drains', async function() {
		freezeClock(new Date(NOW));
		const bounds: QueueBounds = { staples: 10, bytes: 1024 * 1024 };
		const scenario = new Scenario({}, bounds);
		// Twenty sends of a token whose supply comes far later: more than the queue holds.
		const supplyAt = 2900;
		liveHistory(scenario.peer, 3000, 10, NOW - HOUR, undefined, function(index): readonly number[] {
			if (index >= 100 && index < 120) {
				return([supplyAt]);
			}
			return([]);
		});
		const supply = stapleAt(scenario.peer, supplyAt);
		const tenth = stapleAt(scenario.peer, 100 + bounds.staples - 1);

		await expect(scenario.update()).rejects.toThrow(RetryQueueFull);

		// A pass from where the last reached leaves a tenth of the queue to deep re-scans.
		expect(scenario.follower.retryStore.largest).toBe(bounds.staples - 1);
		expect(scenario.follower.progress.get(scenario.peer)?.reached.getTime()).toBeLessThanOrEqual(tenth.moment);
		expect(scenario.missing()).toContain(tenth.id);

		// The staple the sends need arrives otherwise, as over P2P.
		await scenario.node.add(supply);
		await scenario.untilComplete(5);

		expect(scenario.missing()).toEqual([]);
		expect(await scenario.follower.retries.size()).toBe(0);
		expect(scenario.follower.retryStore.largest).toBeLessThanOrEqual(bounds.staples);
	});

	test('re-reads the peer, once a full queue stops every pass, for a staple a pass missed that the queued staples need', async function() {
		freezeClock(new Date(NOW));
		const bounds: QueueBounds = { staples: 20, bytes: 1024 * 1024 };
		const scenario = new Scenario({}, bounds);
		// Fifty sends of a token whose supply, past the first page, which no filter names, a pass missed long before: more than the queue holds.
		const supplyAt = 1500;
		liveHistory(scenario.peer, 5000, 10, NOW - HOUR, undefined, function(index): readonly number[] {
			if (index >= 3000 && index % 40 === 0) {
				return([supplyAt]);
			}
			return([]);
		});
		const supply = stapleAt(scenario.peer, supplyAt);
		scenario.peer.forceFalsePositive(supply);
		await expect(scenario.update()).rejects.toThrow(RetryQueueFull);
		scenario.peer.forceFalsePositive(undefined);
		expect(scenario.missing()).toContain(supply.id);

		await scenario.periodicallyThroughFailures(15 * PERIOD);

		expect(scenario.missing()).toEqual([]);
		expect(await scenario.follower.retries.size()).toBe(0);
		expect(completes(scenario.updates.at(-1)?.outcome.live ?? { kind: 'bounded', reached: new Date(0) })).toBe(true);
	});

	test('downloads each staple about once in a first catch-up from four peers that hold the same history, then reads each peer on its own', async function() {
		freezeClock(new Date(NOW));
		const follower = new Follower();
		const peers = new Map(['rep1', 'rep2', 'rep3', 'rep4'].map(function(name): [string, SimulatedPeer] {
			return([name, new SimulatedPeer({ latency: LATENCY, keying })]);
		}));
		const [first, ...others] = [...peers.values()];
		if (first === undefined) {
			throw(new Error('no peers'));
		}
		const count = 5000;
		outOfOrderHistory(first, count, NOW - HOUR);
		// Each representative applies the same staples at moments of its own.
		others.forEach(function(peer, index): void {
			for (const staple of first.staples) {
				peer.applyAlso(staple, staple.moment + (index + 1) * 7);
			}
		});
		const network = new SimulatedNetwork(follower, peers);

		expect(await network.update()).toEqual(['completed', 'completed', 'completed', 'completed']);

		// A peer keyed by votes lists again a staple whose votes two reads share.
		expect(network.served()).toBeLessThan(1.2 * count);
		expect(network.missing()).toEqual([]);
		expect(await follower.retries.size()).toBe(0);

		advanceClock(PERIOD);
		const third = peers.get('rep3');
		const onlyOnThird = third?.apply(Date.now(), Date.now());
		expect(await network.update()).toEqual(['completed', 'completed', 'completed', 'completed']);
		expect(onlyOnThird !== undefined && follower.node.holds(onlyOnThird)).toBe(true);
		expect(network.missing()).toEqual([]);
	});

	/*
	 * A peer commits staples at moments the passes have read past: within the
	 * margin, which the next pass reads again, or further back, which only a
	 * deep re-scan reads.
	 */
	describe('against a peer that commits staples late', function() {
		async function lateCommitting(within: number): Promise<Scenario> {
			const scenario = new Scenario();
			liveHistory(scenario.peer, 20_000, 100, NOW);
			scenario.peer.goLive(steady(100));
			scenario.peer.commitLate({ perRequest: 5, within });
			await scenario.update();
			await scenario.periodically(3 * PERIOD);
			scenario.peer.stopLive();
			scenario.peer.commitLate(undefined);
			await scenario.periodically(PERIOD);
			return(scenario);
		}

		test('holds, once the next pass has read the margin again, every staple committed up to 55 s late', async function() {
			freezeClock(new Date(NOW));

			const scenario = await lateCommitting(55 * SECOND);

			expect(scenario.missing()).toEqual([]);
			scenario.expectEveryUpdateBounded();
		});

		test('holds, once a deep re-scan has read the peer again, every staple committed up to 20 min late', async function() {
			freezeClock(new Date(NOW));

			const scenario = await lateCommitting(20 * MINUTE);

			expect((await scenario.untilDeepScans(1)).length).toBeGreaterThan(0);
			expect(scenario.missing()).toEqual([]);
			expect(scenario.deepScans().every(completes)).toBe(true);
			scenario.expectEveryUpdateBounded();
		});
	});

	/*
	 * A peer whose clock runs behind the node's by more than a pass lasts has
	 * applied no staple at the moment a pass began while the pass runs, and
	 * one that applies more than a staple per round trip never answers an
	 * empty page.
	 */
	describe('against a peer applying 100 staples a second on a clock behind the node\'s', function() {
		test('ends every pass caught up while the peer runs 90 s behind', async function() {
			freezeClock(new Date(NOW));
			const behind = 90 * SECOND;
			const scenario = new Scenario({ clockOffset: -behind });
			liveHistory(scenario.peer, 3000, 10, NOW - HOUR - behind);
			scenario.peer.goLive(steady(100));

			expect((await scenario.update()).live).toEqual({ kind: 'caught-up' });
			await scenario.periodically(5 * PERIOD);
			scenario.peer.stopLive();

			expect(scenario.liveOutcomes()).toEqual(Array.from(scenario.updates, function(): string {
				return('caught-up');
			}));
			await scenario.untilComplete(3);
			expect(scenario.missing()).toEqual([]);
			scenario.expectEveryUpdateBounded();
		});

		test.each([['90 s', 90 * SECOND], ['4 min', 4 * MINUTE]])('ends every pass caught up while the peer runs %s behind, so that a deep re-scan runs and recovers a staple a filter named by mistake', async function(_ignored: string, behind: number) {
			freezeClock(new Date(NOW));
			const scenario = new Scenario({ clockOffset: -behind });
			liveHistory(scenario.peer, 3000, 10, NOW - HOUR - behind);
			const unlucky = scenario.peer.staples[1500];
			scenario.peer.forceFalsePositive(unlucky);
			scenario.trafficWhileRead = steady(100);

			expect((await scenario.update()).live).toEqual({ kind: 'caught-up' });
			scenario.peer.forceFalsePositive(undefined);

			expect(await scenario.untilDeepScans(1)).toContain(unlucky?.id);
			expect(scenario.missing()).not.toContain(unlucky?.id);
			expect(scenario.deepScans()).toEqual([{ kind: 'caught-up' }]);
			expect(scenario.liveOutcomes()).toEqual(Array.from(scenario.updates, function(): string {
				return('caught-up');
			}));
			scenario.trafficWhileRead = undefined;
			await scenario.untilComplete(3);
			expect(scenario.missing()).toEqual([]);
			scenario.expectEveryUpdateBounded();
		});
	});

	test('recovers, with the deep re-scan, a staple a filter named by mistake during the catch-up', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario();
		// Made well before the margin, so that only the deep re-scan reads it again.
		liveHistory(scenario.peer, 3000, 10, NOW - HOUR);
		const unlucky = scenario.peer.staples[1500];
		scenario.peer.forceFalsePositive(unlucky);

		await scenario.untilComplete(1);
		scenario.peer.forceFalsePositive(undefined);

		expect(await scenario.untilDeepScans(1)).toEqual([unlucky?.id]);
		expect(scenario.missing()).toEqual([]);
		expect(scenario.deepScans()).toEqual([{ kind: 'drained' }]);
		scenario.expectEveryUpdateBounded();
	});

	test('recovers, with the next deep re-scan, a staple committed later than the margin that the first deep re-scan\'s filter named by mistake', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario();
		liveHistory(scenario.peer, 3000, 10, NOW);
		await scenario.untilComplete(1);
		await scenario.periodically(2 * PERIOD);
		const late = scenario.peer.apply(Date.now() - 20 * MINUTE, Date.now() - 20 * MINUTE);
		scenario.peer.forceFalsePositive(late);

		expect(await scenario.untilDeepScans(1)).toEqual([late.id]);
		expect(scenario.missing()).toEqual([late.id]);
		scenario.peer.forceFalsePositive(undefined);

		expect(await scenario.untilDeepScans(2)).toEqual([late.id]);
		expect(scenario.missing()).toEqual([]);
		expect(scenario.deepScans().every(completes)).toBe(true);
		scenario.expectEveryUpdateBounded();
	});
});

/*
 * A main network representative keys each vote at the moment it was made,
 * reads about 20 at a time, from 15 to 25 as its storage returns them,
 * lists a staple once per read that holds one of its votes, and runs out of
 * time after about ten reads, taking about 0.45 s for each; with the node's
 * 1 s rest, a page of about 50 staples, more or fewer, comes every 5.8 s.
 */
describe('bootstrapping against a peer keyed by votes, as the main network\'s representatives are', { timeout: 120_000 }, function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	const REPRESENTATIVE: SimulatedPeerOptions = {
		latency: 1300,
		keying: { kind: 'votes', votesPerRead: 20, readsAtMost: 10, readMilliseconds: 450, readsVaryBy: 5 }
	};

	function requestsOf(scenario: Scenario): number {
		return(scenario.updates.reduce(function(sum, update): number {
			return(sum + update.requests);
		}, 0));
	}

	test('catches up on its history, at the rate it allows', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario(REPRESENTATIVE);
		const count = 3000;
		liveHistory(scenario.peer, count, 0.1, NOW - HOUR);
		scenario.from = new Date(NOW - HOUR - count * 10 * SECOND - MINUTE);

		const { took } = await scenario.onScheduleUntilComplete(60);

		expect(scenario.missing()).toEqual([]);
		// It was 344 requests, about nine staples each, 160 staples a minute, when each page was followed by probes; it is now about one request a page, near the 517 a minute that pages of about 50 staples every 5.8 s allow. A page as long as the longest the peer listed may have been cut by a limit of its own, and costs a second request.
		expect(count / requestsOf(scenario)).toBeGreaterThan(30);
		expect(count / (took / MINUTE)).toBeGreaterThan(400);
	});

	/*
	 * A probe that the peer answers with a staple of the page shows only
	 * that one of its votes was made at or after the moment probed, which
	 * need not be a vote the page read: the page may have ended before the
	 * votes of other staples made before that moment.
	 */
	test('holds every staple, whose votes were made up to minutes apart', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario(REPRESENTATIVE);
		const count = 3000;
		for (let index = 0; index < count; index++) {
			const madeAt = NOW - HOUR - (count - index) * 10 * SECOND;
			let stamps = [madeAt - 900, madeAt - 500, madeAt - 200, madeAt];
			if (index % 3 === 0) {
				// One voter's vote was made long after the others', as one a representative traded in late.
				stamps = [madeAt - 900, madeAt - 500, madeAt - 200, madeAt + (1 + index % 13) * MINUTE];
			}
			scenario.peer.applyVoted(madeAt, madeAt, [], stamps);
		}
		scenario.from = new Date(NOW - HOUR - count * 10 * SECOND - MINUTE);

		await scenario.onScheduleUntilComplete(60);

		expect(scenario.missing()).toEqual([]);
	});

	/*
	 * A representative runs out of time for a request only once it has a
	 * staple to send, so one asked to leave out every staple ahead of the
	 * start reads on until its gateway gives up, as the main network's did
	 * when the node named the 1200 staples it held ahead of the start. The
	 * node holds most of the history already, as after its cursors are reset.
	 */
	test('reads again the history it holds from a peer that gives up past too many named staples, naming fewer ahead of the start', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario({ ...REPRESENTATIVE, givesUpPastNamed: 200 });
		const count = 3000;
		liveHistory(scenario.peer, count, 0.1, NOW - HOUR);
		for (const staple of scenario.peer.staples.slice(0, 2500)) {
			await scenario.node.add(staple);
		}
		scenario.from = new Date(NOW - HOUR - count * 10 * SECOND - MINUTE);

		const failed = await scenario.untilCompleteThroughFailures(80);

		expect(scenario.missing()).toEqual([]);
		expect({ failed, gaveUp: scenario.peer.gaveUp }).toEqual({ failed: 0, gaveUp: 0 });
	});

	test('names fewer staples it holds ahead of the start each time a peer gives up, and holds every staple', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario({ ...REPRESENTATIVE, givesUpPastNamed: 100 });
		const count = 3000;
		liveHistory(scenario.peer, count, 0.1, NOW - HOUR);
		for (const staple of scenario.peer.staples.slice(0, 2500)) {
			await scenario.node.add(staple);
		}
		scenario.from = new Date(NOW - HOUR - count * 10 * SECOND - MINUTE);

		const failed = await scenario.untilCompleteThroughFailures(120);

		expect(scenario.missing()).toEqual([]);
		// It halves from 128 below what the peer reads past, and growing back past it costs one more now and then.
		expect(failed).toBeGreaterThan(0);
		expect(failed).toBe(scenario.peer.gaveUp);
	});

	/*
	 * Read without a filter, the main network's first representative answered
	 * at once from a start where every request carrying the node's filter
	 * timed out at its gateway, however few staples the filter named.
	 */
	test('reads with no filter, until a pass completes, a peer that gives up on every request carrying one from a stretch of its history', async function() {
		freezeClock(new Date(NOW));
		const count = 3000;
		const first = NOW - HOUR - count * 10 * SECOND;
		const scenario = new Scenario({ ...REPRESENTATIVE, givesUpFilteredWithin: { from: first + 1000 * 10 * SECOND, to: first + 1600 * 10 * SECOND } });
		liveHistory(scenario.peer, count, 0.1, NOW - HOUR);
		scenario.from = new Date(first - MINUTE);
		// Read with no filter, a page from the start is never empty, so a pass shows it holds everything before its horizon only by staples applied after it.
		scenario.trafficWhileRead = steady(0.2);

		const failed = await scenario.untilCompleteThroughFailures(120);

		expect(scenario.missing()).toEqual([]);
		// The window halves four times to its floor, where the next give-up drops the filter.
		expect(failed).toBe(4);
		expect(scenario.follower.priming(scenario.peer)).toMatchObject({ unfiltered: false });
	});

	/** Staples made one a second over the hour before, each with four votes within a second, from a peer keyed by votes as given. */
	function votedHistory(options: SimulatedPeerOptions, count: number, spacing: number): Scenario {
		const scenario = new Scenario(options);
		liveHistory(scenario.peer, count, 1000 / spacing, NOW - HOUR);
		scenario.from = new Date(NOW - HOUR - count * spacing - MINUTE);
		return(scenario);
	}

	/*
	 * A peer that caps the limit cuts a page within a read, and a page shorter
	 * than the limit asked for may then not have listed every staple of its
	 * last read: those it left out, and every staple whose votes all fell in
	 * that read, are not listed from any later start.
	 */
	test('holds every staple of a peer that caps the limit below what a read lists', async function() {
		freezeClock(new Date(NOW));
		const scenario = votedHistory({ latency: 1300, answersAtMost: 30, keying: { kind: 'votes', votesPerRead: 200, readsAtMost: Number.POSITIVE_INFINITY, readMilliseconds: 0 } }, 3000, 10 * SECOND);

		await scenario.onScheduleUntilComplete(60);

		expect(scenario.missing()).toEqual([]);
	});

	test('holds every staple of a peer that keys each vote up to the tolerance from when it was made', async function() {
		freezeClock(new Date(NOW));
		const jitter: VoteKey = function(made, staple, vote): number {
			return(made + (staple * 7919 + vote * 104_729) % 2001 - 1000);
		};
		const scenario = votedHistory({ ...REPRESENTATIVE, keying: { kind: 'votes', votesPerRead: 20, readsAtMost: 10, readMilliseconds: 450, keyedAt: jitter } }, 3000, SECOND);

		await scenario.onScheduleUntilComplete(60);

		expect(scenario.missing()).toEqual([]);
	});

	/*
	 * A peer that keys each vote when it received it, up to a minute after
	 * it was made, keys it outside the tolerance a pass allows: a page from a
	 * start may list a staple for a vote made long before it, and a staple
	 * with a vote made minutes later for one keyed long before that vote.
	 */
	test('holds every staple of a peer that keys votes up to a minute after they were made, whose votes were made up to minutes apart', async function() {
		freezeClock(new Date(NOW));
		const received: VoteKey = function(made, staple, vote): number {
			return(made + (staple * 7919 + vote * 104_729) % MINUTE);
		};
		const scenario = new Scenario({ ...REPRESENTATIVE, keying: { kind: 'votes', votesPerRead: 20, readsAtMost: 10, readMilliseconds: 450, keyedAt: received } });
		const count = 3000;
		for (let index = 0; index < count; index++) {
			const madeAt = NOW - HOUR - (count - index) * SECOND;
			let stamps = [madeAt - 900, madeAt - 500, madeAt - 200, madeAt];
			if (index % 3 === 0) {
				stamps = [madeAt - 900, madeAt - 500, madeAt - 200, madeAt + (1 + index % 13) * MINUTE];
			}
			scenario.peer.applyVoted(madeAt, madeAt, [], stamps);
		}
		scenario.from = new Date(NOW - HOUR - count * SECOND - MINUTE);

		await scenario.onScheduleUntilComplete(60);

		expect(scenario.missing()).toEqual([]);
		expect(scenario.follower.progress.get(scenario.peer)?.keying).toBe('late-votes');
		expect(scenario.follower.events.map(function(event): string {
			return(event.kind);
		})).toEqual(['late-votes']);
	});
});

/*
 * A node far behind reads the history it lacks in ranges, one per peer, each
 * peer at its own pace (src/node/bootstrap-ranges.ts). The representatives
 * here hold the same staples, key them by votes and read as the main
 * network's do, and answer side by side on a clock they share.
 */
describe('reading the history it lacks in ranges, one per peer, while far behind', { timeout: 180_000 }, function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	const NAMES: readonly string[] = ['rep1', 'rep2', 'rep3', 'rep4'];

	const KEYED_AS_A_REPRESENTATIVE: SimulatedKeying = { kind: 'votes', votesPerRead: 20, readsAtMost: 10, readMilliseconds: 450, readsVaryBy: 5 };

	/** Where the node holds every staple before, on the first peer, in the scenarios that start there: two days back. */
	const HELD_UP_TO = NOW - 2 * DAY;

	type History = {
		/** When the staple at that index was made, in order. */
		readonly made: readonly number[];
		readonly needs?: (index: number) => readonly number[];
		/** For staples whose votes were made at moments of their own, by index. */
		readonly votes?: ReadonlyMap<number, readonly number[]>;
	};

	/** Representatives by name, each answering as the options for it say, on one clock, holding the same history. */
	function representatives(names: readonly string[], history: History, optionsOf: (name: string) => SimulatedPeerOptions = function(): SimulatedPeerOptions {
		return({});
	}): Map<string, SimulatedPeer> {
		const clock = new ConcurrentClock();
		const peers = new Map(names.map(function(name): [string, SimulatedPeer] {
			return([name, new SimulatedPeer({ latency: 1300, keying: KEYED_AS_A_REPRESENTATIVE, clock, ...optionsOf(name) })]);
		}));
		const [first, ...others] = [...peers.values()];
		if (first === undefined) {
			throw(new Error('no peers'));
		}
		history.made.forEach(function(madeAt, index): void {
			const needs = history.needs?.(index) ?? [];
			const stamps = history.votes?.get(index);
			let staple: SimulatedStaple;
			if (stamps === undefined) {
				staple = first.apply(madeAt, madeAt, needs);
			} else {
				staple = first.applyVoted(madeAt, madeAt, needs, stamps);
			}
			for (const other of others) {
				other.applyAlso(staple, staple.moment);
			}
		});
		return(peers);
	}

	/** The node holds every staple made before the moment, and has read the first peer up to it, as after its first passes. */
	async function heldUpTo(network: SimulatedNetwork, peers: ReadonlyMap<string, SimulatedPeer>, moment: number): Promise<void> {
		const [first] = peers.values();
		if (first === undefined) {
			throw(new Error('no peers'));
		}
		for (const staple of first.staples) {
			if (Math.max(...staple.votes.map(function(vote): number {
				return(vote.validityFrom.getTime());
			})) < moment) {
				await network.follower.node.add(staple);
			}
		}
		network.follower.progress.set(first, { reached: new Date(moment), caughtUp: false, deepScanFrom: new Date(0), nextDeepScan: new Date(NOW + HOUR), deepScan: undefined, keying: 'unknown' });
	}

	/** Updates as the client schedules them until the update the condition holds after, with no ranges left, and answers how long that took. */
	async function untilCaughtUp(network: SimulatedNetwork, updates: number, done: (results: readonly PeerResult[]) => boolean = function(results): boolean {
		return(results.every(function(result): boolean {
			return(result === 'completed');
		}));
	}): Promise<number> {
		const began = Date.now();
		for (let update = 0; update < updates; update++) {
			const results = await network.update();
			if (network.layout === undefined && done(results)) {
				return(Date.now() - began);
			}
			advanceClock(nextUpdateDelay(results, PERIOD));
		}
		throw(new Error(`the node did not catch up within ${String(updates)} updates`));
	}

	/** The staples some peer holds and the node does not. */
	function missingFrom(network: SimulatedNetwork, peers: ReadonlyMap<string, SimulatedPeer>): readonly number[] {
		const missing = new Set<number>();
		for (const peer of peers.values()) {
			for (const staple of peer.staples) {
				if (!network.follower.node.holds(staple)) {
					missing.add(staple.id);
				}
			}
		}
		return([...missing]);
	}

	/** Staples made one after another from the moment the node holds everything before, up to an hour ago: more than a representative reads in a page in any stretch of its time budget. */
	function denseHistory(count: number): History {
		const spacing = (NOW - HOUR - HELD_UP_TO) / count;
		return({ made: Array.from({ length: count }, function(_ignored, index): number {
			return(Math.floor(HELD_UP_TO + (index + 0.5) * spacing));
		}) });
	}

	/** The first catch-up of a node holding the history up to two days back, from the peers named, and how many staples a minute it took. */
	async function catchUpFrom(names: readonly string[], history: History): Promise<{ readonly perMinute: number; readonly missing: readonly number[]; readonly network: SimulatedNetwork }> {
		freezeClock(new Date(NOW));
		const peers = representatives(names, history);
		const network = new SimulatedNetwork(new Follower(), peers);
		await heldUpTo(network, peers, HELD_UP_TO);
		const took = await untilCaughtUp(network, 500);
		return({ perMinute: history.made.length / (took / MINUTE), missing: missingFrom(network, peers), network });
	}

	test('reads a dense history it lacks about four times as fast from four peers as from one, holding every staple', async function() {
		const history = denseHistory(12_000);

		const one = await catchUpFrom(['rep1'], history);
		const four = await catchUpFrom(NAMES, history);

		expect(one.missing).toEqual([]);
		expect(four.missing).toEqual([]);
		expect(one.network.rangeEvents).toEqual([]);
		expect(four.network.rangeEvents.map(function(event): string {
			return(event.kind);
		})).toEqual(['laid-out', 'read']);
		expect(four.perMinute / one.perMinute).toBeGreaterThan(3.3);
	});

	test('reads a history that is dense in one stretch and sparse elsewhere faster from four peers, which take on parts of the range left the longest', async function() {
		const sparse = denseHistory(6000).made;
		const burst = Array.from({ length: 6000 }, function(_ignored, index): number {
			return(HELD_UP_TO + 18 * HOUR + Math.floor(index * 1200));
		});
		const history: History = { made: [...sparse, ...burst].sort(function(left, right): number {
			return(left - right);
		}) };

		const one = await catchUpFrom(['rep1'], history);
		const four = await catchUpFrom(NAMES, history);

		expect(four.missing).toEqual([]);
		expect(four.perMinute / one.perMinute).toBeGreaterThan(2.5);
	});

	test('holds every staple whose dependencies a range before brings, the ranges read ahead filling only part of the shared retry queue', async function() {
		freezeClock(new Date(NOW));
		const count = 4000;
		const history = denseHistory(count);
		// Voting weight the staples of the last three ranges need, near the end of the first; and a staple of the third range that those of the last need.
		const weight = 900;
		const third = 2600;
		const peers = representatives(NAMES, { ...history, needs: function(index): readonly number[] {
			if (index > 3000 && index % 3 === 0) {
				return([weight, third]);
			}
			if (index > 1000 && index % 2 === 0) {
				return([weight]);
			}
			return([]);
		} });
		const bounds: QueueBounds = { staples: 40, bytes: 1024 * 1024 };
		const network = new SimulatedNetwork(new Follower(bounds), peers);
		await heldUpTo(network, peers, HELD_UP_TO);

		await network.update();
		expect(network.layout?.ranges.length).toBe(NAMES.length);
		await untilCaughtUp(network, 200);

		expect(missingFrom(network, peers)).toEqual([]);
		expect(await network.follower.retries.size()).toBe(0);
		expect(network.follower.retryStore.largest).toBeLessThanOrEqual(bounds.staples);
		expect(network.rangeRuns.some(function(run): boolean {
			return(run.result === 'throttled');
		})).toBe(true);
	});

	test('leaves the range of a peer that fails mid-range to another, which holds every staple of it', async function() {
		const history = denseHistory(6000);
		freezeClock(new Date(NOW));
		const failing = 'rep3';
		const peers = representatives(NAMES, history, function(name): SimulatedPeerOptions {
			if (name === failing) {
				return({ failsFrom: NOW + 3 * MINUTE });
			}
			return({});
		});
		const network = new SimulatedNetwork(new Follower(), peers);
		await heldUpTo(network, peers, HELD_UP_TO);

		await untilCaughtUp(network, 300, function(results): boolean {
			return(NAMES.every(function(name, index): boolean {
				return(name === failing || results[index] === 'completed');
			}));
		});

		expect(missingFrom(network, peers)).toEqual([]);
		expect(network.rangeEvents.filter(function(event): boolean {
			return(event.kind === 'benched');
		})).toMatchObject([{ kind: 'benched', peer: failing }]);
		expect(network.rangeRuns.filter(function(run): boolean {
			return(run.peer === failing && run.result === 'failed');
		}).length).toBe(3);
	});

	test('holds every staple whose votes lie on both sides of where two ranges meet, from peers that key each vote up to the tolerance off, across a restart', async function() {
		freezeClock(new Date(NOW));
		const end = NOW - BOOTSTRAP_MARGIN_MILLISECONDS;
		const span = (end - HELD_UP_TO) / NAMES.length;
		const meetings = [1, 2, 3].map(function(index): number {
			return(Math.floor(HELD_UP_TO + index * span));
		});
		const tolerance = VOTE_KEY_TOLERANCE_MILLISECONDS;
		const straddling: (readonly number[])[] = [];
		for (const meeting of [HELD_UP_TO, ...meetings, end]) {
			straddling.push(
				[meeting - 900, meeting - 300, meeting + 200, meeting + 700],
				[meeting - 2 * MINUTE, meeting + 2 * MINUTE],
				[meeting - RANGE_OVERLAP_MILLISECONDS + 10, meeting + RANGE_OVERLAP_MILLISECONDS - 10],
				[meeting - tolerance, meeting - tolerance / 2],
				[meeting, meeting + tolerance]
			);
		}
		const base = denseHistory(6000).made.map(function(madeAt): readonly number[] {
			return([madeAt - 900, madeAt - 400, madeAt - 150, madeAt]);
		});
		const stamped = [...base, ...straddling].sort(function(left, right): number {
			return(Math.max(...left) - Math.max(...right));
		});
		const peers = representatives(NAMES, {
			made: stamped.map(function(stamps): number {
				return(Math.max(...stamps));
			}),
			votes: new Map(stamped.map(function(stamps, index): [number, readonly number[]] {
				return([index, stamps]);
			}))
		}, function(name): SimulatedPeerOptions {
			const salt = NAMES.indexOf(name) * 1009;
			return({ keying: { ...KEYED_AS_A_REPRESENTATIVE, keyedAt: function(made, staple, vote): number {
				return(made + (staple * 7919 + vote * 104_729 + salt) % (2 * tolerance + 1) - tolerance);
			} } });
		});
		let network = new SimulatedNetwork(new Follower(), peers);
		await heldUpTo(network, peers, HELD_UP_TO);

		await network.update();
		expect(network.layout?.from.getTime()).toBe(HELD_UP_TO);
		expect(network.layout?.ranges.map(function(range): number {
			return(range.end.getTime());
		}).slice(0, 3)).toEqual(meetings);
		network = network.restarted();
		await untilCaughtUp(network, 300);

		expect(missingFrom(network, peers)).toEqual([]);
		expect(network.rangeEvents.map(function(event): string {
			return(event.kind);
		})).toEqual(['read']);
	});
});
