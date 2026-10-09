import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { mainnetNodeConfig } from '../conformance/mainnet/fixture.js';
import { explainRefusal, shadowVoter, UnexplainedRefusal } from '../conformance/mainnet/shadow.js';
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
	const empty: ShadowLiveRecord = { kind: 'shadow-live', at, replayed: 0, windowStaples: 0, windowFrom: null, windowTo: null, voted: 0, explained: [], unexplained: [], deferredInWindow: [] };
	if (heldBefore === undefined) {
		return(empty);
	}
	const end = new Date(heldBefore.getTime() - QUIET_MARGIN_MILLISECONDS);
	const total = await setup.store.stapleCountBefore(end);
	const windowStart = Math.max(0, total - setup.windowStaples);
	const node = new lib.Node(mainnetNodeConfig(setup.storage()));
	const { ledger } = node;
	const voter = shadowVoter();
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
					await ledger.add(staple);
				});
				replayed++;
			}
			after = { stapleTime: last.stapleTime, blocksHash: keyOf(last.staple) };
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
			deferredInWindow
		});
	} finally {
		/*
		 * Stopping flushes the node's statistics and closes its switch,
		 * which never had a peer [Keeta TS] index.js:71373-71383.
		 */
		await node.stop();
	}
}
