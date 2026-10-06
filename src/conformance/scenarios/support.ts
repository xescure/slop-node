import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import { sendBlock } from '../../testing/blocks.js';
import type { CaseRecorder } from '../record.js';

export const MINUTE: number = 60 * 1000;

export const HOUR: number = 60 * MINUTE;

/** How far a block's date may lie from the clock for a temporary vote, either way. [Keeta TS] index.js:70194 */
export const BLOCK_WINDOW: number = 5 * MINUTE;

/** How long a temporary vote is valid from the moment it is issued. [Keeta TS] index.js:70207 */
export const TEMPORARY_VALIDITY: number = 5 * MINUTE;

/** How far a vote's validity may be off the clock when its bytes are parsed. [Keeta TS] index.js:80653 */
export const VOTE_SLOP: number = MINUTE;

export type SendOptions = {
	/** Without a previous block, the sender's last genesis block; null opens the account. */
	readonly previous?: BlockHash | null;
	readonly to?: GenericAccount;
	readonly amount?: bigint;
	readonly date?: Date;
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
	const { to = recorder.user(0), amount = 1n, date } = options;
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
		network: recorder.network.network,
		date
	}));
}

/** The blocks genesis gave an account, in order: each user's funding, then its delegation. */
export function genesisBlocksOf(recorder: CaseRecorder, account: GenericAccount): readonly Block[] {
	return(recorder.network.genesis.blocks.filter(function(block): boolean {
		return(block.account.comparePublicKey(account));
	}));
}
