import type { Vote } from '@keetanetwork/keetanet-client/lib/vote.js';

/**
 * How far either end of a vote's validity period stretches.
 * [Keeta TS] index.js:80653
 */
export const voteExpirySlopMilliseconds = 60_000;

/**
 * Whether Keeta's Vote class would still construct a vote at a moment, which
 * rejects a vote issued too far in the future as well as an expired one. It
 * exists to check parity with that class only. It must never filter side
 * reads or gc: a transaction's moment can be stale, and the future bound would
 * then hide a vote that still guards its previous. Use isVoteUnexpired there.
 * [Keeta TS] index.js:80373-80374, 80641-80653
 * @internal
 */
export function isVoteLive(vote: Pick<Vote, 'validityFrom' | 'validityTo' | '$permanent'>, moment: Date): boolean {
	if (moment.getTime() + voteExpirySlopMilliseconds < vote.validityFrom.getTime()) {
		return(false);
	}
	return(isVoteUnexpired(vote, moment));
}

/**
 * Whether one of this node's own side votes still counts at a moment, for
 * side reads and gc: only expiry ends it. Upstream fixes the transaction's
 * moment before the driver's lock is taken, so a transaction that waited
 * behind a long one carries a stale moment, and a competing vote committed
 * meanwhile would look issued in the future; hiding it would let the node
 * sign a competitor. A stale moment can only delay expiry.
 * [Keeta TS] index.js:70393-70396, 80641-80653
 */
export function isVoteUnexpired(vote: Pick<Vote, 'validityTo' | '$permanent'>, moment: Date): boolean {
	if (vote.$permanent) {
		return(true);
	}
	return(moment.getTime() - voteExpirySlopMilliseconds <= vote.validityTo.getTime());
}
