import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Node as KeetaNode } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { mainnetNodeConfig } from '../conformance/mainnet/fixture.js';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import { LedgerInternals } from '../upstream/internals.js';
import { explainRefusal, shadowVote, UnexplainedRefusal } from '../conformance/mainnet/shadow.js';
import type { ShadowVote } from '../conformance/mainnet/shadow.js';
import { recordNoTiming } from '../node/timing.js';
import { assertNever } from '../util/assert-never.js';
import type { FollowerStore, SequencedStaple } from './follower-store.js';
import { atMoment, fromMoment } from './frozen-clock.js';
import { UNEXPLAINED_LISTED } from './log.js';
import type { ShadowBase, ShadowRunState, ShadowTarget, ShadowVoteEntry, ShadowVoteOutcome, ShadowWindow, ShadowWindowTally, UnappliedStaple } from './log.js';

const lib = KeetaNet.lib;

/**
 * The scoped window begins when the npm registry published 0.18.4, of the
 * 0.18 line the main network's representatives run: no representative ran
 * it for a vote older than that. A staple whose every vote is that late was
 * voted under rules that differ from 0.18.7's only by the classified fixes
 * (conformance/MAINNET.md, section 6).
 */
export type ShadowScope = { readonly release: string; readonly from: Date };

export const SHADOW_SCOPE: ShadowScope = { release: '0.18.4', from: new Date('2026-07-24T20:33:26.082Z') };

/** What the run reads of the follower's storage. */
export type ShadowSource = Pick<FollowerStore, 'staplesAfter' | 'staplesOf'>;

/** Where a run keeps its standing and the votes it cast, so that it resumes where it stopped. */
export type ShadowState = {
	load(): Promise<ShadowRunState | undefined>;
	/** Saves the standing, which covers every vote recorded so far. */
	save(state: ShadowRunState): Promise<void>;
	/** Records a vote before its staple is added, so that a stop between the two leaves it recorded. */
	record(entry: ShadowVoteEntry): Promise<void>;
	/** The votes recorded since the standing was last saved, by the hash of their staple's blocks. */
	recordedSinceSaved(): Promise<ReadonlyMap<string, ShadowVoteEntry>>;
};

export type ShadowRun = {
	readonly source: ShadowSource;
	readonly state: ShadowState;
	/** The offline ledger's storage: the base the run started from, with every staple it replayed since. */
	readonly storage: LedgerStorageAPI;
	/** Where the run stands, with the target it goes to now. */
	readonly start: ShadowRunState;
	/** Staples read from the follower at a time, and replayed between two saves. */
	readonly batchStaples?: number;
	/** Told after each batch where the run stands. */
	readonly progress?: (state: ShadowRunState) => void;
	/**
	 * Ends the run after the batch it is in, saved; but once it has come, the
	 * first staple of the batch that applies while staples wait deferred cuts
	 * the batch short there, before the collections that would apply what it
	 * released, unsaved, as does a stop between two slices of those
	 * collections; the run resumes from its last save.
	 */
	readonly stopped?: AbortSignal;
};

/** Enough staples to keep the reads and saves few, and few enough that a batch's bytes are a few megabytes. */
const DEFAULT_BATCH_STAPLES = 500;

/**
 * Replayed in the order the follower added them, the staples apply as they
 * did there, so few ever wait; many waiting means the replay is not the
 * follower's ledger, and the run stops rather than hold them all.
 */
const MAX_UNAPPLIED = 1000;

const EMPTY_TALLY: ShadowWindowTally = { replayed: 0, shadowVoted: 0, voted: 0, explained: {}, unexplained: 0, firstUnexplained: [], votedFrom: null, votedTo: null };

/** A run that has replayed nothing past its base yet. */
export function freshShadowRun(scope: ShadowScope, informationalEvery: number, base: ShadowBase, target: ShadowTarget): ShadowRunState {
	return({
		scope: { release: scope.release, from: scope.from.toISOString() },
		informationalEvery,
		base,
		target,
		reached: { sequence: base.sequence, blocksHash: base.blocksHash },
		scoped: EMPTY_TALLY,
		informational: EMPTY_TALLY,
		unapplied: []
	});
}

/** Whether the run has replayed up to its target. */
export function shadowRunComplete(state: ShadowRunState): boolean {
	return(BigInt(state.reached.sequence) >= BigInt(state.target.sequence));
}

/** When the staple's earliest vote was made, the moment the first representative was asked about it. */
export function votedFrom(staple: VoteStaple): Date {
	return(new Date(Math.min(...staple.votes.map(function(vote): number {
		return(vote.validityFrom.valueOf());
	}))));
}

export function shadowWindowOf(staple: VoteStaple, scope: ShadowScope): ShadowWindow {
	if (votedFrom(staple).valueOf() >= scope.from.valueOf()) {
		return('scoped');
	}
	return('informational');
}

/**
 * One in so many staples of the informational window, chosen by the hash of
 * its blocks, so that a resumed run chooses the same and the choice is
 * spread evenly over the history.
 */
export function sampledForInformation(blocksHash: string, every: number): boolean {
	return(BigInt(`0x${blocksHash.slice(0, 12)}`) % BigInt(every) === 0n);
}

/**
 * How long one garbage collection of the offline ledger runs at most, in a
 * transaction of its own, as the follower's does (src/node/bootstrap.ts).
 * The offline ledger lives in the follower's cluster, where a serializable
 * transaction left open holds back what Postgres may forget of every
 * other, so that the follower's own transactions fail as conflicts; upstream's
 * default runs one for minutes [Keeta TS] index.js:67852-67861.
 */
export const SHADOW_GC_SLICE_MILLISECONDS = 2000;

/**
 * A stop came while staples a batch released were still to be applied: the
 * batch is cut short there, unsaved, as a kill would cut it, and the run
 * resumed applies them before anything else (runShadowVotes).
 */
class StoppedInBatch extends Error {
	constructor() {
		super('the shadow votes were stopped while a batch applied the staples it released');
		this.name = 'StoppedInBatch';
	}
}

/**
 * Applies every deferred staple that what the ledger holds releases, in
 * garbage collections of a slice each, until one reports nothing left: as
 * many transactions as it takes, each on a clock running on from the
 * moment, as the time limits that end it read the clock. A stop ends it
 * between two slices.
 */
async function drainDeferral(ledger: Ledger, moment: Date, stopped: AbortSignal | undefined): Promise<void> {
	for (;;) {
		if (stopped?.aborted === true) {
			throw(new StoppedInBatch());
		}
		const more = await fromMoment(moment, function() {
			return(ledger.gc(SHADOW_GC_SLICE_MILLISECONDS));
		});
		if (!more) {
			return;
		}
	}
}

function keyOf(staple: VoteStaple): string {
	return(staple.blocksHash.toString());
}

/** The ledger's refusal of a staple whose blocks it holds already [Keeta TS] index.js:67683-67687. */
function isAlreadyHeld(error: unknown): boolean {
	return(lib.Error.isInstance(error) && error.code === 'LEDGER_BLOCK_ALREADY_EXISTS');
}

/**
 * Applies the follower's staples to the offline ledger as its ledger
 * accepted them: through the storage's adjust, as the ledger's add does
 * once the votes are weighed, without weighing them again
 * [Keeta TS] index.js:69397-69411, 67717-67729. The follower's list holds
 * only staples its ledger accepted, each at the place it applied it, and a
 * staple it applied by a replay of the staples deferred behind another,
 * which weighs nothing, was weighed as it arrived, under the weights of an
 * earlier place; weighed again at its place it could only be refused where
 * the follower applied it, and the replay would leave the follower's
 * ledger. What the shadow votes judge is the votes on each staple's blocks,
 * not the follower's adds. A staple deferred is applied once a staple
 * applied after it releases it, and one whose blocks the ledger holds
 * already, as a stop that cut its batch short leaves it, is held.
 */
class Adds {
	readonly #ledger: Ledger;
	readonly #storage: LedgerStorageAPI;
	readonly #node: KeetaNode;
	readonly #stopped: AbortSignal | undefined;
	/** The staples the ledger deferred and has not applied yet, which a staple it applies may release. */
	readonly #deferred = new Map<string, SequencedStaple>();

	constructor(node: KeetaNode, storage: LedgerStorageAPI, deferred: readonly SequencedStaple[], stopped: AbortSignal | undefined) {
		this.#ledger = node.ledger;
		this.#storage = storage;
		this.#node = node;
		this.#stopped = stopped;
		for (const held of deferred) {
			this.#deferred.set(keyOf(held.staple), held);
		}
	}

	/**
	 * Applies the staple at its moment, and then, when it applied and
	 * staples wait deferred, applies all those it releases before anything
	 * else is asked of the ledger. The ledger replays nothing as it applies
	 * (its replay window is zero), so that what a vote after sees depends on
	 * what was applied, not on how fast: every release goes through the
	 * collections, whose transactions are each short.
	 */
	async add(held: SequencedStaple): Promise<void> {
		const applied = await fromMoment(held.staple.timestamp(), () => {
			return(this.#apply(held));
		});
		if (!applied || this.#deferred.size === 0) {
			return;
		}
		await drainDeferral(this.#ledger, held.staple.timestamp(), this.#stopped);
		const still = await appliedOf(this.#ledger, [...this.#deferred.values()].map(function(entry): VoteStaple {
			return(entry.staple);
		}));
		for (const [key] of this.#deferred) {
			if (still.has(key)) {
				this.#deferred.delete(key);
			}
		}
	}

	/** Whether the ledger applied the staple now. */
	async #apply(held: SequencedStaple): Promise<boolean> {
		const transaction = await this.#storage.beginTransaction({ node: this.#node, moment: new Date(), identifier: 'shadow-apply', readOnly: false });
		let added: VoteStaple[];
		try {
			added = await this.#storage.adjust(transaction, held.staple, LedgerInternals.computeEffectOfBlocks(held.staple.blocks, this.#ledger));
		} catch (error: unknown) {
			await this.#storage.abortTransaction(transaction);
			if (isAlreadyHeld(error) && (await appliedOf(this.#ledger, [held.staple])).has(keyOf(held.staple))) {
				return(false);
			}
			throw(error);
		}
		await this.#storage.commitTransaction(transaction);
		if (added.length === 0) {
			this.#deferred.set(keyOf(held.staple), held);
			return(false);
		}
		return(true);
	}
}

/** The vote's outcome, its refusal judged by the classified differences (src/conformance/mainnet/shadow.ts). */
function outcomeOf(vote: ShadowVote, ledger: Ledger): ShadowVoteOutcome {
	switch (vote.outcome) {
		case 'voted':
			return({ kind: 'voted' });
		case 'refused':
			try {
				const { reason } = explainRefusal(vote.staple, vote.refusal, ledger);
				return({ kind: 'explained', reason, code: vote.refusal.code });
			} catch (error: unknown) {
				if (!(error instanceof UnexplainedRefusal)) {
					throw(error);
				}
				return({ kind: 'unexplained', code: vote.refusal.code, message: vote.refusal.message, why: error.message });
			}
		default:
			return(assertNever(vote));
	}
}

function earlier(left: string | null, right: string): string {
	if (left === null || right < left) {
		return(right);
	}
	return(left);
}

function later(left: string | null, right: string): string {
	if (left === null || right > left) {
		return(right);
	}
	return(left);
}

function replayedIn(tally: ShadowWindowTally, moment: string): ShadowWindowTally {
	return({ ...tally, replayed: tally.replayed + 1, votedFrom: earlier(tally.votedFrom, moment), votedTo: later(tally.votedTo, moment) });
}

function votedIn(tally: ShadowWindowTally, entry: ShadowVoteEntry): ShadowWindowTally {
	const counted = { ...tally, shadowVoted: tally.shadowVoted + 1 };
	const { outcome } = entry;
	switch (outcome.kind) {
		case 'voted':
			return({ ...counted, voted: counted.voted + 1 });
		case 'explained':
			return({ ...counted, explained: { ...counted.explained, [outcome.reason]: (counted.explained[outcome.reason] ?? 0) + 1 } });
		case 'unexplained': {
			let firstUnexplained = counted.firstUnexplained;
			if (firstUnexplained.length < UNEXPLAINED_LISTED) {
				firstUnexplained = [...firstUnexplained, { blocksHash: entry.blocksHash, code: outcome.code, message: outcome.message, why: outcome.why }];
			}
			return({ ...counted, unexplained: counted.unexplained + 1, firstUnexplained });
		}
		default:
			return(assertNever(outcome));
	}
}

type Tallies = Pick<ShadowRunState, 'scoped' | 'informational'>;

function withTally(tallies: Tallies, window: ShadowWindow, change: (tally: ShadowWindowTally) => ShadowWindowTally): Tallies {
	switch (window) {
		case 'scoped':
			return({ ...tallies, scoped: change(tallies.scoped) });
		case 'informational':
			return({ ...tallies, informational: change(tallies.informational) });
		default:
			return(assertNever(window));
	}
}

/** The hashes of the blocks of those staples the ledger holds on its main ledger. */
async function appliedOf(ledger: Ledger, staples: readonly VoteStaple[]): Promise<Set<string>> {
	const applied = new Set<string>();
	if (staples.length === 0) {
		return(applied);
	}
	const stored = await ledger.getVoteStaples(staples.map(function(staple) {
		return(staple.blocksHash);
	}), 'main');
	for (const [blocksHash, staple] of stored) {
		if (staple !== null) {
			applied.add(blocksHash.toString());
		}
	}
	return(applied);
}

function unappliedOf(held: SequencedStaple, why: UnappliedStaple['why']): UnappliedStaple {
	return({ sequence: held.sequence.toString(), blocksHash: keyOf(held.staple), why });
}

const OFFLINE_TIMEOUT_MILLISECONDS = 600_000;

/**
 * The offline ledger's storage in its database. Its every session commits
 * synchronously: the follower's cluster commits without waiting for the
 * disk, so a kill may lose its last commits, which a save of the standing
 * after them would count as replayed. The offline ledger is the database's
 * only client, and a vote on a staple of hundreds of operations computes
 * its effects for many seconds inside one transaction, so its sessions are
 * not ended for idling there, as a node's are to free locks for other
 * writers.
 */
export function shadowLedgerStorage(connectionString: string): PostgresLedgerStorage {
	let separator = '?';
	if (connectionString.includes('?')) {
		separator = '&';
	}
	return(new PostgresLedgerStorage({
		kind: 'connection-string',
		connectionString: `${connectionString}${separator}options=${encodeURIComponent('-c synchronous_commit=on')}`,
		options: { statementTimeoutMillis: OFFLINE_TIMEOUT_MILLISECONDS, idleInTransactionTimeoutMillis: OFFLINE_TIMEOUT_MILLISECONDS }
	}));
}

/**
 * Whether the offline ledger holds every staple the standing counts as
 * replayed of the batch it saved last, the batch's staples it lists as not
 * applied apart: commits are made in order, so its holding those shows it
 * holds every staple before them. One that commits without waiting for the
 * disk, as an earlier build's did, may have lost them to a kill, and the
 * run would go on from a ledger that is not the follower's.
 */
async function checkLastBatchHeld(run: ShadowRun, ledger: Ledger): Promise<void> {
	const { base, reached, unapplied } = run.start;
	const batchStaples = run.batchStaples ?? DEFAULT_BATCH_STAPLES;
	const place = BigInt(reached.sequence);
	let after = place - BigInt(batchStaples);
	if (after < BigInt(base.sequence)) {
		after = BigInt(base.sequence);
	}
	if (place <= after) {
		return;
	}
	const listed = new Set(unapplied.map(function(staple): string {
		return(staple.blocksHash);
	}));
	const batch = (await run.source.staplesAfter(after, place, batchStaples)).filter(function(held): boolean {
		return(!listed.has(keyOf(held.staple)));
	});
	const applied = await appliedOf(ledger, batch.map(function(held): VoteStaple {
		return(held.staple);
	}));
	const lost = batch.filter(function(held): boolean {
		return(!applied.has(keyOf(held.staple)));
	});
	const [first] = lost;
	if (first !== undefined) {
		throw(new Error(`the offline ledger lacks ${String(lost.length)} staple${plural(lost.length)} of the batch saved last, the first ${keyOf(first.staple)} at ${first.sequence.toString()}; it lost them to a kill, so start again with --restart`));
	}
}

function plural(count: number): string {
	if (count === 1) {
		return('');
	}
	return('s');
}

/**
 * Replays the follower's main staples into an offline ledger, a
 * representative's of its own that votes nowhere, in the order the
 * follower's ledger added them, from where the run stands to its target.
 * Before a staple is added, the offline ledger then stands where the
 * follower's stood before it, and is asked to vote on its blocks with the
 * clock at the staple's moment, as a representative asked then would be.
 * Every staple of the scoped window is put to the vote, and one in so many
 * of the informational window. Each vote is recorded before its staple is
 * added, and the standing is saved after each batch, so that a run stopped
 * anywhere resumes without voting on a staple twice or skipping one: a
 * staple of the batch cut short that the ledger already holds is not added
 * again, and its recorded vote is counted.
 */
export async function runShadowVotes(run: ShadowRun): Promise<ShadowRunState> {
	const config = mainnetNodeConfig(run.storage);
	const node = new lib.Node({ ...config, ledger: { ...config.ledger, heapProcessWindowMs: 0 } });
	recordNoTiming(node.timing);
	const { ledger } = node;
	const scope: ShadowScope = { release: run.start.scope.release, from: new Date(run.start.scope.from) };
	const unappliedBefore = new Map(run.start.unapplied.map(function(staple) {
		return([staple.blocksHash, staple.why] as const);
	}));
	const reloaded = await run.source.staplesOf([...unappliedBefore.keys()]);
	const adds = new Adds(node, run.storage, reloaded.filter(function(held): boolean {
		return(unappliedBefore.get(keyOf(held.staple)) === 'deferred');
	}), run.stopped);
	/*
	 * Staples an earlier build left refused for want of voting weight are
	 * applied as the follower's ledger accepted them, before anything else;
	 * one the ledger defers is listed with the deferred staples from then on.
	 */
	const refusedBefore = reloaded.filter(function(held): boolean {
		return(unappliedBefore.get(keyOf(held.staple)) === 'voting-weight');
	});
	let deferred = reloaded;
	let state = run.start;
	/*
	 * A stop may have cut a batch short after some of its staples were voted
	 * on and added, and a batch of another size may end elsewhere, so the
	 * ledger is asked which staples it holds until a batch finds none.
	 */
	const recorded = await run.state.recordedSinceSaved();
	let resuming = true;
	try {
		await checkLastBatchHeld(run, ledger);
		for (const held of refusedBefore) {
			await adds.add(held);
		}
		while (run.stopped?.aborted !== true) {
			const batch = await run.source.staplesAfter(BigInt(state.reached.sequence), BigInt(state.target.sequence), run.batchStaples ?? DEFAULT_BATCH_STAPLES);
			const last = batch.at(-1);
			if (last === undefined) {
				break;
			}
			let held = new Set<string>();
			if (resuming) {
				/*
				 * A stop or a kill may have cut the batch short after an
				 * applied staple released staples deferred before it in the
				 * batch, and before the collections applied them. Applied
				 * now, as the run cut short would have, at the moment of the
				 * last staple it applied, they are held, their recorded votes
				 * counted.
				 */
				const staples = batch.map(function(entry): VoteStaple {
					return(entry.staple);
				});
				const appliedBefore = await appliedOf(ledger, staples);
				const releasing = staples.filter(function(staple): boolean {
					return(appliedBefore.has(keyOf(staple)));
				}).at(-1) ?? last.staple;
				await drainDeferral(ledger, releasing.timestamp(), run.stopped);
				held = await appliedOf(ledger, staples);
				resuming = held.size > 0;
			}
			let tallies: Tallies = state;
			for (const entry of batch) {
				const { staple, stapleTime, sequence } = entry;
				const blocksHash = keyOf(staple);
				// The history key is the staple's own moment, the order a replay of the follower's history keys it by (src/conformance/mainnet/replay.ts).
				if (staple.timestamp().getTime() !== stapleTime.getTime()) {
					throw(new Error(`the staple ${blocksHash} is keyed at ${stapleTime.toISOString()}, not at its moment ${staple.timestamp().toISOString()}`));
				}
				const window = shadowWindowOf(staple, scope);
				const moment = votedFrom(staple).toISOString();
				tallies = withTally(tallies, window, function(tally) {
					return(replayedIn(tally, moment));
				});
				if (window === 'scoped' || sampledForInformation(blocksHash, state.informationalEvery)) {
					let vote = recorded.get(blocksHash);
					if (vote === undefined) {
						if (held.has(blocksHash)) {
							throw(new Error(`the offline ledger holds the staple ${blocksHash}, whose shadow vote was never recorded`));
						}
						// A vote on a staple the ledger holds already would judge it by a ledger past it.
						if ((await appliedOf(ledger, [staple])).has(blocksHash)) {
							throw(new Error(`the offline ledger applied staple ${blocksHash} before its place ${sequence.toString()}, replaying a deferred copy of it, so a vote on it would see a ledger that holds it`));
						}
						const outcome = await atMoment(staple.timestamp(), async function() {
							return(outcomeOf(await shadowVote(staple, ledger), ledger));
						});
						vote = { sequence: sequence.toString(), blocksHash, window, votedFrom: moment, outcome };
						await run.state.record(vote);
					}
					const counted = vote;
					tallies = withTally(tallies, window, function(tally) {
						return(votedIn(tally, counted));
					});
				}
				// One held was applied before a stop cut its batch short.
				if (!held.has(blocksHash)) {
					await adds.add(entry);
				}
			}
			/*
			 * The follower runs gc as it adds, which applies the staples
			 * deferred until the blocks they build on came. Each staple of the
			 * batch has applied what it released by now, so a stop waits for
			 * the batch's save rather than throw its work away.
			 */
			await drainDeferral(ledger, last.staple.timestamp(), undefined);
			const candidates = [...deferred, ...batch];
			const applied = await appliedOf(ledger, candidates.map(function(held): VoteStaple {
				return(held.staple);
			}));
			deferred = candidates.filter(function(held): boolean {
				return(!applied.has(keyOf(held.staple)));
			});
			const unapplied: UnappliedStaple[] = deferred.map(function(held): UnappliedStaple {
				return(unappliedOf(held, 'deferred'));
			}).sort(function(left, right): number {
				return(Number(BigInt(left.sequence) - BigInt(right.sequence)));
			});
			if (unapplied.length > MAX_UNAPPLIED) {
				throw(new Error(`${String(unapplied.length)} staples replayed are not applied, the first ${unapplied[0]?.blocksHash ?? ''}; the replay is not the follower's ledger`));
			}
			/*
			 * The node's log keeps every entry, with the values it names, until
			 * the node syncs [Keeta TS] index.js:71109-71122, 71377-71383, and
			 * nothing else syncs an offline node, so its log would otherwise
			 * hold every warning of the whole replay.
			 */
			await node.sync();
			state = {
				...state,
				...tallies,
				reached: { sequence: last.sequence.toString(), blocksHash: keyOf(last.staple) },
				unapplied
			};
			await run.state.save(state);
			run.progress?.(state);
		}
		return(state);
	} catch (error: unknown) {
		if (error instanceof StoppedInBatch) {
			return(state);
		}
		throw(error);
	} finally {
		/*
		 * Stopping flushes the node's statistics and closes its switch,
		 * which never had a peer [Keeta TS] index.js:71373-71383.
		 */
		await node.stop();
	}
}
