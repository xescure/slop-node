import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { API_LINE, PROCESS_TIMEOUT_MILLISECONDS, startCLI } from '../testing/cli.js';
import { endpointOf, NODE_ENVIRONMENT, REPRESENTATIVE, TRUSTED_SIGNER, useSDKNodes } from '../testing/sdk.js';
import type { UserClient } from '../testing/sdk.js';
import type { Environment } from './config.js';

const lib = KeetaNet.lib;

const SUPPLY = 1_000_000n;

const RECEIVER = lib.Account.fromSeed('7d3c1e5a9b2f4068a1c3e5f7092b4d6f8a0c2e4f6081a3c5e7f9b1d3f5a7c9e1', 0);

/** What the ledger shows through the API, from both ends of the transfers. */
type LedgerView = {
	readonly holderBalance: bigint;
	readonly receiverBalance: bigint;
	readonly holderHistory: readonly string[];
	readonly receiverHistory: readonly string[];
	readonly holderHead: string | null;
	readonly holderChain: readonly string[];
	readonly representativeWeight: bigint;
};

function stapleHashes(entries: readonly { readonly voteStaple: VoteStaple }[]): string[] {
	return(entries.map(function({ voteStaple }): string {
		return(voteStaple.blocksHash.toString());
	}));
}

/** The serials of the representative's votes in the staples, as the API returned them. */
function representativeSerials(staples: readonly VoteStaple[]): bigint[] {
	return(staples.flatMap(function(staple): bigint[] {
		return(staple.votes.filter(function(vote): boolean {
			return(vote.issuer.comparePublicKey(REPRESENTATIVE));
		}).map(function(vote): bigint {
			return(vote.serial);
		}));
	}));
}

async function viewOf(holder: UserClient): Promise<LedgerView> {
	const [representative] = await holder.client.getAllRepresentativeInfo();
	return({
		holderBalance: await holder.balance(holder.baseToken),
		receiverBalance: await holder.client.getBalance(RECEIVER, holder.baseToken),
		holderHistory: stapleHashes(await holder.history()),
		receiverHistory: stapleHashes(await holder.client.getHistory(RECEIVER)),
		holderHead: (await holder.head())?.toString() ?? null,
		holderChain: (await holder.chain()).map(function(block): string {
			return(block.hash.toString());
		}),
		representativeWeight: representative?.weight ?? 0n
	});
}

/** Every serial the representative's votes in the holder's history carry, read back from the API. */
async function serialsInHistory(holder: UserClient): Promise<bigint[]> {
	return(representativeSerials((await holder.history()).map(function({ voteStaple }): VoteStaple {
		return(voteStaple);
	})));
}

async function transact(holder: UserClient): Promise<void> {
	const initialized = await holder.initializeNetwork({ addSupplyAmount: SUPPLY });
	expect(initialized.publish).toBe(true);
	await holder.send(RECEIVER, 100n, holder.baseToken);
	await holder.send(RECEIVER, 50n, holder.baseToken);
}

const EXPECTED_BEFORE = { holderBalance: SUPPLY - 150n, receiverBalance: 150n, representativeWeight: SUPPLY - 150n } as const;

/** The serials of the votes the representative issued for the new send, read back from the API. */
async function serialsOfNewSend(holder: UserClient): Promise<bigint[]> {
	const sent = await holder.send(RECEIVER, 25n, holder.baseToken);
	if (sent.from !== 'direct') {
		throw(new Error('the client published through a publish aid'));
	}
	const block = sent.voteStaple.blocks[0];
	if (block === undefined) {
		throw(new Error('the send published no block'));
	}
	const staple = await holder.client.getVoteStaple(block.hash);
	if (staple === null) {
		throw(new Error('the node does not hold the staple it voted for'));
	}
	expect(await holder.balance(holder.baseToken)).toBe(SUPPLY - 175n);
	return(representativeSerials([staple]));
}

function maximum(values: readonly bigint[]): bigint {
	return(values.reduce(function(largest, value): bigint {
		if (value > largest) {
			return(value);
		}
		return(largest);
	}));
}

/** Serials of the second run all exceed every serial of the first. */
function expectSerialsContinue(before: readonly bigint[], after: readonly bigint[]): void {
	expect(before.length).toBeGreaterThan(0);
	expect(after.length).toBeGreaterThan(0);
	const latestBefore = maximum(before);
	for (const serial of after) {
		expect(serial).toBeGreaterThan(latestBefore);
	}
}

describe('a node restarted on the same Postgres database', { timeout: PROCESS_TIMEOUT_MILLISECONDS }, function() {
	const nodes = useSDKNodes();

	test('keeps the balances, history and heads, and votes with serials above those it issued before', async function() {
		const environment = await nodes.environmentFor('postgres');
		const first = await nodes.start(environment);
		const holderBefore = nodes.userClient(first, TRUSTED_SIGNER);
		await transact(holderBefore);
		const before = await viewOf(holderBefore);
		expect(before).toMatchObject(EXPECTED_BEFORE);
		expect(before.holderHistory).toHaveLength(3);
		expect(before.receiverHistory).toHaveLength(2);
		const serialsBefore = await serialsInHistory(holderBefore);
		await first.stop();

		const second = await nodes.start(environment);
		expect(second.node).not.toBe(first.node);
		const holderAfter = nodes.userClient(second, TRUSTED_SIGNER);
		expect(await viewOf(holderAfter)).toEqual(before);
		expect(await serialsInHistory(holderAfter)).toEqual(serialsBefore);

		expectSerialsContinue(serialsBefore, await serialsOfNewSend(holderAfter));
	});

	test('through the built command, stopped by SIGTERM between runs', async function() {
		const database = await nodes.database();
		const environment: Environment = { ...NODE_ENVIRONMENT, KEETANET_LOCAL_NODE_POSTGRES_URL: database.connectionString };

		const first = startCLI(['run'], environment);
		const [, firstAPI = ''] = await first.printed(API_LINE);
		const holderBefore = nodes.userClient(endpointOf(firstAPI, REPRESENTATIVE), TRUSTED_SIGNER);
		await transact(holderBefore);
		const before = await viewOf(holderBefore);
		expect(before).toMatchObject(EXPECTED_BEFORE);
		const serialsBefore = await serialsInHistory(holderBefore);
		first.signal('SIGTERM');
		expect(await first.exited).toEqual({ code: 0, signal: null });

		const second = startCLI(['run'], environment);
		const [, secondAPI = ''] = await second.printed(API_LINE);
		const holderAfter = nodes.userClient(endpointOf(secondAPI, REPRESENTATIVE), TRUSTED_SIGNER);
		expect(await viewOf(holderAfter)).toEqual(before);
		expectSerialsContinue(serialsBefore, await serialsOfNewSend(holderAfter));
		second.signal('SIGTERM');
		expect(await second.exited).toEqual({ code: 0, signal: null });
	});
});
