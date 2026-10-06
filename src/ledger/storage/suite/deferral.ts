import { describe, expect, test } from 'vitest';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import { confirmedStaple, sendBlock } from '../../../testing/blocks.js';
import type { TestNetwork } from '../../../testing/network.js';
import type { LedgerStorageDriverBase } from '../base.js';
import { TESTING_KEY, blockHashesOf, blocksHashesOf, headOf, readStorage, requireAt, useFixtures } from './support.js';
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

function deferredWaitingOn(storage: LedgerStorageDriverBase, hash: BlockHash): Promise<string[]> {
	return(readStorage(storage, async function(transaction) {
		return(blocksHashesOf(await storage._Testing(TESTING_KEY).deferredStaplesWaitingOn(transaction, [hash])));
	}));
}

async function sendsAfter(network: TestNetwork, previous: BlockHash, amounts: readonly bigint[]): Promise<Block[]> {
	const from = requireAt(network.users, 0);
	const to = requireAt(network.users, 1);
	const blocks: Block[] = [];
	let head = previous;
	for (const amount of amounts) {
		const block = await sendBlock({ from, previous: head, to, amount, token: network.baseToken, network: network.network });
		blocks.push(block);
		head = block.hash;
	}
	return(blocks);
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
		test('a deferred staple added again stays deferred once', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const { first, second } = await chainOfTwoSends(network);
			const secondStaple = await confirmedStaple([second], network.representatives);

			expect(await ledger.add(secondStaple)).toEqual([]);
			expect(await ledger.add(secondStaple)).toEqual([]);

			expect(await deferredWaitingOn(storage, first.hash)).toEqual(blocksHashesOf([secondStaple]));
			const firstStaple = await confirmedStaple([first], network.representatives);
			expect(blockHashesOf(await ledger.add(firstStaple))).toEqual([first.hash.toString(), second.hash.toString()]);
			expect(await ledger.getBalance(user, network.baseToken)).toBe(388n);
		});

		test('two blocks sharing a missing previous are refused, not deferred', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const [missing, ...unused] = await sendsAfter(network, headOf(network.genesis, user), [1n]);
			if (missing === undefined || unused.length > 0) {
				throw(new Error('one missing block expected'));
			}
			const [twin] = await sendsAfter(network, missing.hash, [5n]);
			const [twinFork] = await sendsAfter(network, missing.hash, [7n]);
			if (twin === undefined || twinFork === undefined) {
				throw(new Error('two forks expected'));
			}

			await expect(ledger.add(await confirmedStaple([twin, twinFork], network.representatives))).rejects.toMatchObject({ code: 'LEDGER_PREVIOUS_ALREADY_USED', shouldRetry: false });
			expect(await deferredWaitingOn(storage, missing.hash)).toEqual([]);
		});

		test('a replayed staple whose idempotent key is taken stays deferred while its trigger applies', async function() {
			const { network, storage, ledger } = await startNetwork();
			const from = requireAt(network.users, 0);
			const to = requireAt(network.users, 1);
			const idempotent = btoa('order-1');
			await ledger.add(network.genesis);
			const keyed = await sendBlock({ from, previous: headOf(network.genesis, from), to, amount: 1n, token: network.baseToken, network: network.network, idempotent });
			const trigger = await sendBlock({ from, previous: keyed.hash, to, amount: 2n, token: network.baseToken, network: network.network });
			const reused = await sendBlock({ from, previous: trigger.hash, to, amount: 4n, token: network.baseToken, network: network.network, idempotent });
			const [keyedStaple, triggerStaple, reusedStaple] = await Promise.all([keyed, trigger, reused].map(function(block) {
				return(confirmedStaple([block], network.representatives));
			}));
			if (keyedStaple === undefined || triggerStaple === undefined || reusedStaple === undefined) {
				throw(new Error('three staples expected'));
			}
			expect(await ledger.add(reusedStaple)).toEqual([]);
			await ledger.add(keyedStaple);

			// The replay passes every check made before the write, and the write refuses the taken key.
			const applied = await ledger.add(triggerStaple);

			expect(blocksHashesOf(applied)).toEqual(blocksHashesOf([triggerStaple]));
			expect(await deferredWaitingOn(storage, trigger.hash)).toEqual(blocksHashesOf([reusedStaple]));
			expect(await ledger.getBlock(reused.hash, 'main')).toBeNull();
			expect((await ledger.getVoteStaples([reusedStaple.blocksHash], 'main')).get(reusedStaple.blocksHash)).toBeNull();
			expect((await ledger.getHeadBlock(from, 'main'))?.hash.toString()).toBe(trigger.hash.toString());
			expect(await ledger.getBalance(from, network.baseToken)).toBe(397n);
			expect(await ledger.getBalance(to, network.baseToken)).toBe(303n);
			expect(blocksHashesOf(await ledger.getHistory(from, null))).toEqual(blocksHashesOf([triggerStaple, keyedStaple, network.genesis]));
			expect((await ledger.getIdempotentBlockHash(from, idempotent, 'main'))?.toString()).toBe(keyed.hash.toString());
		});

		test('deferred staple applies exactly once when its previous arrives', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const { first, second } = await chainOfTwoSends(network);
			const firstStaple = await confirmedStaple([first], network.representatives);
			const secondStaple = await confirmedStaple([second], network.representatives);

			expect(await ledger.add(secondStaple)).toEqual([]);
			expect(await ledger.getBalance(user, network.baseToken)).toBe(400n);
			expect(await deferredWaitingOn(storage, first.hash)).toEqual(blocksHashesOf([secondStaple]));

			const applied = await ledger.add(firstStaple);

			// Ledger.add folds every returned block into the ledger checksum, so each must appear once.
			expect(blocksHashesOf(applied)).toEqual(blocksHashesOf([firstStaple, secondStaple]));
			expect(blockHashesOf(applied)).toEqual([first.hash.toString(), second.hash.toString()]);
			expect(await deferredWaitingOn(storage, first.hash)).toEqual([]);
			expect(await ledger.getBalance(user, network.baseToken)).toBe(388n);
			expect((await ledger.getHeadBlock(user, 'main'))?.hash.toString()).toBe(second.hash.toString());
			await expect(ledger.add(secondStaple)).rejects.toMatchObject({ code: 'LEDGER_BLOCK_ALREADY_EXISTS' });
			expect(await ledger.getBalance(user, network.baseToken)).toBe(388n);
		});

		test('deferred chains replay in order exactly once', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const blocks = await sendsAfter(network, headOf(network.genesis, user), [5n, 7n, 9n]);
			const staples = await Promise.all(blocks.map(function(block) {
				return(confirmedStaple([block], network.representatives));
			}));
			const [firstStaple, secondStaple, thirdStaple] = staples;
			if (firstStaple === undefined || secondStaple === undefined || thirdStaple === undefined) {
				throw(new Error('three staples expected'));
			}

			expect(await ledger.add(thirdStaple)).toEqual([]);
			expect(await ledger.add(secondStaple)).toEqual([]);
			const applied = await ledger.add(firstStaple);

			expect(blocksHashesOf(applied)).toEqual(blocksHashesOf([firstStaple, secondStaple, thirdStaple]));
			expect(blockHashesOf(applied)).toEqual(blocks.map(function(block): string {
				return(block.hash.toString());
			}));
			expect(await ledger.getBalance(user, network.baseToken)).toBe(379n);
			expect((await ledger.getHeadBlock(user, 'main'))?.hash.toString()).toBe(blocks.at(-1)?.hash.toString());
			for (const block of blocks) {
				expect(await deferredWaitingOn(storage, block.hash)).toEqual([]);
			}
		});

		test('a replayed staple that conflicts stays deferred while its trigger applies', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const [trigger, ...unused] = await sendsAfter(network, headOf(network.genesis, user), [1n]);
			if (trigger === undefined || unused.length > 0) {
				throw(new Error('one trigger block expected'));
			}
			const forks = await Promise.all([5n, 7n].map(async function(amount) {
				const [fork] = await sendsAfter(network, trigger.hash, [amount]);
				if (fork === undefined) {
					throw(new Error('one fork block expected'));
				}
				return({ amount, staple: await confirmedStaple([fork], network.representatives) });
			}));
			for (const { staple } of forks) {
				expect(await ledger.add(staple)).toEqual([]);
			}
			expect([...await deferredWaitingOn(storage, trigger.hash)].sort()).toEqual(blocksHashesOf(forks.map(function({ staple }) {
				return(staple);
			})).sort());

			const applied = await ledger.add(await confirmedStaple([trigger], network.representatives));

			expect(applied).toHaveLength(2);
			const [, replayed] = applied;
			const winner = forks.find(function({ staple }): boolean {
				return(staple.blocksHash.toString() === replayed?.blocksHash.toString());
			});
			const loser = forks.find(function(fork): boolean {
				return(fork !== winner);
			});
			if (winner === undefined || loser === undefined) {
				throw(new Error('exactly one fork should have replayed'));
			}
			expect(await deferredWaitingOn(storage, trigger.hash)).toEqual(blocksHashesOf([loser.staple]));
			expect(await ledger.getBalance(user, network.baseToken)).toBe(400n - 1n - winner.amount);
		});
	});
}
