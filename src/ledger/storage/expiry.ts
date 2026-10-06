import type { Vote } from '@keetanetwork/keetanet-client/lib/vote.js';

/**
 * How far either end of a vote's validity period stretches.
 * [Keeta TS] index.js:80653
 */
export const voteExpirySlopMilliseconds = 60_000;

/**
 * Whether a stored vote is live at a moment: exactly when Keeta's Vote class
 * would still construct it then, which rejects a vote issued too far in the
 * future as well as an expired one. Callers pass the transaction's moment,
 * never the wall clock, so every read in one transaction agrees.
 * [Keeta TS] index.js:80373-80374, 80641-80653
 */
export function isVoteLive(vote: Pick<Vote, 'validityFrom' | 'validityTo' | '$permanent'>, moment: Date): boolean {
	const now = moment.getTime();
	if (now + voteExpirySlopMilliseconds < vote.validityFrom.getTime()) {
		return(false);
	}
	if (vote.$permanent) {
		return(true);
	}
	return(now - voteExpirySlopMilliseconds <= vote.validityTo.getTime());
}
