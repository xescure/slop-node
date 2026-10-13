import { describe, expect, test } from 'vitest';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { confirmedStaple, sendBlock, setRepresentativeBlock } from '../../../testing/blocks.js';
import { advanceClock } from '../../../testing/network.js';
import type { TestNetwork } from '../../../testing/network.js';
import type { LedgerStorageDriverBase } from '../base.js';
import {
	DEFAULT_REPLAY_WINDOW_MILLISECONDS,
	DEFAULT_WEIGHTS,
	RecordingLog,
	TESTING_KEY,
	blockHashesOf,
	blocksHashesOf,
	checksumOf,
	failAfterPersisting,
	hashOf,
	headOf,
	ledgerChecksumOf,
	orphanedSideRowsOf,
	readStorage,
	requireAt,
	slowPersisting,
	useFixtures
} from './support.js';
import type { DriverUnderTest } from './types.js';

const lib = KeetaNet.lib;

const NEWCOMER_SEED = '5c2e8a7d4b1f9036e2d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6';

function sendOf(network: TestNetwork, user: number, previous: BlockHash, amount: bigint): Promise<Block> {
	const from = requireAt(network.users, user);
	const to = requireAt(network.users, (user + 1) % network.users.length);
	return(sendBlock({ from, previous, to, amount, token: network.baseToken, network: network.network }));
}

function sendFromGenesisOf(network: TestNetwork, user: number, amount: bigint): Promise<Block> {
	return(sendOf(network, user, headOf(network.genesis, requireAt(network.users, user)), amount));
}

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

/** Each block is built a second after the one before, so each staple of one block has a staple time of its own. */
async function sendsAfter(network: TestNetwork, previous: BlockHash, amounts: readonly bigint[]): Promise<Block[]> {
	const from = requireAt(network.users, 0);
	const to = requireAt(network.users, 1);
	const blocks: Block[] = [];
	let head = previous;
	for (const amount of amounts) {
		advanceClock(1000);
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
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { log });
			const from = requireAt(network.users, 0);
			const to = requireAt(network.users, 1);
			const idempotent = btoa('order-1');
			await ledger.add(network.genesis);
			advanceClock(1000);
			const keyed = await sendBlock({ from, previous: headOf(network.genesis, from), to, amount: 1n, token: network.baseToken, network: network.network, idempotent });
			advanceClock(1000);
			const trigger = await sendBlock({ from, previous: keyed.hash, to, amount: 2n, token: network.baseToken, network: network.network });
			advanceClock(1000);
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
			expect(log.errorsMentioning(reusedStaple).map(function(line): string {
				return(line.slice(0, line.indexOf('it stays deferred')));
			})).toEqual([`ledger replaying deferred staple ${reusedStaple.blocksHash.toString()} failed; `]);
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

		test('a replayed staple that fails after its write leaves nothing behind and stays deferred', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			const { node, storage } = await startNode(0);
			const blocks = await sendsAfter(network, headOf(network.genesis, user), [5n, 7n, 9n]);
			const [firstStaple, secondStaple, thirdStaple] = await Promise.all(blocks.map(function(block) {
				return(confirmedStaple([block], network.representatives));
			}));
			if (firstStaple === undefined || secondStaple === undefined || thirdStaple === undefined) {
				throw(new Error('three staples expected'));
			}
			const second = requireAt(blocks, 1);
			const third = requireAt(blocks, 2);
			expect(await node.ledger.add(thirdStaple)).toEqual([]);
			expect(await node.ledger.add(secondStaple)).toEqual([]);
			failAfterPersisting(storage, thirdStaple);

			// The third staple replays within the second's replay, and only the third's is undone.
			const applied = await node.ledger.add(firstStaple);

			expect(blocksHashesOf(applied)).toEqual(blocksHashesOf([firstStaple, secondStaple]));
			expect(await node.ledger.getBlock(third.hash, 'main')).toBeNull();
			expect((await node.ledger.getVoteStaples([thirdStaple.blocksHash], 'main')).get(thirdStaple.blocksHash)).toBeNull();
			expect(hashOf(await node.ledger.getHeadBlock(user, 'main'))).toBe(hashOf(second));
			expect(await node.ledger.getBalance(user, network.baseToken)).toBe(388n);
			expect(blocksHashesOf(await node.ledger.getHistory(user, null))).toEqual(blocksHashesOf([secondStaple, firstStaple, network.genesis]));
			expect(await deferredWaitingOn(storage, second.hash)).toEqual(blocksHashesOf([thirdStaple]));
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, firstStaple, secondStaple]));
		});

		test('a replayed staple that promotes a voted block and then fails keeps its side rows, and applies when it arrives again', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			const waiter = requireAt(network.users, 1);
			const idempotent = btoa('replayed-order');
			const { node, storage } = await startNode(0);
			const voted = await sendBlock({ from: user, previous: headOf(network.genesis, user), to: waiter, amount: 5n, token: network.baseToken, network: network.network, idempotent });
			await node.ledger.vote([voted]);
			// The staple holds our voted block beside one whose previous this node lacks, so it waits.
			const missing = await sendBlock({ from: waiter, previous: headOf(network.genesis, waiter), to: user, amount: 1n, token: network.baseToken, network: network.network });
			const waiting = await sendBlock({ from: waiter, previous: missing.hash, to: user, amount: 2n, token: network.baseToken, network: network.network });
			const stapleOfVoted = await confirmedStaple([voted, waiting], network.representatives);
			const missingStaple = await confirmedStaple([missing], network.representatives);
			expect(await node.ledger.add(stapleOfVoted)).toEqual([]);
			const restore = failAfterPersisting(storage, stapleOfVoted);

			expect(blocksHashesOf(await node.ledger.add(missingStaple))).toEqual(blocksHashesOf([missingStaple]));

			// The promotion of our block was undone with the replay.
			expect(await node.ledger.getBlock(voted.hash, 'main')).toBeNull();
			expect(hashOf(await node.ledger.getBlock(voted.hash, 'side'))).toBe(hashOf(voted));
			expect(hashOf(await node.ledger.getIdempotentBlockHash(user, idempotent, 'side'))).toBe(hashOf(voted));
			expect(await orphanedSideRowsOf(storage)).toBe(0);
			expect(await deferredWaitingOn(storage, missing.hash)).toEqual(blocksHashesOf([stapleOfVoted]));

			restore();
			expect(blocksHashesOf(await node.ledger.add(stapleOfVoted))).toEqual(blocksHashesOf([stapleOfVoted]));

			expect(hashOf(await node.ledger.getBlock(voted.hash, 'main'))).toBe(hashOf(voted));
			expect(await node.ledger.getBlock(voted.hash, 'side')).toBeNull();
			expect(await node.ledger.getIdempotentBlockHash(user, idempotent, 'side')).toBeNull();
			expect(await orphanedSideRowsOf(storage)).toBe(0);
			expect(await deferredWaitingOn(storage, missing.hash)).toEqual([]);
		});

		test('a staple released by replay promotes a block this node voted on and leaves no side rows', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			const waiter = requireAt(network.users, 1);
			const idempotent = btoa('released-order');
			const { node, storage } = await startNode(0);
			const voted = await sendBlock({ from: user, previous: headOf(network.genesis, user), to: waiter, amount: 5n, token: network.baseToken, network: network.network, idempotent });
			await node.ledger.vote([voted]);
			const missing = await sendBlock({ from: waiter, previous: headOf(network.genesis, waiter), to: user, amount: 1n, token: network.baseToken, network: network.network });
			const waiting = await sendBlock({ from: waiter, previous: missing.hash, to: user, amount: 2n, token: network.baseToken, network: network.network });
			const stapleOfVoted = await confirmedStaple([voted, waiting], network.representatives);
			const missingStaple = await confirmedStaple([missing], network.representatives);
			expect(await node.ledger.add(stapleOfVoted)).toEqual([]);
			expect(await orphanedSideRowsOf(storage)).toBe(0);

			expect(blocksHashesOf(await node.ledger.add(missingStaple))).toEqual(blocksHashesOf([missingStaple, stapleOfVoted]));

			expect(hashOf(await node.ledger.getBlock(voted.hash, 'main'))).toBe(hashOf(voted));
			expect(await node.ledger.getBlock(voted.hash, 'side')).toBeNull();
			expect(await node.ledger.getIdempotentBlockHash(user, idempotent, 'side')).toBeNull();
			expect(await orphanedSideRowsOf(storage)).toBe(0);
			expect(await deferredWaitingOn(storage, missing.hash)).toEqual([]);
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

		test('a waiter that an earlier waiter\'s replay applied is not replayed again', async function() {
			const log = new RecordingLog();
			const { network, ledger } = await startNetwork(DEFAULT_WEIGHTS, { log });
			await ledger.add(network.genesis);
			const [first, second] = await Promise.all([sendFromGenesisOf(network, 0, 1n), sendFromGenesisOf(network, 1, 1n)]);
			const trigger = await confirmedStaple([first, second], network.representatives);
			const onFirst = await sendOf(network, 0, first.hash, 2n);
			const earlier = await confirmedStaple([onFirst], network.representatives);
			// Released by the trigger and by the earlier waiter alike.
			const later = await confirmedStaple([await sendOf(network, 1, second.hash, 3n), await sendOf(network, 0, onFirst.hash, 4n)], network.representatives);
			expect(await ledger.add(later)).toEqual([]);
			expect(await ledger.add(earlier)).toEqual([]);

			expect(blocksHashesOf(await ledger.add(trigger))).toEqual(blocksHashesOf([trigger, earlier, later]));
			expect(log.errors).toEqual([]);
		});

		test('a deferred staple waits only on the previous blocks it lacks, and gc applies it once they arrive', async function() {
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0 });
			await ledger.add(network.genesis);
			const newcomer = lib.Account.fromSeed(NEWCOMER_SEED, 0);
			const missing = await sendFromGenesisOf(network, 0, 1n);
			const onMissing = await sendOf(network, 0, missing.hash, 2n);
			const present = headOf(network.genesis, requireAt(network.users, 1));
			const opening = await setRepresentativeBlock({ account: newcomer, representative: requireAt(network.representatives, 0), previous: null, network: network.network });
			// An opening block, a chain of two inside the staple, and a block whose previous is on main.
			const waiting = await confirmedStaple([opening, onMissing, await sendOf(network, 0, onMissing.hash, 3n), await sendOf(network, 1, present, 4n)], network.representatives);
			expect(await ledger.add(waiting)).toEqual([]);

			expect(await deferredWaitingOn(storage, missing.hash)).toEqual(blocksHashesOf([waiting]));
			for (const notAwaited of [opening.previous, onMissing.hash, present]) {
				expect(await deferredWaitingOn(storage, notAwaited)).toEqual([]);
			}

			// A zero window replays nothing as the missing block arrives.
			const missingStaple = await confirmedStaple([missing], network.representatives);
			expect(blocksHashesOf(await ledger.add(missingStaple))).toEqual(blocksHashesOf([missingStaple]));
			expect(await ledger.gc()).toBe(false);
			expect(hashOf(await ledger.getBlock(opening.hash, 'main'))).toBe(hashOf(opening));
			expect(await deferredWaitingOn(storage, missing.hash)).toEqual([]);
		});

		test('a replayed staple that still lacks a previous stays deferred as it was, and waits on less once added again', async function() {
			const { network, storage, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			const [firstMissing, secondMissing] = await Promise.all([sendFromGenesisOf(network, 0, 1n), sendFromGenesisOf(network, 1, 1n)]);
			const waiting = await confirmedStaple([await sendOf(network, 0, firstMissing.hash, 2n), await sendOf(network, 1, secondMissing.hash, 3n)], network.representatives);
			expect(await ledger.add(waiting)).toEqual([]);
			const firstStaple = await confirmedStaple([firstMissing], network.representatives);

			// Replay never defers again [Keeta TS] index.js:68758-68761.
			expect(blocksHashesOf(await ledger.add(firstStaple))).toEqual(blocksHashesOf([firstStaple]));
			expect(await deferredWaitingOn(storage, firstMissing.hash)).toEqual(blocksHashesOf([waiting]));
			expect(await deferredWaitingOn(storage, secondMissing.hash)).toEqual(blocksHashesOf([waiting]));

			expect(await ledger.add(waiting)).toEqual([]);
			expect(await deferredWaitingOn(storage, firstMissing.hash)).toEqual([]);
			expect(await deferredWaitingOn(storage, secondMissing.hash)).toEqual(blocksHashesOf([waiting]));
			const secondStaple = await confirmedStaple([secondMissing], network.representatives);
			expect(blocksHashesOf(await ledger.add(secondStaple))).toEqual(blocksHashesOf([secondStaple, waiting]));
		});

		test('replay stops once the default window is spent, and warns of each waiter it leaves', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { log });
			await ledger.add(network.genesis);
			const [first, second] = await Promise.all([sendFromGenesisOf(network, 0, 1n), sendFromGenesisOf(network, 1, 1n)]);
			const trigger = await confirmedStaple([first, second], network.representatives);
			const waiters = await Promise.all([sendOf(network, 0, first.hash, 2n), sendOf(network, 1, second.hash, 3n)].map(async function(block) {
				return(await confirmedStaple([await block], network.representatives));
			}));
			for (const waiter of waiters) {
				expect(await ledger.add(waiter)).toEqual([]);
			}
			// Whichever waiter replays first spends the whole window.
			slowPersisting(storage, waiters, DEFAULT_REPLAY_WINDOW_MILLISECONDS);

			const applied = await ledger.add(trigger);

			expect(applied).toHaveLength(2);
			const left = waiters.filter(function(waiter): boolean {
				return(!blocksHashesOf(applied).includes(waiter.blocksHash.toString()));
			});
			expect(left).toHaveLength(1);
			expect(left.map(function(waiter): string[] {
				return(log.warningsMentioning(waiter));
			})).toEqual([[`ledger deferred staple replay window elapsed; ${left[0]?.blocksHash.toString() ?? ''} stays deferred`]]);
		});

		test('lists the deferred staples that await a block the main ledger lacks, by their latest votes, with the blocks they lack, as of before a moment', async function() {
			// A zero window leaves a released staple deferred, as an exhausted window would.
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0 });
			await ledger.add(network.genesis);
			const blocks = await sendsAfter(network, headOf(network.genesis, requireAt(network.users, 0)), [5n, 7n, 9n]);
			const [first, second, third] = blocks;
			const [firstStaple, secondStaple, thirdStaple] = await Promise.all(blocks.map(function(block) {
				return(confirmedStaple([block], network.representatives));
			}));
			if (first === undefined || second === undefined || third === undefined || firstStaple === undefined || secondStaple === undefined || thirdStaple === undefined) {
				throw(new Error('three staples expected'));
			}
			const stranded = async function(before: Date, limit: number): Promise<[string, (string | null)[]][]> {
				return((await storage.listStrandedDeferredStaples(before, limit)).map(function({ staple, lacks }): [string, (string | null)[]] {
					return([staple.blocksHash.toString(), lacks.map(hashOf)]);
				}));
			};
			const latestVoteOf = function(staple: VoteStaple): Date {
				return(new Date(Math.max(...staple.votes.map(function(vote): number {
					return(vote.validityFrom.getTime());
				}))));
			};
			const later = new Date(latestVoteOf(thirdStaple).getTime() + 1);
			expect(await ledger.add(thirdStaple)).toEqual([]);
			expect(await ledger.add(secondStaple)).toEqual([]);

			expect(await stranded(later, 10)).toEqual([[secondStaple.blocksHash.toString(), [first.hash.toString()]], [thirdStaple.blocksHash.toString(), [second.hash.toString()]]]);
			expect(await stranded(later, 1)).toEqual([[secondStaple.blocksHash.toString(), [first.hash.toString()]]]);
			expect(await stranded(latestVoteOf(thirdStaple), 10)).toEqual([[secondStaple.blocksHash.toString(), [first.hash.toString()]]]);

			// The second is released, not stranded: what it awaits is on main, and gc applies it.
			expect(blocksHashesOf(await ledger.add(firstStaple))).toEqual(blocksHashesOf([firstStaple]));
			expect(await stranded(later, 10)).toEqual([[thirdStaple.blocksHash.toString(), [second.hash.toString()]]]);
			expect(await ledger.gc()).toBe(false);
			expect(await stranded(later, 10)).toEqual([]);
			expect(hashOf(await ledger.getBlock(third.hash, 'main'))).toBe(hashOf(third));
		});

		test('lists a stranded staple as of its votes, though the clock has since gone back past them', async function() {
			const { network, storage, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			const [missing, waiting] = await sendsAfter(network, headOf(network.genesis, requireAt(network.users, 0)), [5n, 7n]);
			if (missing === undefined || waiting === undefined) {
				throw(new Error('two blocks expected'));
			}
			const staple = await confirmedStaple([waiting], network.representatives);
			expect(await ledger.add(staple)).toEqual([]);
			const later = new Date(Date.now() + 1);
			// Further back than the minute by which upstream takes a vote to be from the future [Keeta TS] index.js:81525-81527, 81805.
			advanceClock(-10 * 60 * 1000);

			const listed = await storage.listStrandedDeferredStaples(later, 10);

			expect(listed.map(function({ staple: stranded, lacks }): [string, (string | null)[]] {
				return([stranded.blocksHash.toString(), lacks.map(hashOf)]);
			})).toEqual([[staple.blocksHash.toString(), [missing.hash.toString()]]]);
		});

		test('lists stranded staples of one latest vote by their blocks hashes, each with the blocks it lacks by their hashes, and from after a staple given', async function() {
			const { network, storage, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			// Made at one moment, so each staple's votes are made at one moment too.
			const missing = await Promise.all([0, 1, 2].map(function(user) {
				return(sendFromGenesisOf(network, user, 1n));
			}));
			const [first, second, third] = missing;
			if (first === undefined || second === undefined || third === undefined) {
				throw(new Error('three blocks expected'));
			}
			const lackingTwo = await confirmedStaple([await sendOf(network, 0, first.hash, 2n), await sendOf(network, 1, second.hash, 2n)], network.representatives);
			const lackingOne = await confirmedStaple([await sendOf(network, 2, third.hash, 2n)], network.representatives);
			expect(await ledger.add(lackingTwo)).toEqual([]);
			expect(await ledger.add(lackingOne)).toEqual([]);
			const later = new Date(Date.now() + 60_000);
			const byKey = [lackingTwo, lackingOne].sort(function(left, right): number {
				return(Number(left.blocksHash.toString() > right.blocksHash.toString()) - Number(left.blocksHash.toString() < right.blocksHash.toString()));
			});
			const lacked = new Map([[lackingTwo.blocksHash.toString(), [first, second]], [lackingOne.blocksHash.toString(), [third]]]);
			const listed = await storage.listStrandedDeferredStaples(later, 10);

			expect(listed.map(function({ staple, lacks, latestVote }): [string, (string | null)[], number] {
				return([staple.blocksHash.toString(), lacks.map(hashOf), latestVote.getTime()]);
			})).toEqual(byKey.map(function(staple): [string, (string | null)[], number] {
				return([staple.blocksHash.toString(), (lacked.get(staple.blocksHash.toString()) ?? []).map(hashOf).sort(), Math.max(...staple.votes.map(function(vote): number {
					return(vote.validityFrom.getTime());
				}))]);
			}));
			const [earliest] = listed;
			if (earliest === undefined) {
				throw(new Error('two stranded staples expected'));
			}
			expect((await storage.listStrandedDeferredStaples(later, 10, earliest)).map(function({ staple }): string {
				return(staple.blocksHash.toString());
			})).toEqual([byKey[1]?.blocksHash.toString()]);
		});
	});
}
