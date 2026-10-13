import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { pagePath } from '../node/bootstrap-page.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { startFakeAPI } from '../testing/fake-api.js';
import type { FakeAPI } from '../testing/fake-api.js';
import { httpSource } from './api-source.js';
import { checkKeying, KEYING_CHECK_LIMIT, KEYING_EARLY_SPAN_MILLISECONDS, KEYING_EARLY_STEP_MILLISECONDS, KEYING_SAMPLE_AGE_MILLISECONDS, keyingExitCodeOf } from './keying.js';

const lib = KeetaNet.lib;

const NETWORK = 0x5382n;

const SEED = '3c1b5d7e9fa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829308f';
const owner = lib.Account.fromSeed(SEED, 0);
const other = lib.Account.fromSeed(SEED, 1);
const voters = [lib.Account.fromSeed(SEED, 2), lib.Account.fromSeed(SEED, 3)];
const token: TokenAddress = owner.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);

const NOW = Date.UTC(2026, 8, 1, 12);

/** When the second voter's vote on each staple was made after the first's, and so the staple's latest vote. */
const SECOND_VOTE_DELAY = 250;

/** Staples made a few hours ago, a minute apart, each voted on twice, the second vote its latest. */
async function staples(count: number): Promise<VoteStaple[]> {
	const made: VoteStaple[] = [];
	for (let index = 0; index < count; index++) {
		const block = await sendBlock({ from: owner, to: other, amount: 1n, token, previous: made.at(-1)?.blocks[0]?.hash ?? null, network: NETWORK, date: new Date(NOW - 3 * 3_600_000 + index * 60_000) });
		made.push(await confirmedStaple([block], voters, { voteDelays: [0, SECOND_VOTE_DELAY] }));
	}
	return(made);
}

function latestVoteOf(staple: VoteStaple): number {
	return(Math.max(...staple.votes.map(function(vote): number {
		return(vote.validityFrom.getTime());
	})));
}

/** A page of staples, written as a representative writes them. */
function page(listed: readonly VoteStaple[]): unknown {
	return({ voteStaples: listed.map(function(staple) {
		return({ $binary: Buffer.from(staple.toBytes()).toString('base64') });
	}) });
}

function from(moment: number, limit: number): string {
	return(pagePath({ start: new Date(moment), limit, bloomFilter: undefined }));
}

/** Serves, from each step before the staple's latest vote back to the span, the page listed gives for how far back the step is. */
function serveEarlier(api: FakeAPI, staple: VoteStaple, listed: (back: number) => readonly VoteStaple[]): void {
	for (let back = KEYING_EARLY_STEP_MILLISECONDS; back <= KEYING_EARLY_SPAN_MILLISECONDS; back += KEYING_EARLY_STEP_MILLISECONDS) {
		api.serve(from(latestVoteOf(staple) - back, KEYING_CHECK_LIMIT), page(listed(back)));
	}
}

/** A representative listing the staples from the sample's start, then, from the latest vote of each, what the keying given lists. */
function serve(api: FakeAPI, sample: readonly VoteStaple[], fromLatest: (staple: VoteStaple, index: number) => { readonly at: readonly VoteStaple[]; readonly after: readonly VoteStaple[] }): void {
	api.serve(from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 2), page(sample));
	sample.forEach(function(staple, index) {
		const listed = fromLatest(staple, index);
		api.serve(from(latestVoteOf(staple), KEYING_CHECK_LIMIT), page(listed.at));
		api.serve(from(latestVoteOf(staple) + 1, KEYING_CHECK_LIMIT), page(listed.after));
	});
}

describe('how each representative keys the votes of its staples', function() {
	test('is checked by whether it lists each sampled staple from its latest vote\'s moment, and not from a millisecond later', async function() {
		const sample = await staples(3);
		const exact = await startFakeAPI();
		const early = await startFakeAPI();
		const late = await startFakeAPI();
		const unanswered = await startFakeAPI();
		const sampled = sample.slice(0, 2);
		serve(exact, sampled, function(staple, index) {
			return({ at: sample.slice(index), after: sample.slice(index + 1) });
		});
		// The second staple's latest vote is keyed before it was made, so a page from that moment leaves it out, and one from a little before lists it.
		serve(early, sampled, function(staple, index) {
			if (index === 1) {
				return({ at: sample.slice(2), after: sample.slice(2) });
			}
			return({ at: sample.slice(index), after: sample.slice(index + 1) });
		});
		const [, second] = sampled;
		if (second === undefined) {
			throw(new Error('no staple'));
		}
		serveEarlier(early, second, function(): readonly VoteStaple[] {
			return(sample.slice(1));
		});
		serve(late, sampled, function(staple, index) {
			return({ at: sample.slice(index), after: sample.slice(index) });
		});

		const checked = await checkKeying({
			representatives: [exact, early, late, unanswered].map(function(api) {
				return(httpSource(api.endpoint));
			}),
			staples: 2,
			now: NOW
		});

		expect(checked.map(function(representative) {
			return([representative.representative, representative.verdict]);
		})).toEqual([
			[exact.endpoint, 'keys exactly'],
			[early.endpoint, 'keys early by more than 1 ms'],
			[late.endpoint, 'keys late'],
			[unanswered.endpoint, 'not checked']
		]);
		expect(checked[1]?.staples).toEqual(sampled.map(function(staple, index) {
			return({ staple: staple.blocksHash.toString(), latestVote: new Date(latestVoteOf(staple)).toISOString(), outcome: ['exact', 'early'][index] });
		}));
		expect(checked[3]?.unanswered).toMatch(/answered 404/);
		expect(keyingExitCodeOf(checked)).toBe(1);
		expect(keyingExitCodeOf(checked.slice(0, 1))).toBe(0);
		// The check asks from the latest vote's moment, not the first's, which the fixture keeps apart.
		expect(sampled.every(function(staple): boolean {
			return(Math.min(...staple.votes.map(function(vote): number {
				return(vote.validityFrom.getTime());
			})) === latestVoteOf(staple) - SECOND_VOTE_DELAY);
		})).toBe(true);
		// Read-only, paced by the caller: a GET for the sample, then two for each staple, the later moment first.
		expect(exact.requests).toEqual(['GET ' + from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 2), ...sampled.flatMap(function(staple) {
			return([`GET ${from(latestVoteOf(staple) + 1, KEYING_CHECK_LIMIT)}`, `GET ${from(latestVoteOf(staple), KEYING_CHECK_LIMIT)}`]);
		})]);
		expect(exact.requests[0]).toBe(`GET /node/bootstrap/votes?start=${encodeURIComponent(new Date(NOW - KEYING_SAMPLE_AGE_MILLISECONDS).toISOString())}&limit=2`);
	});

	test('samples each staple once, though a representative lists it once for each read holding one of its votes', async function() {
		const sample = await staples(2);
		const api = await startFakeAPI();
		const [first, second] = sample;
		if (first === undefined || second === undefined) {
			throw(new Error('no staple'));
		}
		api.serve(from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 3), page([first, first, second]));
		sample.forEach(function(staple, index) {
			api.serve(from(latestVoteOf(staple), KEYING_CHECK_LIMIT), page(sample.slice(index)));
			api.serve(from(latestVoteOf(staple) + 1, KEYING_CHECK_LIMIT), page(sample.slice(index + 1)));
		});

		const [checked] = await checkKeying({ representatives: [httpSource(api.endpoint)], staples: 3, now: NOW });

		expect(checked?.verdict).toBe('keys exactly');
		expect(checked?.staples.map(function(staple) {
			return(staple.staple);
		})).toEqual(sample.map(function(staple) {
			return(staple.blocksHash.toString());
		}));
	});

	test('leaves a staple unsettled when the page from its latest vote is full without it, and the representative unchecked when no staple settles', async function() {
		const sample = await staples(KEYING_CHECK_LIMIT + 1);
		const [first] = sample;
		if (first === undefined) {
			throw(new Error('no staple'));
		}
		const api = await startFakeAPI();
		api.serve(from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 1), page([first]));
		api.serve(from(latestVoteOf(first), KEYING_CHECK_LIMIT), page(sample.slice(1)));
		api.serve(from(latestVoteOf(first) + 1, KEYING_CHECK_LIMIT), page(sample.slice(1)));

		const [checked] = await checkKeying({ representatives: [httpSource(api.endpoint)], staples: 1, now: NOW });

		expect(checked).toEqual({ representative: api.endpoint, verdict: 'not checked', staples: [{ staple: first.blocksHash.toString(), latestVote: new Date(latestVoteOf(first)).toISOString(), outcome: 'unsettled' }], unanswered: null });
	});

	test('takes a staple missing from the page from its latest vote for keyed early only once a page from a little before lists it, and the page from then holds no other staple voted on then', async function() {
		const sample = await staples(3);
		const [first, second, third] = sample;
		if (first === undefined || second === undefined || third === undefined) {
			throw(new Error('no staple'));
		}
		// Another staple on the first's blocks, its second vote made when the first's latest was, which the page from then lists.
		const sibling = await confirmedStaple(first.blocks, voters, { voteDelays: [SECOND_VOTE_DELAY, SECOND_VOTE_DELAY] });
		const crowded = await startFakeAPI();
		crowded.serve(from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 1), page([first]));
		crowded.serve(from(latestVoteOf(first) + 1, KEYING_CHECK_LIMIT), page([second]));
		crowded.serve(from(latestVoteOf(first), KEYING_CHECK_LIMIT), page([sibling, second]));
		const nowhere = await startFakeAPI();
		nowhere.serve(from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 1), page([first]));
		nowhere.serve(from(latestVoteOf(first) + 1, KEYING_CHECK_LIMIT), page([second]));
		nowhere.serve(from(latestVoteOf(first), KEYING_CHECK_LIMIT), page([second]));
		serveEarlier(nowhere, first, function(): readonly VoteStaple[] {
			return([second]);
		});

		const checked = await checkKeying({ representatives: [httpSource(crowded.endpoint), httpSource(nowhere.endpoint)], staples: 1, now: NOW });

		expect(checked.map(function(representative) {
			return([representative.verdict, representative.staples.map(function(staple) {
				return(staple.outcome);
			})]);
		})).toEqual([['not checked', ['unsettled']], ['not checked', ['unsettled']]]);
		// The page from a millisecond on lists the sibling, which is another staple, keyed by its own votes, and not the first keyed late.
		const sameBlocks = await startFakeAPI();
		sameBlocks.serve(from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 1), page([first]));
		sameBlocks.serve(from(latestVoteOf(first) + 1, KEYING_CHECK_LIMIT), page([sibling, second]));
		sameBlocks.serve(from(latestVoteOf(first), KEYING_CHECK_LIMIT), page([first, sibling, second]));
		const [exact] = await checkKeying({ representatives: [httpSource(sameBlocks.endpoint)], staples: 1, now: NOW });
		expect(exact?.verdict).toBe('keys exactly');
	});

	test('fails a representative that leaves a sampled staple unanswered, and one most of whose staples do not settle', async function() {
		const sample = await staples(KEYING_CHECK_LIMIT + 2);
		const [first, second, third] = sample;
		if (first === undefined || second === undefined || third === undefined) {
			throw(new Error('no staple'));
		}
		const exactly = function(api: FakeAPI, staple: VoteStaple, index: number): void {
			api.serve(from(latestVoteOf(staple) + 1, KEYING_CHECK_LIMIT), page(sample.slice(index + 1, index + 2)));
			api.serve(from(latestVoteOf(staple), KEYING_CHECK_LIMIT), page(sample.slice(index, index + 2)));
		};
		// The second staple's pages go unanswered; the others are keyed exactly.
		const failing = await startFakeAPI();
		failing.serve(from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 3), page([first, second, third]));
		exactly(failing, first, 0);
		exactly(failing, third, 2);
		// Of three staples one settles, keyed exactly; the pages from the others' latest votes are full without them.
		const unsettled = await startFakeAPI();
		unsettled.serve(from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 3), page([first, second, third]));
		exactly(unsettled, first, 0);
		for (const staple of [second, third]) {
			unsettled.serve(from(latestVoteOf(staple) + 1, KEYING_CHECK_LIMIT), page([]));
			unsettled.serve(from(latestVoteOf(staple), KEYING_CHECK_LIMIT), page(sample.slice(2, 2 + KEYING_CHECK_LIMIT).filter(function(listed): boolean {
				return(listed !== staple);
			}).concat(sample.slice(-1))));
		}

		const checked = await checkKeying({ representatives: [httpSource(failing.endpoint), httpSource(unsettled.endpoint)], staples: 3, now: NOW });

		expect(checked.map(function(representative) {
			return([representative.verdict, representative.staples.map(function(staple) {
				return(staple.outcome);
			})]);
		})).toEqual([['not checked', ['exact', 'unanswered', 'exact']], ['not checked', ['exact', 'unsettled', 'unsettled']]]);
		expect(keyingExitCodeOf(checked)).toBe(1);
	});

	/*
	 * The representative keys the staple's latest vote 50 ms before it was
	 * made, in a second of dense history: a page from a second before is full
	 * of other staples well before it.
	 */
	test('finds a staple keyed early within a second of dense history, stepping back from the moment of its latest vote', async function() {
		const sample = await staples(KEYING_CHECK_LIMIT + 2);
		const [first, ...others] = sample;
		if (first === undefined) {
			throw(new Error('no staple'));
		}
		const api = await startFakeAPI();
		api.serve(from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 1), page([first]));
		api.serve(from(latestVoteOf(first) + 1, KEYING_CHECK_LIMIT), page([]));
		api.serve(from(latestVoteOf(first), KEYING_CHECK_LIMIT), page(others.slice(-1)));
		serveEarlier(api, first, function(back): readonly VoteStaple[] {
			if (back === KEYING_EARLY_STEP_MILLISECONDS) {
				return([first, ...others.slice(-1)]);
			}
			return(others.slice(0, KEYING_CHECK_LIMIT));
		});

		const [checked] = await checkKeying({ representatives: [httpSource(api.endpoint)], staples: 1, now: NOW });

		expect(checked?.verdict).toBe('keys early by more than 1 ms');
	});

	test('reports no representative as keying exactly while a staple of it is unsettled, though most were keyed exactly', async function() {
		const sample = await staples(KEYING_CHECK_LIMIT + 3);
		const [first, second, third] = sample;
		if (first === undefined || second === undefined || third === undefined) {
			throw(new Error('no staple'));
		}
		const api = await startFakeAPI();
		api.serve(from(NOW - KEYING_SAMPLE_AGE_MILLISECONDS, 3), page([first, second, third]));
		for (const staple of [first, third]) {
			api.serve(from(latestVoteOf(staple) + 1, KEYING_CHECK_LIMIT), page([]));
			api.serve(from(latestVoteOf(staple), KEYING_CHECK_LIMIT), page([staple]));
		}
		// The page from the second's latest vote is full without it.
		api.serve(from(latestVoteOf(second) + 1, KEYING_CHECK_LIMIT), page([]));
		api.serve(from(latestVoteOf(second), KEYING_CHECK_LIMIT), page(sample.slice(3, 3 + KEYING_CHECK_LIMIT)));

		const [checked] = await checkKeying({ representatives: [httpSource(api.endpoint)], staples: 3, now: NOW });

		expect(checked?.staples.map(function(staple) {
			return(staple.outcome);
		})).toEqual(['exact', 'unsettled', 'exact']);
		expect(checked?.verdict).toBe('not checked');
	});
});
