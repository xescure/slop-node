import { afterEach, describe, expect, test, vi } from 'vitest';
import { SimulatedNode, SimulatedPeer } from '../testing/simulated-peer.js';
import type { LiveTraffic, SimulatedPeerOptions, SimulatedStaple } from '../testing/simulated-peer.js';
import { advanceClock, freezeClock } from '../testing/network.js';
import { DEEP_SCAN_PERIOD_MILLISECONDS, MAX_PASS_MILLISECONDS, MAX_PASS_REQUESTS, bootstrapPeer, completes } from './bootstrap-pass.js';
import type { PassOutcome, PeerIO, PeerOutcome, PeerProgress } from './bootstrap-pass.js';
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

class Scenario {
	readonly peer: SimulatedPeer;
	readonly node = new SimulatedNode();
	readonly updates: UpdateRecord[] = [];
	/** Staples the peer applies while each update reads it, and only then, so that a busy peer takes hours of updates without millions of staples. */
	trafficWhileRead: LiveTraffic | undefined;
	#progress: PeerProgress | undefined;
	readonly #seed = seeds();

	constructor(options: SimulatedPeerOptions = {}) {
		this.peer = new SimulatedPeer({ latency: LATENCY, ...options });
	}

	/** One update: a pass over the peer, and the deep re-scan under way alongside, if any. */
	async update(): Promise<PeerOutcome> {
		const requests = this.peer.requests;
		const began = Date.now();
		const io: PeerIO<SimulatedStaple> = {
			page: (request) => {
				return(this.peer.page(request));
			},
			held: (from, count) => {
				return(this.node.held(from, count));
			},
			add: (staple) => {
				return(this.node.add(staple));
			},
			readProgress: () => {
				return(Promise.resolve(this.#progress));
			},
			writeProgress: (progress) => {
				this.#progress = progress;
				return(Promise.resolve());
			}
		};
		if (this.trafficWhileRead !== undefined) {
			this.peer.goLive(this.trafficWhileRead);
		}
		const outcome = await bootstrapPeer(io, { limit: LIMIT, seed: this.#seed });
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

/** History the peer applied as it was made, so many a second, ending at the moment given. */
function liveHistory(peer: SimulatedPeer, count: number, perSecond: number, endingAt: number, voterSkew: (index: number) => number = function(): number {
	return(0);
}): void {
	const spacing = 1000 / perSecond;
	for (let index = 0; index < count; index++) {
		const madeAt = Math.floor(endingAt - (count - index) * spacing);
		peer.apply(madeAt + voterSkew(index), madeAt);
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
