import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { ErrorCode } from '@keetanetwork/keetanet-client/lib/error/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { LedgerStorageDriverBase } from '../../ledger/storage/base.js';
import { deferredStaplesWaitingOnOf } from '../../ledger/storage/suite/support.js';
import { assertNever } from '../../util/assert-never.js';
import { addInReplayOrder, compareText, replayOrder } from './replay.js';
import { refusalOf } from './shadow.js';
import type { LedgerRefusal } from './shadow.js';

export const EDGE_CASE_OUTCOMES = ['applied', 'deferred', 'refused'] as const;

/** Where a staple stands once it has been added and gc has retried everything it could. */
export type EdgeCaseOutcome =
	{ readonly outcome: typeof EDGE_CASE_OUTCOMES[0] } |
	{ readonly outcome: typeof EDGE_CASE_OUTCOMES[1]; readonly waitingOn: readonly string[] } |
	{ readonly outcome: typeof EDGE_CASE_OUTCOMES[2]; readonly code: ErrorCode; readonly message: string };

export type EdgeCaseResult = EdgeCaseOutcome & { readonly blocksHash: string };

/*
 * A block waits on its previous unless it opens its chain or its previous is
 * an earlier block of the same staple; a staple is deferred while any such
 * previous is not on the main ledger.
 * [Keeta TS] index.js:67678-67732
 */
async function awaitedBlocks(ledger: Ledger, staple: VoteStaple): Promise<BlockHash[]> {
	const own = new Set(staple.blocks.map(function(block): string {
		return(block.hash.toString());
	}));
	const awaited: BlockHash[] = [];
	for (const block of staple.blocks) {
		if (block.$opening || own.has(block.previous.toString())) {
			continue;
		}
		if (await ledger.getBlock(block.previous, 'main') === null) {
			awaited.push(block.previous);
		}
	}
	return(awaited.sort(function(left, right): number {
		return(compareText(left.toString(), right.toString()));
	}));
}

/**
 * A staple that is neither on the main ledger nor refused must be held by the
 * driver as waiting on every block it misses, or it is lost, which is a
 * fault of the run rather than an outcome.
 */
async function deferredOutcome(storage: LedgerStorageDriverBase, ledger: Ledger, staple: VoteStaple): Promise<EdgeCaseOutcome> {
	const awaited = await awaitedBlocks(ledger, staple);
	for (const blockHash of awaited) {
		const waiting = await deferredStaplesWaitingOnOf(storage, [blockHash]);
		if (!waiting.some(function(waiter): boolean {
			return(waiter.blocksHash.toString() === staple.blocksHash.toString());
		})) {
			throw(new Error(`staple ${staple.blocksHash.toString()} is not deferred on ${blockHash.toString()}, which it misses`));
		}
	}
	if (awaited.length === 0) {
		throw(new Error(`staple ${staple.blocksHash.toString()} misses no block, yet is neither applied nor refused`));
	}
	return({
		outcome: 'deferred',
		waitingOn: awaited.map(function(blockHash): string {
			return(blockHash.toString());
		})
	});
}

/**
 * Adds the staples to the ledger in replay order, with the clock frozen at
 * each one's timestamp, drains deferral, and reports each staple's outcome in
 * replay order. A refusal is a coded error of the ledger's add; any other
 * failure is a fault of the run and is thrown.
 */
export async function addEdgeCases(storage: LedgerStorageDriverBase, ledger: Ledger, staples: readonly VoteStaple[]): Promise<EdgeCaseResult[]> {
	const refusals = new Map<VoteStaple, LedgerRefusal>();
	await addInReplayOrder(ledger, staples, async function(staple) {
		try {
			await ledger.add(staple);
		} catch (error: unknown) {
			refusals.set(staple, refusalOf(error));
		}
	});
	const stored = await ledger.getVoteStaples(staples.map(function(staple) {
		return(staple.blocksHash);
	}), 'main');
	const results: EdgeCaseResult[] = [];
	for (const staple of replayOrder(staples)) {
		const blocksHash = staple.blocksHash.toString();
		const refusal = refusals.get(staple);
		if (refusal !== undefined) {
			results.push({ blocksHash, outcome: 'refused', ...refusal });
		} else if (stored.get(staple.blocksHash) !== null) {
			results.push({ blocksHash, outcome: 'applied' });
		} else {
			results.push({ blocksHash, ...await deferredOutcome(storage, ledger, staple) });
		}
	}
	return(results);
}

function outcomeOnly(result: EdgeCaseResult): EdgeCaseOutcome {
	switch (result.outcome) {
		case 'applied':
			return({ outcome: result.outcome });
		case 'deferred':
			return({ outcome: result.outcome, waitingOn: result.waitingOn });
		case 'refused':
			return({ outcome: result.outcome, code: result.code, message: result.message });
		default:
			return(assertNever(result));
	}
}

/** A JSON object from blocks hash to outcome, in code-point order of the hashes. */
export function renderEdgeCaseOutcomes(results: readonly EdgeCaseResult[]): string {
	const sorted = [...results].sort(function(left, right): number {
		return(compareText(left.blocksHash, right.blocksHash));
	});
	const byBlocksHash = Object.fromEntries(sorted.map(function(result) {
		return([result.blocksHash, outcomeOnly(result)]);
	}));
	return(`${JSON.stringify(byBlocksHash, null, 2)}\n`);
}
