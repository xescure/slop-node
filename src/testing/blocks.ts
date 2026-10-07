import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, MultisigAddress, StorageAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash, BlockJSONIncomplete, BlockV2JSON } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { MultisigConfig } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type {
	BlockJSONOperationMANAGE_CERTIFICATE,
	BlockJSONOperationMODIFY_PERMISSIONS,
	BlockJSONOperationRECEIVE,
	BlockJSONOperationSEND,
	BlockJSONOperationSET_INFO,
	BlockJSONOperationTOKEN_ADMIN_SUPPLY,
	BlockJSONOperations
} from '@keetanetwork/keetanet-client/lib/block/operations.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';

const lib = KeetaNet.lib;

type BlockContext = {
	readonly previous: BlockHash | null;
	readonly network: bigint;
	/** Without a subnet a block is accepted only by a ledger without one. */
	readonly subnet?: bigint | undefined;
	readonly idempotent?: string | undefined;
	/** Without a date a block is dated at the moment it is sealed. */
	readonly date?: Date | undefined;
};

type SignedBlockContext = BlockContext & {
	readonly account: GenericAccount;
	readonly signer?: Account | undefined;
};

type SealInput = SignedBlockContext & { readonly operations: BlockJSONOperations[] };

async function seal(input: SealInput): Promise<Block> {
	const fields: BlockJSONIncomplete = {
		network: input.network,
		account: input.account,
		previous: input.previous ?? lib.Block.NO_PREVIOUS,
		operations: input.operations
	};
	if (input.signer !== undefined) {
		fields.signer = input.signer;
	}
	if (input.subnet !== undefined) {
		fields.subnet = input.subnet;
	}
	if (input.idempotent !== undefined) {
		fields.idempotent = input.idempotent;
	}
	if (input.date !== undefined) {
		fields.date = input.date;
	}
	return(await new lib.Block.Builder(fields).seal());
}

/** A block of any operations, for the combinations the single-operation builders do not cover. */
export function operationsBlock(input: SealInput): Promise<Block> {
	return(seal(input));
}

/** An identifier such as a token sends with its owner as the signer. */
export function sendBlock(input: BlockContext & { readonly from: GenericAccount; readonly signer?: Account; readonly to: GenericAccount; readonly amount: bigint; readonly token: TokenAddress }): Promise<Block> {
	const { from, to, amount, token, ...context } = input;
	return(seal({
		...context,
		account: from,
		operations: [{ type: lib.Block.OperationType.SEND, to, amount, token }]
	}));
}

/** The account requires that `from` sent it, earlier in the request, at least the amount stated, or with `exact` exactly that amount. */
export function receiveBlock(input: SignedBlockContext & Omit<BlockJSONOperationRECEIVE, 'type' | 'forward'>): Promise<Block> {
	const { account, signer, previous, network, subnet, idempotent, date, ...operation } = input;
	return(seal({
		account,
		signer,
		previous,
		network,
		subnet,
		idempotent,
		date,
		operations: [{ type: lib.Block.OperationType.RECEIVE, ...operation }]
	}));
}

/** A multisig and the signers that sign for it, nested to any depth the network allows. */
export type MultisigSigner = Extract<BlockV2JSON['signer'], readonly unknown[]>;

/*
 * Only a version 2 block carries a multisig signer; each listed key signs.
 * [Keeta TS] index.js:64140-64166
 */
export function multisigSendBlock(input: BlockContext & { readonly from: GenericAccount; readonly signer: MultisigSigner; readonly to: GenericAccount; readonly amount: bigint; readonly token: TokenAddress }): Promise<Block> {
	const { from, signer, to, amount, token, previous, network, subnet, idempotent, date } = input;
	const fields: BlockJSONIncomplete = {
		version: 2,
		purpose: lib.Block.Purpose.GENERIC,
		network,
		account: from,
		signer,
		previous: previous ?? lib.Block.NO_PREVIOUS,
		operations: [{ type: lib.Block.OperationType.SEND, to, amount, token }]
	};
	if (subnet !== undefined) {
		fields.subnet = subnet;
	}
	if (idempotent !== undefined) {
		fields.idempotent = idempotent;
	}
	if (date !== undefined) {
		fields.date = date;
	}
	return(new lib.Block.Builder(fields).seal());
}

export function setRepresentativeBlock(input: SignedBlockContext & { readonly representative: GenericAccount }): Promise<Block> {
	const { representative, ...context } = input;
	return(seal({
		...context,
		operations: [{ type: lib.Block.OperationType.SET_REP, to: representative }]
	}));
}

/*
 * The identifier derives from the owner's previous block and the operation
 * index, so the token address is known before the block is published.
 * [Keeta TS] index.js:62864-62889
 */
export async function createTokenBlock(input: BlockContext & { readonly owner: Account }): Promise<{ readonly block: Block; readonly token: TokenAddress }> {
	const { owner, ...context } = input;
	const token = owner.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, context.previous ?? undefined, 0);
	const block = await seal({
		...context,
		account: owner,
		operations: [{ type: lib.Block.OperationType.CREATE_IDENTIFIER, identifier: token }]
	});
	return({ block, token });
}

/** A storage account, derived like a token; its creator becomes its owner. */
export async function createStorageBlock(input: BlockContext & { readonly owner: Account }): Promise<{ readonly block: Block; readonly storage: StorageAddress }> {
	const { owner, ...context } = input;
	const storage = owner.generateIdentifier(lib.Account.AccountKeyAlgorithm.STORAGE, context.previous ?? undefined, 0);
	const block = await seal({
		...context,
		account: owner,
		operations: [{ type: lib.Block.OperationType.CREATE_IDENTIFIER, identifier: storage }]
	});
	return({ block, storage });
}

/*
 * A multisig identifier carries its signers and quorum in the creation
 * arguments; its address derives like any other identifier's.
 * [Keeta TS] index.js:68305-68320
 */
export async function createMultisigBlock(input: BlockContext & { readonly owner: Account; readonly signers: readonly MultisigConfig['signers'][number][]; readonly quorum: bigint }): Promise<{ readonly block: Block; readonly multisig: MultisigAddress }> {
	const { owner, signers, quorum, ...context } = input;
	const multisig = owner.generateIdentifier(lib.Account.AccountKeyAlgorithm.MULTISIG, context.previous ?? undefined, 0);
	const block = await seal({
		...context,
		account: owner,
		operations: [{
			type: lib.Block.OperationType.CREATE_IDENTIFIER,
			identifier: multisig,
			createArguments: { type: lib.Account.AccountKeyAlgorithm.MULTISIG, signers: [...signers], quorum }
		}]
	});
	return({ block, multisig });
}

export function tokenSupplyBlock(input: BlockContext & { readonly owner: Account; readonly token: TokenAddress; readonly amount: bigint; readonly method?: BlockJSONOperationTOKEN_ADMIN_SUPPLY['method'] }): Promise<Block> {
	const { owner, token, amount, method = lib.Block.AdjustMethod.ADD, ...context } = input;
	return(seal({
		...context,
		account: token,
		signer: owner,
		operations: [{ type: lib.Block.OperationType.TOKEN_ADMIN_SUPPLY, amount, method }]
	}));
}

export function modifyPermissionsBlock(input: SignedBlockContext & Omit<BlockJSONOperationMODIFY_PERMISSIONS, 'type'>): Promise<Block> {
	const { account, signer, previous, network, subnet, idempotent, date, ...operation } = input;
	return(seal({
		account,
		signer,
		previous,
		network,
		subnet,
		idempotent,
		date,
		operations: [{ type: lib.Block.OperationType.MODIFY_PERMISSIONS, ...operation }]
	}));
}

export function setInfoBlock(input: SignedBlockContext & Omit<BlockJSONOperationSET_INFO, 'type'>): Promise<Block> {
	const { account, signer, previous, network, subnet, idempotent, date, ...operation } = input;
	return(seal({
		account,
		signer,
		previous,
		network,
		subnet,
		idempotent,
		date,
		operations: [{ type: lib.Block.OperationType.SET_INFO, ...operation }]
	}));
}

/*
 * Adding a certificate requires the intermediate certificates field to be
 * present, and null states that there are none; removing one requires it to
 * be absent.
 * [Keeta TS] index.js:65684-65686
 */
export function manageCertificateBlock(input: SignedBlockContext & Omit<BlockJSONOperationMANAGE_CERTIFICATE, 'type'>): Promise<Block> {
	const { account, signer, previous, network, subnet, idempotent, date, intermediateCertificates, ...fields } = input;
	const operation: BlockJSONOperationMANAGE_CERTIFICATE = { type: lib.Block.OperationType.MANAGE_CERTIFICATE, ...fields };
	if (fields.method === lib.Block.AdjustMethod.ADD) {
		operation.intermediateCertificates = intermediateCertificates ?? null;
	} else if (intermediateCertificates !== undefined) {
		operation.intermediateCertificates = intermediateCertificates;
	}
	return(seal({
		account,
		signer,
		previous,
		network,
		subnet,
		idempotent,
		date,
		operations: [operation]
	}));
}

/*
 * A fee block pays the voters with SENDs only, as many as the votes that
 * charge a fee, and must be a version 2 block with the FEE purpose.
 * [Keeta TS] index.js:57612-57681
 */
export function feeBlock(input: BlockContext & { readonly from: Account; readonly payments: readonly Pick<BlockJSONOperationSEND, 'to' | 'token' | 'amount'>[] }): Promise<Block> {
	const { from, payments, previous, network, subnet, idempotent, date } = input;
	const fields: BlockJSONIncomplete = {
		version: 2,
		purpose: lib.Block.Purpose.FEE,
		network,
		account: from,
		previous: previous ?? lib.Block.NO_PREVIOUS,
		operations: payments.map(function(payment): BlockJSONOperationSEND {
			return({ type: lib.Block.OperationType.SEND, ...payment });
		})
	};
	if (subnet !== undefined) {
		fields.subnet = subnet;
	}
	if (idempotent !== undefined) {
		fields.idempotent = idempotent;
	}
	if (date !== undefined) {
		fields.date = date;
	}
	return(new lib.Block.Builder(fields).seal());
}

function serialForBlocks(blocks: readonly Block[]): bigint {
	const blocksHash = lib.Vote.VoteBlocksHash.fromBlockHashes(blocks.map(function(block): BlockHash {
		return(block.hash);
	}));
	return(BigInt(`0x${blocksHash.toString('hex').slice(0, 15)}`));
}

type VoteValidity = {
	readonly validFrom: Date;
	readonly validTo: Date;
};

/*
 * A permanent vote's validity, as upstream sets it, but counted from the
 * newest block's date, plus the vote's delay, rather than from the clock. The
 * clock has passed that date by the time the blocks are voted on, so a vote
 * without a delay is never issued in the future.
 * [Keeta TS] index.js:81533-81540
 */
function permanentValidityForBlocks(blocks: readonly Block[], delayMilliseconds: number): VoteValidity {
	const validFrom = new Date(delayMilliseconds + Math.max(...blocks.map(function(block): number {
		return(block.date.getTime());
	})));
	const validTo = new Date(validFrom);
	validTo.setUTCFullYear(validFrom.getUTCFullYear() + 1000, 12, 31);
	validTo.setUTCHours(0, 0, 0, 0);
	return({ validFrom, validTo });
}

export type ConfirmedStapleOptions = {
	/**
	 * Milliseconds after the newest block's date at which each signer's vote
	 * becomes valid, one entry per signer in order; every vote is valid from
	 * that date when absent.
	 */
	readonly voteDelays?: readonly number[] | undefined;
};

type DelayedSigner = {
	readonly signer: Account;
	readonly delayMilliseconds: number;
};

function delayedSigners(signers: readonly Account[], voteDelays: readonly number[] | undefined): readonly DelayedSigner[] {
	if (voteDelays !== undefined && voteDelays.length !== signers.length) {
		throw(new Error(`${String(voteDelays.length)} vote delays given for ${String(signers.length)} signers`));
	}
	return(signers.map(function(signer, index): DelayedSigner {
		return({ signer, delayMilliseconds: voteDelays?.[index] ?? 0 });
	}));
}

/*
 * Serial and validity both derive from the blocks, so a signer never issues
 * two different votes under one serial, however the clock moves between
 * calls, and repeated runs stay byte-identical.
 */
export async function confirmedStaple(blocks: readonly Block[], signers: readonly Account[], options: ConfirmedStapleOptions = {}): Promise<VoteStaple> {
	const serial = serialForBlocks(blocks);
	const votes = [];
	for (const { signer, delayMilliseconds } of delayedSigners(signers, options.voteDelays)) {
		const { validFrom, validTo } = permanentValidityForBlocks(blocks, delayMilliseconds);
		votes.push(await new lib.Vote.Builder(signer, [...blocks]).seal(serial, validTo, validFrom));
	}
	return(lib.Vote.Staple.fromVotesAndBlocks(votes, [...blocks]));
}
