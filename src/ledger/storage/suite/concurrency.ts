import { describe, expect, test } from 'vitest';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import { advanceClock } from '../../../testing/network.js';
import { confirmedStaple, sendBlock } from '../../../testing/blocks.js';
import { blocksHashesOf, checksumOf, hashOf, headOf, identitiesOf, ledgerChecksumOf, requireAt, useFixtures } from './support.js';
import type { DriverUnderTest } from './types.js';

// Longer than the slop either side of a vote's validity, shorter than a temporary vote's lifetime.
const QUEUED_MILLISECONDS = 120_000;

/** A read-write transaction that holds the driver until it is released. */
type LongTransaction = {
	readonly finished: Promise<string>;
	release(): void;
};

/*
 * Ledger fixes each transaction's moment when the request arrives, before
 * the driver admits it, so requests queued behind this one keep a moment
 * from before the wait.
 * [Keeta TS] index.js:70393-70396
 */
function startLongTransaction(ledger: Ledger): LongTransaction {
	let release = function(): void {
		// Replaced synchronously by the promise executor below.
	};
	const gate = new Promise<void>(function(resolve) {
		release = resolve;
	});
	const finished = ledger.run('suite-long-transaction', async function() {
		await gate;
		return('released');
	});
	return({ finished, release });
}

function settledValues<Value>(outcomes: readonly PromiseSettledResult<Value>[]): Value[] {
	return(outcomes.flatMap(function(outcome): Value[] {
		if (outcome.status === 'fulfilled') {
			return([outcome.value]);
		}
		return([]);
	}));
}

function settledReasons(outcomes: readonly PromiseSettledResult<unknown>[]): unknown[] {
	return(outcomes.flatMap(function(outcome): unknown[] {
		if (outcome.status === 'rejected') {
			return([outcome.reason]);
		}
		return([]);
	}));
}

/*
 * Both requests run through the public ledger at the same time. Voting and
 * adding check, then write; a driver must keep the two requests from both
 * passing the check, whether it serializes them or aborts one for a retry.
 */
export function defineConcurrencyCases(driver: DriverUnderTest): void {
	describe('concurrency', function() {
		const startNetwork = useFixtures(driver);

		test('concurrent competing votes produce exactly one temporary vote', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const representative = requireAt(network.representatives, 0);
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const competing = await Promise.all([5n, 7n].map(function(amount) {
				return(sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount, token: network.baseToken, network: network.network }));
			}));

			const outcomes = await Promise.allSettled(competing.map(function(block) {
				return(ledger.vote([block]));
			}));

			const votes = settledValues(outcomes);
			expect(votes).toHaveLength(1);
			const [vote] = votes;
			if (vote === undefined) {
				throw(new Error('one vote expected'));
			}
			expect(vote.$permanent).toBe(false);
			expect(settledReasons(outcomes)).toEqual([expect.objectContaining({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' })]);
			const voted = competing.find(function(block): boolean {
				return(block.hash.toString() === requireAt(vote.blocks, 0).toString());
			});
			const refused = competing.find(function(block): boolean {
				return(block !== voted);
			});
			if (voted === undefined || refused === undefined) {
				throw(new Error('the vote should cover one of the competing blocks'));
			}
			const found = await ledger.getVotesFromMultiplePrevious([genesisHead], 'both', representative);
			expect(identitiesOf(found[genesisHead.toString()])).toEqual([vote.$uid]);
			expect(hashOf(await ledger.getBlockFromPrevious(genesisHead, 'side'))).toBe(hashOf(voted));
			expect(await ledger.getVotes(refused.hash, 'side')).toBeNull();
			expect(await ledger.getBlock(refused.hash, 'side')).toBeNull();
		});

		test('a vote queued behind a long transaction still sees a competing vote committed meanwhile', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const competing = await Promise.all([5n, 7n].map(function(amount) {
				return(sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount, token: network.baseToken, network: network.network }));
			}));
			const long = startLongTransaction(ledger);
			const voting = Promise.allSettled(competing.map(function(block) {
				return(ledger.vote([block]));
			}));

			// The first vote is sealed after the wait, so it is issued after the second request's moment.
			advanceClock(QUEUED_MILLISECONDS);
			long.release();
			const outcomes = await voting;

			expect(await long.finished).toBe('released');
			const votes = settledValues(outcomes);
			expect(votes).toHaveLength(1);
			expect(settledReasons(outcomes)).toEqual([expect.objectContaining({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' })]);
			const found = await ledger.getVotesFromMultiplePrevious([genesisHead], 'both', requireAt(network.representatives, 0));
			expect(identitiesOf(found[genesisHead.toString()])).toEqual(identitiesOf(votes));
		});

		test('side reads queued behind a long transaction see a vote committed meanwhile', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const idempotent = btoa('queued-order');
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const send = await sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount: 5n, token: network.baseToken, network: network.network, idempotent });
			const long = startLongTransaction(ledger);
			const voting = ledger.vote([send]);
			const reading = Promise.all([
				ledger.getVotes(send.hash, 'side'),
				ledger.getBlock(send.hash, 'side'),
				ledger.getBlockFromPrevious(genesisHead, 'side'),
				ledger.getIdempotentBlockHash(user, idempotent, 'side')
			]);

			advanceClock(QUEUED_MILLISECONDS);
			long.release();
			const vote = await voting;
			const [votes, block, successor, holder] = await reading;

			expect(await long.finished).toBe('released');
			expect(identitiesOf(votes)).toEqual([vote.$uid]);
			expect(hashOf(block)).toBe(hashOf(send));
			expect(hashOf(successor)).toBe(hashOf(send));
			expect(hashOf(holder)).toBe(hashOf(send));
		});

		test('gc queued behind a long transaction keeps a vote committed meanwhile', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const send = await sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount: 5n, token: network.baseToken, network: network.network });
			const long = startLongTransaction(ledger);
			const voting = ledger.vote([send]);
			const collecting = ledger.gc();

			advanceClock(QUEUED_MILLISECONDS);
			long.release();
			const vote = await voting;

			expect(await collecting).toBe(false);
			expect(await long.finished).toBe('released');
			expect(identitiesOf(await ledger.getVotes(send.hash, 'side'))).toEqual([vote.$uid]);
			const competitor = await sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount: 7n, token: network.baseToken, network: network.network });
			await expect(ledger.vote([competitor])).rejects.toMatchObject({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' });
		});

		test('concurrent adds of one staple apply it once', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			const { node } = await startNode(0);
			advanceClock(1000);
			const send = await sendBlock({ from: user, previous: headOf(network.genesis, user), to: requireAt(network.users, 1), amount: 5n, token: network.baseToken, network: network.network });
			const staple = await confirmedStaple([send], network.representatives);

			const outcomes = await Promise.allSettled([node.ledger.add(staple), node.ledger.add(staple)]);

			expect(settledValues(outcomes).map(blocksHashesOf)).toEqual([blocksHashesOf([staple])]);
			expect(settledReasons(outcomes)).toEqual([expect.objectContaining({ code: 'LEDGER_BLOCK_ALREADY_EXISTS' })]);
			expect(await node.ledger.getBalance(user, network.baseToken)).toBe(395n);
			expect(blocksHashesOf(await node.ledger.getHistory(user, null))).toEqual(blocksHashesOf([staple, network.genesis]));
			// Each applied block enters the checksum by XOR, so a second application would cancel the first.
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, staple]));
		});
	});
}
