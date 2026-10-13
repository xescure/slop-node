// Upstream's own default for the number of history entries per request.
// [Keeta TS] index.js:70568
export const DEFAULT_HISTORY_LIMIT = 25;

// The largest page upstream's only caller ever asks for.
// [Keeta TS] index.js:70686-70694
export const DEFAULT_VOTES_PER_PAGE = 200;

/**
 * Where a main vote sits in the catch-up order (D8): the moment it was made,
 * its `validityFrom`, then a node-local sequence, never reused, that breaks
 * ties between votes made in the same millisecond.
 */
export type CatchUpPosition = {
	readonly validityFrom: Date;
	readonly sequence: bigint;
};

export function compareCatchUpPositions(left: CatchUpPosition, right: CatchUpPosition): number {
	const byValidity = left.validityFrom.getTime() - right.validityFrom.getTime();
	if (byValidity !== 0) {
		return(byValidity);
	}
	if (left.sequence < right.sequence) {
		return(-1);
	}
	if (left.sequence > right.sequence) {
		return(1);
	}
	return(0);
}

/** The getVotesAfter key that resumes after a vote. */
export function encodeCatchUpKey(position: CatchUpPosition): string {
	return(`${String(position.validityFrom.getTime())}:${position.sequence.toString()}`);
}

/** Keys come only from earlier pages of the same read, so a malformed one is a caller bug. */
export function decodeCatchUpKey(key: string): CatchUpPosition {
	const match = /^(\d+):(\d+)$/u.exec(key);
	const validityFrom = match?.[1];
	const sequence = match?.[2];
	if (validityFrom === undefined || sequence === undefined) {
		throw(new Error(`invalid getVotesAfter key: ${key}`));
	}
	return({ validityFrom: new Date(Number(validityFrom)), sequence: BigInt(sequence) });
}
