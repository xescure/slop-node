import { afterEach, describe, expect, test, vi } from 'vitest';
import { SimulatedNode, SimulatedPeer } from '../testing/simulated-peer.js';
import type { SimulatedPeerOptions, SimulatedStaple } from '../testing/simulated-peer.js';
import { advanceClock, freezeClock } from '../testing/network.js';
import { DEEP_SCAN_DEPTH_MILLISECONDS, DEEP_SCAN_PERIOD_MILLISECONDS, MAX_PASS_MILLISECONDS, bootstrapPeer } from './bootstrap-pass.js';
import type { PassAnswer, PassOptions, PassRequest, PeerIO, PeerOutcome, PeerProgress } from './bootstrap-pass.js';
import { BOOTSTRAP_MARGIN_MILLISECONDS, MAX_NAMED } from './bootstrap-window.js';

const NOW = Date.UTC(2026, 9, 7, 12);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const EPOCH = new Date(0);

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
	progress: PeerProgress | undefined;
	readonly #answer: (request: PassRequest) => Promise<PassAnswer<SimulatedStaple>>;

	constructor(answer: (request: PassRequest) => Promise<PassAnswer<SimulatedStaple>>) {
		this.#answer = answer;
	}

	get io(): PeerIO<SimulatedStaple> {
		return({
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
				return(this.node.held(from, count));
			},
			add: (staple) => {
				return(this.node.add(staple));
			},
			retry: function() {
				return(Promise.resolve());
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

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'drained' }));

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

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'drained' }));

		const moves = [...new Set(harness.pages().map(function(request): number {
			return(request.start.getTime());
		}))].slice(1);
		expect(moves.length).toBeGreaterThan(1);
		expect(harness.heldFrom).toEqual([0, ...moves]);
		// Of the 5000 staples the node held, the peer sent fewer than half again.
		expect(harness.node.resent).toBeLessThan(2500);
	});

	test.each([1, 2, 3, 4, 5])('passes more staples at one moment than a filter and a page hold, checking with further filters before it concludes it holds them all (seed %i)', async function(seed: number) {
		freezeClock(new Date(NOW));
		const peer = new SimulatedPeer();
		const moment = NOW - MINUTE;
		for (let index = 0; index < 2500; index++) {
			peer.apply(moment, moment);
		}
		for (let index = 0; index < 500; index++) {
			peer.apply(moment + 1 + index * 10, moment + 1 + index * 10);
		}
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		let state = seed;

		expect(await bootstrapPeer(harness.io, { limit: 1000, seed: function(): number {
			state = (state * 48271) % 2147483647;
			return(state);
		} })).toEqual(liveOnly({ kind: 'drained' }));

		expect(harness.node.size).toBe(3000);
		const at = harness.requests.findIndex(function(request): boolean {
			return(request.limit > 1 && request.start.getTime() === moment);
		});
		expect(at).toBeGreaterThan(0);
		// Probes from the crowded moment itself, which only the further filters ask for, whether the pass then moves a millisecond on or drains the peer from there.
		const checks = harness.requests.slice(at).filter(function(request): boolean {
			return(request.limit === 1 && request.start.getTime() === moment);
		});
		expect(checks.length).toBeGreaterThan(0);
	});

	test('moves a millisecond on past more staples at one moment than a filter and a page hold, once a page reaches past them, before it names too many to go on', async function() {
		freezeClock(new Date(NOW));
		const peer = new SimulatedPeer();
		const moment = NOW - HOUR;
		for (let index = 0; index < 2500; index++) {
			peer.apply(moment, moment);
		}
		for (let index = 0; index < MAX_NAMED; index++) {
			peer.apply(moment + 1 + index * 10, moment + 1 + index * 10);
		}
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		expect(await bootstrapPeer(harness.io, passOptions(1000))).toEqual(liveOnly({ kind: 'drained' }));

		expect(harness.node.size).toBe(2500 + MAX_NAMED);
		expect(harness.pages().some(function(request): boolean {
			return(request.start.getTime() === moment + 1);
		})).toBe(true);
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
		expect(harness.progress).toEqual({ reached: EPOCH, caughtUp: false, deepScanFrom: EPOCH, nextDeepScan: new Date(NOW + DEEP_SCAN_PERIOD_MILLISECONDS), deepScan: undefined });
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
		expect(harness.progress).toEqual({ reached: new Date(NOW + 50 + MINUTE - BOOTSTRAP_MARGIN_MILLISECONDS), caughtUp: true, deepScanFrom: EPOCH, nextDeepScan: new Date(NOW + DEEP_SCAN_PERIOD_MILLISECONDS), deepScan: undefined });
	});
});

describe('deep re-scans of a peer', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	const caughtUp: PeerProgress = { reached: new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS), caughtUp: true, deepScanFrom: new Date(NOW - 2 * DEEP_SCAN_DEPTH_MILLISECONDS), nextDeepScan: new Date(NOW), deepScan: undefined };

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

		expect(outcome.deepScan).toEqual({ kind: 'caught-up' });
		expect(harness.written.at(-1)?.deepScan).toBeUndefined();
		const deepStarts = harness.written.flatMap(function(progress): number[] {
			if (progress.deepScan === undefined) {
				return([]);
			}
			return([progress.deepScan.reached.getTime()]);
		});
		expect(deepStarts.at(-1)).toBeGreaterThanOrEqual(horizon.getTime());
		expect(new Set(deepStarts).size).toBeGreaterThan(2);
	});
});
