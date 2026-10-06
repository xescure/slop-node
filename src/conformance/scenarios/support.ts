import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { ChainCursor } from '../../ledger/storage/suite/support.js';
import { confirmedStaple, createTokenBlock, operationsBlock, sendBlock } from '../../testing/blocks.js';
import type { CaseRecorder } from '../record.js';

const lib = KeetaNet.lib;

export const MINUTE: number = 60 * 1000;

export const HOUR: number = 60 * MINUTE;

/** How far a block's date may lie from the clock for a temporary vote, either way. [Keeta TS] index.js:70194 */
export const BLOCK_WINDOW: number = 5 * MINUTE;

/** How long a temporary vote is valid from the moment it is issued. [Keeta TS] index.js:70207 */
export const TEMPORARY_VALIDITY: number = 5 * MINUTE;

/** How far a vote's validity may be off the clock when its bytes are parsed. [Keeta TS] index.js:80653 */
export const VOTE_SLOP: number = MINUTE;

/** The largest supply a token may have. [Keeta TS] index.js:61315 */
export const MAXIMUM_SUPPLY: bigint = (10n ** 200n) - 1n;

/** Blocks dated from this moment on may not carry a negative amount. [Keeta TS] index.js:61330 */
export const NEGATIVE_AMOUNTS_REFUSED_FROM: Date = new Date(Date.UTC(2025, 10, 21));

/** An idempotent key as a block carries it: the base64 of the text's bytes. */
export function idempotentKey(text: string): string {
	return(Buffer.from(text).toString('base64'));
}

export type SendOptions = {
	/** Without a previous block, the sender's last genesis block; null opens the account. */
	readonly previous?: BlockHash | null;
	readonly to?: GenericAccount;
	readonly amount?: bigint;
	readonly date?: Date;
	/** The case's network unless stated. */
	readonly network?: bigint;
	readonly subnet?: bigint;
	readonly idempotent?: string;
};

/** User `from` sends the base token, one unit unless stated. */
export function send(recorder: CaseRecorder, from: number, options: SendOptions = {}): Promise<Block> {
	return(sendFrom(recorder, recorder.user(from), {
		to: recorder.user((from + 1) % recorder.network.users.length),
		...options
	}));
}

/** Any key sends the base token, to the first user unless stated. */
export function sendFrom(recorder: CaseRecorder, sender: Account, options: SendOptions = {}): Promise<Block> {
	const { to = recorder.user(0), amount = 1n, date, network = recorder.network.network, subnet, idempotent } = options;
	let { previous } = options;
	if (previous === undefined) {
		previous = recorder.genesisHead(sender);
	}
	return(sendBlock({
		from: sender,
		to,
		amount,
		token: recorder.network.baseToken,
		previous,
		network,
		subnet,
		idempotent,
		date
	}));
}

/** The blocks genesis gave an account, in order: each user's funding, then its delegation. */
export function genesisBlocksOf(recorder: CaseRecorder, account: GenericAccount): readonly Block[] {
	return(recorder.network.genesis.blocks.filter(function(block): boolean {
		return(block.account.comparePublicKey(account));
	}));
}

/** Every representative confirms the blocks. */
export function confirmed(recorder: CaseRecorder, blocks: readonly Block[]): Promise<VoteStaple> {
	return(confirmedStaple(blocks, recorder.network.representatives));
}

/** Tracks each account's chain head from genesis on, as blocks are built. */
export function chainsOf(recorder: CaseRecorder): ChainCursor {
	return(new ChainCursor(recorder.network.genesis));
}

/** A token added to a ledger, and the chain heads at that point. */
export type PublishedToken = {
	readonly token: TokenAddress;
	readonly chains: ChainCursor;
};

export type IssuedToken = {
	readonly token: TokenAddress;
	/** The creation on the owner's chain, then the token's opening block. */
	readonly blocks: readonly [Block, Block];
};

export type TokenOptions = {
	readonly supply: bigint;
	/** What every account may do with the token without an ACL row of its own. */
	readonly defaultPermission: ConstructorParameters<typeof KeetaNet.lib.Permissions>[0];
};

/*
 * The owner creates the token, and the token's opening block names it, sets
 * its default permission and mints the supply into its own balance.
 * [Keeta TS] index.js:65426-65428
 */
export async function issueToken(recorder: CaseRecorder, chains: ChainCursor, owner: Account, options: TokenOptions): Promise<IssuedToken> {
	const { network } = recorder.network;
	const { block, token } = await createTokenBlock({ owner, previous: chains.previous(owner), network });
	const created = chains.append(block);
	const opening = chains.append(await operationsBlock({
		account: token,
		signer: owner,
		previous: chains.previous(token),
		network,
		operations: [
			{ type: lib.Block.OperationType.SET_INFO, name: 'TOKEN', description: '', metadata: '', defaultPermission: new lib.Permissions(options.defaultPermission) },
			{ type: lib.Block.OperationType.TOKEN_ADMIN_SUPPLY, method: lib.Block.AdjustMethod.ADD, amount: options.supply }
		]
	}));
	return({ token, blocks: [created, opening] });
}
