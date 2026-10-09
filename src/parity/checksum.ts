import { getOK } from './api-source.js';
import type { APISource } from './api-source.js';
import type { FollowerProgress } from './follower-store.js';
import type { ChecksumReading, ChecksumRecord, ChecksumVerdict, ChecksumWindow, NotComparableReason, SweepPointer } from './log.js';

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
 * Reads the follower's checksum and block count, then each
 * representative's, waits out the gap, and reads each representative and
 * then the follower again, so that the follower's window holds every
 * representative's. A comparison counts only once the follower has
 * completed a bootstrap pass and neither side moved within its window.
 */
export async function compareChecksums(comparison: ChecksumComparison): Promise<readonly ChecksumRecord[]> {
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
	const records: ChecksumRecord[] = [];
	for (const [index, source] of comparison.representatives.entries()) {
		const representativeWindow = representativeWindows[index] ?? { kind: 'unanswered', error: 'not read' };
		records.push({
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
	return(records);
}
