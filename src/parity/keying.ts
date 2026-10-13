import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { VOTE_KEY_TOLERANCE_MILLISECONDS } from '../node/bootstrap-evidence.js';
import { pagePath, staplesOfPage } from '../node/bootstrap-page.js';
import { stapleKey } from '../node/bootstrap-window.js';
import { getOK } from './api-source.js';
import type { APISource } from './api-source.js';
import { messageOf } from './values.js';

/** Staples of each representative a check takes when not told how many. */
export const DEFAULT_KEYING_STAPLES = 8;

/** The check samples the staples a representative lists from this long ago: a day of the main network's traffic. */
export const KEYING_SAMPLE_AGE_MILLISECONDS: number = 24 * 60 * 60_000;

/** Staples a page from a vote's moment is asked for: more than the main network makes in one millisecond. */
export const KEYING_CHECK_LIMIT = 10;

/**
 * How far before its latest vote a staple missing from the pages about that
 * moment is looked for, to show it keyed early: ten times the tolerance a
 * pass allows (VOTE_KEY_TOLERANCE_MILLISECONDS), as a store keeping votes to
 * the second would key them.
 */
export const KEYING_EARLY_SPAN_MILLISECONDS = 1000;

/**
 * How far apart the pages that look for it start, from the moment back: the
 * main network's densest history holds about 36 staples a second, so a page
 * from a second before can fill before it reaches the staple, and one from
 * a tenth of that before cannot.
 */
export const KEYING_EARLY_STEP_MILLISECONDS: number = VOTE_KEY_TOLERANCE_MILLISECONDS;

/** How a representative keyed the latest vote of a staple, as two pages from about its moment show. */
export type StapleKeyingOutcome =
	/** Listed from the moment the vote was made, and not from a millisecond later. */
	| 'exact'
	/** Listed from neither, though the page from the moment holds fewer than it was asked for and no other staple voted on then, and listed from a moment up to KEYING_EARLY_SPAN_MILLISECONDS before: keyed before it was made. */
	| 'early'
	/** Listed from a millisecond after the moment it was made. */
	| 'late'
	/**
	 * Listed from neither, and the page from the moment is full, or lists
	 * another staple voted on then, among which a read the page ended in may
	 * have left it, or the staple is not listed from the span before either.
	 */
	| 'unsettled';

export type StapleKeying = {
	readonly staple: string;
	readonly latestVote: string;
	readonly outcome: StapleKeyingOutcome | 'unanswered';
};

/**
 * What the staples checked show of a representative: early when one was
 * keyed early, which a pass cannot detect and loses staples to
 * (VOTE_KEY_TOLERANCE_MILLISECONDS), then late when one was keyed late; not
 * checked when one went unanswered or unsettled, so that a representative
 * failing the check's requests, or keying some staples further off than the
 * check looks, fails it; exactly when every one was keyed exactly.
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

/** By its bytes: a staple on the same blocks with other votes is another staple, keyed by its own votes. */
function lists(page: readonly VoteStaple[], staple: VoteStaple): boolean {
	const key = stapleKey(staple);
	return(page.some(function(listed): boolean {
		return(stapleKey(listed) === key);
	}));
}

/** The staples of a page, each once: a representative lists a staple once for each read holding one of its votes. */
function eachOnce(page: readonly VoteStaple[]): VoteStaple[] {
	const seen = new Set<string>();
	return(page.filter(function(staple): boolean {
		const key = stapleKey(staple);
		if (seen.has(key)) {
			return(false);
		}
		seen.add(key);
		return(true);
	}));
}

/** Whether a staple of the page other than the one given has a vote made at the moment. */
function votedOnThenBesides(page: readonly VoteStaple[], staple: VoteStaple, moment: number): boolean {
	const key = stapleKey(staple);
	return(page.some(function(listed): boolean {
		return(stapleKey(listed) !== key && listed.votes.some(function(vote): boolean {
			return(vote.validityFrom.getTime() === moment);
		}));
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
	if (fromLatest.length >= KEYING_CHECK_LIMIT || votedOnThenBesides(fromLatest, staple, latest)) {
		return('unsettled');
	}
	for (let back = KEYING_EARLY_STEP_MILLISECONDS; back <= KEYING_EARLY_SPAN_MILLISECONDS; back += KEYING_EARLY_STEP_MILLISECONDS) {
		if (lists(await pageFrom(source, latest - back, KEYING_CHECK_LIMIT), staple)) {
			return('early');
		}
	}
	return('unsettled');
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
	if (outcomes.has('unanswered') || outcomes.has('unsettled') || staples.length === 0) {
		return('not checked');
	}
	return('keys exactly');
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
