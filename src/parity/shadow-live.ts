import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { mainnetNodeConfig } from '../conformance/mainnet/fixture.js';
import { explainRefusal, shadowVote, UnexplainedRefusal } from '../conformance/mainnet/shadow.js';
import type { ShadowVote } from '../conformance/mainnet/shadow.js';
import { recordNoTiming } from '../node/timing.js';
import { assertNever } from '../util/assert-never.js';
import type { FollowerStore, SequencedStaple } from './follower-store.js';
import { atMoment } from './frozen-clock.js';
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
	/** Ends the run after the batch it is in. */
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
		refusedForWeight: 0,
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

/** gc reports whether more work remains once its time budget is spent. */
async function drainDeferral(ledger: Ledger): Promise<void> {
	while (await ledger.gc()) {
		// Each pass retries the staples that the earlier passes released.
	}
}

function keyOf(staple: VoteStaple): string {
	return(staple.blocksHash.toString());
}

/** The ledger's refusal of a staple whose votes are short of a quorum by the weights it holds so far. */
function isWeightRefusal(error: unknown): boolean {
	return(lib.Error.isInstance(error) && error.code === 'LEDGER_INSUFFICIENT_VOTING_WEIGHT');
}

/**
 * Adds staples as the follower's bootstrap does: one refused for want of
 * voting weight waits, and is tried again once more staples were added
 * (src/node/bootstrap-pass.ts).
 */
class WeightedAdds {
	readonly #ledger: Ledger;
	readonly #waiting = new Map<string, SequencedStaple>();
	refused = 0;

	constructor(ledger: Ledger, waiting: readonly SequencedStaple[]) {
		this.#ledger = ledger;
		for (const held of waiting) {
			this.#waiting.set(keyOf(held.staple), held);
		}
	}

	async add(held: SequencedStaple): Promise<void> {
		try {
			await this.#ledger.add(held.staple);
			this.#waiting.delete(keyOf(held.staple));
		} catch (error: unknown) {
			if (!isWeightRefusal(error)) {
				throw(error);
			}
			if (!this.#waiting.has(keyOf(held.staple))) {
				this.refused++;
			}
			this.#waiting.set(keyOf(held.staple), held);
		}
	}

	/** Tries every waiting staple again, each at its own moment, until a round adds none. */
	async retry(): Promise<void> {
		for (;;) {
			const before = this.#waiting.size;
			for (const held of [...this.#waiting.values()]) {
				await atMoment(held.staple.timestamp(), () => {
					return(this.add(held));
				});
			}
			if (this.#waiting.size === 0 || this.#waiting.size === before) {
				return;
			}
		}
	}

	waiting(): readonly SequencedStaple[] {
		return([...this.#waiting.values()]);
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
	const node = new lib.Node(mainnetNodeConfig(run.storage));
	recordNoTiming(node.timing);
	const { ledger } = node;
	const scope: ShadowScope = { release: run.start.scope.release, from: new Date(run.start.scope.from) };
	const unappliedBefore = new Map(run.start.unapplied.map(function(staple) {
		return([staple.blocksHash, staple.why] as const);
	}));
	const reloaded = await run.source.staplesOf([...unappliedBefore.keys()]);
	const adds = new WeightedAdds(ledger, reloaded.filter(function(held): boolean {
		return(unappliedBefore.get(keyOf(held.staple)) === 'voting-weight');
	}));
	let deferred = reloaded.filter(function(held): boolean {
		return(unappliedBefore.get(keyOf(held.staple)) === 'deferred');
	});
	let state = run.start;
	/*
	 * A stop may have cut a batch short after some of its staples were voted
	 * on and added, and a batch of another size may end elsewhere, so the
	 * ledger is asked which staples it holds until a batch finds none.
	 */
	const recorded = await run.state.recordedSinceSaved();
	let resuming = true;
	try {
		while (run.stopped?.aborted !== true) {
			const batch = await run.source.staplesAfter(BigInt(state.reached.sequence), BigInt(state.target.sequence), run.batchStaples ?? DEFAULT_BATCH_STAPLES);
			const last = batch.at(-1);
			if (last === undefined) {
				break;
			}
			let held = new Set<string>();
			if (resuming) {
				held = await appliedOf(ledger, batch.map(function(entry): VoteStaple {
					return(entry.staple);
				}));
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
				if (!held.has(blocksHash)) {
					await atMoment(staple.timestamp(), function() {
						return(adds.add(entry));
					});
				}
			}
			// The follower runs gc as it adds, which applies the staples deferred until the blocks they build on came.
			await atMoment(last.staple.timestamp(), function() {
				return(drainDeferral(ledger));
			});
			await adds.retry();
			const waiting = adds.waiting();
			const waitingHashes = new Set(waiting.map(function(held): string {
				return(keyOf(held.staple));
			}));
			const candidates = [...deferred, ...batch].filter(function(held): boolean {
				return(!waitingHashes.has(keyOf(held.staple)));
			});
			const applied = await appliedOf(ledger, candidates.map(function(held): VoteStaple {
				return(held.staple);
			}));
			deferred = candidates.filter(function(held): boolean {
				return(!applied.has(keyOf(held.staple)));
			});
			const unapplied: UnappliedStaple[] = [...waiting.map(function(held): UnappliedStaple {
				return(unappliedOf(held, 'voting-weight'));
			}), ...deferred.map(function(held): UnappliedStaple {
				return(unappliedOf(held, 'deferred'));
			})].sort(function(left, right): number {
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
				refusedForWeight: state.refusedForWeight + adds.refused,
				unapplied
			};
			adds.refused = 0;
			await run.state.save(state);
			run.progress?.(state);
		}
		return(state);
	} finally {
		/*
		 * Stopping flushes the node's statistics and closes its switch,
		 * which never had a peer [Keeta TS] index.js:71373-71383.
		 */
		await node.stop();
	}
}
