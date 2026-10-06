import type { Account, AccountKeyAlgorithm } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Ledger, LedgerConfig, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { AccountInfoForType } from '@keetanetwork/keetanet-client/lib/ledger/types.js';

// Every operation but init is asynchronous upstream, so callers attach their error handling to the
// returned promise; a synchronous throw would bypass it.
function rejectNotImplemented(member: keyof LedgerStorageAPI): Promise<never> {
	return(Promise.reject(new Error(`not implemented: ${member}`)));
}

/*
 * Every operation fails instead of returning an empty default: Ledger feeds
 * storage results into consensus checks, so a fabricated value would pass them
 * silently, while a rejection fails loudly at the first unfinished operation.
 */
export class LedgerStorageSkeleton implements LedgerStorageAPI {
	protected ledgerConfig: LedgerConfig | undefined;
	protected ledger: Ledger | undefined;

	init(config: LedgerConfig, ledger: Ledger): void {
		this.ledgerConfig = config;
		this.ledger = ledger;
	}

	beginTransaction(..._args: Parameters<LedgerStorageAPI['beginTransaction']>): ReturnType<LedgerStorageAPI['beginTransaction']> {
		return(rejectNotImplemented('beginTransaction'));
	}

	commitTransaction(..._args: Parameters<LedgerStorageAPI['commitTransaction']>): ReturnType<LedgerStorageAPI['commitTransaction']> {
		return(rejectNotImplemented('commitTransaction'));
	}

	abortTransaction(..._args: Parameters<LedgerStorageAPI['abortTransaction']>): ReturnType<LedgerStorageAPI['abortTransaction']> {
		return(rejectNotImplemented('abortTransaction'));
	}

	evaluateError(..._args: Parameters<LedgerStorageAPI['evaluateError']>): ReturnType<LedgerStorageAPI['evaluateError']> {
		return(rejectNotImplemented('evaluateError'));
	}

	delegatedWeight(..._args: Parameters<LedgerStorageAPI['delegatedWeight']>): ReturnType<LedgerStorageAPI['delegatedWeight']> {
		return(rejectNotImplemented('delegatedWeight'));
	}

	getBalance(..._args: Parameters<LedgerStorageAPI['getBalance']>): ReturnType<LedgerStorageAPI['getBalance']> {
		return(rejectNotImplemented('getBalance'));
	}

	getAllBalances(..._args: Parameters<LedgerStorageAPI['getAllBalances']>): ReturnType<LedgerStorageAPI['getAllBalances']> {
		return(rejectNotImplemented('getAllBalances'));
	}

	// Written out because a generic signature cannot be derived through Parameters and ReturnType, and a
	// method (unlike a function-typed property) stays overridable by subclasses.
	getAccountInfo<T extends AccountKeyAlgorithm = AccountKeyAlgorithm>(_transaction: Parameters<LedgerStorageAPI['getAccountInfo']>[0], _account: Account<T> | string): Promise<AccountInfoForType<T>> {
		return(rejectNotImplemented('getAccountInfo'));
	}

	listOwners(..._args: Parameters<LedgerStorageAPI['listOwners']>): ReturnType<LedgerStorageAPI['listOwners']> {
		return(rejectNotImplemented('listOwners'));
	}

	listACLsByPrincipal(..._args: Parameters<LedgerStorageAPI['listACLsByPrincipal']>): ReturnType<LedgerStorageAPI['listACLsByPrincipal']> {
		return(rejectNotImplemented('listACLsByPrincipal'));
	}

	listACLsByEntity(..._args: Parameters<LedgerStorageAPI['listACLsByEntity']>): ReturnType<LedgerStorageAPI['listACLsByEntity']> {
		return(rejectNotImplemented('listACLsByEntity'));
	}

	adjust(..._args: Parameters<LedgerStorageAPI['adjust']>): ReturnType<LedgerStorageAPI['adjust']> {
		return(rejectNotImplemented('adjust'));
	}

	addPendingVote(..._args: Parameters<LedgerStorageAPI['addPendingVote']>): ReturnType<LedgerStorageAPI['addPendingVote']> {
		return(rejectNotImplemented('addPendingVote'));
	}

	getBlock(..._args: Parameters<LedgerStorageAPI['getBlock']>): ReturnType<LedgerStorageAPI['getBlock']> {
		return(rejectNotImplemented('getBlock'));
	}

	getBlockHeight(..._args: Parameters<LedgerStorageAPI['getBlockHeight']>): ReturnType<LedgerStorageAPI['getBlockHeight']> {
		return(rejectNotImplemented('getBlockHeight'));
	}

	getBlockHeights(..._args: Parameters<LedgerStorageAPI['getBlockHeights']>): ReturnType<LedgerStorageAPI['getBlockHeights']> {
		return(rejectNotImplemented('getBlockHeights'));
	}

	getAccountsBlockHeightInfo(..._args: Parameters<LedgerStorageAPI['getAccountsBlockHeightInfo']>): ReturnType<LedgerStorageAPI['getAccountsBlockHeightInfo']> {
		return(rejectNotImplemented('getAccountsBlockHeightInfo'));
	}

	getVotes(..._args: Parameters<LedgerStorageAPI['getVotes']>): ReturnType<LedgerStorageAPI['getVotes']> {
		return(rejectNotImplemented('getVotes'));
	}

	getVotesFromPrevious(..._args: Parameters<LedgerStorageAPI['getVotesFromPrevious']>): ReturnType<LedgerStorageAPI['getVotesFromPrevious']> {
		return(rejectNotImplemented('getVotesFromPrevious'));
	}

	getVotesFromMultiplePrevious(..._args: Parameters<LedgerStorageAPI['getVotesFromMultiplePrevious']>): ReturnType<LedgerStorageAPI['getVotesFromMultiplePrevious']> {
		return(rejectNotImplemented('getVotesFromMultiplePrevious'));
	}

	getVoteStaples(..._args: Parameters<LedgerStorageAPI['getVoteStaples']>): ReturnType<LedgerStorageAPI['getVoteStaples']> {
		return(rejectNotImplemented('getVoteStaples'));
	}

	getHistory(..._args: Parameters<LedgerStorageAPI['getHistory']>): ReturnType<LedgerStorageAPI['getHistory']> {
		return(rejectNotImplemented('getHistory'));
	}

	getHeadBlocks(..._args: Parameters<LedgerStorageAPI['getHeadBlocks']>): ReturnType<LedgerStorageAPI['getHeadBlocks']> {
		return(rejectNotImplemented('getHeadBlocks'));
	}

	getHeadBlockHashes(..._args: Parameters<LedgerStorageAPI['getHeadBlockHashes']>): ReturnType<LedgerStorageAPI['getHeadBlockHashes']> {
		return(rejectNotImplemented('getHeadBlockHashes'));
	}

	getHeadBlock(..._args: Parameters<LedgerStorageAPI['getHeadBlock']>): ReturnType<LedgerStorageAPI['getHeadBlock']> {
		return(rejectNotImplemented('getHeadBlock'));
	}

	getBlockFromPrevious(..._args: Parameters<LedgerStorageAPI['getBlockFromPrevious']>): ReturnType<LedgerStorageAPI['getBlockFromPrevious']> {
		return(rejectNotImplemented('getBlockFromPrevious'));
	}

	getAccountRep(..._args: Parameters<LedgerStorageAPI['getAccountRep']>): ReturnType<LedgerStorageAPI['getAccountRep']> {
		return(rejectNotImplemented('getAccountRep'));
	}

	getVotesAfter(..._args: Parameters<LedgerStorageAPI['getVotesAfter']>): ReturnType<LedgerStorageAPI['getVotesAfter']> {
		return(rejectNotImplemented('getVotesAfter'));
	}

	gc(..._args: Parameters<LedgerStorageAPI['gc']>): ReturnType<LedgerStorageAPI['gc']> {
		return(rejectNotImplemented('gc'));
	}

	getNextSerialNumber(..._args: Parameters<LedgerStorageAPI['getNextSerialNumber']>): ReturnType<LedgerStorageAPI['getNextSerialNumber']> {
		return(rejectNotImplemented('getNextSerialNumber'));
	}

	getAccountCertificates(..._args: Parameters<LedgerStorageAPI['getAccountCertificates']>): ReturnType<LedgerStorageAPI['getAccountCertificates']> {
		return(rejectNotImplemented('getAccountCertificates'));
	}

	getAccountCertificateByHash(..._args: Parameters<LedgerStorageAPI['getAccountCertificateByHash']>): ReturnType<LedgerStorageAPI['getAccountCertificateByHash']> {
		return(rejectNotImplemented('getAccountCertificateByHash'));
	}

	getIdempotentBlockHash(..._args: Parameters<LedgerStorageAPI['getIdempotentBlockHash']>): ReturnType<LedgerStorageAPI['getIdempotentBlockHash']> {
		return(rejectNotImplemented('getIdempotentBlockHash'));
	}

	stats(..._args: Parameters<LedgerStorageAPI['stats']>): ReturnType<LedgerStorageAPI['stats']> {
		return(rejectNotImplemented('stats'));
	}
}
