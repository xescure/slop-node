import { describe, expect, test } from 'vitest';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { confirmedStaple, sendBlock } from '../../../testing/blocks.js';
import type { TestNetwork } from '../../../testing/network.js';
import type { LedgerStorageDriverBase } from '../base.js';
import { TESTING_KEY, headOf, requireAt, useFixtures } from './support.js';
import type { DriverUnderTest } from './types.js';

type UserChain = {
	readonly first: Block;
	readonly second: Block;
};

async function chainOfTwoSends(network: TestNetwork): Promise<UserChain> {
	const from = requireAt(network.users, 0);
	const to = requireAt(network.users, 1);
	const first = await sendBlock({ from, previous: headOf(network.genesis, from), to, amount: 5n, token: network.baseToken, network: network.network });
	const second = await sendBlock({ from, previous: first.hash, to, amount: 7n, token: network.baseToken, network: network.network });
	return({ first, second });
}

async function deferredWaitingOn(storage: LedgerStorageDriverBase, hash: BlockHash): Promise<string[]> {
	const transaction = await storage.beginTransaction({ identifier: 'suite-inspect-deferred', readOnly: true });
	try {
		const waiting = await storage._Testing(TESTING_KEY).deferredStaplesWaitingOn(transaction, [hash]);
		return(waiting.map(function(staple): string {
			return(staple.blocksHash.toString());
		}));
	} finally {
		await storage.abortTransaction(transaction);
	}
}

function blocksHashesOf(staples: readonly VoteStaple[]): string[] {
	return(staples.map(function(staple): string {
		return(staple.blocksHash.toString());
	}));
}

export function defineDeferralCases(driver: DriverUnderTest): void {
	describe('deferral', function() {
		const startNetwork = useFixtures(driver);

		test('a deferred staple applied on its own stops waiting', async function() {
			// A zero window leaves every waiter for later, as an exhausted window would.
			const { network, storage, ledger } = await startNetwork(undefined, { heapProcessWindowMs: 0 });
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const { first, second } = await chainOfTwoSends(network);
			const firstStaple = await confirmedStaple([first], network.representatives);
			const secondStaple = await confirmedStaple([second], network.representatives);

			expect(await ledger.add(secondStaple)).toEqual([]);
			expect(blocksHashesOf(await ledger.add(firstStaple))).toEqual(blocksHashesOf([firstStaple]));
			expect(await deferredWaitingOn(storage, first.hash)).toEqual(blocksHashesOf([secondStaple]));

			expect(blocksHashesOf(await ledger.add(secondStaple))).toEqual(blocksHashesOf([secondStaple]));
			expect(await deferredWaitingOn(storage, first.hash)).toEqual([]);
			expect(await ledger.getBalance(user, network.baseToken)).toBe(388n);
		});

		test('a staple listing a block before its previous is refused, not deferred', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const { first, second } = await chainOfTwoSends(network);
			const outOfOrder = await confirmedStaple([second, first], network.representatives);
			const refusal = ledger.add(outOfOrder);

			await expect(refusal).rejects.toMatchObject({ code: 'LEDGER_PREVIOUS_NOT_SEEN', shouldRetry: false });
			await expect(refusal).rejects.toThrow('out of order');
			expect(await deferredWaitingOn(storage, first.hash)).toEqual([]);
			expect(await deferredWaitingOn(storage, headOf(network.genesis, user))).toEqual([]);
			expect(await ledger.getBalance(user, network.baseToken)).toBe(400n);
		});

		test('an out-of-order staple that also misses a previous is refused, not deferred', async function() {
			const { network, storage, ledger } = await startNetwork();
			const from = requireAt(network.users, 0);
			const to = requireAt(network.users, 1);
			await ledger.add(network.genesis);
			const missing = await sendBlock({ from, previous: headOf(network.genesis, from), to, amount: 1n, token: network.baseToken, network: network.network });
			const first = await sendBlock({ from, previous: missing.hash, to, amount: 5n, token: network.baseToken, network: network.network });
			const second = await sendBlock({ from, previous: first.hash, to, amount: 7n, token: network.baseToken, network: network.network });
			const outOfOrder = await confirmedStaple([second, first], network.representatives);

			await expect(ledger.add(outOfOrder)).rejects.toMatchObject({ code: 'LEDGER_PREVIOUS_NOT_SEEN', shouldRetry: false });
			expect(await deferredWaitingOn(storage, missing.hash)).toEqual([]);
		});
	});
}
