import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { pagePath } from '../node/bootstrap-page.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { startFakeAPI } from '../testing/fake-api.js';
import type { FakeAPI } from '../testing/fake-api.js';
import { httpSource } from './api-source.js';
import { checkKeying, KEYING_CHECK_LIMIT, KEYING_SAMPLE_AGE_MILLISECONDS, keyingExitCodeOf } from './keying.js';

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
		// The second staple's latest vote is keyed before it was made, so a page from that moment leaves it out.
		serve(early, sampled, function(staple, index) {
			if (index === 1) {
				return({ at: sample.slice(2), after: sample.slice(2) });
			}
			return({ at: sample.slice(index), after: sample.slice(index + 1) });
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
});
