import { getOK } from './api-source.js';
import type { APISource } from './api-source.js';
import type { ChecksumSnapshot, FollowerProgress, FollowerStore, SnapshotStaples, StapleFold } from './follower-store.js';
import type { BlockCountNotComparableReason, BlockCountRecord, BlockCountVerdict, ChecksumReading, ChecksumRecord, ChecksumVerdict, ChecksumWindow, CrossCheckOutcome, CrossCheckRecord, NotComparableReason, SweepPointer } from './log.js';

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

/**
 * The follower's count must be within the floor of the representative's,
 * widened by how far the representatives count apart and by what either
 * side added within its window, as the two may have been read at different
 * points of the same ledger.
 */
function blockCountRecordOf(at: string, completedPass: string | null, follower: ChecksumWindow, representative: string, representativeWindow: ChecksumWindow, spread: number): BlockCountRecord {
	const reasons: BlockCountNotComparableReason[] = [];
	if (completedPass === null) {
		reasons.push('no-completed-pass');
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
	return({ kind: 'block-count', at, representative, completedPass, follower, representativeWindow, toleranceBlocks, verdict });
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
 * representative's. A comparison counts only once the follower has
 * completed a bootstrap pass and neither side moved within its window.
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
	let completedPass: string | null = null;
	if (comparison.progress.completedPass !== undefined) {
		completedPass = comparison.progress.completedPass.toISOString();
	}
	const checksums: ChecksumRecord[] = [];
	const blockCounts: BlockCountRecord[] = [];
	const spread = spreadOf(representativeWindows);
	for (const [index, source] of comparison.representatives.entries()) {
		const representativeWindow = representativeWindows[index] ?? { kind: 'unanswered', error: 'not read' };
		blockCounts.push(blockCountRecordOf(at, completedPass, follower, source.endpoint, representativeWindow, spread));
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

function bitLength(value: bigint): number {
	return(value.toString(2).length);
}

/**
 * The indexes of vectors whose XOR is the target, or nothing when no set of
 * them makes it: Gaussian elimination over the field of two elements, each
 * reduced vector carrying the set of inputs it is the XOR of. With far fewer
 * vectors than the 256 bits of a hash, an unrelated target lies in their
 * span by chance with a probability below 2^(n - 256).
 */
export function xorSubsetOf(vectors: readonly bigint[], target: bigint): readonly number[] | undefined {
	const basis = new Map<number, { readonly vector: bigint; readonly made: bigint }>();
	for (const [index, vector] of vectors.entries()) {
		let rest = vector;
		let made = 1n << BigInt(index);
		while (rest !== 0n) {
			const pivot = bitLength(rest);
			const entry = basis.get(pivot);
			if (entry === undefined) {
				basis.set(pivot, { vector: rest, made });
				break;
			}
			rest ^= entry.vector;
			made ^= entry.made;
		}
	}
	let rest = target;
	let made = 0n;
	while (rest !== 0n) {
		const entry = basis.get(bitLength(rest));
		if (entry === undefined) {
			return(undefined);
		}
		rest ^= entry.vector;
		made ^= entry.made;
	}
	return(vectors.flatMap(function(_vector, index): number[] {
		if (((made >> BigInt(index)) & 1n) === 0n) {
			return([]);
		}
		return([index]);
	}));
}

/**
 * The longest run of staples whose loss the cross-check explains. The
 * follower writes its statistics whenever its API answers and when it
 * stops, so what a stop without that write loses is what it committed in
 * the minutes before, at most a few thousand blocks at the rate it follows.
 */
export const MAX_LOST_RUN = 1000;

/** The shortest run of consecutive staples, by commit order, whose blocks XOR to the offset, at most MAX_LOST_RUN long. */
export function lostRunOf(staples: readonly StapleFold[], offset: bigint): { readonly first: number; readonly last: number } | undefined {
	const prefixEnds = new Map<bigint, number>([[0n, 0]]);
	let prefix = 0n;
	for (const [index, staple] of staples.entries()) {
		prefix ^= staple.fold;
		const start = prefixEnds.get(prefix ^ offset);
		if (start !== undefined && index + 1 - start <= MAX_LOST_RUN) {
			return({ first: start, last: index });
		}
		prefixEnds.set(prefix, index + 1);
	}
	return(undefined);
}

/** The staples newest by commit order that a fresh snapshot lists, among which the node's unsynced ones are sought. */
export const UNSYNCED_CANDIDATES = 32;

export function hexOf(value: bigint): string {
	return(`0x${value.toString(16).toUpperCase()}`);
}

/** What explains the difference between the stored checksum and the fold, as far as the staples listed show. */
export function crossCheckOutcomeOf(snapshot: ChecksumSnapshot): CrossCheckOutcome {
	const offset = snapshot.stored ^ snapshot.folded;
	if (offset === 0n) {
		return({ kind: 'equal' });
	}
	const newest = snapshot.staples.slice(-UNSYNCED_CANDIDATES);
	const unsynced = xorSubsetOf(newest.map(function(staple): bigint {
		return(staple.fold);
	}), offset);
	if (unsynced !== undefined) {
		return({
			kind: 'unsynced',
			staples: unsynced.map(function(index): string {
				return(newest[index]?.blocksHash ?? '');
			})
		});
	}
	const run = lostRunOf(snapshot.staples, offset);
	const first = snapshot.staples[run?.first ?? -1];
	const last = snapshot.staples[run?.last ?? -1];
	if (run === undefined || first === undefined || last === undefined) {
		return({ kind: 'unexplained', offset: hexOf(offset) });
	}
	return({
		kind: 'lost-run',
		firstSequence: first.sequence,
		lastSequence: last.sequence,
		staples: run.last - run.first + 1,
		firstMoment: first.moment.toISOString(),
		lastMoment: last.moment.toISOString()
	});
}

export type CrossCheck = {
	readonly follower: APISource;
	readonly store: Pick<FollowerStore, 'checksumSnapshot'>;
};

/**
 * Checks the follower's stored checksum against the XOR of the blocks its
 * main ledger holds. The node merges a staple's blocks into its statistics
 * as it commits them and writes them to its store at its next sync, which
 * every request of its API runs before answering (src/api/route.ts), so one
 * request first leaves unsynced only what it commits after that. A first
 * snapshot lists only the newest staples, which hold those; only a
 * difference they do not explain reads every staple, to find a run of them
 * whose statistics were never written.
 */
export async function crossCheckChecksum(check: CrossCheck): Promise<CrossCheckRecord> {
	const at = new Date().toISOString();
	const read = async function(staples: SnapshotStaples): Promise<ChecksumSnapshot> {
		try {
			await check.follower.get('/node/version');
		} catch {
			// The stored checksum is read all the same; whatever the node has not synced shows as a difference.
		}
		return(await check.store.checksumSnapshot(staples));
	};
	let snapshot = await read({ kind: 'newest', count: UNSYNCED_CANDIDATES });
	let outcome = crossCheckOutcomeOf(snapshot);
	if (outcome.kind === 'unexplained') {
		snapshot = await read({ kind: 'every' });
		outcome = crossCheckOutcomeOf(snapshot);
	}
	return({ kind: 'cross-check', at, stored: hexOf(snapshot.stored), folded: hexOf(snapshot.folded), mainBlocks: snapshot.mainBlocks, outcome });
}
