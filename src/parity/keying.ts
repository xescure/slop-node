import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { pagePath, staplesOfPage } from '../node/bootstrap-page.js';
import { getOK } from './api-source.js';
import type { APISource } from './api-source.js';
import { messageOf } from './values.js';

/** Staples of each representative a check takes when not told how many. */
export const DEFAULT_KEYING_STAPLES = 8;

/** The check samples the staples a representative lists from this long ago: a day of the main network's traffic. */
export const KEYING_SAMPLE_AGE_MILLISECONDS: number = 24 * 60 * 60_000;

/** Staples a page from a vote's moment is asked for: more than the main network makes in one millisecond. */
export const KEYING_CHECK_LIMIT = 10;

/** How a representative keyed the latest vote of a staple, as two pages from about its moment show. */
export type StapleKeyingOutcome =
	/** Listed from the moment the vote was made, and not from a millisecond later. */
	| 'exact'
	/** Listed from neither, though the page from the moment holds fewer than it was asked for: keyed before it was made. */
	| 'early'
	/** Listed from a millisecond after the moment it was made. */
	| 'late'
	/** Listed from neither, and the page from the moment is full, so the staple may come after it. */
	| 'unsettled';

export type StapleKeying = {
	readonly staple: string;
	readonly latestVote: string;
	readonly outcome: StapleKeyingOutcome | 'unanswered';
};

/**
 * What the staples checked show of a representative: early when one was
 * keyed early, which a pass cannot detect and loses staples to
 * (VOTE_KEY_TOLERANCE_MILLISECONDS), then late when one was keyed late,
 * exactly when every staple that settled was keyed exactly, and not checked
 * when none settled.
 */
export type KeyingVerdict = 'keys exactly' | 'keys early by more than 1 ms' | 'keys late' | 'not checked';

export type RepresentativeKeying = {
	readonly representative: string;
	readonly verdict: KeyingVerdict;
	readonly staples: readonly StapleKeying[];
	/** Why no staple was sampled, when the page to sample from was not answered. */
	readonly unanswered: string | null;
};

export type KeyingCheck = {
	/** Read with GETs alone, paced by whoever made them. */
	readonly representatives: readonly APISource[];
	readonly staples: number;
	readonly now: number;
};

async function pageFrom(source: APISource, moment: number, limit: number): Promise<VoteStaple[]> {
	return(staplesOfPage(source.endpoint, await getOK(source, pagePath({ start: new Date(moment), limit, bloomFilter: undefined }))));
}

function latestVoteOf(staple: VoteStaple): number {
	return(Math.max(...staple.votes.map(function(vote): number {
		return(vote.validityFrom.getTime());
	})));
}

function lists(page: readonly VoteStaple[], staple: VoteStaple): boolean {
	const hash = staple.blocksHash.toString();
	return(page.some(function(listed): boolean {
		return(listed.blocksHash.toString() === hash);
	}));
}

/** The staples of a page, each once: a representative lists a staple once for each read holding one of its votes. */
function eachOnce(page: readonly VoteStaple[]): VoteStaple[] {
	const seen = new Set<string>();
	return(page.filter(function(staple): boolean {
		const hash = staple.blocksHash.toString();
		if (seen.has(hash)) {
			return(false);
		}
		seen.add(hash);
		return(true);
	}));
}

/** A representative keyed by votes lists the staple from the moment of its latest vote, and from no later moment, when it keys each vote at the moment it says it was made. */
async function outcomeOf(source: APISource, staple: VoteStaple, latest: number): Promise<StapleKeyingOutcome> {
	if (lists(await pageFrom(source, latest + 1, KEYING_CHECK_LIMIT), staple)) {
		return('late');
	}
	const fromLatest = await pageFrom(source, latest, KEYING_CHECK_LIMIT);
	if (lists(fromLatest, staple)) {
		return('exact');
	}
	if (fromLatest.length >= KEYING_CHECK_LIMIT) {
		return('unsettled');
	}
	return('early');
}

async function stapleKeyingOf(source: APISource, staple: VoteStaple): Promise<StapleKeying> {
	const latest = latestVoteOf(staple);
	const named = { staple: staple.blocksHash.toString(), latestVote: new Date(latest).toISOString() };
	try {
		return({ ...named, outcome: await outcomeOf(source, staple, latest) });
	} catch {
		return({ ...named, outcome: 'unanswered' });
	}
}

function verdictOf(staples: readonly StapleKeying[]): KeyingVerdict {
	const outcomes = new Set(staples.map(function(staple) {
		return(staple.outcome);
	}));
	if (outcomes.has('early')) {
		return('keys early by more than 1 ms');
	}
	if (outcomes.has('late')) {
		return('keys late');
	}
	if (outcomes.has('exact')) {
		return('keys exactly');
	}
	return('not checked');
}

async function representativeKeyingOf(source: APISource, check: KeyingCheck): Promise<RepresentativeKeying> {
	let sample: VoteStaple[];
	try {
		sample = eachOnce(await pageFrom(source, check.now - KEYING_SAMPLE_AGE_MILLISECONDS, check.staples));
	} catch (error: unknown) {
		return({ representative: source.endpoint, verdict: 'not checked', staples: [], unanswered: messageOf(error) });
	}
	const staples: StapleKeying[] = [];
	for (const staple of sample) {
		staples.push(await stapleKeyingOf(source, staple));
	}
	return({ representative: source.endpoint, verdict: verdictOf(staples), staples, unanswered: null });
}

/**
 * Checks how each representative keys the votes of its staples, which a
 * bootstrap pass relies on (src/node/bootstrap-pass.ts, Pass): for staples
 * it lists from a day ago, whether it lists each from the moment of its
 * latest vote and not from a millisecond later. The representatives are
 * read side by side, each one request at a time.
 */
export async function checkKeying(check: KeyingCheck): Promise<readonly RepresentativeKeying[]> {
	return(await Promise.all(check.representatives.map(function(source) {
		return(representativeKeyingOf(source, check));
	})));
}

/** Whether the check passes: every representative keys exactly, as the passes rely on. */
export function keyingExitCodeOf(checked: readonly RepresentativeKeying[]): 0 | 1 {
	if (checked.every(function(representative): boolean {
		return(representative.verdict === 'keys exactly');
	})) {
		return(0);
	}
	return(1);
}
