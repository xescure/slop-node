import { assertNever } from '../util/assert-never.js';
import type { PassEvent, PassStaple } from './bootstrap-pass.js';
import { stapleKey } from './bootstrap-window.js';

/**
 * How far from the moment a vote was made, as the vote says, a peer keyed by
 * votes may key it. The main network's representatives key a vote at the
 * moment it says, to the millisecond: on 2026-10-12 each of the four listed
 * the latest vote of every staple asked about from that vote's moment, and
 * none from a millisecond later. This allows for a peer that reads it a
 * little off.
 *
 * A pass moves its start to the tolerance before a vote the page listed, so
 * each request reads again what was keyed within the tolerance before where
 * the last read ended. The main network's history on 2025-12-31 is so dense
 * that a representative reads less than a second of it for a request, and a
 * tolerance of a second left a pass reading again most of what it read.
 */
export const VOTE_KEY_TOLERANCE_MILLISECONDS = 100;

/**
 * The most votes a peer reads at a time for a request
 * [Keeta TS] index.js:69655-69659, and so the most staples it lists for one
 * read: a page cut within a read may have listed only some of the staples of
 * that read, which are among this many last.
 */
const MAX_VOTES_PER_READ = 200;

/**
 * What a peer has shown, by what it listed, of how it keys its staples
 * (see Pass, src/node/bootstrap-pass.ts).
 */
export type PeerKeying =
	/** Nothing yet: either way. */
	| 'unknown'
	/** It listed a staple twice in one answer, which only a peer keyed by votes does. */
	| 'votes'
	/** It listed from a start a staple none of whose votes was made at or after the tolerance before it, which only a peer keyed by when it applied its staples does. */
	| 'applied'
	/** It did both: it keys votes later than the tolerance after they were made. */
	| 'late-votes';

/**
 * What a page from a start shows of how far the peer read for it: which of
 * its staples it listed for reads it listed in full, as the peer keys its
 * staples as far as the pass knows.
 */
export type Evidence<Staple extends PassStaple> = {
	readonly page: readonly Staple[];
	readonly start: number;
	/** As the passes know it when the evidence is weighed, which only ever moves towards late-votes, so what was counted when the page came stays sound. */
	readonly keying: KeyingRecord;
	/** The staples of the page before this index were listed by reads it listed in full. */
	readonly wholeBelow: number;
	/** Every read of the page that held a key before this moment was listed in full, as the votes the peer holds show (countedReach). */
	readonly countedTo: number;
};

/** When each of the staple's votes was made. */
export function stampsOf(staple: PassStaple): number[] {
	return(staple.votes.map(function(vote): number {
		return(vote.validityFrom.getTime());
	}));
}

/**
 * The latest moment a page that lists the staple, from a peer keyed by votes,
 * is shown to have read up to by it: the tolerance before its first vote.
 * The peer keys none of its votes earlier, so whichever it listed the staple
 * for, it read a key at or after this moment.
 */
export function reachOf(staple: PassStaple): number {
	return(Math.min(...stampsOf(staple)) - VOTE_KEY_TOLERANCE_MILLISECONDS);
}

/** Whether the answer lists a staple twice: once for each of two reads holding one of its votes, as only a peer keyed by votes does. */
function listsTwice(staples: readonly PassStaple[]): boolean {
	return(new Set(staples.map(stapleKey)).size < staples.length);
}

/** The first staple of the answer from the start none of whose votes was made at or after the tolerance before it, which a peer keyed by votes within the tolerance never lists. */
export function listedForEarlierVotes<Staple extends PassStaple>(staples: readonly Staple[], start: number): Staple | undefined {
	return(staples.find(function(staple): boolean {
		return(stampsOf(staple).every(function(stamp): boolean {
			return(stamp < start - VOTE_KEY_TOLERANCE_MILLISECONDS);
		}));
	}));
}

function notKeyedAsThisNode(keying: PeerKeying): PeerKeying {
	switch (keying) {
		case 'unknown':
		case 'votes':
			return('votes');
		case 'applied':
		case 'late-votes':
			return('late-votes');
		default:
			return(assertNever(keying));
	}
}

function notKeyedByVotesInTime(keying: PeerKeying): PeerKeying {
	switch (keying) {
		case 'unknown':
		case 'applied':
			return('applied');
		case 'votes':
		case 'late-votes':
			return('late-votes');
		default:
			return(assertNever(keying));
	}
}

/**
 * What the passes over a peer learn of how it keys its staples from every
 * answer, kept with its progress, and reported once it keys votes late.
 */
export class KeyingRecord {
	#current: PeerKeying;
	readonly #changed: (keying: PeerKeying) => Promise<void>;
	readonly #report: (event: PassEvent) => void;

	constructor(current: PeerKeying, changed: (keying: PeerKeying) => Promise<void>, report: (event: PassEvent) => void) {
		this.#current = current;
		this.#changed = changed;
		this.#report = report;
	}

	get current(): PeerKeying {
		return(this.#current);
	}

	async observe(staples: readonly PassStaple[], start: number): Promise<void> {
		let next = this.#current;
		if (listsTwice(staples)) {
			next = notKeyedAsThisNode(next);
		}
		const forEarlier = listedForEarlierVotes(staples, start);
		if (forEarlier !== undefined) {
			next = notKeyedByVotesInTime(next);
		}
		if (next === this.#current) {
			return;
		}
		this.#current = next;
		await this.#changed(next);
		if (next === 'late-votes') {
			this.#report({ kind: 'late-votes', start: new Date(start), staple: (forEarlier ?? staples[0])?.blocksHash.toString() ?? '' });
		}
	}
}

/**
 * The staples a pass was listed by the peer, by their keys (stapleKey), with
 * when their votes were made: votes the peer held when it answered each
 * later request. A peer holds one staple per set of blocks, so two keys are
 * two staples and their votes are distinct. A pass reads a bounded part of
 * a peer, so it keeps them all.
 */
export class KnownVotes {
	readonly #stamps = new Map<string, readonly number[]>();

	learn(staples: readonly PassStaple[]): void {
		for (const staple of staples) {
			this.#stamps.set(stapleKey(staple), stampsOf(staple));
		}
	}

	/** Whether a vote of the staple was made at or after the moment, or, for a staple the peer did not list, nothing is known of it. */
	mayBeMadeSince(key: string, moment: number): boolean {
		return(this.#stamps.get(key)?.some(function(stamp): boolean {
			return(stamp >= moment);
		}) ?? true);
	}

	/** The moment of the vote that many before the latest made from the moment given up to the bound, if there are that many. */
	countBack(count: number, from: number, bound: number): number | undefined {
		const before: number[] = [];
		for (const stamps of this.#stamps.values()) {
			for (const stamp of stamps) {
				if (stamp >= from && stamp < bound) {
					before.push(stamp);
				}
			}
		}
		if (before.length < count) {
			return(undefined);
		}
		return(before.sort(function(left, right): number {
			return(right - left);
		})[count - 1]);
	}
}

/**
 * The index below which a page's staples were listed by reads it listed in
 * full. A peer stops between reads when its time for a request runs out
 * [Keeta TS] index.js:69641-69647, but within one when it reaches the limit,
 * the one asked for or a lower one of its own: so all of a page shorter than
 * the limit asked for and than the longest answer the peer gave before,
 * which no limit of its own cut, and of any other page, all but its
 * last MAX_VOTES_PER_READ staples, and every staple up to the first listing
 * of a staple it listed twice, which the read listing it again followed.
 */
export function wholeBelowOf(page: readonly PassStaple[], limit: number, longest: number): number {
	if (page.length < limit && page.length < longest) {
		return(page.length);
	}
	let below = Math.max(0, page.length - MAX_VOTES_PER_READ);
	const first = new Map<string, number>();
	page.forEach(function(staple, index): void {
		const key = stapleKey(staple);
		const at = first.get(key);
		if (at === undefined) {
			first.set(key, index);
		} else {
			below = Math.max(below, at + 1);
		}
	});
	return(below);
}

/**
 * The latest moment before which every read of a page that may have been
 * cut within its last read was listed in full, shown by the votes the peer
 * holds, or nothing. The last read held a vote of the page's last staple,
 * keyed at or after the tolerance before its first vote, and at most
 * MAX_VOTES_PER_READ votes in all, which run on in key order; so it began
 * after any moment with that many votes the peer holds keyed between it and
 * that vote: those made from the tolerance after it up to twice the tolerance
 * before the staple's first vote.
 */
export function countedReach(page: readonly PassStaple[], start: number, known: KnownVotes): number {
	const last = page.at(-1);
	if (last === undefined) {
		return(Number.NEGATIVE_INFINITY);
	}
	// A vote made before the tolerance after the start shows no moment past it.
	const stamp = known.countBack(MAX_VOTES_PER_READ, start + VOTE_KEY_TOLERANCE_MILLISECONDS, reachOf(last) - VOTE_KEY_TOLERANCE_MILLISECONDS);
	if (stamp === undefined) {
		return(Number.NEGATIVE_INFINITY);
	}
	return(stamp - VOTE_KEY_TOLERANCE_MILLISECONDS);
}

/**
 * Whether the staple at the index of the page shows, once an answer from the
 * moment lists it, that the page read every key before the moment (see Pass,
 * src/node/bootstrap-pass.ts).
 */
export function shows(evidence: Evidence<PassStaple>, index: number, moment: number): boolean {
	const staple = evidence.page[index];
	if (staple === undefined) {
		return(false);
	}
	const whole = index < evidence.wholeBelow;
	const keying = evidence.keying.current;
	switch (keying) {
		case 'applied':
			return(true);
		case 'late-votes':
			return(whole && moment <= reachOf(staple));
		case 'unknown':
		case 'votes':
			return((whole || moment <= evidence.countedTo) && moment <= reachOf(staple));
		default:
			return(assertNever(keying));
	}
}

/**
 * The latest moment past the start the page's votes show it read up to, and
 * the staple that shows it, the one whose first vote was made earliest among
 * those that do, which a peer keyed by votes lists first from there; nothing
 * when none shows one.
 */
export function shownTarget(evidence: Evidence<PassStaple>): { readonly at: number; readonly index: number } | undefined {
	let target: { readonly at: number; readonly index: number; readonly reach: number } | undefined;
	evidence.page.forEach(function(staple, index): void {
		const reach = reachOf(staple);
		let at = reach;
		if (index >= evidence.wholeBelow && evidence.keying.current !== 'applied') {
			at = Math.min(at, evidence.countedTo);
		}
		if (at <= evidence.start || !shows(evidence, index, at)) {
			return;
		}
		if (target === undefined || at > target.at || (at === target.at && reach < target.reach)) {
			target = { at, index, reach };
		}
	});
	return(target);
}

/** Whether a staple of the page may show the page reached some moment past the start. */
export function mayShowPast(evidence: Evidence<PassStaple>): boolean {
	return(evidence.keying.current === 'applied' || shownTarget(evidence) !== undefined);
}

/** Whether a vote of the staple was made within the tolerance of the moments from the start up to the moment. */
export function madeBetween(staple: PassStaple, start: number, moment: number): boolean {
	return(stampsOf(staple).some(function(stamp): boolean {
		return(stamp >= start - VOTE_KEY_TOLERANCE_MILLISECONDS && stamp < moment + VOTE_KEY_TOLERANCE_MILLISECONDS);
	}));
}
