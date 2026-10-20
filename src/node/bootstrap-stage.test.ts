import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryBootstrapStage } from '../ledger/storage/stage.js';
import type { BootstrapStage } from '../ledger/storage/stage.js';
import { freezeClock } from '../testing/network.js';
import { captureUnhandledRejections } from '../testing/unhandled-rejections.js';
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

		expect(await harness.addBefore(8.64e15)).toEqual({ left: 200, backlog: false, blocked: false });

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

		expect(applied).toEqual({ left: 100, backlog: false, blocked: false });
		expect(events.slice(0, 3)).toEqual(['read leaving out 0', 'read leaving out 64', 'add 0']);
		expect(events.slice(events.indexOf('add 63'), events.indexOf('add 64') + 1)).toEqual(['add 63', 'remove 64', 'add 64']);
		expect(events.slice(events.indexOf('add 99'), events.indexOf('add 99') + 2)).toEqual(['add 99', 'remove 36']);
		// Once removed, a staple is left out of no read.
		expect(events.filter(function(event): boolean {
			return(!event.startsWith('add'));
		})).toEqual(['read leaving out 0', 'read leaving out 64', 'remove 64', 'remove 36', 'read leaving out 0', 'read leaving out 0']);
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
		expect(applied).toEqual({ left: 200, backlog: false, blocked: false });
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

		expect(await harness.addBefore(NOW + 2 * SECOND - 900)).toEqual({ left: 2, backlog: false, blocked: false });
		expect(await harness.stagedIDs()).toEqual([2, 3]);
		expect(await harness.addBefore(NOW + 3 * SECOND - 900)).toEqual({ left: 1, backlog: false, blocked: false });
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

		expect(await harness.addBefore(8.64e15)).toEqual({ left: 3, backlog: false, blocked: false });

		expect(harness.node.size).toBe(3);
		expect(await harness.retries.size()).toBe(0);
		expect(await harness.staging.isEmpty()).toBe(true);
	});

	test('leaves staged a staple the ledger refuses while the queue has no room, and says some are left to add, the queue having blocked the adding', async function() {
		const list = staples([[9], [9], []]);
		// The queue's share for the node adding is one staple.
		const harness = new Harness({ bounds: { staples: 2, bytes: 1024 } });
		for (const staple of list) {
			await harness.staging.take(staple, 'live');
		}

		expect(await harness.addBefore(8.64e15)).toEqual({ left: 1, backlog: true, blocked: true });

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
		expect(applied).toEqual({ left: 4, backlog: false, blocked: false });
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

	test('refuses a staple from a range read ahead at its bound, naming the bound and the staple', async function() {
		const [first, second] = staples([[], []]);
		if (first === undefined || second === undefined) {
			throw(new Error('no staples'));
		}
		const harness = new Harness({ bound: 1 });
		await harness.staging.take(first, 'live');

		const refused = await harness.staging.take(second, 'ahead').then(function(): never {
			throw(new Error('expected the stage to be full'));
		}, function(error: unknown): unknown {
			return(error);
		});

		expect(refused).toBeInstanceOf(StageFull);
		expect(refused).toMatchObject({ name: 'StageFull', message: `the bootstrap stage held its bound of 1 bytes when staple ${second.blocksHash.toString()} came from a range read ahead` });
	});

	test('keeps its counts as staples are staged and leave, and reads them again after a read that failed', async function() {
		const list = staples([[], [], []]);
		const harness = new Harness();
		expect(await harness.staging.isEmpty()).toBe(true);
		for (const staple of list) {
			await harness.staging.take(staple, 'live');
		}
		expect(await harness.staging.isEmpty()).toBe(false);
		expect(await harness.staging.counts()).toEqual({ staples: 3, bytes: 3 * SIMULATED_STAPLE_BYTES });

		await harness.addBefore(8.64e15);

		expect(await harness.staging.counts()).toEqual({ staples: 0, bytes: 0 });
		const stage = new MemoryBootstrapStage();
		const counts = vi.spyOn(stage, 'counts').mockRejectedValueOnce(new Error('the stage failed'));
		const staging = new Staging(stage, harness.retries, { holds: function(): Promise<boolean> {
			return(Promise.resolve(false));
		}, decode: decodeSimulatedStaple });
		await expect(staging.counts()).rejects.toThrow('the stage failed');
		expect(await staging.counts()).toEqual({ staples: 0, bytes: 0 });
		expect(counts).toHaveBeenCalledTimes(2);
	});

	test('asks the stage for no staple to name when none is wanted', async function() {
		const harness = new Harness();
		await harness.staging.take(at(staples([[]]), 0), 'live');
		const lastFrom = vi.spyOn(harness.stage, 'lastFrom');

		expect(await harness.staging.named(new Date(0), 0)).toEqual([]);
		expect(await harness.staging.named(new Date(0), -3)).toEqual([]);
		expect(lastFrom).not.toHaveBeenCalled();
	});

	test('adds a staple staged while the work runs, and one the frontier moved past, without waiting for the work to end', async function() {
		const [first, second] = staples([[], [0]]);
		if (first === undefined || second === undefined) {
			throw(new Error('no staples'));
		}
		const harness = new Harness();
		// Between the two staples' votes.
		let frontier = NOW + 1;
		let finish: (() => void) | undefined;
		const work = new Promise<void>(function(resolve) {
			finish = resolve;
		});
		const adding = harness.staging.alongside(work, function(): number {
			return(frontier);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(false);
		});

		await harness.staging.take(first, 'live');
		await turnsOfTheLoop();
		expect(harness.node.holds(first)).toBe(true);
		await harness.staging.take(second, 'live');
		await turnsOfTheLoop();
		expect(harness.node.holds(second)).toBe(false);

		// Only the move tells the node adding that the frontier is past it.
		frontier = 8.64e15;
		await turnsOfTheLoop();
		expect(harness.node.holds(second)).toBe(false);
		harness.staging.moved();
		await turnsOfTheLoop();
		expect(harness.node.holds(second)).toBe(true);

		finish?.();
		expect((await adding).applied).toEqual({ left: 2, backlog: false, blocked: false });
	});

	test('adds nothing once stopped, and says nothing is left when nothing was staged', async function() {
		const list = staples([[], [], []]);
		const harness = new Harness();
		for (const staple of list) {
			await harness.staging.take(staple, 'live');
		}
		let offered = 0;
		const offer = vi.spyOn(harness.node, 'offer');
		offer.mockImplementation(function(...args: Parameters<SimulatedNode['offer']>): ReturnType<SimulatedNode['offer']> {
			offered++;
			offer.mockRestore();
			const result = harness.node.offer(...args);
			offer.mockImplementation(function(...again: Parameters<SimulatedNode['offer']>): ReturnType<SimulatedNode['offer']> {
				offered++;
				return(SimulatedNode.prototype.offer.apply(harness.node, again));
			});
			return(result);
		});

		const { applied } = await harness.staging.alongside(Promise.resolve(), function(): number {
			return(8.64e15);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(offered > 0);
		});

		expect(applied).toEqual({ left: 1, backlog: true, blocked: false });
		expect(await harness.stagedIDs()).toEqual([1, 2]);

		const empty = new Harness();
		expect((await empty.staging.alongside(Promise.resolve(), function(): number {
			return(8.64e15);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(true);
		})).applied).toEqual({ left: 0, backlog: false, blocked: false });
	});

	test('stops adding once the work is done and its time is up, and says what is left', async function() {
		freezeClock(new Date(NOW));
		const list = staples(Array.from({ length: 100 }, function(): readonly number[] {
			return([]);
		}));
		const harness = new Harness();
		for (const staple of list) {
			await harness.staging.take(staple, 'live');
		}

		const { applied } = await harness.staging.alongside(Promise.resolve(), function(): number {
			return(8.64e15);
		}, NOW, function(): boolean {
			return(false);
		});

		expect(applied).toEqual({ left: 64, backlog: true, blocked: false });
		expect((await harness.stagedIDs()).length).toBe(36);
	});

	test('waits for the removal of what left the stage before it ends', async function() {
		const list = staples([[], []]);
		const node = new SimulatedNode();
		const stage = new MemoryBootstrapStage();
		const slowRemoval: BootstrapStage = {
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
			remove: async function(keys) {
				await turnsOfTheLoop();
				return(await stage.remove(keys));
			},
			counts: function() {
				return(stage.counts());
			}
		};
		const staging = new Staging(slowRemoval, simulatedRetries(node, new SimulatedRetryStore(), []), {
			holds: function(staple): Promise<boolean> {
				return(Promise.resolve(node.holds(staple)));
			},
			decode: decodeSimulatedStaple
		});
		for (const staple of list) {
			await staging.take(staple, 'live');
		}
		freezeClock(new Date(NOW));

		// Its time is up, so it ends after the one batch, while the batch's removal runs.
		await staging.alongside(Promise.resolve(), function(): number {
			return(8.64e15);
		}, NOW, function(): boolean {
			return(false);
		});

		expect(await stage.counts()).toEqual({ staples: 0, bytes: 0 });
	});

	test('fails, once it stops adding, when a staple cannot be added for a reason other than a full queue', async function() {
		const list = staples([[], []]);
		const node = new SimulatedNode();
		const staging = new Staging(new MemoryBootstrapStage(), simulatedRetries(node, new SimulatedRetryStore(), []), {
			holds: function(staple): Promise<boolean> {
				return(Promise.resolve(node.holds(staple)));
			},
			decode: function(): SimulatedStaple {
				throw(new Error('the staged bytes are no staple'));
			}
		});
		for (const staple of list) {
			await staging.take(staple, 'live');
		}

		await expect(staging.alongside(Promise.resolve(), function(): number {
			return(8.64e15);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(false);
		})).rejects.toThrow('the staged bytes are no staple');
	});

	test('adds of the batch read ahead only what lies before a frontier that moved back meanwhile', async function() {
		const list = staples(Array.from({ length: 100 }, function(): readonly number[] {
			return([]);
		}));
		const harness = new Harness();
		for (const staple of list) {
			await harness.staging.take(staple, 'live');
		}
		const firstVoteOf = function(index: number): number {
			return(Math.min(...at(list, index).votes.map(function(vote): number {
				return(vote.validityFrom.getTime());
			})));
		};
		let frontier = 8.64e15;
		const offer = vi.spyOn(harness.node, 'offer').mockImplementation(function(...args: Parameters<SimulatedNode['offer']>): ReturnType<SimulatedNode['offer']> {
			// As a range is handed over the overlap before where it reached, the frontier moves back.
			if (args[0].id === 10) {
				frontier = firstVoteOf(70);
			}
			return(SimulatedNode.prototype.offer.apply(harness.node, args));
		});

		const { applied } = await harness.staging.alongside(Promise.resolve(), function(): number {
			return(frontier);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(false);
		});

		expect(applied.left).toBe(70);
		expect(await harness.stagedIDs()).toEqual(Array.from({ length: 30 }, function(_ignored, index): number {
			return(70 + index);
		}));
		offer.mockRestore();
	});

	test('starts again from the earliest staged staple after a queue that had no room made some, rather than add the batch read ahead', async function() {
		// A queued staple whose voters gain their weight with genesis frees, once offered again, the one place a node adding has; the staged staple after the first five needs it, and each after that the one before.
		const list = staples([[], [0], ...Array.from({ length: 100 }, function(_ignored, index): readonly number[] {
			const id = index + 2;
			if (id < 7) {
				return([0]);
			}
			if (id === 7) {
				return([1]);
			}
			return([id - 1]);
		})]);
		const harness = new Harness({ bounds: { staples: 2, bytes: 1024 * 1024 } });
		expect(await harness.retries.add(at(list, 1), 'deep')).toBe('queued');
		await harness.node.add(at(list, 0));
		for (const staple of list.slice(2)) {
			await harness.staging.take(staple, 'live');
		}
		const offered: number[] = [];
		vi.spyOn(harness.node, 'offer').mockImplementation(function(...args: Parameters<SimulatedNode['offer']>): ReturnType<SimulatedNode['offer']> {
			offered.push(args[0].id);
			return(SimulatedNode.prototype.offer.apply(harness.node, args));
		});

		await harness.addBefore(8.64e15);

		expect(offered.filter(function(id): boolean {
			return(id >= 2);
		})).toEqual([...offered.filter(function(id): boolean {
			return(id >= 2);
		})].sort(function(left, right): number {
			return(left - right);
		}));
		expect(harness.node.size).toBe(list.length);
	});
});

describe('staging what the ranges read, while something fails', function() {
	/** A stage whose reads and removals fail as the test says, and whose node's offers each take turns of the loop, as a ledger's do. */
	function failingHarness(fails: { readonly read?: number; readonly remove?: number }): { readonly staging: Staging<SimulatedStaple>; readonly stage: MemoryBootstrapStage; readonly node: SimulatedNode } {
		const node = new SimulatedNode();
		const stage = new MemoryBootstrapStage();
		let reads = 0;
		let removals = 0;
		const failing: BootstrapStage = {
			put: function(staged) {
				return(stage.put(staged));
			},
			holds: function(key) {
				return(stage.holds(key));
			},
			firstBefore: function(moment, count, leftOut) {
				reads++;
				if (reads === fails.read) {
					return(Promise.reject(new Error('the read failed')));
				}
				return(stage.firstBefore(moment, count, leftOut));
			},
			lastFrom: function(moment, count) {
				return(stage.lastFrom(moment, count));
			},
			remove: function(keys) {
				removals++;
				if (removals === fails.remove) {
					return(Promise.reject(new Error('the removal failed')));
				}
				return(stage.remove(keys));
			},
			counts: function() {
				return(stage.counts());
			}
		};
		vi.spyOn(node, 'offer').mockImplementation(async function(...args: Parameters<SimulatedNode['offer']>): ReturnType<SimulatedNode['offer']> {
			await turnsOfTheLoop();
			return(await SimulatedNode.prototype.offer.apply(node, args));
		});
		const staging = new Staging(failing, simulatedRetries(node, new SimulatedRetryStore(), []), {
			holds: function(staple): Promise<boolean> {
				return(Promise.resolve(node.holds(staple)));
			},
			decode: decodeSimulatedStaple
		});
		return({ staging, stage, node });
	}

	async function stageAll(staging: Staging<SimulatedStaple>, count: number): Promise<void> {
		for (const staple of staples(Array.from({ length: count }, function(): readonly number[] {
			return([]);
		}))) {
			await staging.take(staple, 'live');
		}
	}

	test('hears of a work that failed while a staple was being added only once it stops adding, leaving no rejection unhandled', async function() {
		const unhandled = captureUnhandledRejections();
		const { staging } = failingHarness({});
		await stageAll(staging, 2);

		await expect(staging.alongside(Promise.reject(new Error('the peer failed')), function(): number {
			return(8.64e15);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(false);
		})).rejects.toThrow('the peer failed');

		expect(unhandled.reasons).toEqual([]);
	});

	test('drops a batch read ahead that failed once it stops before it, leaving no rejection unhandled', async function() {
		const unhandled = captureUnhandledRejections();
		const { staging, node } = failingHarness({ read: 2 });
		await stageAll(staging, 100);

		const { applied } = await staging.alongside(Promise.resolve(), function(): number {
			return(8.64e15);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(node.size > 0);
		});

		expect(applied.left).toBe(1);
		expect(unhandled.reasons).toEqual([]);
	});

	test('fails with a removal that failed while the next batch was added, leaving no rejection unhandled', async function() {
		const unhandled = captureUnhandledRejections();
		const { staging, stage } = failingHarness({ remove: 1 });
		await stageAll(staging, 100);

		await expect(staging.alongside(Promise.resolve(), function(): number {
			return(8.64e15);
		}, Number.POSITIVE_INFINITY, function(): boolean {
			return(false);
		})).rejects.toThrow('the removal failed');

		expect(unhandled.reasons).toEqual([]);
		// The staples whose removal failed stay staged, to be found held when offered again.
		expect((await stage.counts()).staples).toBeGreaterThan(0);
	});
});

/** Lets every promise the staging chained settle, as a few turns of the event loop do. */
async function turnsOfTheLoop(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) {
		await new Promise(setImmediate);
	}
}
