import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, inject, test, vi } from 'vitest';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { loadMainnetFixture, mainnetNodeConfig } from '../conformance/mainnet/fixture.js';
import { REPLAY_TIMEOUT_MILLISECONDS } from '../conformance/mainnet/head-replay.js';
import { replayOrder } from '../conformance/mainnet/replay.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import { confirmedStaple, operationsBlock } from '../testing/blocks.js';
import { createDatabase } from '../testing/postgres.js';
import type { TestDatabase } from '../testing/postgres.js';
import type { SequencedStaple } from './follower-store.js';
import { ParityLog } from './log.js';
import type { ShadowBase, ShadowRunRecord, ShadowRunState, ShadowTarget, ShadowVoteEntry } from './log.js';
import { recordsOf } from './report.js';
import { CONFIRMATION_REFUSED, SHADOW_GC_SLICE_MILLISECONDS, explainByRule, freshShadowRun, runShadowVotes, sampledForInformation, shadowLedgerStorage, shadowRunComplete, shadowWindowOf, votedFrom } from './shadow-live.js';
import type { ShadowScope, ShadowSource, ShadowState } from './shadow-live.js';

const lib = KeetaNet.lib;

const GENESIS_BASE: ShadowBase = { database: null, sequence: '0', blocksHash: null, scopedStaples: 0 };

const SCOPE_OF_TEST: ShadowScope = { release: 'test', from: new Date(0) };

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

/**
 * The head, but for a chain of three staples, each building on the one
 * before, after a staple past the first two hundred: listed just before
 * the staple they build on, at whose place they are released.
 */
async function chainListedBeforeItsRoot(): Promise<{ readonly listed: readonly VoteStaple[]; readonly rootPlace: number }> {
	const head = replayOrder(await loadMainnetFixture('head')).slice(0, 400);
	const chainOf = function(root: number): number[] {
		const chain: number[] = [];
		let tip = root;
		for (let index = root + 1; index < head.length && chain.length < 3; index++) {
			const staple = head[index];
			if (staple !== undefined && buildsOn(staple, head[tip])) {
				chain.push(index);
				tip = index;
			}
		}
		return(chain);
	};
	const root = head.findIndex(function(_staple, index): boolean {
		return(index >= 200 && chainOf(index).length === 3);
	});
	const chain = chainOf(root);
	if (root < 0) {
		throw(new Error('no chain of three staples in the head'));
	}
	const listed = [...head.slice(0, root).filter(function(_staple, index): boolean {
		return(!chain.includes(index));
	}), ...chain.flatMap(function(index): VoteStaple[] {
		return(head.slice(index, index + 1));
	}), ...head.slice(root).filter(function(_staple, index): boolean {
		return(!chain.includes(index + root));
	})];
	return({ listed, rootPlace: root + chain.length });
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

	test('explain a refusal for blocks dated more than five minutes before the staple\'s votes once a vote beside its own permanent votes passes, and only then', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 160);
		const exceptions = await committedExceptions();
		const place = head.findIndex(function(staple, index): boolean {
			return(index >= 100 && !exceptions.has(keyOf(staple)));
		});
		const original = head[place];
		if (original === undefined) {
			throw(new Error('no staple the shadow votes for'));
		}
		// Its blocks fail the age check at its votes' moment, ten minutes after them.
		const voter = lib.Account.fromSeed('5b1e8d2c4a6f7e9b0c3d5a7f9e1b3c5d7a9f0e2b4c6d8a0f2e4b6c8d0a2f4e6b', 0);
		const late = await confirmedStaple(original.blocks, [voter], { voteDelays: [10 * 60_000] });
		const replayed = [...head.slice(0, place), late, ...head.slice(place + 1)];
		const everyStaple: ShadowScope = { release: 'test', from: new Date(0) };
		const outcomeOfLate = async function(): Promise<ShadowVoteEntry['outcome'] | undefined> {
			const state = memoryState();
			await runShadowVotes({ source: sourceOf(replayed), state, storage: new MemoryLedgerStorage(), start: freshShadowRun(everyStaple, 1, GENESIS_BASE, targetOf(replayed)), batchStaples: 200 });
			return(state.votes.find(function(vote): boolean {
				return(vote.blocksHash === keyOf(late));
			})?.outcome);
		};

		// The voter holds no weight on the main network, so a vote beside its vote alone is refused.
		expect(await outcomeOfLate()).toMatchObject({ kind: 'unexplained', code: 'LEDGER_BLOCK_EXPIRED', why: `${CONFIRMATION_REFUSED} LEDGER_INSUFFICIENT_VOTING_WEIGHT: Temporary vote must represent at least a minority of the voting weight` });

		// Holding every delegation, its vote is enough for a vote beside it, which skips the check of the blocks' dates.
		const realWeight = Reflect.get(MemoryLedgerStorage.prototype, 'delegatedWeight');
		vi.spyOn(MemoryLedgerStorage.prototype, 'delegatedWeight').mockImplementation(function(this: MemoryLedgerStorage, ...args: Parameters<MemoryLedgerStorage['delegatedWeight']>) {
			const [transaction, representative] = args;
			if (representative instanceof lib.Account && representative.comparePublicKey(voter)) {
				return(Reflect.apply(realWeight, this, [transaction]));
			}
			return(Reflect.apply(realWeight, this, args));
		});
		expect(await outcomeOfLate()).toEqual({ kind: 'explained', reason: 'permanent-vote-block-age', code: 'LEDGER_BLOCK_EXPIRED' });
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('explain by rule alone a refusal for a block\'s date that a build without the confirming vote recorded, once, and no other', async function() {
		const voter = lib.Account.fromSeed('5b1e8d2c4a6f7e9b0c3d5a7f9e1b3c5d7a9f0e2b4c6d8a0f2e4b6c8d0a2f4e6b', 1);
		const voted = new Date('2026-10-08T19:54:38.360Z');
		const datedStaple = async function(minutesBefore: number, index: number): Promise<VoteStaple> {
			const block = await operationsBlock({ account: lib.Account.fromSeed('5b1e8d2c4a6f7e9b0c3d5a7f9e1b3c5d7a9f0e2b4c6d8a0f2e4b6c8d0a2f4e6b', 10 + index), signer: undefined, previous: null, network: 0x5382n, date: new Date(voted.valueOf() - minutesBefore * 60_000), operations: [{ type: lib.Block.OperationType.SET_REP, to: voter }] });
			return(confirmedStaple([block], [voter], { voteDelays: [minutesBefore * 60_000] }));
		};
		const old = await datedStaple(6, 0);
		const confirmedApart = await datedStaple(6, 1);
		const recent = await datedStaple(2, 2);
		const preRule = 'only a permission refusal is explained, not LEDGER_BLOCK_EXPIRED: Refusing to issue vote';
		const unexplained = function(staple: VoteStaple, why: string) {
			return({ blocksHash: keyOf(staple), code: 'LEDGER_BLOCK_EXPIRED', message: 'Refusing to issue vote', why });
		};
		const tally = { ...freshShadowRun(SCOPE_OF_TEST, 1, GENESIS_BASE, targetOf([])).scoped, unexplained: 3, firstUnexplained: [unexplained(old, preRule), unexplained(confirmedApart, `${CONFIRMATION_REFUSED} LEDGER_INSUFFICIENT_VOTING_WEIGHT: Temporary vote must represent at least a minority of the voting weight`), unexplained(recent, preRule)] };
		const run: ShadowRunRecord = { kind: 'shadow-run', at: '2026-10-12T16:20:00.000Z', ...freshShadowRun(SCOPE_OF_TEST, 1, GENESIS_BASE, targetOf([])), scoped: tally, complete: true, cost: { seconds: 1, staples: 3, shadowVotes: 3, maxResidentMiB: 1 } };
		const directory = await mkdtemp(join(tmpdir(), 'slop-shadow-explain-'));
		const log = new ParityLog(join(directory, 'parity.jsonl'));
		await log.append([run]);
		const anchors = { initialTrustedAccount: voter, ...lib.Account.generateBaseAddresses(0x5382n) };
		try {
			const at = new Date('2026-10-12T17:00:00.000Z');
			const explained = await explainByRule(log, sourceOf([old, confirmedApart, recent]), anchors, at);

			expect(explained).toEqual([{ kind: 'shadow-explained', at: at.toISOString(), blocksHash: keyOf(old), window: 'scoped', code: 'LEDGER_BLOCK_EXPIRED', reason: 'permanent-vote-block-age', basis: 'by-rule', replaces: preRule }]);
			expect(await explainByRule(log, sourceOf([old, confirmedApart, recent]), anchors, at)).toEqual([]);
			expect(recordsOf((await log.read()).records, 'shadow-explained')).toEqual(explained);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

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

	test('refuse to resume on an offline ledger that lacks a staple of the batch saved last, as a kill losing its last commits leaves it', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 100);
		const start = freshShadowRun(scopeFrom(head, 50), 3, GENESIS_BASE, targetOf(head));
		const saved = memoryState();
		await runShadowVotes({ source: sourceOf(head), state: saved, storage: new MemoryLedgerStorage(), start, batchStaples: 50 });
		const behind = await offlineLedger();
		await behind(function(storage) {
			return(runShadowVotes({ source: sourceOf(head), state: memoryState(), storage, start: { ...start, target: targetOf(head.slice(0, 99)) }, batchStaples: 50 }));
		});
		const standing = saved.saved;
		const lost = head[99];
		if (standing === undefined || lost === undefined) {
			throw(new Error('the run saved no standing'));
		}

		await expect(behind(function(storage) {
			return(runShadowVotes({ source: sourceOf(head), state: saved, storage, start: standing, batchStaples: 50 }));
		})).rejects.toThrow(`the offline ledger lacks 1 staple of the batch saved last, the first ${keyOf(lost)} at 100; it lost them to a kill, so start again with --restart`);
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('commit each session of the offline ledger synchronously, whatever the cluster commits by default', async function() {
		const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
		databases.push(database);
		const plain = database.pool();
		expect((await plain.query<{ synchronous_commit: string }>('SHOW synchronous_commit')).rows[0]?.synchronous_commit).toBe('off');
		const storage = shadowLedgerStorage(database.connectionString);
		const node = new lib.Node(mainnetNodeConfig(storage));
		try {
			const transaction = await storage.beginTransaction({ node, moment: new Date(), identifier: 'shadow-settings', readOnly: true });
			const settings = await transaction.execute('SELECT current_setting(\'synchronous_commit\') AS commit, current_setting(\'statement_timeout\') AS statement');
			await storage.abortTransaction(transaction);
			expect(settings).toEqual([{ commit: 'on', statement: '10min' }]);
		} finally {
			await node.stop();
			await storage.destroy();
		}
	});

	test('keep listing as unapplied a staple an earlier build left refused for voting weight that then waits deferred', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 100);
		const replayed = head.slice(0, 50);
		const place = head.findIndex(function(staple, index): boolean {
			return(index > replayed.length && head.slice(replayed.length, index).some(function(earlier): boolean {
				return(buildsOn(staple, earlier));
			}));
		});
		const waiting = head[place];
		if (waiting === undefined) {
			throw(new Error('no staple building on one past the target'));
		}
		const sequence = String(place + 1);
		const start: ShadowRunState = { ...freshShadowRun(scopeFrom(head, 49), 3, GENESIS_BASE, targetOf(replayed)), unapplied: [{ sequence, blocksHash: keyOf(waiting), why: 'voting-weight' }] };

		const reached = await runShadowVotes({ source: sourceOf(head), state: memoryState(), storage: new MemoryLedgerStorage(), start, batchStaples: 50 });

		expect(reached.reached.sequence).toBe('50');
		expect(reached.unapplied).toEqual([{ sequence, blocksHash: keyOf(waiting), why: 'deferred' }]);
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('end after the batch a stop came in, saving it, when no staple of the batch released others', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 100);
		const start = freshShadowRun(scopeFrom(head, 50), 3, GENESIS_BASE, targetOf(head));
		const storage = new MemoryLedgerStorage();
		const state = memoryState();
		const stopping = new AbortController();
		const stoppedIn = head[10];
		if (stoppedIn === undefined) {
			throw(new Error('no staple at 10'));
		}
		const stoppedAt = keyOf(stoppedIn);
		const adjust = storage.adjust.bind(storage);
		vi.spyOn(storage, 'adjust').mockImplementation(async function(...args: Parameters<typeof storage.adjust>): ReturnType<typeof storage.adjust> {
			const applied = await adjust(...args);
			if (args[1].blocksHash.toString() === stoppedAt) {
				stopping.abort();
			}
			return(applied);
		});

		const reached = await runShadowVotes({ source: sourceOf(head), state, storage, start, batchStaples: 50, stopped: stopping.signal });

		expect(reached.reached.sequence).toBe('50');
		expect(reached.unapplied).toEqual([]);
		expect(state.saved).toEqual(reached);
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

		const withDeferredCopy = async function(informationalEvery: number, batchStaples = 50): Promise<ShadowRunState> {
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
			if (batchStaples === 1) {
				// Each batch collects at its end, so the one of the staple the copy builds on applies the copy.
				return(await inLedger(function(storage) {
					return(runShadowVotes({ source: sourceOf(head), state, storage, start: { ...before, target: targetOf(head) }, batchStaples }));
				}));
			}
			// A run that ends at the staple the copy builds on collects at its end, which applies the copy.
			const through = await inLedger(function(storage) {
				return(runShadowVotes({ source: sourceOf(head.slice(0, earlier + 1)), state, storage, start: { ...before, target: targetOf(head.slice(0, earlier + 1)) }, batchStaples }));
			});
			return(await inLedger(function(storage) {
				return(runShadowVotes({ source: sourceOf(head), state, storage, start: { ...through, target: targetOf(head) }, batchStaples }));
			}));
		};

		expect(await withDeferredCopy(every)).toEqual(whole);
		// Resumed past the copy's root, the run finds the copy held with no vote recorded, which no vote now could judge.
		await expect(withDeferredCopy(1)).rejects.toThrow(`the offline ledger holds the staple ${keyOf(laterStaple)}, whose shadow vote was never recorded`);
		await expect(withDeferredCopy(1, 1)).rejects.toThrow(`the offline ledger applied staple ${keyOf(laterStaple)} before its place ${String(later + 1)}`);
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

	/*
	 * The follower's list holds only staples its ledger accepted. One it
	 * applied by a replay of the staples deferred behind another was weighed
	 * as it arrived, under the weights of an earlier place, and a replay
	 * weighs nothing [Keeta TS] index.js:70433-70447: weighed again at its
	 * place, it could be refused where the follower applied it.
	 */
	test('apply every staple as the follower\'s ledger accepted it, without weighing its votes again', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 200);
		// Listed before the genesis staple, which gives their voters weight, the first staples would be refused for it.
		const rest = head.slice(1);
		const late = [...rest.slice(0, 5), ...head.slice(0, 1), ...rest.slice(5)];
		const reached = await runShadowVotes({ source: sourceOf(late), state: memoryState(), storage: new MemoryLedgerStorage(), start: freshShadowRun(scopeFrom(head, 150), 10, GENESIS_BASE, targetOf(late)), batchStaples: 3 });

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
		vi.spyOn(storage, 'gc').mockImplementation(function(...[transaction, limit]: Parameters<typeof storage.gc>): Promise<boolean> {
			collected.push({ limit, at: Date.now() });
			return(collect(transaction, limit));
		});
		await runShadowVotes({ source: sourceOf(head), state: memoryState(), storage, start: freshShadowRun(scopeFrom(head, 39), 1000, GENESIS_BASE, targetOf(head)), batchStaples: 20 });

		// One collection as the run begins, which applies what a batch cut short released, and one at the end of each batch.
		expect(collected.map(function({ limit }): number | undefined {
			return(limit);
		})).toEqual([SHADOW_GC_SLICE_MILLISECONDS, SHADOW_GC_SLICE_MILLISECONDS, SHADOW_GC_SLICE_MILLISECONDS]);
		expect(collected.map(function({ at }, call): boolean {
			return(at > (head[Math.max(0, call - 1) * 20 + 19]?.timestamp().getTime() ?? Number.POSITIVE_INFINITY));
		})).toEqual([true, true, true]);
	});

	/*
	 * Staples the follower listed before the one they build on are deferred
	 * at their places, and the staple they wait on releases them all. Each
	 * must be applied before the next vote, whatever the machine's pace, but
	 * across as many short transactions as the release takes: a stopped
	 * clock, or a replay as the add runs, would apply the chain in one.
	 */
	test('apply a deferred chain the next staple releases before the next vote, one staple to a transaction, at any pace', async function() {
		const { listed, rootPlace } = await chainListedBeforeItsRoot();
		const places = new Map(listed.map(function(staple, index): [string, number] {
			return([keyOf(staple), index]);
		}));
		const blocksBefore = function(place: number | undefined): number {
			return(listed.slice(0, place).reduce(function(count, staple): number {
				return(count + staple.blocks.length);
			}, 0));
		};
		const largest = Math.max(...listed.map(function(staple): number {
			return(staple.blocks.length);
		}));

		const runAt = async function(step: number): Promise<{ readonly reached: ShadowRunState; readonly seenAtNextVote: { readonly place: number; readonly blocks: number } | undefined; readonly mostInOne: number }> {
			vi.restoreAllMocks();
			let ticks = 0;
			vi.spyOn(performance, 'now').mockImplementation(function(): number {
				ticks += step;
				return(ticks);
			});
			const storage = new MemoryLedgerStorage();
			let committed = 0;
			let mostInOne = 0;
			const commit = storage.commitTransaction.bind(storage);
			vi.spyOn(storage, 'commitTransaction').mockImplementation(async function(transaction: Parameters<typeof storage.commitTransaction>[0]): Promise<void> {
				await commit(transaction);
				const { blockCount } = await storage.stats();
				mostInOne = Math.max(mostInOne, blockCount - committed);
				committed = blockCount;
			});
			let seenAtNextVote: { readonly place: number; readonly blocks: number } | undefined;
			const vote = storage.addPendingVote.bind(storage);
			vi.spyOn(storage, 'addPendingVote').mockImplementation(async function(...args: Parameters<typeof storage.addPendingVote>): Promise<void> {
				const [, staple] = args;
				const place = places.get(staple.blocksHash.toString()) ?? -1;
				if (seenAtNextVote === undefined && place > rootPlace) {
					seenAtNextVote = { place, blocks: (await storage.stats()).blockCount };
				}
				await vote(...args);
			});
			const reached = await runShadowVotes({ source: sourceOf(listed), state: memoryState(), storage, start: freshShadowRun(scopeFrom(listed, listed.length - 1), 1, GENESIS_BASE, targetOf(listed)), batchStaples: 500 });
			return({ reached, seenAtNextVote, mostInOne });
		};

		const fast = await runAt(1);
		const slow = await runAt(10_000);

		// Every staple before the first voted on after the chain's root is applied when it is voted on, the chain included.
		expect(fast.seenAtNextVote?.blocks).toBe(blocksBefore(fast.seenAtNextVote?.place));
		expect(slow.seenAtNextVote).toEqual(fast.seenAtNextVote);
		expect(slow.reached).toEqual(fast.reached);
		// Genesis may land in one transaction with what its own staple holds; past it, no transaction holds two staples of the chain.
		expect(slow.mostInOne).toBeLessThanOrEqual(Math.max(largest, listed[0]?.blocks.length ?? 0));
	}, REPLAY_TIMEOUT_MILLISECONDS);

	/*
	 * A stop, as a kill, can land after a staple applied and before the
	 * collections applied the staples it released, which were listed, and
	 * voted on, before it in the batch.
	 */
	test('resume a batch cut short between a staple applying and the staples it released, applying those first, to the outcome of a run never cut', async function() {
		const { listed, rootPlace } = await chainListedBeforeItsRoot();
		const root = listed[rootPlace];
		if (root === undefined) {
			throw(new Error('no root'));
		}
		const start = freshShadowRun(scopeFrom(listed, listed.length - 1), 1, GENESIS_BASE, targetOf(listed));
		const whole = await runShadowVotes({ source: sourceOf(listed), state: memoryState(), storage: new MemoryLedgerStorage(), start, batchStaples: 500 });

		const inLedger = await offlineLedger();
		const state = memoryState();
		const stopping = new AbortController();
		const cut = await inLedger(function(storage) {
			const adjust = storage.adjust.bind(storage);
			vi.spyOn(storage, 'adjust').mockImplementation(async function(...args: Parameters<typeof storage.adjust>): ReturnType<typeof storage.adjust> {
				const applied = await adjust(...args);
				if (args[1].blocksHash.toString() === keyOf(root)) {
					stopping.abort();
				}
				return(applied);
			});
			return(runShadowVotes({ source: sourceOf(listed), state, storage, start, batchStaples: 500, stopped: stopping.signal }));
		});
		expect(cut).toEqual(start);
		vi.restoreAllMocks();
		const chain = new Set(listed.slice(rootPlace - 3, rootPlace).map(keyOf));
		const appliedAgain: string[] = [];
		const collectedAt: number[] = [];
		const resumed = await inLedger(function(storage) {
			const collect = storage.gc.bind(storage);
			vi.spyOn(storage, 'gc').mockImplementation(function(...args: Parameters<typeof storage.gc>): Promise<boolean> {
				collectedAt.push(Date.now());
				return(collect(...args));
			});
			const adjust = storage.adjust.bind(storage);
			vi.spyOn(storage, 'adjust').mockImplementation(function(...args: Parameters<typeof storage.adjust>): ReturnType<typeof storage.adjust> {
				if (chain.has(args[1].blocksHash.toString())) {
					appliedAgain.push(args[1].blocksHash.toString());
				}
				return(adjust(...args));
			});
			return(runShadowVotes({ source: sourceOf(listed), state, storage, start, batchStaples: 500 }));
		});

		expect(resumed).toEqual(whole);
		// The collections applied the chain as the run began, so it is held, not added at its places again.
		expect(appliedAgain).toEqual([]);
		// At the moment of the root that released it, as the run never cut applied it, not at the batch's last.
		const lastMoment = listed.at(-1)?.timestamp().getTime() ?? 0;
		expect(lastMoment - root.timestamp().getTime()).toBeGreaterThan(60_000);
		expect((collectedAt[0] ?? lastMoment) - root.timestamp().getTime()).toBeGreaterThanOrEqual(0);
		expect((collectedAt[0] ?? lastMoment) - root.timestamp().getTime()).toBeLessThan(60_000);
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('replay nothing past a target they have reached', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 3);
		const start = freshShadowRun(scopeFrom(head, 0), 1, { database: 'follower_snapshot', sequence: '3', blocksHash: head[2]?.blocksHash.toString() ?? null, scopedStaples: 0 }, targetOf(head));
		const reached = await runShadowVotes({ source: sourceOf(head), state: memoryState(), storage: new MemoryLedgerStorage(), start });
		expect(reached).toEqual(start);
		expect(shadowRunComplete(reached)).toBe(true);
	});
});
