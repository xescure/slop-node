import { describe, expect } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { FAUCET, FEES, feeRecipientOf, perRepresentative, publishedStaple, REPRESENTATIVE_INDEXES, representativeOf, settledPerRepresentative, userOf } from './genesis.js';
import type { PerRepresentative, RepresentativeIndex, UserClient } from './genesis.js';
import type { Devnet } from './harness.js';
import { expectConvergedDumps, useDevnet } from './use-devnet.js';
import type { Timeout } from './use-devnet.js';

const lib = KeetaNet.lib;

/*
 * A scenario publishes a few staples, each settled on every node, and reads
 * four dumps; one took about a second, and a loaded machine may take many
 * times as long.
 */
const SCENARIO: Timeout = { milliseconds: 60_000, reason: 'a few staples, each awaited on four nodes, and four dumps' };

const devnet = useDevnet();

function keyOf(account: { readonly publicKeyString: { get(): string } }): string {
	return(account.publicKeyString.get());
}

/** What every voting representative charges for one block, the fee block aside. */
function feePerBlock(voters: readonly RepresentativeIndex[]): bigint {
	return(voters.reduce(function(sum, index): bigint {
		return(sum + FEES[index].amountPerBlock);
	}, 0n));
}

const EVERY_FEE_PER_BLOCK = feePerBlock(REPRESENTATIVE_INDEXES);

function votersOf(staple: VoteStaple): string[] {
	return(staple.votes.map(function(vote): string {
		return(keyOf(vote.issuer));
	}).sort());
}

function keysOf(indexes: readonly RepresentativeIndex[]): string[] {
	return(indexes.map(function(index): string {
		return(keyOf(representativeOf(index)));
	}).sort());
}

/** The blocks hashes of the staples a history lists, newest first as the API answers. */
function historyOf(entries: readonly { readonly voteStaple: VoteStaple }[]): string[] {
	return(entries.map(function({ voteStaple }): string {
		return(voteStaple.blocksHash.toString());
	}));
}

/** Publishes with the client's own representatives, and waits until every running node holds the staple. */
async function settledPublish(network: Devnet, published: Promise<Awaited<ReturnType<UserClient['publishBuilder']>>>): Promise<VoteStaple> {
	const staple = publishedStaple(await published);
	await network.settled(staple);
	return(staple);
}

async function fund(network: Devnet, account: Account, amount: bigint): Promise<VoteStaple> {
	const faucet = network.client(FAUCET);
	return(await settledPublish(network, faucet.send(account, amount, faucet.baseToken)));
}

function feeBalances(client: UserClient): Promise<PerRepresentative<bigint>> {
	return(settledPerRepresentative(perRepresentative(function(index): Promise<bigint> {
		return(client.client.getBalance(feeRecipientOf(index), client.baseToken));
	})));
}

function credited(before: PerRepresentative<bigint>, after: PerRepresentative<bigint>): PerRepresentative<bigint> {
	return(perRepresentative(function(index): bigint {
		return(after[index] - before[index]);
	}));
}

/** What each representative is owed for voting on the blocks, the fee block aside. */
function feesFor(blocks: bigint): PerRepresentative<bigint> {
	return(perRepresentative(function(index): bigint {
		return(FEES[index].amountPerBlock * blocks);
	}));
}

/** The error a promise is rejected with. */
async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error: unknown) {
		return(error);
	}
	throw(new Error('the request was not refused'));
}

describe('a devnet of four representative processes under the official SDK', function() {
	devnet.test('confirms a staple with the votes of any three representatives', SCENARIO, async function(network) {
		const payer = userOf(30);
		await fund(network, payer, 10_000n);
		let spent = 0n;
		for (const absent of REPRESENTATIVE_INDEXES) {
			const voters = REPRESENTATIVE_INDEXES.filter(function(index): boolean {
				return(index !== absent);
			});
			const client = network.client(payer, voters);
			const staple = await settledPublish(network, client.send(userOf(31), 10n, client.baseToken));
			expect(votersOf(staple)).toEqual(keysOf(voters));
			spent += 10n + feePerBlock(voters);
			expect(await client.balance(client.baseToken)).toBe(10_000n - spent);
		}
		await expectConvergedDumps(network);
	});

	devnet.test('confirms nothing with the votes of two representatives', SCENARIO, async function(network) {
		const payer = userOf(40);
		await fund(network, payer, 10_000n);
		const client = network.client(payer, [0, 1]);
		const refusal = await refusalOf(client.send(userOf(41), 10n, client.baseToken));
		expect(lib.Error.isInstance(refusal)).toBe(true);
		expect(refusal).toMatchObject({ code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT' });
		const everyone = network.client(null);
		expect(await everyone.client.getBalance(payer, everyone.baseToken)).toBe(10_000n);
		expect(await everyone.client.getBalance(userOf(41), everyone.baseToken)).toBe(0n);
		await expectConvergedDumps(network);
	});

	devnet.test('basic: sends, the receiver spends what it received, and the histories show both', SCENARIO, async function(network) {
		const [sender, receiver, third] = [userOf(1), userOf(2), userOf(3)];
		const sending = network.client(sender);
		const receiving = network.client(receiver);
		const base = sending.baseToken;
		const funding = await fund(network, sender, 10_000n);
		expect(await sending.balance(base)).toBe(10_000n);

		const sent = await settledPublish(network, sending.send(receiver, 4_000n, base));
		expect(votersOf(sent)).toEqual(keysOf(REPRESENTATIVE_INDEXES));
		expect(await sending.balance(base)).toBe(10_000n - 4_000n - EVERY_FEE_PER_BLOCK);
		expect(await receiving.balance(base)).toBe(4_000n);
		// A send needs no receive: the receiver's chain is still empty.
		expect(await receiving.head()).toBeNull();

		const spent = await settledPublish(network, receiving.send(third, 1_500n, base));
		expect(await receiving.balance(base)).toBe(4_000n - 1_500n - EVERY_FEE_PER_BLOCK);
		expect(await receiving.client.getBalance(third, base)).toBe(1_500n);
		// The receiver's chain opens with its send, followed by the block that pays the fees.
		expect(spent.blocks.map(function(block): string {
			return(keyOf(block.account));
		})).toEqual([keyOf(receiver), keyOf(receiver)]);
		expect((await receiving.head())?.toString()).toBe(spent.blocks[1]?.hash.toString());

		expect(historyOf(await sending.history())).toEqual([sent.blocksHash.toString(), funding.blocksHash.toString()]);
		expect(historyOf(await receiving.history())).toEqual([spent.blocksHash.toString(), sent.blocksHash.toString()]);
		await expectConvergedDumps(network);
	});

	devnet.test('single fee: one transaction pays every voting representative its fee', SCENARIO, async function(network) {
		const payer = userOf(10);
		const client = network.client(payer);
		await fund(network, payer, 10_000n);
		const before = await feeBalances(client);

		const sent = await settledPublish(network, client.send(userOf(11), 100n, client.baseToken));
		// The send and the block that pays the fees.
		expect(sent.blocks).toHaveLength(2);
		expect(credited(before, await feeBalances(client))).toEqual(feesFor(1n));
		expect(await client.balance(client.baseToken)).toBe(10_000n - 100n - EVERY_FEE_PER_BLOCK);
		await expectConvergedDumps(network);
	});

	devnet.test('multiple fees: every representative\'s own fee reaches its own account, block by block', SCENARIO, async function(network) {
		const issuer = userOf(20);
		const client = network.client(issuer);
		await fund(network, issuer, 10_000n);
		const before = await feeBalances(client);

		const builder = client.initBuilder();
		const pending = builder.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN);
		await builder.computeBlocks();
		const token: TokenAddress = pending.account;
		builder.modifyTokenSupply(1_000n, { account: token });
		const created = await settledPublish(network, client.publishBuilder(builder));
		// The issuer's block, the token's, and the block that pays the fees for both.
		expect(created.blocks).toHaveLength(3);
		expect(credited(before, await feeBalances(client))).toEqual(feesFor(2n));

		await settledPublish(network, client.send(issuer, 1_000n, token, undefined, { account: token }));
		expect(credited(before, await feeBalances(client))).toEqual(feesFor(3n));
		expect(await client.balance(token)).toBe(1_000n);
		expect(await client.balance(client.baseToken)).toBe(10_000n - (3n * EVERY_FEE_PER_BLOCK));
		await expectConvergedDumps(network);
	});
});
