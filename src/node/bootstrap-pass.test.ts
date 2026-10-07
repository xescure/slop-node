import { afterEach, describe, expect, test, vi } from 'vitest';
import { SimulatedNode, SimulatedPeer } from '../testing/simulated-peer.js';
import type { SimulatedStaple } from '../testing/simulated-peer.js';
import { advanceClock, freezeClock } from '../testing/network.js';
import { DEEP_SCAN_DEPTH_MILLISECONDS, DEEP_SCAN_EVERY, MAX_PASS_MILLISECONDS, bootstrapPeer } from './bootstrap-pass.js';
import type { PassAnswer, PassRequest, PeerIO, PeerProgress } from './bootstrap-pass.js';
import { BOOTSTRAP_MARGIN_MILLISECONDS } from './bootstrap-window.js';

const NOW = Date.UTC(2026, 9, 7, 12);
const SECOND = 1000;
const MINUTE = 60 * SECOND;

type Recorded = PassRequest & { readonly served: number };

/** A pass's view of a peer and a node, recording each request and the progress written. */
class Harness {
	readonly node = new SimulatedNode();
	readonly requests: Recorded[] = [];
	readonly written: PeerProgress[] = [];
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
				return(this.node.held(from, count));
			},
			add: (staple) => {
				return(this.node.add(staple));
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
}

/** A peer that applied that many staples, one a second up to now. */
function peerWith(count: number): SimulatedPeer {
	const peer = new SimulatedPeer();
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

	test('asks again from the same start, naming what it was sent, until a page comes back short', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(1200);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		expect(await bootstrapPeer(harness.io, { limit: 500 })).toEqual({ kind: 'drained' });

		expect(harness.requests.map(function(request) {
			return([request.start.getTime(), request.limit, request.bloomFilter !== undefined, request.served]);
		})).toEqual([[0, 500, false, 500], [0, 500, true, 500], [0, 500, true, 200]]);
		expect(harness.node.size).toBe(1200);
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

		expect(await bootstrapPeer(harness.io, { limit: 1000 })).toEqual({ kind: 'drained' });

		expect(starts.length).toBeGreaterThan(2);
		expect(harness.node.size).toBe(5000);
	});

	test('ends the pass with an error once the peer sends a staple its filter named', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(3);
		const harness = new Harness(function(request) {
			return(peer.page({ ...request, bloomFilter: undefined }));
		});

		await expect(bootstrapPeer(harness.io, { limit: 2 })).rejects.toThrow('which the filter named');

		expect(harness.requests.map(function(request): number {
			return(request.served);
		})).toEqual([2, 2]);
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

		expect(await bootstrapPeer(harness.io, { limit: 1000 })).toEqual({ kind: 'drained' });

		expect(harness.pages().map(function(request): number {
			return(request.limit);
		})).toEqual([1000, 500, 250, 250]);
		expect(harness.node.size).toBe(300);
	});

	test('fails when even a single staple is too large', async function() {
		freezeClock(new Date(NOW));
		const harness = new Harness(function() {
			return(Promise.resolve({ kind: 'too-large' }));
		});

		await expect(bootstrapPeer(harness.io, { limit: 4 })).rejects.toThrow('larger than a page may be');

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

		expect(await bootstrapPeer(harness.io, { limit: 1000 })).toEqual({ kind: 'bounded', reached: new Date(0) });

		expect(harness.requests.length).toBeLessThanOrEqual(MAX_PASS_MILLISECONDS / MINUTE + 1);
		expect(harness.progress).toEqual({ reached: new Date(0), deepScanFrom: new Date(0), completions: 0, deepScanning: false });
	});

	test('records, once it drains the peer, that the next pass starts the margin before this one began', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(10);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});

		await bootstrapPeer(harness.io, { limit: 1000 });
		advanceClock(MINUTE);
		await bootstrapPeer(harness.io, { limit: 1000 });

		const firstFloor = new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS);
		expect(harness.requests[1]?.start).toEqual(firstFloor);
		expect(harness.progress).toEqual({ reached: new Date(NOW + 25 + MINUTE - BOOTSTRAP_MARGIN_MILLISECONDS), deepScanFrom: new Date(0), completions: 2, deepScanning: false });
	});

	test('re-scans from the earliest start since the last deep re-scan once enough passes have completed, and then carries on from where it reached', async function() {
		freezeClock(new Date(NOW));
		const peer = peerWith(10);
		const harness = new Harness(function(request) {
			return(peer.page(request));
		});
		harness.progress = { reached: new Date(NOW), deepScanFrom: new Date(NOW - 2 * DEEP_SCAN_DEPTH_MILLISECONDS), completions: DEEP_SCAN_EVERY, deepScanning: false };

		await bootstrapPeer(harness.io, { limit: 1000 });
		const floor = new Date(NOW - BOOTSTRAP_MARGIN_MILLISECONDS);
		expect(harness.requests[0]?.start).toEqual(new Date(NOW - 2 * DEEP_SCAN_DEPTH_MILLISECONDS));
		expect(harness.progress).toEqual({ reached: floor, deepScanFrom: floor, completions: 0, deepScanning: false });

		harness.progress = { reached: new Date(NOW), deepScanFrom: new Date(NOW), completions: DEEP_SCAN_EVERY, deepScanning: false };
		await bootstrapPeer(harness.io, { limit: 1000 });
		expect(harness.requests[1]?.start).toEqual(new Date(NOW - DEEP_SCAN_DEPTH_MILLISECONDS));
	});
});
