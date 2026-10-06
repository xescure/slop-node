import { describe, expect, test } from 'vitest';
import { confirmedStaple, sendBlock } from '../../../testing/blocks.js';
import { blocksHashesOf, checksumOf, hashOf, headOf, identitiesOf, ledgerChecksumOf, requireAt, useFixtures } from './support.js';
import type { DriverUnderTest } from './types.js';

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

		test('concurrent adds of one staple apply it once', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			const node = await startNode(0);
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
