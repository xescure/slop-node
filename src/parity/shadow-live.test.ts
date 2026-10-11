import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, inject, test, vi } from 'vitest';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { loadMainnetFixture, mainnetNodeConfig } from '../conformance/mainnet/fixture.js';
import { REPLAY_TIMEOUT_MILLISECONDS } from '../conformance/mainnet/head-replay.js';
import { replayOrder } from '../conformance/mainnet/replay.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import { createDatabase } from '../testing/postgres.js';
import type { TestDatabase } from '../testing/postgres.js';
import type { SequencedStaple } from './follower-store.js';
import type { ShadowBase, ShadowRunState, ShadowTarget, ShadowVoteEntry } from './log.js';
import { SHADOW_GC_SLICE_MILLISECONDS, freshShadowRun, runShadowVotes, sampledForInformation, shadowRunComplete, shadowWindowOf, votedFrom } from './shadow-live.js';
import type { ShadowScope, ShadowSource, ShadowState } from './shadow-live.js';

const lib = KeetaNet.lib;

const GENESIS_BASE: ShadowBase = { database: null, sequence: '0', blocksHash: null, scopedStaples: 0 };

function keyOf(staple: VoteStaple): string {
	return(staple.blocksHash.toString());
}

/** Whether a block of the staple builds on a block of the earlier one. */
function buildsOn(staple: VoteStaple, earlier: VoteStaple | undefined): boolean {
	const hashes = new Set(earlier?.blocks.map(function(block): string {
		return(block.hash.toString());
	}));
	return(staple.blocks.some(function(block): boolean {
		return(hashes.has(block.previous.toString()));
	}));
}

/** The follower's store holding the staples at the places of the list, from 1 on, as its ledger added them. */
function sourceOf(staples: readonly VoteStaple[]): ShadowSource {
	const sequenced: SequencedStaple[] = staples.map(function(staple, index): SequencedStaple {
		return({ staple, stapleTime: staple.timestamp(), sequence: BigInt(index + 1) });
	});
	return({
		staplesAfter: (after, through, count) => Promise.resolve(sequenced.filter(function(entry) {
			return(entry.sequence > after && entry.sequence <= through);
		}).slice(0, count)),
		staplesOf: (blocksHashes) => Promise.resolve(sequenced.filter(function(entry) {
			return(blocksHashes.includes(keyOf(entry.staple)));
		}))
	});
}

type MemoryState = ShadowState & {
	readonly votes: ShadowVoteEntry[];
	saved: ShadowRunState | undefined;
	saves: number;
};

/** A run's standing and votes kept in memory; a save may be made to fail, as a stop of the process at that point would. */
function memoryState(failSave: (saves: number) => boolean = () => false): MemoryState {
	let votesSaved = 0;
	const state: MemoryState = {
		votes: [],
		saved: undefined,
		saves: 0,
		load: () => Promise.resolve(state.saved),
		save(standing) {
			state.saves++;
			if (failSave(state.saves)) {
				return(Promise.reject(new Error('stopped')));
			}
			state.saved = standing;
			votesSaved = state.votes.length;
			return(Promise.resolve());
		},
		record(entry) {
			state.votes.push(entry);
			return(Promise.resolve());
		},
		recordedSinceSaved: () => Promise.resolve(new Map(state.votes.slice(votesSaved).map(function(entry) {
			return([entry.blocksHash, entry] as const);
		})))
	};
	return(state);
}

const databases: TestDatabase[] = [];

afterEach(async function() {
	vi.restoreAllMocks();
	await Promise.all(databases.splice(0).map(function(database) {
		return(database.drop());
	}));
});

/**
 * A run on the offline ledger in a database, each with storage of its own
 * as a process of its own would have, so that a later run finds what an
 * earlier one left.
 */
async function offlineLedger(): Promise<<Result>(work: (storage: PostgresLedgerStorage) => Promise<Result>) => Promise<Result>> {
	const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	databases.push(database);
	return(async function<Result>(work: (storage: PostgresLedgerStorage) => Promise<Result>): Promise<Result> {
		const storage = new PostgresLedgerStorage({ kind: 'connection-string', connectionString: database.connectionString });
		try {
			return(await work(storage));
		} finally {
			await storage.destroy();
		}
	});
}

function targetOf(staples: readonly VoteStaple[]): ShadowTarget {
	return({ sequence: String(staples.length), fixedAt: '2026-10-10T00:00:00.000Z', followerCaughtUp: true, heldBefore: '2026-10-10T00:00:00.000Z' });
}

/** The scope beginning where the staple at the place was first voted for. */
function scopeFrom(staples: readonly VoteStaple[], index: number): ShadowScope {
	const staple = staples[index];
	if (staple === undefined) {
		throw(new Error(`no staple at ${String(index)}`));
	}
	return({ release: 'test', from: votedFrom(staple) });
}

async function committedExceptions(): Promise<ReadonlyMap<string, string>> {
	const parsed: unknown = JSON.parse(await readFile(new URL('../../conformance/mainnet/shadow-vote-exceptions.json', import.meta.url), 'utf8'));
	const exceptions = new Map<string, string>();
	if (typeof parsed !== 'object' || parsed === null) {
		throw(new Error('no exceptions'));
	}
	for (const [blocksHash, entry] of Object.entries(parsed)) {
		const fields: unknown = entry;
		if (typeof fields === 'object' && fields !== null && 'reason' in fields && typeof fields.reason === 'string') {
			exceptions.set(blocksHash, fields.reason);
		}
	}
	return(exceptions);
}

function countBy(values: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) {
		counts[value] = (counts[value] ?? 0) + 1;
	}
	return(counts);
}

describe('the window a staple is shadow-voted in', function() {
	test('is the scoped one when its earliest vote is from the scope\'s start on', async function() {
		const head = await loadMainnetFixture('head');
		const { from } = scopeFrom(head, 0);
		const [staple] = head;
		expect(staple && shadowWindowOf(staple, { release: 'test', from })).toBe('scoped');
		expect(staple && shadowWindowOf(staple, { release: 'test', from: new Date(from.valueOf() + 1) })).toBe('informational');
	});

	test('samples the informational window by the hash of the blocks', function() {
		expect(sampledForInformation(`${'0'.repeat(11)}A${'F'.repeat(52)}`, 10)).toBe(true);
		expect(sampledForInformation(`${'0'.repeat(11)}B${'F'.repeat(52)}`, 10)).toBe(false);
		expect(sampledForInformation('FF'.repeat(32), 1)).toBe(true);
	});
});

describe('shadow votes on the follower\'s history', function() {
	test('vote on every staple of the scoped window and on one in so many before it, refusing only what the classified differences explain', async function() {
		const head = replayOrder(await loadMainnetFixture('head'));
		const scope = scopeFrom(head, 1400);
		const state = memoryState();
		const reached = await runShadowVotes({ source: sourceOf(head), state, storage: new MemoryLedgerStorage(), start: freshShadowRun(scope, 4, GENESIS_BASE, targetOf(head)), batchStaples: 300 });

		const scoped = head.filter(function(staple) {
			return(shadowWindowOf(staple, scope) === 'scoped');
		});
		const sampled = head.filter(function(staple) {
			return(shadowWindowOf(staple, scope) === 'informational' && sampledForInformation(keyOf(staple), 4));
		});
		const exceptions = await committedExceptions();
		const reasonsOf = function(staples: readonly VoteStaple[]): Record<string, number> {
			return(countBy(staples.flatMap(function(staple) {
				return([exceptions.get(keyOf(staple)) ?? []].flat());
			})));
		};
		expect(scoped.length).toBeGreaterThan(400);
		expect(Object.keys(reasonsOf(scoped)).length).toBeGreaterThan(0);
		expect(shadowRunComplete(reached)).toBe(true);
		expect(reached).toMatchObject({ reached: { sequence: String(head.length), blocksHash: head.at(-1)?.blocksHash.toString() }, unapplied: [] });
		expect(reached.scoped).toMatchObject({ replayed: scoped.length, shadowVoted: scoped.length, unexplained: 0, explained: reasonsOf(scoped), votedFrom: scope.from.toISOString() });
		expect(reached.informational).toMatchObject({ replayed: head.length - scoped.length, shadowVoted: sampled.length, unexplained: 0, explained: reasonsOf(sampled) });
		expect(state.votes.map(function(vote) {
			return(vote.blocksHash);
		})).toEqual([...scoped, ...sampled].map(keyOf).sort(function(left, right) {
			return(head.findIndex(function(staple) {
				return(keyOf(staple) === left);
			}) - head.findIndex(function(staple) {
				return(keyOf(staple) === right);
			}));
		}));
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('resume where a stop left them, voting on no staple twice and skipping none', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 400);
		const scope = scopeFrom(head, 250);
		const start = freshShadowRun(scope, 3, GENESIS_BASE, targetOf(head));
		const whole = await runShadowVotes({ source: sourceOf(head), state: memoryState(), storage: new MemoryLedgerStorage(), start, batchStaples: 50 });

		// The run is asked to stop after its second batch, then cut short at its fifth save, then resumes in batches of another size.
		const inLedger = await offlineLedger();
		const state = memoryState(function(saves) {
			return(saves === 5);
		});
		const stopping = new AbortController();
		const first = await inLedger(function(storage) {
			return(runShadowVotes({ source: sourceOf(head.slice(0, 300)), state, storage, start: { ...start, target: targetOf(head.slice(0, 300)) }, batchStaples: 50, stopped: stopping.signal, progress(standing) {
				if (standing.reached.sequence === '100') {
					stopping.abort();
				}
			} }));
		});
		expect(first.reached.sequence).toBe('100');
		await expect(inLedger(function(storage) {
			return(runShadowVotes({ source: sourceOf(head), state, storage, start: { ...first, target: targetOf(head) }, batchStaples: 50 }));
		})).rejects.toThrow('stopped');
		expect(state.saved?.reached.sequence).toBe('200');
		const resumed = await inLedger(function(storage) {
			return(runShadowVotes({ source: sourceOf(head), state, storage, start: { ...(state.saved ?? first), target: targetOf(head) }, batchStaples: 35 }));
		});

		expect({ ...resumed, target: whole.target }).toEqual(whole);
		const voted = state.votes.map(function(vote) {
			return(vote.blocksHash);
		});
		expect(new Set(voted).size).toBe(voted.length);
		expect(voted.length).toBe(whole.scoped.shadowVoted + whole.informational.shadowVoted);
	}, REPLAY_TIMEOUT_MILLISECONDS);

	/*
	 * A snapshot holds deferred copies of staples the follower applied later,
	 * by a replay of the staple before on their chain, in the same
	 * transaction; the offline ledger replays them as the follower did, ahead
	 * of their own places.
	 */
	test('skip as held a staple the offline ledger applied before its place, replaying a deferred copy, unless it is to be voted on', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 400);
		// Past the first staples, whose votes the weight that later staples give carries.
		const earlier = head.findIndex(function(staple, index): boolean {
			return(index >= 200 && head.slice(index + 1).some(function(later): boolean {
				return(buildsOn(later, staple));
			}));
		});
		const later = head.findIndex(function(staple, index): boolean {
			return(index > earlier && buildsOn(staple, head[earlier]));
		});
		const laterStaple = head[later];
		if (earlier < 0 || laterStaple === undefined) {
			throw(new Error('no staple of the head extends an earlier one'));
		}
		const scope = scopeFrom(head, head.length - 1);
		const every = [1000, 1001, 1003].find(function(candidate): boolean {
			return(!sampledForInformation(keyOf(laterStaple), candidate));
		}) ?? 1000;
		const start = freshShadowRun(scope, every, GENESIS_BASE, targetOf(head));
		const whole = await runShadowVotes({ source: sourceOf(head), state: memoryState(), storage: new MemoryLedgerStorage(), start, batchStaples: 50 });

		const withDeferredCopy = async function(informationalEvery: number): Promise<ShadowRunState> {
			const inLedger = await offlineLedger();
			const state = memoryState();
			const before = await inLedger(function(storage) {
				return(runShadowVotes({ source: sourceOf(head.slice(0, earlier)), state, storage, start: { ...start, informationalEvery, target: targetOf(head.slice(0, earlier)) }, batchStaples: 50 }));
			});
			await inLedger(async function(storage) {
				const node = new lib.Node(mainnetNodeConfig(storage));
				try {
					expect(await node.ledger.add(laterStaple)).toEqual([]);
				} finally {
					await node.stop();
				}
			});
			return(await inLedger(function(storage) {
				return(runShadowVotes({ source: sourceOf(head), state, storage, start: { ...before, target: targetOf(head) }, batchStaples: 50 }));
			}));
		};

		expect(await withDeferredCopy(every)).toEqual(whole);
		await expect(withDeferredCopy(1)).rejects.toThrow(`the offline ledger applied staple ${keyOf(laterStaple)} before its place ${String(later + 1)}`);
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('stop rather than miscount when the ledger holds a staple whose vote was never recorded', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 100);
		const start = freshShadowRun(scopeFrom(head, 0), 1, GENESIS_BASE, targetOf(head));
		const inLedger = await offlineLedger();
		const lost = memoryState(function(saves) {
			return(saves === 1);
		});
		await expect(inLedger(function(storage) {
			return(runShadowVotes({ source: sourceOf(head), state: lost, storage, start, batchStaples: 50 }));
		})).rejects.toThrow('stopped');
		// The votes of the batch cut short are lost with the machine, while the ledger kept its staples.
		lost.votes.splice(0);

		await expect(inLedger(function(storage) {
			return(runShadowVotes({ source: sourceOf(head), state: lost, storage, start, batchStaples: 50 }));
		})).rejects.toThrow('whose shadow vote was never recorded');
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('count a staple of the window whose history the follower lacks as refused without explanation, and as not applied', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 300);
		const window = head.slice(-100);
		const blockStaple = new Map(window.flatMap(function(staple) {
			return(staple.blocks.map(function(block) {
				return([block.hash.toString(), staple] as const);
			}));
		}));
		// A staple of the window that builds on a block another staple of the window holds.
		const dependent = window.find(function(staple) {
			return(staple.blocks.some(function(block) {
				const holder = blockStaple.get(block.previous.toString());
				return(holder !== undefined && holder !== staple);
			}));
		});
		const missing = dependent?.blocks.map(function(block) {
			return(blockStaple.get(block.previous.toString()));
		}).find(function(holder) {
			return(holder !== undefined && holder !== dependent);
		});
		expect(dependent).toBeDefined();
		expect(missing).toBeDefined();
		const held = head.filter(function(staple) {
			return(staple !== missing);
		});

		const reached = await runShadowVotes({ source: sourceOf(held), state: memoryState(), storage: new MemoryLedgerStorage(), start: freshShadowRun(scopeFrom(head, 200), 1, GENESIS_BASE, targetOf(held)) });

		expect(reached.scoped.firstUnexplained.map(function(refusal) {
			return(refusal.blocksHash);
		})).toContain(dependent?.blocksHash.toString());
		expect(reached.unapplied).toContainEqual(expect.objectContaining({ blocksHash: dependent?.blocksHash.toString(), why: 'deferred' }));
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('retry a staple refused for want of voting weight once the staples that give it come', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 200);
		// The genesis staple gives the first representatives their weight; added late, the staples before it wait for it.
		const rest = head.slice(1);
		const late = [...rest.slice(0, 5), ...head.slice(0, 1), ...rest.slice(5)];
		const state = memoryState();
		const reached = await runShadowVotes({ source: sourceOf(late), state, storage: new MemoryLedgerStorage(), start: freshShadowRun(scopeFrom(head, 150), 10, GENESIS_BASE, targetOf(late)), batchStaples: 3 });

		expect(reached.refusedForWeight).toBeGreaterThan(0);
		expect(reached).toMatchObject({ reached: { sequence: '200' }, unapplied: [] });
		expect(reached.scoped.replayed + reached.informational.replayed).toBe(200);
	}, REPLAY_TIMEOUT_MILLISECONDS);

	/*
	 * The offline ledger lives in the follower's cluster, where a
	 * serializable transaction left open holds back what every other one may
	 * forget, and the follower's transactions then fail as conflicts. A
	 * stopped clock never lets the ledger's time limits end a collection or
	 * a replay: releasing a long deferred chain held one transaction open
	 * for most of an hour.
	 */
	test('add and collect on a clock that runs on from each staple\'s moment, collecting in slices of bounded time', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 40);
		const storage = new MemoryLedgerStorage();
		let ticks = 0;
		vi.spyOn(performance, 'now').mockImplementation(function(): number {
			ticks += 1000;
			return(ticks);
		});
		const collected: { readonly limit: number | undefined; readonly at: number }[] = [];
		const collect = storage.gc.bind(storage);
		vi.spyOn(storage, 'gc').mockImplementation(function(transaction: unknown, limit?: number): Promise<boolean> {
			collected.push({ limit, at: Date.now() });
			return(collect(transaction, limit));
		});
		await runShadowVotes({ source: sourceOf(head), state: memoryState(), storage, start: freshShadowRun(scopeFrom(head, 39), 1000, GENESIS_BASE, targetOf(head)), batchStaples: 20 });

		expect(collected.map(function({ limit }): number | undefined {
			return(limit);
		})).toEqual([SHADOW_GC_SLICE_MILLISECONDS, SHADOW_GC_SLICE_MILLISECONDS]);
		expect(collected.map(function({ at }, batch): boolean {
			return(at > (head[batch * 20 + 19]?.timestamp().getTime() ?? Number.POSITIVE_INFINITY));
		})).toEqual([true, true]);
	});

	test('replay nothing past a target they have reached', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 3);
		const start = freshShadowRun(scopeFrom(head, 0), 1, { database: 'follower_snapshot', sequence: '3', blocksHash: head[2]?.blocksHash.toString() ?? null, scopedStaples: 0 }, targetOf(head));
		const reached = await runShadowVotes({ source: sourceOf(head), state: memoryState(), storage: new MemoryLedgerStorage(), start });
		expect(reached).toEqual(start);
		expect(shadowRunComplete(reached)).toBe(true);
	});
});
