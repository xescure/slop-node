import { afterEach, describe, expect, test, vi } from 'vitest';
import { SimulatedNode, SimulatedPeer } from '../testing/simulated-peer.js';
import type { SimulatedStaple } from '../testing/simulated-peer.js';
import { advanceClock, freezeClock } from '../testing/network.js';
import { DEEP_SCAN_EVERY, MAX_PASS_MILLISECONDS, MAX_PASS_REQUESTS, bootstrapPeer } from './bootstrap-pass.js';
import type { PassOutcome, PeerIO, PeerProgress } from './bootstrap-pass.js';

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

type PassRecord = {
	readonly outcome: PassOutcome;
	readonly requests: number;
	readonly elapsed: number;
};

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
	readonly passes: PassRecord[] = [];
	#progress: PeerProgress | undefined;
	readonly #seed = seeds();

	constructor(peer: SimulatedPeer) {
		this.peer = peer;
	}

	/** One update: a pass over the peer. */
	async update(): Promise<PassOutcome> {
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
		const outcome = await bootstrapPeer(io, { limit: LIMIT, seed: this.#seed });
		this.passes.push({ outcome, requests: this.peer.requests - requests, elapsed: Date.now() - began });
		return(outcome);
	}

	/** Updates back to back until a pass drains the peer, as a node catching up does. */
	async untilDrained(updates: number): Promise<void> {
		for (let update = 0; update < updates; update++) {
			if ((await this.update()).kind === 'drained') {
				return;
			}
		}
		throw(new Error(`no pass drained the peer within ${String(updates)} updates`));
	}

	/** The staples the peer holds and the node does not. */
	missing(): readonly number[] {
		return(this.peer.staples.filter((staple) => {
			return(!this.node.holds(staple));
		}).map(function(staple): number {
			return(staple.id);
		}));
	}

	expectEveryPassBounded(): void {
		for (const pass of this.passes) {
			expect(pass.requests).toBeLessThanOrEqual(MAX_PASS_REQUESTS);
			expect(pass.elapsed).toBeLessThanOrEqual(MAX_PASS_MILLISECONDS + LATENCY);
		}
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

describe('bootstrapping against a simulated peer', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('holds every staple of a peer that applies 100 a second during the catch-up', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario(new SimulatedPeer({ latency: LATENCY }));
		liveHistory(scenario.peer, 10_000, 100, NOW);
		scenario.peer.goLive({ perSecond: 100, voterSkew: function(): number {
			return(0);
		} });

		await scenario.untilDrained(10);
		scenario.peer.stopLive();
		await scenario.untilDrained(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryPassBounded();
	});

	test('holds every staple of a peer that applied its history long after it was made, as one that bootstrapped does', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario(new SimulatedPeer({ latency: LATENCY }));
		const count = 10_000;
		// Made over a month, applied within a second an hour ago, twenty to a millisecond.
		for (let index = 0; index < count; index++) {
			scenario.peer.apply(NOW - 30 * DAY + index * Math.floor(30 * DAY / count), NOW - HOUR + Math.floor(index / 20));
		}

		await scenario.untilDrained(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryPassBounded();
	});

	test('holds every staple whose voters\' clocks ran up to 60 s ahead', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario(new SimulatedPeer({ latency: LATENCY }));
		liveHistory(scenario.peer, 10_000, 50, NOW - HOUR, function(index): number {
			return((index * 7919) % MINUTE);
		});
		scenario.peer.goLive({ perSecond: 20, voterSkew: function(madeAt): number {
			return(madeAt % MINUTE);
		} });

		await scenario.untilDrained(10);
		for (let update = 0; update < 5; update++) {
			advanceClock(PERIOD);
			await scenario.update();
		}
		scenario.peer.stopLive();
		await scenario.untilDrained(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryPassBounded();
	});

	test('holds every staple of a peer whose clock runs minutes behind the node\'s', async function() {
		freezeClock(new Date(NOW));
		const behind = -4 * MINUTE;
		const scenario = new Scenario(new SimulatedPeer({ latency: LATENCY, clockOffset: behind }));
		liveHistory(scenario.peer, 2000, 10, NOW + behind);
		// The peer votes too, on its own clock.
		scenario.peer.goLive({ perSecond: 10, voterSkew: function(): number {
			return(behind);
		} });

		for (let update = 0; update < 10; update++) {
			await scenario.update();
			advanceClock(PERIOD);
		}
		scenario.peer.stopLive();
		await scenario.untilDrained(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryPassBounded();
	});

	test('recovers, with the deep re-scan, a staple a filter named by mistake', async function() {
		freezeClock(new Date(NOW));
		const scenario = new Scenario(new SimulatedPeer({ latency: LATENCY }));
		// Made well before the margin, so that only the deep re-scan reads it again.
		liveHistory(scenario.peer, 3000, 10, NOW - HOUR);
		const unlucky = scenario.peer.staples[1500];
		scenario.peer.forceFalsePositive(unlucky);

		await scenario.untilDrained(1);
		scenario.peer.forceFalsePositive(undefined);
		expect(scenario.missing()).toEqual([unlucky?.id]);

		for (let completed = 1; completed < DEEP_SCAN_EVERY; completed++) {
			advanceClock(PERIOD);
			await scenario.untilDrained(1);
		}
		expect(scenario.missing()).toEqual([unlucky?.id]);

		advanceClock(PERIOD);
		await scenario.untilDrained(10);

		expect(scenario.missing()).toEqual([]);
		scenario.expectEveryPassBounded();
	});
});
