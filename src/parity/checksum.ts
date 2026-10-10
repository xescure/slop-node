import { getOK } from './api-source.js';
import type { APISource } from './api-source.js';
import type { ChecksumSnapshot, FollowerProgress, FollowerStore } from './follower-store.js';
import type { BlockCountNotComparableReason, BlockCountRecord, BlockCountVerdict, ChecksumReading, ChecksumRecord, ChecksumVerdict, ChecksumWindow, CrossCheckOutcome, CrossCheckRecord, MismatchedStapleRecord, NotComparableReason, SweepPointer } from './log.js';

/**
 * How long a representative's checksum and block count must hold still to
 * count. The main network adds a few thousand blocks a day, in bursts, so
 * ten seconds is often quiet and still short enough that both ends of the
 * window describe one ledger.
 */
export const DEFAULT_CHECKSUM_GAP_MILLISECONDS = 10_000;

/**
 * Both are the "0x" spelling of a bigint, which drops leading zeros
 * (conformance/STATE-DUMP.md section 3.5), so equal values may still be
 * spelled differently; they are compared as numbers.
 */
export function checksumsEqual(left: string, right: string): boolean {
	return(BigInt(left) === BigInt(right));
}

export type ChecksumComparison = {
	readonly follower: APISource;
	readonly representatives: readonly APISource[];
	readonly progress: FollowerProgress;
	readonly gapMilliseconds: number;
	/** Waits out the gap between the two ends of the window. */
	readonly wait: (milliseconds: number) => Promise<void>;
	/** Where the sweep stands, which a mismatch points to. */
	readonly sweep: () => Promise<SweepPointer>;
};

type Reading = { readonly kind: 'read'; readonly reading: ChecksumReading } | { readonly kind: 'unanswered'; readonly error: string };

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return(error.message);
	}
	return(String(error));
}

function fieldOf(body: unknown, name: string): unknown {
	if (typeof body !== 'object' || body === null || !(name in body)) {
		return(undefined);
	}
	const fields: Readonly<Record<string, unknown>> = { ...body };
	return(fields[name]);
}

/** The checksum, then the block count; a staple applied between the two shows as a reading that differs at the other end of the window. */
async function readingOf(source: APISource): Promise<Reading> {
	try {
		const checksum = fieldOf(await getOK(source, '/node/ledger/checksum'), 'checksum');
		const blockCount = fieldOf(fieldOf(await getOK(source, '/node/stats'), 'ledger'), 'blockCount');
		if (typeof checksum !== 'string' || !/^0x[0-9A-Fa-f]+$/.test(checksum)) {
			throw(new Error(`${source.endpoint} served no checksum: ${JSON.stringify(checksum)}`));
		}
		if (typeof blockCount !== 'number' || !Number.isSafeInteger(blockCount) || blockCount < 0) {
			throw(new Error(`${source.endpoint} served no block count: ${JSON.stringify(blockCount)}`));
		}
		return({ kind: 'read', reading: { checksum, blockCount } });
	} catch (error: unknown) {
		return({ kind: 'unanswered', error: messageOf(error) });
	}
}

/** The window of a node read at its start; a node that did not answer then is not asked again. */
async function windowOf(source: APISource, first: Reading): Promise<ChecksumWindow> {
	if (first.kind === 'unanswered') {
		return(first);
	}
	const second = await readingOf(source);
	if (second.kind === 'unanswered') {
		return(second);
	}
	return({ kind: 'read', first: first.reading, second: second.reading });
}

function heldStill(window: Extract<ChecksumWindow, { kind: 'read' }>): boolean {
	return(window.first.blockCount === window.second.blockCount && checksumsEqual(window.first.checksum, window.second.checksum));
}

async function verdictOf(comparison: ChecksumComparison, follower: ChecksumWindow, representative: ChecksumWindow): Promise<ChecksumVerdict> {
	const reasons: NotComparableReason[] = [];
	if (comparison.progress.completedPass === undefined) {
		reasons.push('no-completed-pass');
	}
	if (follower.kind === 'unanswered') {
		reasons.push('follower-unanswered');
	} else if (!heldStill(follower)) {
		reasons.push('follower-moving');
	}
	if (representative.kind === 'unanswered') {
		reasons.push('representative-unanswered');
	} else if (!heldStill(representative)) {
		reasons.push('representative-moving');
	}
	if (reasons.length > 0 || follower.kind !== 'read' || representative.kind !== 'read') {
		return({ kind: 'not-comparable-yet', reasons });
	}
	if (checksumsEqual(follower.second.checksum, representative.second.checksum)) {
		return({ kind: 'pass' });
	}
	return({
		kind: 'fail',
		bisect: {
			followerBlockCount: follower.second.blockCount,
			representativeBlockCount: representative.second.blockCount,
			sweep: await comparison.sweep()
		}
	});
}

/**
 * How many blocks two nodes holding the same ledger may count apart besides
 * what they added while being read and what the representatives count apart
 * among themselves. Each representative's count is its own statistic, kept
 * like its checksum (conformance/API.md, Differences), and the four main
 * network representatives counted up to 20 blocks apart while each held
 * still; a hundred blocks is a few minutes of the main network's traffic.
 */
export const BLOCK_COUNT_FLOOR = 100;

function movement(window: Extract<ChecksumWindow, { kind: 'read' }>): number {
	return(Math.abs(window.second.blockCount - window.first.blockCount));
}

/** How far apart the representatives that answered count, at the end of their windows. */
function spreadOf(windows: readonly ChecksumWindow[]): number {
	const counts = windows.flatMap(function(window): number[] {
		if (window.kind !== 'read') {
			return([]);
		}
		return([window.second.blockCount]);
	});
	if (counts.length === 0) {
		return(0);
	}
	return(Math.max(...counts) - Math.min(...counts));
}

function isoOrNull(moment: Date | undefined): string | null {
	if (moment === undefined) {
		return(null);
	}
	return(moment.toISOString());
}

/**
 * The follower's count must be within the floor of the representative's,
 * widened by how far the representatives count apart and by what either
 * side added within its window, as the two may have been read at different
 * points of the same ledger.
 */
function blockCountRecordOf(at: string, progress: FollowerProgress, follower: ChecksumWindow, representative: string, representativeWindow: ChecksumWindow, spread: number): BlockCountRecord {
	const reasons: BlockCountNotComparableReason[] = [];
	const completedPass = isoOrNull(progress.completedPass);
	if (completedPass === null) {
		reasons.push('no-completed-pass');
	}
	if (progress.staged > 0) {
		reasons.push('stage-not-empty');
	}
	if (follower.kind === 'unanswered') {
		reasons.push('follower-unanswered');
	}
	if (representativeWindow.kind === 'unanswered') {
		reasons.push('representative-unanswered');
	}
	let toleranceBlocks = BLOCK_COUNT_FLOOR + spread;
	let verdict: BlockCountVerdict = { kind: 'not-comparable-yet', reasons };
	if (follower.kind === 'read' && representativeWindow.kind === 'read') {
		toleranceBlocks += movement(follower) + movement(representativeWindow);
		const difference = follower.second.blockCount - representativeWindow.second.blockCount;
		if (reasons.length === 0 && Math.abs(difference) <= toleranceBlocks) {
			verdict = { kind: 'pass' };
		} else if (reasons.length === 0) {
			verdict = { kind: 'fail', difference };
		}
	}
	return({ kind: 'block-count', at, representative, completedPass, staged: progress.staged, follower, representativeWindow, toleranceBlocks, verdict });
}

export type ChecksumComparisonRecords = {
	/** The follower's checksum against each representative's, kept for information: each is a statistic of its own node. */
	readonly checksums: readonly ChecksumRecord[];
	readonly blockCounts: readonly BlockCountRecord[];
};

/**
 * Reads the follower's checksum and block count, then each
 * representative's, waits out the gap, and reads each representative and
 * then the follower again, so that the follower's window holds every
 * representative's. A checksum comparison counts only once the follower
 * has completed a bootstrap pass and neither side moved within its window;
 * a block count comparison, once the follower has also added every staple
 * it staged.
 */
export async function compareChecksums(comparison: ChecksumComparison): Promise<ChecksumComparisonRecords> {
	const at = new Date().toISOString();
	const followerFirst = await readingOf(comparison.follower);
	const representativesFirst = await Promise.all(comparison.representatives.map(readingOf));
	await comparison.wait(comparison.gapMilliseconds);
	const representativeWindows = await Promise.all(comparison.representatives.map(function(source, index) {
		return(windowOf(source, representativesFirst[index] ?? { kind: 'unanswered', error: 'not read' }));
	}));
	const follower = await windowOf(comparison.follower, followerFirst);
	const completedPass = isoOrNull(comparison.progress.completedPass);
	const checksums: ChecksumRecord[] = [];
	const blockCounts: BlockCountRecord[] = [];
	const spread = spreadOf(representativeWindows);
	for (const [index, source] of comparison.representatives.entries()) {
		const representativeWindow = representativeWindows[index] ?? { kind: 'unanswered', error: 'not read' };
		blockCounts.push(blockCountRecordOf(at, comparison.progress, follower, source.endpoint, representativeWindow, spread));
		checksums.push({
			kind: 'checksum',
			at,
			representative: source.endpoint,
			gapMilliseconds: comparison.gapMilliseconds,
			completedPass,
			follower,
			representativeWindow,
			verdict: await verdictOf(comparison, follower, representativeWindow)
		});
	}
	return({ checksums, blockCounts });
}

export function hexOf(value: bigint): string {
	return(`0x${value.toString(16).toUpperCase()}`);
}

/** How the stored checksum stands against the fold, and the staples whose own checksum is not the fold of their blocks. */
export function crossCheckOutcomeOf(snapshot: ChecksumSnapshot): CrossCheckOutcome {
	const offset = snapshot.stored ^ snapshot.folded;
	if (offset === 0n) {
		return({ kind: 'equal' });
	}
	return({
		kind: 'differs',
		offset: hexOf(offset),
		staples: snapshot.mismatched.map(function(staple): MismatchedStapleRecord {
			return({ sequence: staple.sequence, blocksHash: staple.blocksHash, stored: hexOf(staple.stored), fold: hexOf(staple.fold) });
		})
	});
}

export type CrossCheck = {
	readonly store: Pick<FollowerStore, 'checksumSnapshot'>;
};

/**
 * Checks the follower's stored checksum against the XOR of the blocks its
 * main ledger holds. The node writes each staple's part of the checksum in
 * the transaction that writes its blocks (schema/CONTRACT.md, D19), so the
 * two are equal in every view of its database, whenever the node stopped.
 */
export async function crossCheckChecksum(check: CrossCheck): Promise<CrossCheckRecord> {
	const at = new Date().toISOString();
	const snapshot = await check.store.checksumSnapshot();
	return({ kind: 'cross-check', at, stored: hexOf(snapshot.stored), folded: hexOf(snapshot.folded), mainBlocks: snapshot.mainBlocks, outcome: crossCheckOutcomeOf(snapshot) });
}
