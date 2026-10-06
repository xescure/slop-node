import type { Vote } from '@keetanetwork/keetanet-client/lib/vote.js';

/**
 * How long after its validTo a vote is still accepted.
 * [Keeta TS] index.js:80653
 */
export const voteExpirySlopMilliseconds = 60_000;

/**
 * Whether a stored vote is still live at a moment: exactly when Keeta's Vote
 * class would still construct it then. Callers pass the transaction's moment,
 * never the wall clock, so every read in one transaction agrees.
 * [Keeta TS] index.js:80641-80653
 */
export function isVoteLive(vote: Pick<Vote, 'validityTo' | '$permanent'>, moment: Date): boolean {
	if (vote.$permanent) {
		return(true);
	}
	return(moment.getTime() - voteExpirySlopMilliseconds <= vote.validityTo.getTime());
}
