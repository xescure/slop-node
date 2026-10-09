import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { mainnetNodeConfig } from '../conformance/mainnet/fixture.js';
import { explainRefusal, shadowVoter, UnexplainedRefusal } from '../conformance/mainnet/shadow.js';
import { recordNoTiming } from '../node/timing.js';
import { assertNever } from '../util/assert-never.js';
import type { FollowerStore, StapleKey } from './follower-store.js';
import { atMoment } from './frozen-clock.js';
import type { ShadowLiveRecord, ShadowRefusal, UnexplainedShadowRefusal } from './log.js';
import { QUIET_MARGIN_MILLISECONDS } from './sweep.js';

const lib = KeetaNet.lib;

/** What shadow voting reads of the follower's storage. */
export type ShadowLiveStore = Pick<FollowerStore, 'progress' | 'stapleCountBefore' | 'staplesBefore'>;

export type ShadowLiveSetup = {
	readonly store: ShadowLiveStore;
	/** How many of the newest staples within the follower's reach are voted on. */
	readonly windowStaples: number;
	/** The offline ledger's storage, fresh and empty. */
	readonly storage: () => LedgerStorageAPI;
	/** Staples read from the follower at a time. */
	readonly batchStaples?: number;
	/** Told after each batch how far the replay has come. */
	readonly progress?: (progress: ShadowLiveProgress) => void;
};

export type ShadowLiveProgress = {
	readonly replayed: number;
	readonly total: number;
	/** Staples refused for want of voting weight that have not been applied yet. */
	readonly waiting: number;
	/** The moment of the last staple replayed. */
	readonly reached: string;
};

/** Enough staples to keep the reads few, and few enough that a batch's bytes are a few megabytes. */
const DEFAULT_BATCH_STAPLES = 500;

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
 * voting weight waits, and is tried again once more staples were added,
 * since the staples that give its voters their weight may come later in
 * the order of the staples' own moments than in the order mainnet applied
 * them (src/node/bootstrap-pass.ts).
 */
class WeightedAdds {
	readonly #ledger: Ledger;
	readonly #waiting = new Map<string, VoteStaple>();
	readonly refused = new Set<string>();

	constructor(ledger: Ledger) {
		this.#ledger = ledger;
	}

	async add(staple: VoteStaple): Promise<void> {
		try {
			await this.#ledger.add(staple);
			this.#waiting.delete(keyOf(staple));
		} catch (error: unknown) {
			if (!isWeightRefusal(error)) {
				throw(error);
			}
			this.refused.add(keyOf(staple));
			this.#waiting.set(keyOf(staple), staple);
		}
	}

	/** Tries every waiting staple again, each at its own moment, until a round adds none. */
	async retry(): Promise<void> {
		for (;;) {
			const before = this.#waiting.size;
			for (const staple of [...this.#waiting.values()]) {
				await atMoment(staple.timestamp(), () => {
					return(this.add(staple));
				});
			}
			if (this.#waiting.size === 0 || this.#waiting.size === before) {
				return;
			}
		}
	}

	waiting(): readonly string[] {
		return([...this.#waiting.keys()]);
	}
}

/**
 * Replays the follower's history from the first staple to the end of the
 * window into an offline ledger, a representative's of its own that votes
 * nowhere, and before each staple of the window is added, asks that ledger
 * to vote on its blocks, with the clock at the staple's moment, as 0d does
 * on the captured head (src/conformance/mainnet/head-replay.ts). The
 * follower holds every staple voted on before its reach, so the window ends
 * the sweep's margin before it (src/parity/sweep.ts): every staple the
 * window's blocks build on is replayed before them. Each refusal must be
 * one the classified differences between 0.18.4, which confirmed the
 * staples, and 0.18.7 explain (src/conformance/mainnet/shadow.ts).
 */
export async function shadowVoteLive(setup: ShadowLiveSetup): Promise<ShadowLiveRecord> {
	const at = new Date().toISOString();
	const { heldBefore } = await setup.store.progress();
	const empty: ShadowLiveRecord = { kind: 'shadow-live', at, replayed: 0, windowStaples: 0, windowFrom: null, windowTo: null, voted: 0, explained: [], unexplained: [], deferredInWindow: [], refusedForWeight: 0, unappliedBeforeWindow: [] };
	if (heldBefore === undefined) {
		return(empty);
	}
	const end = new Date(heldBefore.getTime() - QUIET_MARGIN_MILLISECONDS);
	const total = await setup.store.stapleCountBefore(end);
	const windowStart = Math.max(0, total - setup.windowStaples);
	const node = new lib.Node(mainnetNodeConfig(setup.storage()));
	recordNoTiming(node.timing);
	const { ledger } = node;
	const voter = shadowVoter();
	const adds = new WeightedAdds(ledger);
	const window: VoteStaple[] = [];
	let replayed = 0;
	let after: StapleKey | undefined;
	try {
		for (;;) {
			const batch = await setup.store.staplesBefore(end, after, setup.batchStaples ?? DEFAULT_BATCH_STAPLES);
			const last = batch.at(-1);
			if (last === undefined) {
				break;
			}
			for (const { staple, stapleTime } of batch) {
				// The history key is the staple's own moment, the order a replay adds staples in (src/conformance/mainnet/replay.ts).
				if (staple.timestamp().getTime() !== stapleTime.getTime()) {
					throw(new Error(`the staple ${keyOf(staple)} is keyed at ${stapleTime.toISOString()}, not at its moment ${staple.timestamp().toISOString()}`));
				}
				const inWindow = replayed >= windowStart;
				await atMoment(staple.timestamp(), async function() {
					if (inWindow) {
						window.push(staple);
						await voter.beforeAdd(staple, ledger);
					}
					await adds.add(staple);
				});
				replayed++;
			}
			// The follower runs gc as it adds, which applies the staples deferred until the blocks they build on came.
			await atMoment(last.staple.timestamp(), function() {
				return(drainDeferral(ledger));
			});
			await adds.retry();
			/*
			 * The node's log keeps every entry, with the values it names, until
			 * the node syncs [Keeta TS] index.js:71109-71122, 71377-71383, and
			 * nothing else syncs an offline node, so its log would otherwise
			 * hold every warning of the whole replay.
			 */
			await node.sync();
			after = { stapleTime: last.stapleTime, blocksHash: keyOf(last.staple) };
			setup.progress?.({ replayed, total, waiting: adds.waiting().length, reached: last.stapleTime.toISOString() });
		}
		const drainAt = window.at(-1)?.timestamp() ?? end;
		await atMoment(drainAt, function() {
			return(drainDeferral(ledger));
		});
		const stored = await ledger.getVoteStaples(window.map(function(staple) {
			return(staple.blocksHash);
		}), 'main');
		const deferredInWindow = window.filter(function(staple): boolean {
			return(stored.get(staple.blocksHash) === null);
		}).map(keyOf);
		const inWindow = new Set(window.map(keyOf));
		const unappliedBeforeWindow = adds.waiting().filter(function(staple): boolean {
			return(!inWindow.has(staple));
		});
		const explained: ShadowRefusal[] = [];
		const unexplained: UnexplainedShadowRefusal[] = [];
		for (const vote of voter.votes) {
			switch (vote.outcome) {
				case 'voted':
					break;
				case 'refused':
					try {
						const { reason } = explainRefusal(vote.staple, vote.refusal, ledger);
						explained.push({ blocksHash: keyOf(vote.staple), reason, code: vote.refusal.code });
					} catch (error: unknown) {
						if (!(error instanceof UnexplainedRefusal)) {
							throw(error);
						}
						unexplained.push({ blocksHash: keyOf(vote.staple), code: vote.refusal.code, message: vote.refusal.message, why: error.message });
					}
					break;
				default:
					assertNever(vote);
			}
		}
		return({
			kind: 'shadow-live',
			at,
			replayed,
			windowStaples: window.length,
			windowFrom: window[0]?.timestamp().toISOString() ?? null,
			windowTo: window.at(-1)?.timestamp().toISOString() ?? null,
			voted: voter.votes.length - explained.length - unexplained.length,
			explained,
			unexplained,
			deferredInWindow,
			refusedForWeight: adds.refused.size,
			unappliedBeforeWindow
		});
	} finally {
		/*
		 * Stopping flushes the node's statistics and closes its switch,
		 * which never had a peer [Keeta TS] index.js:71373-71383.
		 */
		await node.stop();
	}
}
