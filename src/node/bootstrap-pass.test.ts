import { afterEach, describe, expect, test, vi } from 'vitest';
import { SimulatedNode, SimulatedPeer } from '../testing/simulated-peer.js';
import type { SimulatedKeying, SimulatedPeerOptions, SimulatedStaple } from '../testing/simulated-peer.js';
import { advanceClock, freezeClock } from '../testing/network.js';
import { DEEP_SCAN_DEPTH_MILLISECONDS, DEEP_SCAN_PERIOD_MILLISECONDS, LongestAnswer, PrimingWindow, MAX_PASS_MILLISECONDS, bootstrapPeer, completes } from './bootstrap-pass.js';
import type { PassAnswer, PassEvent, PassOptions, PassRequest, PeerIO, PeerOutcome, PeerProgress } from './bootstrap-pass.js';
import { BLOOM_CAPACITY, BOOTSTRAP_MARGIN_MILLISECONDS, MAX_NAMED } from './bootstrap-window.js';

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
	readonly events: PassEvent[] = [];
	readonly answers = new LongestAnswer();
	/** As wide as a filter, so that what a pass names of what the node holds is not cut short by the window the peer is read with. */
	readonly priming = new PrimingWindow(BLOOM_CAPACITY);
	progress: PeerProgress | undefined;
	readonly #answer: (request: PassRequest) => Promise<PassAnswer<SimulatedStaple>>;

	constructor(answer: (request: PassRequest) => Promise<PassAnswer<SimulatedStaple>>) {
		this.#answer = answer;
	}

	get io(): PeerIO<SimulatedStaple> {
		return({
			answers: this.answers,
			priming: this.priming,
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
