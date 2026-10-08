import { describe, expect } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, MultisigAddress, StorageAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { BlockJSONOperationSEND } from '@keetanetwork/keetanet-client/lib/block/operations.js';
import type { ACLRow } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { replayOrder } from '../conformance/mainnet/replay.js';
import { explainRefusal } from '../conformance/mainnet/shadow.js';
import type { NetworkAnchors } from '../conformance/mainnet/shadow.js';
import { multisigSendBlock, sendBlock } from '../testing/blocks.js';
import { assertNever } from '../util/assert-never.js';
import { FAUCET, FEES, feeRecipientOf, perRepresentative, publishedStaple, REPRESENTATIVE_INDEXES, representativeOf, settledPerRepresentative, TRUSTED_ACCOUNT, userOf } from './genesis.js';
import type { PerRepresentative, RepresentativeIndex, UserClient } from './genesis.js';
import type { Devnet } from './harness.js';
import { shadowReplay } from './shadow.js';
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

/** The ledger's message for a refusal, which the client passes on with the ledger's code. */
async function refusedWith(promise: Promise<unknown>, code: string): Promise<string> {
	const refusal = await refusalOf(promise);
	if (!lib.Error.isInstance(refusal)) {
		throw(new Error(`refused without a coded error: ${String(refusal)}`, { cause: refusal }));
	}
	expect({ code: refusal.code, message: refusal.message }).toEqual({ code, message: refusal.message });
	return(refusal.message);
}

/*
 * The message a ledger refuses a requirement with: the principal, the
 * entity and target, and the flags needed, which always include ACCESS.
 * [Keeta TS] index.js:69873-69879
 */
function lacking(principal: GenericAccount, entity: GenericAccount, target: GenericAccount, flag: string): string {
	return(`${keyOf(principal)} does not have required permissions to perform action on ${keyOf(entity)}/${keyOf(target)} -- needs [${flag}, ACCESS]/[]`);
}

function balanceOf(client: UserClient, account: GenericAccount, token: TokenAddress = client.baseToken): Promise<bigint> {
	return(client.client.getBalance(account, token));
}

/**
 * An entity's account rows as "principal target flags", sorted. A row
 * granted without a target names the entity as its target, and every
 * grant's flags include ACCESS.
 */
async function aclsOf(client: UserClient, entity: GenericAccount): Promise<string[]> {
	const rows: ACLRow[] = await client.client.listACLsByEntity(entity);
	return(rows.flatMap(function(row): string[] {
		if (row.principalType !== 'ACCOUNT') {
			return([]);
		}
		return([`${keyOf(row.principal)} ${keyOf(row.target)} ${row.permissions.base.flags.join(',')}`]);
	}).sort());
}

function permissions(flags: ConstructorParameters<typeof lib.Permissions>[0]): InstanceType<typeof lib.Permissions> {
	return(new lib.Permissions(flags));
}

/** The fee block the client computes for a staple, as a client's default does [Keeta TS] index.js:60433-60437. */
function feeBlockOf(client: UserClient): (staple: VoteStaple) => Promise<Block> {
	return(function(staple: VoteStaple): Promise<Block> {
		return(client.initBuilder().computeFeeBlock(staple));
	});
}

/** What classifying a refusal by the rules of an older version reads of the network. */
function anchorsOf(client: UserClient): NetworkAnchors {
	return({ initialTrustedAccount: TRUSTED_ACCOUNT, ...lib.Account.generateBaseAddresses(client.network) });
}

/** Sends base tokens with the fee block given; the client's send takes its own [Keeta TS] index.js:60637-60642. */
function sendPayingFees(client: UserClient, to: GenericAccount, amount: bigint, generateFeeBlock: (staple: VoteStaple) => Promise<Block>): ReturnType<UserClient['publishBuilder']> {
	const builder = client.initBuilder();
	builder.send(to, amount, client.baseToken);
	return(client.publishBuilder(builder, { generateFeeBlock }));
}

/** A fee block of the payer, after the staple's last block, paying each representative named the amount given. */
function feeBlockPaying(client: UserClient, payer: Account, fees: readonly { readonly index: RepresentativeIndex; readonly amount: bigint }[]): (staple: VoteStaple) => Promise<Block> {
	return(async function(staple: VoteStaple): Promise<Block> {
		const last = staple.blocks.at(-1);
		if (last === undefined) {
			throw(new Error('the staple has no blocks'));
		}
		const operations: BlockJSONOperationSEND[] = fees.map(function({ index, amount }): BlockJSONOperationSEND {
			return({ type: lib.Block.OperationType.SEND, to: feeRecipientOf(index), amount, token: client.baseToken });
		});
		return(await new lib.Block.Builder({
			version: 2,
			purpose: lib.Block.Purpose.FEE,
			network: client.network,
			account: payer,
			previous: last.hash,
			operations
		}).seal());
	});
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

	devnet.test('builder storage: creates a storage account, deposits, and grants deposits to another account only', SCENARIO, async function(network) {
		const [owner, depositor, stranger] = [userOf(50), userOf(51), userOf(52)];
		const owning = network.client(owner);
		const base = owning.baseToken;
		await fund(network, owner, 10_000n);
		await fund(network, depositor, 10_000n);
		await fund(network, stranger, 10_000n);

		const builder = owning.initBuilder();
		const pending = builder.generateIdentifier(lib.Account.AccountKeyAlgorithm.STORAGE);
		await builder.computeBlocks();
		const storage: StorageAddress = pending.account;
		builder.updatePermissions(base, permissions(['STORAGE_CAN_HOLD']), undefined, lib.Block.AdjustMethod.ADD, { account: storage });
		builder.updatePermissions(depositor, permissions(['STORAGE_DEPOSIT']), base, lib.Block.AdjustMethod.ADD, { account: storage });
		builder.send(storage, 1_000n, base);
		await settledPublish(network, owning.publishBuilder(builder));
		expect(await balanceOf(owning, storage)).toBe(1_000n);
		// Creating an identifier makes its creator its owner [Keeta TS] index.js:68323-68330.
		expect(await aclsOf(owning, storage)).toEqual([
			`${keyOf(base)} ${keyOf(storage)} ACCESS,STORAGE_CAN_HOLD`,
			`${keyOf(depositor)} ${keyOf(base)} ACCESS,STORAGE_DEPOSIT`,
			`${keyOf(owner)} ${keyOf(storage)} OWNER,ACCESS`
		].sort());

		const depositing = network.client(depositor);
		await settledPublish(network, depositing.send(storage, 500n, base));
		expect(await balanceOf(owning, storage)).toBe(1_500n);

		// A deposit needs the depositor's own grant on the storage account [Keeta TS] index.js:68481-68487.
		const strangers = network.client(stranger);
		expect(await refusedWith(strangers.send(storage, 500n, base), 'LEDGER_INVALID_PERMISSIONS')).toBe(lacking(stranger, storage, base, 'STORAGE_DEPOSIT'));

		// The owner withdraws on the storage account's behalf.
		await settledPublish(network, owning.send(owner, 200n, base, undefined, { account: storage }));
		expect(await balanceOf(owning, storage)).toBe(1_300n);
		expect(await balanceOf(owning, stranger)).toBe(10_000n);
		await expectConvergedDumps(network);
	});

	devnet.test('token self-send storage scoping: a token sends itself to storage only with every grant, the deposit scoped to that token', SCENARIO, async function(network) {
		const issuer = userOf(60);
		const issuing = network.client(issuer);
		const base = issuing.baseToken;
		await fund(network, issuer, 10_000n);

		const builder = issuing.initBuilder();
		const pendingToken = builder.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN);
		const pendingStorage = builder.generateIdentifier(lib.Account.AccountKeyAlgorithm.STORAGE);
		await builder.computeBlocks();
		const token: TokenAddress = pendingToken.account;
		const storage: StorageAddress = pendingStorage.account;
		builder.modifyTokenSupply(1_000n, { account: token });
		await settledPublish(network, issuing.publishBuilder(builder));
		expect(await balanceOf(issuing, token, token)).toBe(1_000n);

		function selfSend(): ReturnType<UserClient['send']> {
			return(issuing.send(storage, 100n, token, undefined, { account: token }));
		}

		/*
		 * The token's requirement on itself comes first among the send's and
		 * is skipped, but the ones after it still hold, where 0.18.4 stopped
		 * reading them: the storage account must let the token be held, and
		 * the token deposit into it.
		 * [Keeta TS] index.js:68461-68492, 68646-68648
		 */
		const unscoped = issuing.initBuilder();
		unscoped.send(storage, 100n, token, undefined, { account: token });
		const message = await refusedWith(issuing.publishBuilder(unscoped), 'LEDGER_INVALID_PERMISSIONS');
		expect(message).toBe(`${keyOf(token)} does not have required permissions to perform action on ${keyOf(storage)}/undefined -- needs [STORAGE_CAN_HOLD, ACCESS]/[]`);
		expect(explainRefusal({ blocks: unscoped.blocks, votes: [] }, { code: 'LEDGER_INVALID_PERMISSIONS', message }, anchorsOf(issuing)).reason).toBe('self-requirement-return');

		const grants = issuing.initBuilder();
		grants.updatePermissions(storage, permissions(['ACCESS']), undefined, lib.Block.AdjustMethod.ADD, { account: token });
		grants.updatePermissions(token, permissions(['STORAGE_CAN_HOLD']), undefined, lib.Block.AdjustMethod.ADD, { account: storage });
		grants.updatePermissions(token, permissions(['STORAGE_DEPOSIT']), base, lib.Block.AdjustMethod.ADD, { account: storage });
		await settledPublish(network, issuing.publishBuilder(grants));
		// A deposit granted for another token does not cover this one.
		expect(await refusedWith(selfSend(), 'LEDGER_INVALID_PERMISSIONS')).toBe(lacking(token, storage, token, 'STORAGE_DEPOSIT'));
		expect(await balanceOf(issuing, storage, token)).toBe(0n);

		await settledPublish(network, issuing.updatePermissions(token, permissions(['STORAGE_DEPOSIT']), token, lib.Block.AdjustMethod.ADD, { account: storage }));
		await settledPublish(network, selfSend());
		expect(await balanceOf(issuing, storage, token)).toBe(100n);
		expect(await balanceOf(issuing, token, token)).toBe(900n);
		await expectConvergedDumps(network);
	});

	devnet.test('send/drain authorization: SEND_ON_BEHALF lets an account spend a storage account\'s funds, and nobody drains it without', SCENARIO, async function(network) {
		const [owner, spender, drainer, recipient] = [userOf(70), userOf(71), userOf(72), userOf(73)];
		const owning = network.client(owner);
		const base = owning.baseToken;
		await fund(network, owner, 10_000n);
		await fund(network, spender, 1_000n);
		await fund(network, drainer, 1_000n);

		const builder = owning.initBuilder();
		const pending = builder.generateIdentifier(lib.Account.AccountKeyAlgorithm.STORAGE);
		await builder.computeBlocks();
		const vault: StorageAddress = pending.account;
		builder.updatePermissions(base, permissions(['STORAGE_CAN_HOLD']), undefined, lib.Block.AdjustMethod.ADD, { account: vault });
		builder.updatePermissions(spender, permissions(['SEND_ON_BEHALF']), base, lib.Block.AdjustMethod.ADD, { account: vault });
		builder.send(vault, 3_000n, base);
		await settledPublish(network, owning.publishBuilder(builder));

		// The signer pays the fees from its own account, as the client builds the fee block for it.
		const spending = network.client(spender);
		await settledPublish(network, spending.send(recipient, 1_000n, base, undefined, { account: vault }));
		expect(await balanceOf(owning, vault)).toBe(2_000n);
		expect(await balanceOf(owning, recipient)).toBe(1_000n);
		expect(await balanceOf(owning, spender)).toBe(1_000n - EVERY_FEE_PER_BLOCK);

		// A signer other than the account needs SEND_ON_BEHALF on it for the token [Keeta TS] index.js:68493-68498.
		const draining = network.client(drainer);
		expect(await refusedWith(draining.send(drainer, 2_000n, base, undefined, { account: vault }), 'LEDGER_INVALID_PERMISSIONS')).toBe(lacking(drainer, vault, base, 'SEND_ON_BEHALF'));

		// Once the grant is taken back, the spender cannot drain it either.
		await settledPublish(network, owning.updatePermissions(spender, permissions(['SEND_ON_BEHALF']), base, lib.Block.AdjustMethod.SUBTRACT, { account: vault }));
		expect(await refusedWith(spending.send(spender, 2_000n, base, undefined, { account: vault }), 'LEDGER_INVALID_PERMISSIONS')).toBe(lacking(spender, vault, base, 'SEND_ON_BEHALF'));
		expect(await balanceOf(owning, vault)).toBe(2_000n);
		expect(await balanceOf(owning, drainer)).toBe(1_000n);
		await expectConvergedDumps(network);
	});

	devnet.test('multisig: a quorum of its signers spends for an account that granted it, and fewer are refused', SCENARIO, async function(network) {
		const [first, second, third, creator, account, recipient] = [userOf(80), userOf(81), userOf(82), userOf(83), userOf(84), userOf(85)];
		const creating = network.client(creator);
		const base = creating.baseToken;
		await fund(network, creator, 1_000n);
		await fund(network, account, 5_000n);
		await fund(network, first, 1_000n);

		const builder = creating.initBuilder();
		const pending = builder.generateIdentifier({ type: lib.Account.AccountKeyAlgorithm.MULTISIG, signers: [first, second, third], quorum: 2n });
		await settledPublish(network, creating.publishBuilder(builder));
		const multisig: MultisigAddress = pending.account;
		const state = await creating.client.getAccountInfo(multisig);
		expect(state.info).toMatchObject({ multisigQuorum: 2n });
		// Each signer holds MULTISIG_SIGNER on the multisig [Keeta TS] index.js:68311-68319.
		expect(await aclsOf(creating, multisig)).toEqual([first, second, third].map(function(signer): string {
			return(`${keyOf(signer)} ${keyOf(multisig)} ACCESS,MULTISIG_SIGNER`);
		}).sort());

		const owning = network.client(account);
		await settledPublish(network, owning.updatePermissions(multisig, permissions(['SEND_ON_BEHALF']), undefined, lib.Block.AdjustMethod.ADD));
		const granted = 5_000n - EVERY_FEE_PER_BLOCK;

		/*
		 * The client's builder signs with one account, so a block signed by a
		 * multisig is built with the library's block builder and published by
		 * a signer's client, which adds its own fee block.
		 */
		async function spendSignedBy(signers: readonly Account[]): Promise<Block> {
			return(await multisigSendBlock({
				from: account,
				signer: [multisig, [...signers]],
				to: recipient,
				amount: 1_000n,
				token: base,
				previous: await owning.head(),
				network: owning.network
			}));
		}
		const signing = network.client(first);

		// The ledger counts the multisig's signers on the block against its quorum [Keeta TS] index.js:69926-69933.
		expect(await refusedWith(signing.transmit([await spendSignedBy([first])]), 'LEDGER_INVALID_PERMISSIONS')).toBe(`Quorum of 2 not reached for ${keyOf(multisig)} -- got 1`);
		expect(await balanceOf(owning, account)).toBe(granted);

		const spent = await settledPublish(network, signing.transmit([await spendSignedBy([first, third])]));
		expect(spent.blocks).toHaveLength(2);
		expect(await balanceOf(owning, account)).toBe(granted - 1_000n);
		expect(await balanceOf(owning, recipient)).toBe(1_000n);
		expect(await balanceOf(owning, first)).toBe(1_000n - EVERY_FEE_PER_BLOCK);
		await expectConvergedDumps(network);
	});

	devnet.test('permission escalation via a same-staple self-grant is refused', SCENARIO, async function(network) {
		const [attacker, victim] = [userOf(90), userOf(91)];
		const attacking = network.client(attacker);
		const base = attacking.baseToken;
		await fund(network, attacker, 1_000n);
		await fund(network, victim, 5_000n);

		/*
		 * The attacker grants itself SEND_ON_BEHALF on its own account, and a
		 * later block of the same staple spends the victim's funds with it.
		 * Since 0.18.5 a grant earlier in the staple counts only for the same
		 * entity and target [Keeta TS] index.js:68035-68057, so the victim's
		 * requirement stands.
		 */
		const builder = attacking.initBuilder();
		builder.updatePermissions(attacker, permissions(['SEND_ON_BEHALF']), undefined, lib.Block.AdjustMethod.ADD);
		builder.send(attacker, 5_000n, base, undefined, { account: victim });
		const message = await refusedWith(attacking.publishBuilder(builder), 'LEDGER_INVALID_PERMISSIONS');
		expect(message).toBe(lacking(attacker, victim, base, 'SEND_ON_BEHALF'));
		expect(builder.blocks.map(function(block): string {
			return(keyOf(block.account));
		})).toEqual([keyOf(attacker), keyOf(victim)]);
		// It is the refusal that 0.18.4's scope for a same-staple grant would not have made.
		expect(explainRefusal({ blocks: builder.blocks, votes: [] }, { code: 'LEDGER_INVALID_PERMISSIONS', message }, anchorsOf(attacking)).reason).toBe('same-staple-grant-scope');
		expect(await balanceOf(attacking, victim)).toBe(5_000n);
		expect(await balanceOf(attacking, attacker)).toBe(1_000n);
		await expectConvergedDumps(network);
	});

	devnet.test('recover account: a send only two representatives voted on is completed by the client\'s recover', SCENARIO, async function(network) {
		const [user, recipient, other] = [userOf(100), userOf(101), userOf(102)];
		const everyone = network.client(user);
		const base = everyone.baseToken;
		await fund(network, user, 10_000n);

		const minority = network.client(user, [0, 1]);
		await refusedWith(minority.send(recipient, 700n, base), 'LEDGER_INSUFFICIENT_VOTING_WEIGHT');
		const pending = await everyone.pendingBlock();
		expect(pending?.operations).toMatchObject([{ type: lib.Block.OperationType.SEND, amount: 700n }]);

		// Representatives that voted on the pending send vote on no other successor [Keeta TS] index.js:69280-69305.
		const competing = minority.initBuilder();
		competing.send(other, 1n, base);
		await refusedWith(minority.publishBuilder(competing), 'LEDGER_SUCCESSOR_VOTE_EXISTS');

		/*
		 * Recovering asks the representatives that have not voted, and needs
		 * the fee block the votes ask for, which the client builds only when
		 * told how [Keeta TS] index.js:59408-59417, 60856-60858.
		 */
		expect(await refusalOf(everyone.recover())).toMatchObject({ message: 'Votes require fees but generateFeeBlock was not defined' });
		const recovered = await everyone.recover(true, { generateFeeBlock: feeBlockOf(everyone) });
		if (recovered === null) {
			throw(new Error('nothing was recovered'));
		}
		await network.settled(recovered);
		expect(votersOf(recovered)).toEqual(keysOf(REPRESENTATIVE_INDEXES));
		expect(recovered.blocks[0]?.hash.toString()).toBe(pending?.hash.toString());
		expect(await balanceOf(everyone, recipient)).toBe(700n);
		expect(await everyone.balance(base)).toBe(10_000n - 700n - EVERY_FEE_PER_BLOCK);
		expect(await everyone.pendingBlock()).toBeNull();
		await expectConvergedDumps(network);
	});

	devnet.test('errors: each refusal a client can cause reaches it with the ledger\'s code', SCENARIO, async function(network) {
		const [user, recipient, other, underpaying, shortPaying] = [userOf(110), userOf(111), userOf(112), userOf(113), userOf(114)];
		const client = network.client(user);
		const base = client.baseToken;
		const funding = await fund(network, user, 1_000n);
		await fund(network, other, 1_000n);

		// A balance may not fall below zero at any point [Keeta TS] index.js:70086-70089.
		await refusedWith(client.send(recipient, 1_001n, base), 'LEDGER_INVALID_BALANCE');

		// A block must follow the account's head, and an account without blocks takes only an opening one [Keeta TS] index.js:69260-69275.
		const elsewhere = funding.blocks[0]?.hash ?? null;
		const unopened = await sendBlock({ from: user, to: recipient, amount: 1n, token: base, previous: elsewhere, network: client.network });
		await refusedWith(client.transmit([unopened]), 'LEDGER_NOT_OPENING');
		const opened = await settledPublish(network, client.send(recipient, 10n, base));
		const head = opened.blocks.at(-1)?.hash ?? null;
		const misplaced = await sendBlock({ from: user, to: recipient, amount: 1n, token: base, previous: elsewhere, network: client.network });
		await refusedWith(client.transmit([misplaced]), 'LEDGER_NOT_SUCCESSOR');

		// No vote is given on a block dated more than five minutes away [Keeta TS] index.js:70185-70197.
		const stale = await sendBlock({ from: user, to: recipient, amount: 1n, token: base, previous: head, network: client.network, date: new Date(Date.now() - (10 * 60 * 1000)) });
		await refusedWith(client.transmit([stale]), 'LEDGER_BLOCK_EXPIRED');

		// A signer other than the account needs a grant for what it does.
		expect(await refusedWith(client.send(user, 1n, base, undefined, { account: other }), 'LEDGER_INVALID_PERMISSIONS')).toBe(lacking(user, other, base, 'SEND_ON_BEHALF'));

		/*
		 * A fee block must pay each voter: one fee too few, and one of the
		 * right count with the wrong amounts, are refused when the permanent
		 * votes are asked for [Keeta TS] index.js:69151-69210.
		 */
		await fund(network, underpaying, 1_000n);
		await fund(network, shortPaying, 1_000n);
		const short = network.client(shortPaying);
		const exactFees = REPRESENTATIVE_INDEXES.map(function(index) {
			return({ index, amount: FEES[index].amountPerBlock });
		});
		await refusedWith(sendPayingFees(short, recipient, 10n, feeBlockPaying(short, shortPaying, exactFees.slice(1))), 'LEDGER_REQUIRED_FEE_MISMATCH');
		const under = network.client(underpaying);
		const lowFees = exactFees.map(function({ index, amount }) {
			return({ index, amount: amount - 1n });
		});
		await refusedWith(sendPayingFees(under, recipient, 10n, feeBlockPaying(under, underpaying, lowFees)), 'LEDGER_FEE_MISSING');

		// The representatives hold temporary votes on both sends, which recovering confirms with the right fees.
		for (const payer of [short, under]) {
			const recovered = await payer.recover(true, { generateFeeBlock: feeBlockOf(payer) });
			if (recovered === null) {
				throw(new Error('nothing was recovered'));
			}
			await network.settled(recovered);
			expect(await payer.balance(base)).toBe(1_000n - 10n - EVERY_FEE_PER_BLOCK);
		}

		expect(await client.balance(base)).toBe(1_000n - 10n - EVERY_FEE_PER_BLOCK);
		expect(await balanceOf(client, recipient)).toBe(30n);
		expect((await client.head())?.toString()).toBe(head?.toString());
		await expectConvergedDumps(network);
	});

	/*
	 * After every scenario, so that the history holds all they confirmed.
	 */
	devnet.test('shadow agreement: a fresh 0.18.7 ledger would vote for every staple the devnet confirmed', SCENARIO, async function(network) {
		const staples = await network.nodes[0].confirmedStaples();
		const { result, votes } = await shadowReplay(staples);
		expect(result.deferred).toEqual([]);
		expect(result.applied).toBe(staples.length);
		expect(votes).toHaveLength(staples.length);
		const refused = votes.flatMap(function(vote): string[] {
			switch (vote.outcome) {
				case 'voted':
					return([]);
				case 'refused':
					return([`${vote.staple.blocksHash.toString()}: ${vote.refusal.code} ${vote.refusal.message}`]);
				default:
					return(assertNever(vote));
			}
		});
		/*
		 * The genesis staple is the trusted account's alone, as upstream's
		 * genesis builder seals it, and it mints the supply with an operation
		 * that a representative's ledger never votes for.
		 * [Keeta TS] index.js:79646-79657, 79675-79688, 68983, 69969-69972
		 */
		const [genesis] = replayOrder(staples);
		expect(genesis?.votes.map(function(vote): string {
			return(keyOf(vote.issuer));
		})).toEqual([keyOf(TRUSTED_ACCOUNT)]);
		expect(refused).toEqual([`${String(genesis?.blocksHash.toString())}: LEDGER_OPERATION_NOT_SUPPORTED TOKEN_ADMIN_MODIFY_BALANCE operation not supported`]);
	});
});
