import type { FollowerStore } from '../parity/follower-store.js';

function unread(name: string): () => Promise<never> {
	return(function(): Promise<never> {
		return(Promise.reject(new Error(`the case does not read ${name} from the follower's store`)));
	});
}

/** A follower's store that serves the reads given, and fails any other a case does not expect. */
export function followerStoreOf(reads: Partial<FollowerStore>): FollowerStore {
	return({
		progress: unread('progress'),
		chainAccountsAfter: unread('chainAccountsAfter'),
		passiveAccountsAfter: unread('passiveAccountsAfter'),
		accountCount: unread('accountCount'),
		chainAccounts: unread('chainAccounts'),
		rowIDsOf: unread('rowIDsOf'),
		historyHolds: unread('historyHolds'),
		checksumSnapshot: unread('checksumSnapshot'),
		quietAccounts: unread('quietAccounts'),
		heldBlocks: unread('heldBlocks'),
		blockPages: unread('blockPages'),
		heldBlocksInPages: unread('heldBlocksInPages'),
		heldBlocksOfStaples: unread('heldBlocksOfStaples'),
		lastSequence: unread('lastSequence'),
		stapleAt: unread('stapleAt'),
		staplesAfter: unread('staplesAfter'),
		staplesOf: unread('staplesOf'),
		newestStaples: unread('newestStaples'),
		close: () => Promise.resolve(),
		...reads
	});
}
