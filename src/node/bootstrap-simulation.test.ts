import { afterEach, describe, expect, test, vi } from 'vitest';
import { SimulatedNode, SimulatedPeer, SimulatedRetryStore, simulatedRetries } from '../testing/simulated-peer.js';
import type { LiveTraffic, RefusalReport, SimulatedPeerOptions, SimulatedStaple } from '../testing/simulated-peer.js';
import { advanceClock, freezeClock } from '../testing/network.js';
import { DEEP_SCAN_PERIOD_MILLISECONDS, MAX_PASS_MILLISECONDS, MAX_PASS_REQUESTS, bootstrapPeer, completes } from './bootstrap-pass.js';
import type { PassOptions, PassOutcome, PeerIO, PeerOutcome, PeerProgress } from './bootstrap-pass.js';
import { REPORT_REFUSED_AFTER_MILLISECONDS, RetryQueueFull } from './bootstrap-retry.js';
import type { QueueBounds, RetryQueue } from './bootstrap-retry.js';
import { BLOOM_CAPACITY } from './bootstrap-window.js';

/*
 * Catch-ups against a simulated representative that pages and filters as
 * this node's API does, with the client's own Bloom filters, under the
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

/** A simulated node with the retry queue it keeps for the staples its ledger refuses, and its progress on each peer. */
class Follower {
	readonly node = new SimulatedNode();
	readonly retryStore = new SimulatedRetryStore();
	readonly reports: RefusalReport[] = [];
	readonly retries: RetryQueue<SimulatedStaple>;
	readonly progress = new Map<SimulatedPeer, PeerProgress>();
	readonly #seed = seeds();

	constructor(bounds?: QueueBounds) {
		this.retries = simulatedRetries(this.node, this.retryStore, this.reports, bounds);
	}

	/** How a pass over the peer reaches it and this node. */
	io(peer: SimulatedPeer): PeerIO<SimulatedStaple> {
		return({
			page: function(request) {
				return(peer.page(request));
			},
			held: async (from, count) => {
				const queued = (await this.retries.staples()).slice(0, count);
				return([...queued, ...await this.node.held(from, count - queued.length)]);
			},
			add: (staple) => {
				return(this.retries.add(staple));
			},
			retry: async () => {
				await this.retries.retry();
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

	options(): PassOptions {
		return({ limit: LIMIT, seed: this.#seed });
	}
}

class Scenario {
	readonly peer: SimulatedPeer;
	readonly follower: Follower;
	readonly node: SimulatedNode;
	readonly updates: UpdateRecord[] = [];
	/** Staples the peer applies while each update reads it, and only then, so that a busy peer takes hours of updates without millions of staples. */
	trafficWhileRead: LiveTraffic | undefined;

	constructor(options: SimulatedPeerOptions = {}, bounds?: QueueBounds) {
		this.peer = new SimulatedPeer({ latency: LATENCY, ...options });
		this.follower = new Follower(bounds);
		this.node = this.follower.node;
	}

	/** One update: a pass over the peer, and the deep re-scan under way alongside, if any. */
	async update(): Promise<PeerOutcome> {
		const requests = this.peer.requests;
		const began = Date.now();
		if (this.trafficWhileRead !== undefined) {
			this.peer.goLive(this.trafficWhileRead);
		}
		const outcome = await bootstrapPeer(this.follower.io(this.peer), this.follower.options());
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

	/** Updates on the period for that long. */
	async periodically(duration: number): Promise<void> {
		for (let waited = 0; waited < duration; waited += PERIOD) {
			advanceClock(PERIOD);
			await this.update();
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

function noSkew(): number {
	return(0);
}

function noNeeds(): readonly number[] {
	return([]);
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
describe('bootstrapping against a simulated peer', { timeout: 120_000 }, function() {
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

	test.each([['caps the limit', 400], ['runs out of time for a request', 100]])('holds every staple of a peer that %s, whose pages come back short', async function(_ignored: string, answersAtMost: number) {
		freezeClock(new Date(NOW));
		const scenario = new Scenario({ answersAtMost });
		liveHistory(scenario.peer, 20_000, 100, NOW - HOUR);

		await scenario.untilComplete(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryUpdateBounded();
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
		expect(scenario.missing()).toEqual([refused.id]);
		await scenario.periodically(REPORT_REFUSED_AFTER_MILLISECONDS + 10 * PERIOD);
		scenario.peer.stopLive();
		await scenario.untilComplete(3);

		expect(scenario.missing()).toEqual([refused.id]);
		expect(await scenario.follower.retries.staples()).toEqual([refused]);
		expect(scenario.follower.reports.map(function({ id, code }): string {
			return(`${String(id)} ${code}`);
		})).toEqual([`${String(refused.id)} LEDGER_INSUFFICIENT_VOTING_WEIGHT`]);
		expect(scenario.follower.reports[0]?.age).toBeGreaterThanOrEqual(REPORT_REFUSED_AFTER_MILLISECONDS);
		expect(scenario.liveOutcomes().slice(1).every(function(kind): boolean {
			return(kind !== 'bounded');
		})).toBe(true);
		scenario.expectEveryUpdateBounded();
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
		const eleventh = stapleAt(scenario.peer, 100 + bounds.staples);

		await expect(scenario.update()).rejects.toThrow(RetryQueueFull);

		expect(scenario.follower.retryStore.largest).toBe(bounds.staples);
		expect(scenario.follower.progress.get(scenario.peer)?.reached.getTime()).toBeLessThanOrEqual(eleventh.moment);
		expect(scenario.missing()).toContain(eleventh.id);

		// The staple the sends need arrives otherwise, as over P2P.
		await scenario.node.add(supply);
		await scenario.untilComplete(5);

		expect(scenario.missing()).toEqual([]);
		expect(await scenario.follower.retries.size()).toBe(0);
		expect(scenario.follower.retryStore.largest).toBe(bounds.staples);
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
