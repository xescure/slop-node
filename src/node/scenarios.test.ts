import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { RECEIVER, REPRESENTATIVE, stapleHashes, STORAGES_UNDER_TEST, SUPPLY, TRUSTED_SIGNER, useSDKNodes } from '../testing/sdk.js';
import type { ServingNode, StorageUnderTest, UserClient } from '../testing/sdk.js';
import type { Environment } from './config.js';

const lib = KeetaNet.lib;

/** Keys of the accounts the scenarios create besides the receiver, each from a fixed seed. */
const ISSUER = lib.Account.fromSeed('2e9a4c6f8b1d3e5f7a9c0b2d4f6e8a1c3b5d7f9e0a2c4b6d8f1e3a5c7b9d0f2e', 0);
const FEE_ACCOUNT = lib.Account.fromSeed('c81f3a5e7b9d0c2e4f6a8b1d3c5e7f9a0b2d4c6e8f1a3b5d7c9e0f2a4b6d8c1e', 0);

const FEE_PER_BLOCK = 5n;

/*
 * The network created by UserClient.initializeNetwork lets anyone create
 * storage accounts only [Keeta TS] index.js:79607; a development network
 * also lets anyone create tokens, which needs TOKEN_ADMIN_CREATE.
 */
const NETWORK_DEFAULT_PERMISSION = ['ACCESS', 'STORAGE_CREATE', 'TOKEN_ADMIN_CREATE'] as const;

function keyOf(account: { readonly publicKeyString: { get(): string } }): string {
	return(account.publicKeyString.get());
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

/** What every scenario starts from: a node, and its network initialized by the trusted key through the SDK. */
type Network = {
	readonly serving: ServingNode;
	/** Signs as the trusted key, which holds the whole supply after genesis. */
	readonly holder: UserClient;
	readonly genesis: VoteStaple;
};

describe.each(STORAGES_UNDER_TEST)('the official SDK against a node on %s', function(storage: StorageUnderTest) {
	const nodes = useSDKNodes();

	async function initializedNetwork(extra: Environment = {}): Promise<Network> {
		const serving = await nodes.start(await nodes.environmentFor(storage, extra));
		const holder = nodes.userClient(serving, TRUSTED_SIGNER);
		const initialized = await holder.initializeNetwork({
			addSupplyAmount: SUPPLY,
			baseNetworkInfo: { defaultPermission: new lib.Permissions([...NETWORK_DEFAULT_PERMISSION]) }
		});
		expect(initialized.publish).toBe(true);
		return({ serving, holder, genesis: initialized.voteStaple });
	}

	test('initializes the network, which delegates the supply to the node', async function() {
		const { serving, holder, genesis } = await initializedNetwork();
		expect(await holder.balance(holder.baseToken)).toBe(SUPPLY);
		expect((await holder.head())?.toString()).toBe(genesis.blocks.at(-1)?.hash.toString());

		const representatives = await holder.client.getAllRepresentativeInfo();
		expect(representatives.map(function({ representative, weight }) {
			return({ representative, weight });
		})).toEqual([{ representative: keyOf(REPRESENTATIVE), weight: SUPPLY }]);
		expect(await serving.node.ledger.getBalance(TRUSTED_SIGNER, holder.baseToken)).toBe(SUPPLY);
	});

	test('sends to a fresh account, which sees the balance, and both histories show it', async function() {
		const { serving, holder, genesis } = await initializedNetwork();
		const receiver = nodes.userClient(serving, RECEIVER);
		const sent = await holder.send(RECEIVER, 250n, holder.baseToken);
		expect(sent.publish).toBe(true);
		if (sent.from !== 'direct') {
			throw(new Error('the client published through a publish aid'));
		}

		expect(await holder.balance(holder.baseToken)).toBe(SUPPLY - 250n);
		expect(await receiver.balance(receiver.baseToken)).toBe(250n);

		const sentHash = sent.voteStaple.blocksHash.toString();
		expect(stapleHashes(await holder.history())).toEqual([sentHash, genesis.blocksHash.toString()]);
		expect(stapleHashes(await receiver.history())).toEqual([sentHash]);

		// The receiver's account has no block of its own: a send needs no receive.
		expect(await receiver.head()).toBeNull();
		expect((await holder.head())?.toString()).toBe(sent.voteStaple.blocks[0]?.hash.toString());
		const [vote] = sent.voteStaple.votes;
		expect(sent.voteStaple.votes).toHaveLength(1);
		expect(vote?.issuer.publicKeyString.get()).toBe(keyOf(REPRESENTATIVE));
	});

	test('creates a token with a supply and transfers it', async function() {
		const { serving } = await initializedNetwork();
		const issuer = nodes.userClient(serving, ISSUER);
		const receiver = nodes.userClient(serving, RECEIVER);

		const builder = issuer.initBuilder();
		const pending = builder.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN);
		await builder.computeBlocks();
		const token: TokenAddress = pending.account;
		builder.modifyTokenSupply(1_000n, { account: token });
		builder.setInfo({ name: 'SCENARIO', description: 'A token of the SDK scenarios', metadata: '', defaultPermission: new lib.Permissions(['ACCESS']) }, { account: token });
		const created = await issuer.publishBuilder(builder);
		expect(created.publish).toBe(true);
		expect(await issuer.client.getTokenSupply(token)).toBe(1_000n);
		expect(await issuer.client.getBalance(token, token)).toBe(1_000n);

		/*
		 * The supply is minted to the token account. The builder writes a
		 * block's sends before its supply change [Keeta TS] index.js:57723-57807,
		 * so sending the new supply on in the same block would overdraw the
		 * token account; the issuer sends it on from the token account next.
		 */
		await issuer.send(ISSUER, 1_000n, token, undefined, { account: token });
		expect(await issuer.balance(token)).toBe(1_000n);
		expect(await issuer.client.getBalance(token, token)).toBe(0n);

		await issuer.send(RECEIVER, 400n, token);
		expect(await issuer.balance(token)).toBe(600n);
		expect(await receiver.balance(token)).toBe(400n);
		const balances = await receiver.allBalances();
		expect(balances.map(function({ token: held, balance }) {
			return({ token: keyOf(held), balance });
		})).toEqual([{ token: keyOf(token), balance: 400n }]);
	});

	test('charges a flat fee per block to the fee account, paid by the SDK\'s fee block', async function() {
		const { holder, serving } = await initializedNetwork({
			KEETANET_LOCAL_NODE_FEE_SCHEDULE: `flat:${String(FEE_PER_BLOCK)}`,
			KEETANET_LOCAL_NODE_FEE_ACCOUNTS: keyOf(FEE_ACCOUNT)
		});
		const feeAccount = nodes.userClient(serving, FEE_ACCOUNT);

		// One block is voted on, so the fee is one block's.
		const sent = await holder.send(RECEIVER, 100n, holder.baseToken);
		if (sent.from !== 'direct') {
			throw(new Error('the client published through a publish aid'));
		}
		expect(sent.voteStaple.blocks).toHaveLength(2);
		expect(await holder.balance(holder.baseToken)).toBe(SUPPLY - 100n - FEE_PER_BLOCK);
		expect(await feeAccount.balance(holder.baseToken)).toBe(FEE_PER_BLOCK);
		expect(await holder.client.getBalance(RECEIVER, holder.baseToken)).toBe(100n);
		expect(await holder.client.getBalance(REPRESENTATIVE, holder.baseToken)).toBe(0n);

		// Creating a token with a supply takes a block of the holder and one of the token: twice the fee.
		const builder = holder.initBuilder();
		const pending = builder.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN);
		await builder.computeBlocks();
		builder.modifyTokenSupply(10n, { account: pending.account });
		const created = await holder.publishBuilder(builder);
		if (created.from !== 'direct') {
			throw(new Error('the client published through a publish aid'));
		}
		expect(created.voteStaple.blocks).toHaveLength(3);
		expect(await feeAccount.balance(holder.baseToken)).toBe(3n * FEE_PER_BLOCK);
		expect(await holder.balance(holder.baseToken)).toBe(SUPPLY - 100n - 3n * FEE_PER_BLOCK);
	});

	test('surfaces the upstream code of a refused transaction', async function() {
		const { holder } = await initializedNetwork();
		const head = (await holder.head())?.toString();

		const refusal = await refusalOf(holder.send(RECEIVER, SUPPLY + 1n, holder.baseToken));
		// [Keeta TS] index.js:70088 refuses a balance that would become negative.
		expect(lib.Error.isInstance(refusal)).toBe(true);
		expect(refusal).toMatchObject({ code: 'LEDGER_INVALID_BALANCE', type: 'LEDGER' });

		expect(await holder.balance(holder.baseToken)).toBe(SUPPLY);
		expect((await holder.head())?.toString()).toBe(head);
		expect(await holder.client.getBalance(RECEIVER, holder.baseToken)).toBe(0n);
	});
});

