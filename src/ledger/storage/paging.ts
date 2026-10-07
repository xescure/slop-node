// Upstream's own default for the number of history entries per request.
// [Keeta TS] index.js:69532
export const DEFAULT_HISTORY_LIMIT = 25;

// The largest page upstream's only caller ever asks for.
// [Keeta TS] index.js:69650-69658
export const DEFAULT_VOTES_PER_PAGE = 200;

/**
 * Where a main staple sits in the order it entered this node's main ledger:
 * the moment of the transaction that confirmed it, then a node-local sequence
 * that breaks ties between staples confirmed at the same moment (D8).
 */
export type CatchUpPosition = {
	readonly moment: Date;
	readonly sequence: bigint;
};

export function compareCatchUpPositions(left: CatchUpPosition, right: CatchUpPosition): number {
	const byMoment = left.moment.getTime() - right.moment.getTime();
	if (byMoment !== 0) {
		return(byMoment);
	}
	if (left.sequence < right.sequence) {
		return(-1);
	}
	if (left.sequence > right.sequence) {
		return(1);
	}
	return(0);
}

/** The getVotesAfter key that resumes after a staple. */
export function encodeCatchUpKey(position: CatchUpPosition): string {
	return(`${String(position.moment.getTime())}:${position.sequence.toString()}`);
}

/** Keys come only from earlier pages of the same read, so a malformed one is a caller bug. */
export function decodeCatchUpKey(key: string): CatchUpPosition {
	const match = /^(\d+):(\d+)$/u.exec(key);
	const moment = match?.[1];
	const sequence = match?.[2];
	if (moment === undefined || sequence === undefined) {
		throw(new Error(`invalid getVotesAfter key: ${key}`));
	}
	return({ moment: new Date(Number(moment)), sequence: BigInt(sequence) });
}
