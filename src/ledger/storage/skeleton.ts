import type { Ledger, LedgerConfig, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';

function notImplemented(member: keyof LedgerStorageAPI): never {
	throw(new Error(`not implemented: ${member}`));
}

/*
 * Every operation throws instead of returning an empty default: Ledger feeds
 * storage results into consensus checks, so a fabricated value would pass them
 * silently, while a throw fails loudly at the first unfinished operation.
 */
export class LedgerStorageSkeleton implements LedgerStorageAPI {
	protected ledgerConfig: LedgerConfig | undefined;
	protected ledger: Ledger | undefined;

	init(config: LedgerConfig, ledger: Ledger): void {
		this.ledgerConfig = config;
		this.ledger = ledger;
	}

	beginTransaction(..._args: Parameters<LedgerStorageAPI['beginTransaction']>): ReturnType<LedgerStorageAPI['beginTransaction']> {
		return(notImplemented('beginTransaction'));
	}

	commitTransaction(..._args: Parameters<LedgerStorageAPI['commitTransaction']>): ReturnType<LedgerStorageAPI['commitTransaction']> {
		return(notImplemented('commitTransaction'));
	}

	abortTransaction(..._args: Parameters<LedgerStorageAPI['abortTransaction']>): ReturnType<LedgerStorageAPI['abortTransaction']> {
		return(notImplemented('abortTransaction'));
	}

	evaluateError(..._args: Parameters<LedgerStorageAPI['evaluateError']>): ReturnType<LedgerStorageAPI['evaluateError']> {
		return(notImplemented('evaluateError'));
	}

	delegatedWeight(..._args: Parameters<LedgerStorageAPI['delegatedWeight']>): ReturnType<LedgerStorageAPI['delegatedWeight']> {
		return(notImplemented('delegatedWeight'));
	}

	getBalance(..._args: Parameters<LedgerStorageAPI['getBalance']>): ReturnType<LedgerStorageAPI['getBalance']> {
		return(notImplemented('getBalance'));
	}

	getAllBalances(..._args: Parameters<LedgerStorageAPI['getAllBalances']>): ReturnType<LedgerStorageAPI['getAllBalances']> {
		return(notImplemented('getAllBalances'));
	}

	getAccountInfo: LedgerStorageAPI['getAccountInfo'] = function() {
		return(notImplemented('getAccountInfo'));
	};

	listOwners(..._args: Parameters<LedgerStorageAPI['listOwners']>): ReturnType<LedgerStorageAPI['listOwners']> {
		return(notImplemented('listOwners'));
	}

	listACLsByPrincipal(..._args: Parameters<LedgerStorageAPI['listACLsByPrincipal']>): ReturnType<LedgerStorageAPI['listACLsByPrincipal']> {
		return(notImplemented('listACLsByPrincipal'));
	}

	listACLsByEntity(..._args: Parameters<LedgerStorageAPI['listACLsByEntity']>): ReturnType<LedgerStorageAPI['listACLsByEntity']> {
		return(notImplemented('listACLsByEntity'));
	}

	adjust(..._args: Parameters<LedgerStorageAPI['adjust']>): ReturnType<LedgerStorageAPI['adjust']> {
		return(notImplemented('adjust'));
	}

	addPendingVote(..._args: Parameters<LedgerStorageAPI['addPendingVote']>): ReturnType<LedgerStorageAPI['addPendingVote']> {
		return(notImplemented('addPendingVote'));
	}

	getBlock(..._args: Parameters<LedgerStorageAPI['getBlock']>): ReturnType<LedgerStorageAPI['getBlock']> {
		return(notImplemented('getBlock'));
	}

	getBlockHeight(..._args: Parameters<LedgerStorageAPI['getBlockHeight']>): ReturnType<LedgerStorageAPI['getBlockHeight']> {
		return(notImplemented('getBlockHeight'));
	}

	getBlockHeights(..._args: Parameters<LedgerStorageAPI['getBlockHeights']>): ReturnType<LedgerStorageAPI['getBlockHeights']> {
		return(notImplemented('getBlockHeights'));
	}

	getAccountsBlockHeightInfo(..._args: Parameters<LedgerStorageAPI['getAccountsBlockHeightInfo']>): ReturnType<LedgerStorageAPI['getAccountsBlockHeightInfo']> {
		return(notImplemented('getAccountsBlockHeightInfo'));
	}

	getVotes(..._args: Parameters<LedgerStorageAPI['getVotes']>): ReturnType<LedgerStorageAPI['getVotes']> {
		return(notImplemented('getVotes'));
	}

	getVotesFromPrevious(..._args: Parameters<LedgerStorageAPI['getVotesFromPrevious']>): ReturnType<LedgerStorageAPI['getVotesFromPrevious']> {
		return(notImplemented('getVotesFromPrevious'));
	}

	getVotesFromMultiplePrevious(..._args: Parameters<LedgerStorageAPI['getVotesFromMultiplePrevious']>): ReturnType<LedgerStorageAPI['getVotesFromMultiplePrevious']> {
		return(notImplemented('getVotesFromMultiplePrevious'));
	}

	getVoteStaples(..._args: Parameters<LedgerStorageAPI['getVoteStaples']>): ReturnType<LedgerStorageAPI['getVoteStaples']> {
		return(notImplemented('getVoteStaples'));
	}

	getHistory(..._args: Parameters<LedgerStorageAPI['getHistory']>): ReturnType<LedgerStorageAPI['getHistory']> {
		return(notImplemented('getHistory'));
	}

	getHeadBlocks(..._args: Parameters<LedgerStorageAPI['getHeadBlocks']>): ReturnType<LedgerStorageAPI['getHeadBlocks']> {
		return(notImplemented('getHeadBlocks'));
	}

	getHeadBlockHashes(..._args: Parameters<LedgerStorageAPI['getHeadBlockHashes']>): ReturnType<LedgerStorageAPI['getHeadBlockHashes']> {
		return(notImplemented('getHeadBlockHashes'));
	}

	getHeadBlock(..._args: Parameters<LedgerStorageAPI['getHeadBlock']>): ReturnType<LedgerStorageAPI['getHeadBlock']> {
		return(notImplemented('getHeadBlock'));
	}

	getBlockFromPrevious(..._args: Parameters<LedgerStorageAPI['getBlockFromPrevious']>): ReturnType<LedgerStorageAPI['getBlockFromPrevious']> {
		return(notImplemented('getBlockFromPrevious'));
	}

	getAccountRep(..._args: Parameters<LedgerStorageAPI['getAccountRep']>): ReturnType<LedgerStorageAPI['getAccountRep']> {
		return(notImplemented('getAccountRep'));
	}

	getVotesAfter(..._args: Parameters<LedgerStorageAPI['getVotesAfter']>): ReturnType<LedgerStorageAPI['getVotesAfter']> {
		return(notImplemented('getVotesAfter'));
	}

	gc(..._args: Parameters<LedgerStorageAPI['gc']>): ReturnType<LedgerStorageAPI['gc']> {
		return(notImplemented('gc'));
	}

	getNextSerialNumber(..._args: Parameters<LedgerStorageAPI['getNextSerialNumber']>): ReturnType<LedgerStorageAPI['getNextSerialNumber']> {
		return(notImplemented('getNextSerialNumber'));
	}

	getAccountCertificates(..._args: Parameters<LedgerStorageAPI['getAccountCertificates']>): ReturnType<LedgerStorageAPI['getAccountCertificates']> {
		return(notImplemented('getAccountCertificates'));
	}

	getAccountCertificateByHash(..._args: Parameters<LedgerStorageAPI['getAccountCertificateByHash']>): ReturnType<LedgerStorageAPI['getAccountCertificateByHash']> {
		return(notImplemented('getAccountCertificateByHash'));
	}

	getIdempotentBlockHash(..._args: Parameters<LedgerStorageAPI['getIdempotentBlockHash']>): ReturnType<LedgerStorageAPI['getIdempotentBlockHash']> {
		return(notImplemented('getIdempotentBlockHash'));
	}

	stats(..._args: Parameters<LedgerStorageAPI['stats']>): ReturnType<LedgerStorageAPI['stats']> {
		return(notImplemented('stats'));
	}
}
