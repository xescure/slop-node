import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryBootstrapStage } from '../ledger/storage/stage.js';
import type { BootstrapStage } from '../ledger/storage/stage.js';
import { freezeClock } from '../testing/network.js';
import { decodeSimulatedStaple, SIMULATED_STAPLE_BYTES, SimulatedNode, SimulatedPeer, SimulatedRetryStore, simulatedRetries } from '../testing/simulated-peer.js';
import type { RefusalReport, SimulatedStaple } from '../testing/simulated-peer.js';
import type { RangeLayout } from './bootstrap-ranges.js';
import { RANGE_OVERLAP_MILLISECONDS } from './bootstrap-ranges.js';
import type { QueueBounds } from './bootstrap-retry.js';
import { StageFull, Staging, applyFrontier, stagedOf } from './bootstrap-stage.js';

const NOW = Date.UTC(2026, 9, 9, 12);
const SECOND = 1000;

/** Staples made a second apart, each needing those its index lists, by index; their votes were made within the second before. */
function staples(needs: readonly (readonly number[])[]): SimulatedStaple[] {
	const peer = new SimulatedPeer();
	return(needs.map(function(each, index): SimulatedStaple {
		return(peer.apply(NOW + index * SECOND, NOW + index * SECOND, each));
	}));
}

function at(list: readonly SimulatedStaple[], index: number): SimulatedStaple {
	const staple = list[index];
	if (staple === undefined) {
		throw(new Error(`no staple at ${String(index)}`));
	}
	return(staple);
}

/** A node, its retry queue and the stage it adds from, as a client builds them. */
class Harness {
	readonly node: SimulatedNode;
	readonly stage = new MemoryBootstrapStage();
	readonly reports: RefusalReport[] = [];
	readonly retries: ReturnType<typeof simulatedRetries>;
	readonly staging: Staging<SimulatedStaple>;

	constructor(options: { readonly bound?: number; readonly bounds?: QueueBounds; readonly node?: SimulatedNode } = {}) {
		const node = options.node ?? new SimulatedNode();
		this.node = node;
		this.retries = simulatedRetries(node, new SimulatedRetryStore(), this.reports, options.bounds);
		this.staging = new Staging(this.stage, this.retries, {
			holds: function(staple): Promise<boolean> {
				return(Promise.resolve(node.holds(staple)));
			},
			decode: decodeSimulatedStaple
		}, options.bound);
	}

	/** Adds what is staged before the frontier, with no work besides. */
	async addBefore(frontier: number): Promise<{ readonly left: number; readonly backlog: boolean }> {
		const { applied } = await this.staging.alongside(Promise.resolve(), function(): number {
			return(frontier);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(false);
		});
		return(applied);
	}

	async stagedIDs(): Promise<number[]> {
		return((await this.stage.firstBefore(new Date(8.64e15), 1000)).map(function(staged): number {
			return(decodeSimulatedStaple(staged.bytes).id);
		}));
	}
}

function layoutReached(reached: readonly number[]): RangeLayout {
	return({
		from: new Date(0),
		end: new Date(NOW),
		deepScanPeer: 'rep1',
		ranges: reached.map(function(moment, id) {
			return({ id, reached: new Date(moment), end: new Date(NOW), peer: undefined, pace: { spent: 0, advanced: 0 } });
		}),
		standings: {},
		fullQueueUpdates: 0,
		nextID: reached.length
	});
}

describe('staging what the ranges read', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('keeps a staple by the moments its earliest and latest votes were made', function() {
		const [staple] = staples([[]]);
		if (staple === undefined) {
			throw(new Error('no staple'));
		}

		expect(stagedOf(staple)).toEqual({ key: staple.blocksHash.toString(), bytes: staple.toBytes(), firstVote: new Date(NOW - 900), lastVote: new Date(NOW) });
	});

	test('stages a staple a pass was sent, unless the ledger, the queue or the stage holds it', async function() {
		freezeClock(new Date(NOW));
		const list = staples([[], [], [1]]);
		const harness = new Harness();
		await harness.node.add(at(list, 0));
		expect(await harness.retries.add(at(list, 2), 'live')).toBe('queued');

		expect(await harness.staging.take(at(list, 0), 'live')).toBe('held');
		expect(await harness.staging.take(at(list, 1), 'live')).toBe('added');
		expect(await harness.staging.take(at(list, 1), 'ahead')).toBe('held');
		expect(await harness.staging.take(at(list, 2), 'live')).toBe('queued');

		expect(await harness.stagedIDs()).toEqual([1]);
		expect(await harness.staging.counts()).toEqual({ staples: 1, bytes: SIMULATED_STAPLE_BYTES });
		expect(harness.node.size).toBe(1);
	});

	test('refuses a staple from a range read ahead once the stage holds its bound, and stages any other', async function() {
		const list = staples([[], [], [], []]);
		const harness = new Harness({ bound: 2 * SIMULATED_STAPLE_BYTES });
		await harness.staging.take(at(list, 0), 'ahead');
		await harness.staging.take(at(list, 1), 'ahead');

		expect(await harness.staging.roomAhead()).toBe(false);
		await expect(harness.staging.take(at(list, 2), 'ahead')).rejects.toThrow(StageFull);
		expect(await harness.staging.take(at(list, 2), 'live')).toBe('added');
		expect(await harness.staging.take(at(list, 3), 'deep')).toBe('added');
		expect(await harness.stagedIDs()).toEqual([0, 1, 2, 3]);
	});

	test('names to a filter the staged staples with a vote made from a moment on', async function() {
		const list = staples([[], [], []]);
		const harness = new Harness();
		for (const staple of list) {
			await harness.staging.take(staple, 'live');
		}

		const named = await harness.staging.named(new Date(NOW + SECOND - 100), 10);

		expect(named.map(function(staple): string {
			return(staple.blocksHash.toString());
		})).toEqual([at(list, 1).blocksHash.toString(), at(list, 2).blocksHash.toString()]);
		expect(await harness.staging.named(new Date(0), 0)).toEqual([]);
	});

	test('adds what it staged in the order of the staples\' votes, whatever order it was read in, so that none waits on a later one', async function() {
		// Each staple needs the one before: added in any other order, one would be refused.
		const list = staples(Array.from({ length: 200 }, function(_ignored, index): readonly number[] {
			if (index === 0) {
				return([]);
			}
			return([index - 1]);
		}));
		const harness = new Harness();
		for (const index of [150, 3, 199, 0, 77, ...Array.from({ length: 200 }, function(_ignored, each): number {
			return(199 - each);
		})]) {
			await harness.staging.take(at(list, index), 'live');
		}

		expect(await harness.addBefore(8.64e15)).toEqual({ left: 200, backlog: false });

		expect(harness.node.size).toBe(200);
		expect(harness.node.refused).toBe(0);
		expect(await harness.staging.isEmpty()).toBe(true);
	});

	test('reads the batch after a full one while it adds that one', async function() {
		const list = staples(Array.from({ length: 100 }, function(): readonly number[] {
			return([]);
		}));
		const node = new SimulatedNode();
		const stage = new MemoryBootstrapStage();
		const events: string[] = [];
		const recording: BootstrapStage = {
			put: function(staged) {
				return(stage.put(staged));
			},
			holds: function(key) {
				return(stage.holds(key));
			},
			firstBefore: function(moment, count, leftOut) {
				events.push(`read leaving out ${String(leftOut?.length ?? 0)}`);
				return(stage.firstBefore(moment, count, leftOut));
			},
			lastFrom: function(moment, count) {
				return(stage.lastFrom(moment, count));
			},
			remove: function(keys) {
				events.push(`remove ${String(keys.length)}`);
				return(stage.remove(keys));
			},
			counts: function() {
				return(stage.counts());
			}
		};
		const staging = new Staging(recording, simulatedRetries(node, new SimulatedRetryStore(), []), {
			holds: function(staple): Promise<boolean> {
				return(Promise.resolve(node.holds(staple)));
			},
			decode: function(bytes): SimulatedStaple {
				const staple = decodeSimulatedStaple(bytes);
				events.push(`add ${String(staple.id)}`);
				return(staple);
			}
		});
		for (const staple of list) {
			await staging.take(staple, 'live');
		}

		const { applied } = await staging.alongside(Promise.resolve(), function(): number {
			return(8.64e15);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(false);
		});

		expect(applied).toEqual({ left: 100, backlog: false });
		expect(events.slice(0, 3)).toEqual(['read leaving out 0', 'read leaving out 64', 'add 0']);
		expect(events.slice(events.indexOf('add 63'), events.indexOf('add 64') + 1)).toEqual(['add 63', 'remove 64', 'add 64']);
		expect(events.slice(events.indexOf('add 99'), events.indexOf('add 99') + 2)).toEqual(['add 99', 'remove 36']);
		expect(events.filter(function(event): boolean {
			return(event.startsWith('remove'));
		})).toEqual(['remove 64', 'remove 36']);
		expect(node.size).toBe(100);
		expect(await staging.isEmpty()).toBe(true);
	});

	test('adds a staple staged while a batch is added, ahead of the batch read meanwhile, in its place', async function() {
		// Each staple needs the one before: added in any other order, one would be refused.
		const list = staples(Array.from({ length: 200 }, function(_ignored, index): readonly number[] {
			if (index === 0) {
				return([]);
			}
			return([index - 1]);
		}));
		const late = 70;
		const node = new SimulatedNode();
		const retries = simulatedRetries(node, new SimulatedRetryStore(), []);
		const stagedLate: Promise<unknown>[] = [];
		const staging: Staging<SimulatedStaple> = new Staging(new MemoryBootstrapStage(), retries, {
			holds: function(staple): Promise<boolean> {
				return(Promise.resolve(node.holds(staple)));
			},
			// Staged while the first batch is added, so after the batch after it was read.
			decode: function(bytes): SimulatedStaple {
				const staple = decodeSimulatedStaple(bytes);
				if (staple.id === 10) {
					stagedLate.push(staging.take(at(list, late), 'live'));
				}
				return(staple);
			}
		});
		for (const [index, staple] of list.entries()) {
			if (index !== late) {
				await staging.take(staple, 'live');
			}
		}

		const { applied } = await staging.alongside(Promise.resolve(), function(): number {
			return(8.64e15);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(false);
		});

		expect(await Promise.all(stagedLate)).toEqual(['added']);
		expect(applied).toEqual({ left: 200, backlog: false });
		expect(node.size).toBe(200);
		expect(node.refused).toBe(0);
		expect(await staging.isEmpty()).toBe(true);
	});

	test('fails when removing what left the stage fails, once it stops adding, and leaves it staged', async function() {
		const list = staples([[], [0]]);
		const node = new SimulatedNode();
		const stage = new MemoryBootstrapStage();
		const failing: BootstrapStage = {
			put: function(staged) {
				return(stage.put(staged));
			},
			holds: function(key) {
				return(stage.holds(key));
			},
			firstBefore: function(moment, count, leftOut) {
				return(stage.firstBefore(moment, count, leftOut));
			},
			lastFrom: function(moment, count) {
				return(stage.lastFrom(moment, count));
			},
			remove: function() {
				return(Promise.reject(new Error('the stage failed')));
			},
			counts: function() {
				return(stage.counts());
			}
		};
		const staging = new Staging(failing, simulatedRetries(node, new SimulatedRetryStore(), []), {
			holds: function(staple): Promise<boolean> {
				return(Promise.resolve(node.holds(staple)));
			},
			decode: decodeSimulatedStaple
		});
		for (const staple of list) {
			await staging.take(staple, 'live');
		}

		await expect(staging.alongside(Promise.resolve(), function(): number {
			return(8.64e15);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(false);
		})).rejects.toThrow('the stage failed');
		expect(node.size).toBe(2);
		expect((await stage.counts()).staples).toBe(2);
	});

	test('adds only the staples whose earliest vote was made before the frontier, and the rest once it moves past them', async function() {
		const list = staples([[], [], [], []]);
		const harness = new Harness();
		for (const staple of list) {
			await harness.staging.take(staple, 'live');
		}

		expect(await harness.addBefore(NOW + 2 * SECOND - 900)).toEqual({ left: 2, backlog: false });
		expect(await harness.stagedIDs()).toEqual([2, 3]);
		expect(await harness.addBefore(NOW + 3 * SECOND - 900)).toEqual({ left: 1, backlog: false });
		expect(await harness.stagedIDs()).toEqual([3]);
		expect(harness.node.size).toBe(3);
	});

	test('queues a staple the ledger refuses for one keyed after it within the slop, and adds it once that one is added', async function() {
		// The second needs the third, whose votes were made after its own.
		const list = staples([[], [2], []]);
		const harness = new Harness();
		for (const staple of list) {
			await harness.staging.take(staple, 'live');
		}

		expect(await harness.addBefore(8.64e15)).toEqual({ left: 3, backlog: false });

		expect(harness.node.size).toBe(3);
		expect(await harness.retries.size()).toBe(0);
		expect(await harness.staging.isEmpty()).toBe(true);
	});

	test('leaves staged a staple the ledger refuses while the queue has no room, and says some are left to add', async function() {
		const list = staples([[9], [9], []]);
		// The queue's share for the node adding is one staple.
		const harness = new Harness({ bounds: { staples: 2, bytes: 1024 } });
		for (const staple of list) {
			await harness.staging.take(staple, 'live');
		}

		expect(await harness.addBefore(8.64e15)).toEqual({ left: 1, backlog: true });

		expect(await harness.retries.size()).toBe(1);
		expect(await harness.stagedIDs()).toEqual([1, 2]);
		expect(harness.node.size).toBe(0);
	});

	test('adds as the work stages staples and moves the frontier, until the work is done and nothing is left before the frontier', async function() {
		freezeClock(new Date(NOW));
		const list = staples([[], [0], [1], [2]]);
		const harness = new Harness();
		let frontier = NOW - SECOND;
		const work = (async (): Promise<string> => {
			for (const staple of list) {
				await harness.staging.take(staple, 'live');
				frontier = staple.votes[0]?.validityFrom.getTime() ?? 0;
				harness.staging.moved();
				await new Promise(setImmediate);
			}
			frontier = 8.64e15;
			harness.staging.moved();
			return('read');
		})();

		const { result, applied } = await harness.staging.alongside(work, function(): number {
			return(frontier);
		}, NOW, function(): boolean {
			return(false);
		});

		expect(result).toBe('read');
		expect(applied).toEqual({ left: 4, backlog: false });
		expect(harness.node.size).toBe(4);
		expect(harness.node.refused).toBe(0);
	});

	test('fails with the work when the work fails, once it stops adding', async function() {
		const harness = new Harness();

		await expect(harness.staging.alongside(Promise.reject(new Error('the peer failed')), function(): number {
			return(0);
		}, Date.now(), function(): boolean {
			return(false);
		})).rejects.toThrow('the peer failed');
	});

	test('adds before the overlap before where the range that reached least has reached, and every staple once no range is left', function() {
		expect(applyFrontier(layoutReached([NOW, NOW - 5 * SECOND, NOW + SECOND]))).toBe(NOW - 5 * SECOND - RANGE_OVERLAP_MILLISECONDS);
		expect(applyFrontier(layoutReached([]))).toBe(8.64e15);
		expect(applyFrontier(undefined)).toBe(8.64e15);
	});
});
