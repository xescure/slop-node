import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, AccountKeyAlgorithm, GenericAccount, IdentifierAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { GetVotesAfterOptions, IdempotentKey, LedgerSelector, LedgerStorageAPI, ListACLsByEntityFilters, PaginatedVotes } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { ACLRow, ACLUpdate, AccountInfoForType, CertificateWithIntermediates, GetAllBalancesResponse } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { Vote, VoteBlockHash, VoteBlockHashMap, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals } from '../../../upstream/internals.js';
import { assertNever } from '../../../util/assert-never.js';
import { LedgerDriverTransaction, LedgerStorageDriverBase } from '../base.js';
import type { CollectedDeferredStaples, LedgerChecksum, LedgerCountsSnapshot, StrandedDeferredStaple, TransactionOptions } from '../base.js';
import type { AccountInfoUpdate, ConfirmedStapleChange } from '../confirmed.js';
import { createIdempotentKeyError, createLedgerError, HistoryStartNotListed } from '../errors.js';
import { isVoteUnexpired } from '../expiry.js';
import {
	toACLScopeKey,
	toAccountKey,
	toBlockHashKey,
	toCertificateHashKey,
	toIdempotentKeyString,
	toPrincipalKey,
	toStapleKey,
	toVoteKey
} from '../keys.js';
import type { AccountKey, BlockHashKey, IdempotentKeyString, StapleKey, VoteKey } from '../keys.js';
import { DEFAULT_HISTORY_LIMIT, DEFAULT_VOTES_PER_PAGE, compareCatchUpPositions, decodeCatchUpKey, encodeCatchUpKey } from '../paging.js';
import type { CatchUpPosition } from '../paging.js';
import type { AccountInfoRow } from '../rows.js';
import { MemoryBootstrapStage } from '../stage.js';
import type { BootstrapStage } from '../stage.js';
import { compareText } from '../../../util/compare-text.js';
import { commitOverlay, createCommittedLedger, openOverlay } from './state.js';
import type { BalanceRow, CommittedLedger, LedgerOverlay, SideVoteRow, StapleRow, TableOverlay } from './state.js';

const lib = KeetaNet.lib;

type Release = () => void;

/** Hands out one lock at a time, in request order. */
class AsyncMutex {
	#tail: Promise<void> = Promise.resolve();

	acquire(): Promise<Release> {
		const previous = this.#tail;
		let release: Release = function() {
			// Replaced synchronously by the promise executor below.
		};
		const held = new Promise<void>(function(resolve) {
			release = resolve;
		});
		this.#tail = previous.then(function() {
			return(held);
		});
		return(previous.then(function() {
			return(release);
		}));
	}
}

type TransactionState =
	| { readonly status: 'open'; readonly overlay: LedgerOverlay; readonly release: Release }
	| { readonly status: 'finished'; readonly outcome: 'committed' | 'aborted' | 'failed' };

/** A memory transaction: its own view of the ledger, valid until commit or abort. */
export class MemoryTransaction extends LedgerDriverTransaction {
	#state: TransactionState;
	// The overlays of the isolated units now open, innermost last.
	readonly #units: LedgerOverlay[] = [];

	constructor(options: TransactionOptions, overlay: LedgerOverlay, release: Release) {
		super(options);
		this.#state = { status: 'open', overlay, release };
	}

	/**
	 * The transaction's view of the ledger, through the innermost open unit;
	 * rejects once the transaction has ended.
	 */
	view(): Promise<LedgerOverlay> {
		return(new Promise((resolve) => {
			const { overlay } = this.#open();
			resolve(this.#units.at(-1) ?? overlay);
		}));
	}

	/**
	 * Runs a unit over an overlay of its own, which reaches the enclosing view
	 * only if the unit succeeds. The base runs one unit at a time per
	 * transaction, so the innermost overlay always belongs to the unit that
	 * is running.
	 */
	async isolate<Result>(unit: () => Promise<Result>): Promise<Result> {
		const overlay = openOverlay(await this.view());
		this.#units.push(overlay);
		let result: Result;
		try {
			result = await unit();
		} catch (error: unknown) {
			this.#closeUnit(overlay);
			throw(error);
		}
		this.#closeUnit(overlay);
		commitOverlay(overlay);
		return(result);
	}

	/**
	 * Ends the transaction exactly once and releases its lock. The merge runs
	 * first, and the outcome is recorded only once it has succeeded.
	 */
	end(outcome: 'committed' | 'aborted', merge: (overlay: LedgerOverlay) => void): Promise<void> {
		return(new Promise((resolve) => {
			const open = this.#open();
			try {
				merge(open.overlay);
				this.#state = { status: 'finished', outcome };
			} catch (error: unknown) {
				this.#state = { status: 'finished', outcome: 'failed' };
				throw(error);
			} finally {
				open.release();
			}
			resolve();
		}));
	}

	#closeUnit(overlay: LedgerOverlay): void {
		if (this.#units.pop() !== overlay) {
			throw(new Error(`internal error: isolated units of transaction ${this.identifier} closed out of order`));
		}
	}

	#open(): Extract<TransactionState, { status: 'open' }> {
		const state = this.#state;
		switch (state.status) {
			case 'open':
				return(state);
			case 'finished':
				throw(new Error(`transaction ${this.identifier} is already ${state.outcome}`));
			default:
				return(assertNever(state));
		}
	}
}

function sumOf(values: Iterable<bigint>): bigint {
	let total = 0n;
	for (const value of values) {
		total += value;
	}
	return(total);
}

/*
 * After computeLedgerEffect resolves permissions, every update is a SET of
 * the final flags or a delete; an absent target means the whole entity.
 * [Keeta TS] index.js:68503-68522, 68145-68168
 */
function toACLRow(update: ACLUpdate, permissions: NonNullable<ACLUpdate['permissions']>): ACLRow {
	const target = update.target ?? update.entity;
	switch (update.principalType) {
		case 'ACCOUNT':
			return({ principalType: 'ACCOUNT', principal: update.principal, entity: update.entity, target, permissions });
		case 'CERTIFICATE':
			return({ principalType: 'CERTIFICATE', principal: update.principal, entity: update.entity, target, permissions });
		default:
			return(assertNever(update));
	}
}

/** Where a staple sits in history, the same on every node. */
type HistoryOrder = Pick<StapleRow, 'stapleTime' | 'blocksHash'>;

/** A main vote and where it sits in the catch-up order (D8). */
type CatchUpVote = { readonly position: CatchUpPosition; readonly vote: Vote };

/*
 * The staple time is a property of the staple alone, so it orders history
 * the same way however late a node applied each staple; the blocks hash,
 * compared as bytes, breaks ties between equal staple times.
 * [Keeta TS] index.js:82222-82248
 */
function compareHistoryOrder(left: HistoryOrder, right: HistoryOrder): number {
	const byStapleTime = left.stapleTime.getTime() - right.stapleTime.getTime();
	if (byStapleTime !== 0) {
		return(byStapleTime);
	}
	return(left.blocksHash.getBuffer().compare(right.blocksHash.getBuffer()));
}

function rowsOfEntity(overlay: LedgerOverlay, entity: GenericAccount): ACLRow[] {
	const rows: ACLRow[] = [];
	for (const [, scopes] of overlay.acls.entries()) {
		for (const row of scopes.values()) {
			if (row.entity.comparePublicKey(entity)) {
				rows.push(row);
			}
		}
	}
	return(rows);
}

function mergeAccountInfo(row: AccountInfoRow | undefined, update: AccountInfoUpdate): AccountInfoRow {
	const merged: { -readonly [Field in keyof AccountInfoRow]: AccountInfoRow[Field] } = { ...row };
	if (update.name !== undefined) {
		merged.name = update.name;
	}
	if (update.description !== undefined) {
		merged.description = update.description;
	}
	if (update.metadata !== undefined) {
		merged.metadata = update.metadata;
	}
	if (update.defaultPermission !== undefined) {
		merged.defaultBasePermission = update.defaultPermission.base;
		merged.defaultExternalPermission = update.defaultPermission.external;
	}
	if (update.multisigQuorum === null) {
		delete merged.multisigQuorum;
	} else if (update.multisigQuorum !== undefined) {
		merged.multisigQuorum = update.multisigQuorum;
	}
	return(merged);
}

function withEntry<Key, Value>(entries: ReadonlyMap<Key, Value> | undefined, key: Key, value: Value): ReadonlyMap<Key, Value> {
	const copy = new Map(entries);
	copy.set(key, value);
	return(copy);
}

function withoutEntry<Key, Value>(entries: ReadonlyMap<Key, Value> | undefined, key: Key): ReadonlyMap<Key, Value> {
	const copy = new Map(entries);
	copy.delete(key);
	return(copy);
}

function setOrDeleteEntries<TableKey extends string, Key, Value>(table: TableOverlay<TableKey, ReadonlyMap<Key, Value>>, key: TableKey, entries: ReadonlyMap<Key, Value>): void {
	if (entries.size === 0) {
		table.delete(key);
		return;
	}
	table.set(key, entries);
}

function addMember<TableKey extends string, Member>(table: TableOverlay<TableKey, ReadonlySet<Member>>, key: TableKey, member: Member): void {
	const members = new Set(table.get(key));
	members.add(member);
	table.set(key, members);
}

function hasMembers<Member>(members: ReadonlySet<Member> | undefined): boolean {
	return((members?.size ?? 0) > 0);
}

/** Removes the row once its last member is gone. */
function removeMember<TableKey extends string, Member>(table: TableOverlay<TableKey, ReadonlySet<Member>>, key: TableKey, member: Member): void {
	const members = new Set(table.get(key));
	members.delete(member);
	if (members.size === 0) {
		table.delete(key);
		return;
	}
	table.set(key, members);
}

/*
 * Under 'both' the main ledger answers whenever it has an answer, so whatever
 * has been confirmed reads as confirmed; the side ledger answers only for
 * what is still pending.
 */
function fromSelected<Result>(from: LedgerSelector, readMain: () => Result | null, readSide: () => Result | null): Result | null {
	switch (from) {
		case 'main':
			return(readMain());
		case 'side':
			return(readSide());
		case 'both':
			return(readMain() ?? readSide());
		default:
			return(assertNever(from));
	}
}

/** A pending successor, with when the vote naming it was issued. */
type PendingSuccessor = {
	readonly block: Block;
	readonly issued: number;
};

function isIssuedLater(candidate: PendingSuccessor, current: PendingSuccessor): boolean {
	if (candidate.issued !== current.issued) {
		return(candidate.issued > current.issued);
	}
	return(toBlockHashKey(candidate.block.hash) > toBlockHashKey(current.block.hash));
}

function nullWhenEmpty<Item>(items: Item[]): Item[] | null {
	if (items.length === 0) {
		return(null);
	}
	return(items);
}

/** [Keeta TS] index.js:69956-69987 */
function idempotentKeyOf(block: Block): IdempotentKeyString | undefined {
	if (block.idempotent === undefined) {
		return(undefined);
	}
	return(toIdempotentKeyString(LedgerInternals.IdempotentKey.fromAccountAndIdempotent(block.account, block.idempotent)));
}

/**
 * The reference driver: the whole ledger in memory, with transactions
 * serialized by one lock and isolated by a copy-on-write overlay. Nothing
 * survives the instance, so a fresh instance is a fresh node.
 */
export class MemoryLedgerStorage extends LedgerStorageDriverBase<MemoryTransaction> implements LedgerStorageAPI {
	readonly #committed: CommittedLedger = createCommittedLedger();
	readonly #lock = new AsyncMutex();
	// Lives outside every transaction, so an aborted attempt's serial is never issued again.
	#nextSerial = 1n;
	#nextVoteSequence = 0n;
	readonly #stage = new MemoryBootstrapStage();

	async beginTransaction(options: TransactionOptions): Promise<MemoryTransaction> {
		const release = await this.#lock.acquire();
		return(new MemoryTransaction(options, openOverlay(this.#committed), release));
	}

	protected commitStorage(transaction: MemoryTransaction): Promise<void> {
		return(transaction.end('committed', commitOverlay));
	}

	abortTransaction(transaction: MemoryTransaction): Promise<void> {
		return(transaction.end('aborted', function() {
			// Dropping the overlay is the whole of an abort.
		}));
	}

	protected override runIsolated<Result>(transaction: MemoryTransaction, unit: () => Promise<Result>): Promise<Result> {
		return(transaction.isolate(unit));
	}

	getNextSerialNumber(_transaction?: MemoryTransaction): Promise<bigint> {
		const serial = this.#nextSerial;
		this.#nextSerial += 1n;
		return(Promise.resolve(serial));
	}

	async delegatedWeight(transaction: MemoryTransaction, representative?: Parameters<LedgerStorageAPI['delegatedWeight']>[1]): Promise<bigint> {
		const { weights } = await transaction.view();
		if (representative === undefined) {
			return(sumOf(Array.from(weights.entries(), function([, weight]): bigint {
				return(weight);
			})));
		}
		if (lib.Account.isInstance(representative)) {
			return(weights.get(toAccountKey(representative)) ?? 0n);
		}
		// Account.Set holds each account once, so no representative counts twice.
		return(sumOf(Array.from(representative, function(account): bigint {
			return(weights.get(toAccountKey(account)) ?? 0n);
		})));
	}

	async getBalance(transaction: MemoryTransaction, account: GenericAccount, token: TokenAddress): Promise<bigint> {
		const { balances } = await transaction.view();
		return(balances.get(toAccountKey(account))?.get(toAccountKey(token))?.balance ?? 0n);
	}

	async getAllBalances(transaction: MemoryTransaction, account: GenericAccount): Promise<GetAllBalancesResponse> {
		const { balances } = await transaction.view();
		const rows = Array.from(balances.get(toAccountKey(account))?.values() ?? []);
		return(rows.filter(function(row): boolean {
			return(row.balance !== 0n);
		}).map(function({ token, balance }) {
			return({ token, balance });
		}));
	}

	async getAccountInfo<T extends AccountKeyAlgorithm = AccountKeyAlgorithm>(transaction: MemoryTransaction, account: Account<T> | string): Promise<AccountInfoForType<T>> {
		const { accountInfo } = await transaction.view();
		const resolved = resolveAccount(account);
		return(this._formatAccountInfoFromRow(resolved, accountInfo.get(toAccountKey(resolved))));
	}

	async getAccountRep(transaction: MemoryTransaction, account: GenericAccount | string): Promise<Account | null> {
		const { representatives } = await transaction.view();
		return(representatives.get(toAccountKey(account)) ?? null);
	}

	async listACLsByPrincipal(transaction: MemoryTransaction, principal: ACLRow['principal'], entityList?: GenericAccount[]): Promise<ACLRow[]> {
		const { acls } = await transaction.view();
		const rows = Array.from(acls.get(toPrincipalKey(principal))?.values() ?? []);
		if (entityList === undefined) {
			return(rows);
		}
		const entities = new Set<AccountKey>(entityList.map(function(entity): AccountKey {
			return(toAccountKey(entity));
		}));
		return(rows.filter(function(row): boolean {
			return(entities.has(toAccountKey(row.entity)));
		}));
	}

	async getAccountCertificateByHash(transaction: MemoryTransaction, account: GenericAccount, hash: Parameters<LedgerStorageAPI['getAccountCertificateByHash']>[2]): Promise<CertificateWithIntermediates | null> {
		const { certificates } = await transaction.view();
		return(certificates.get(toAccountKey(account))?.get(toCertificateHashKey(hash)) ?? null);
	}

	async getBlock(transaction: MemoryTransaction, hash: BlockHash, from: LedgerSelector): Promise<Block | null> {
		const overlay = await transaction.view();
		const key = toBlockHashKey(hash);
		return(fromSelected(from, function() {
			return(overlay.blocks.get(key)?.block ?? null);
		}, () => {
			return(this.#sideBlock(overlay, key, transaction.moment));
		}));
	}

	async getBlockHeight(transaction: MemoryTransaction, hash: BlockHash, account: GenericAccount): Promise<bigint | null> {
		const { blocks } = await transaction.view();
		const row = blocks.get(toBlockHashKey(hash));
		if (row === undefined || !row.block.account.comparePublicKey(account)) {
			return(null);
		}
		return(row.height);
	}

	/*
	 * Heads are main-chain only, even under 'both': a side block as head would
	 * make the permanent vote for that very block fail its successor check.
	 * [Keeta TS] index.js:70296-70312
	 */
	async getHeadBlocks(transaction: MemoryTransaction, accounts: GenericAccount[], from: LedgerSelector): Promise<{ [account: string]: Block | null }> {
		const overlay = await transaction.view();
		const heads: { [account: string]: Block | null } = {};
		for (const account of accounts) {
			const key = toAccountKey(account);
			heads[key] = this.#headBlock(overlay, key, from);
		}
		return(heads);
	}

	/*
	 * Voting refuses a competing successor while our vote on another is
	 * unexpired, so when a vote is issued its block is the only pending
	 * successor. A stale moment can still see an expired vote's block beside
	 * the block voted on after it expired; the most recently issued vote
	 * names the successor, and the block hash breaks ties, so the answer
	 * never depends on storage order.
	 * [Keeta TS] index.js:70317-70342
	 */
	async getBlockFromPrevious(transaction: MemoryTransaction, previous: BlockHash, from: LedgerSelector): Promise<Block | null> {
		const overlay = await transaction.view();
		const previousKey = toBlockHashKey(previous);
		return(fromSelected(from, () => {
			const successor = overlay.successors.get(previousKey);
			if (successor === undefined) {
				return(null);
			}
			return(this.#confirmedBlock(overlay, successor));
		}, () => {
			let newest: PendingSuccessor | null = null;
			for (const row of this.#unexpiredSideVoteRows(overlay, overlay.sideVotesByPrevious.get(previousKey), transaction.moment)) {
				for (const block of row.blocks) {
					const successor = this.#sideBlock(overlay, toBlockHashKey(block.hash), transaction.moment);
					if (successor === null || toBlockHashKey(successor.previous) !== previousKey) {
						continue;
					}
					const candidate = { block: successor, issued: row.vote.validityFrom.getTime() };
					if (newest === null || isIssuedLater(candidate, newest)) {
						newest = candidate;
					}
				}
			}
			return(newest?.block ?? null);
		}));
	}

	/*
	 * Absent is null, never an empty list: upstream reads the first vote's
	 * blocks of any non-null result.
	 * [Keeta TS] index.js:70613-70616
	 */
	async getVotes(transaction: MemoryTransaction, hash: BlockHash, from: LedgerSelector): Promise<Vote[] | null> {
		const overlay = await transaction.view();
		const key = toBlockHashKey(hash);
		return(fromSelected(from, () => {
			const row = overlay.blocks.get(key);
			if (row === undefined) {
				return(null);
			}
			return(Array.from(this.#confirmedStaple(overlay, row.staple).votes.values()));
		}, () => {
			return(nullWhenEmpty(this.#unexpiredSideVoteRows(overlay, overlay.sideVotesByBlock.get(key), transaction.moment).map(function(row): Vote {
				return(row.vote);
			})));
		}));
	}

	/*
	 * Voting reads this under 'both' with its own key as the issuer, and may
	 * replace only a single unexpired temporary vote of its own; an expired vote
	 * left in the answer would block the account until it is collected.
	 * [Keeta TS] index.js:70317-70342
	 */
	async getVotesFromMultiplePrevious(transaction: MemoryTransaction, previousBlocks: BlockHash[], from: LedgerSelector, issuer?: Account): Promise<{ [hash: string]: Vote[] | null }> {
		const overlay = await transaction.view();
		const votes: { [hash: string]: Vote[] | null } = {};
		for (const previous of previousBlocks) {
			const previousKey = toBlockHashKey(previous);
			votes[previousKey] = fromSelected(from, () => {
				return(this.#successorVotes(overlay, previous, issuer));
			}, () => {
				return(nullWhenEmpty(this.#unexpiredSideVoteRows(overlay, overlay.sideVotesByPrevious.get(previousKey), transaction.moment).map(function(row): Vote {
					return(row.vote);
				}).filter(function(vote): boolean {
					return(issuer === undefined || vote.issuer.comparePublicKey(issuer));
				})));
			});
		}
		return(votes);
	}

	/*
	 * Staples are identified by the hash of their blocks, and every requested
	 * hash gets an entry: upstream reads each one back and treats a missing
	 * entry as an internal error.
	 * [Keeta TS] index.js:70548-70584
	 */
	async getVoteStaples(transaction: MemoryTransaction, voteBlockHashes: VoteBlockHash[], from: LedgerSelector): Promise<VoteBlockHashMap<VoteStaple | null>> {
		const overlay = await transaction.view();
		const staples = new lib.Vote.VoteBlocksHash.Map<VoteStaple | null>();
		for (const voteBlockHash of voteBlockHashes) {
			const key = toStapleKey(voteBlockHash);
			staples.set(voteBlockHash, fromSelected(from, () => {
				const row = overlay.staples.get(key);
				if (row === undefined) {
					return(null);
				}
				return(this.#voteStapleOf(row));
			}, () => {
				return(this.#sideStaple(overlay, key, transaction.moment));
			}));
		}
		return(staples);
	}

	protected async listMainStaplesHolding(transaction: MemoryTransaction, blocks: readonly BlockHash[]): Promise<readonly VoteBlockHash[]> {
		const overlay = await transaction.view();
		const holding = new Map<StapleKey, VoteBlockHash>();
		for (const block of blocks) {
			const row = overlay.blocks.get(toBlockHashKey(block));
			if (row !== undefined && !holding.has(row.staple)) {
				holding.set(row.staple, this.#confirmedStaple(overlay, row.staple).blocksHash);
			}
		}
		return([...holding.values()]);
	}

	/*
	 * Newest first by staple time. The start is exclusive, so a caller can
	 * pass the last staple of one page to get the next. A start that is no
	 * entry of an account's history is refused, and one outside the whole
	 * ledger's history gives nothing (D8).
	 * [Keeta TS] index.js:70568-70584, 59982-59984, 82222-82248
	 */
	async getHistory(transaction: MemoryTransaction, account: GenericAccount | null, start: VoteBlockHash | null, limit: number = DEFAULT_HISTORY_LIMIT): Promise<VoteBlockHash[]> {
		const overlay = await transaction.view();
		const newestFirst = this.#historyOf(overlay, account).sort(function(left, right): number {
			return(compareHistoryOrder(right, left));
		});
		let first = 0;
		if (start !== null) {
			const startKey = toStapleKey(start);
			const position = newestFirst.findIndex(function(row): boolean {
				return(toStapleKey(row.blocksHash) === startKey);
			});
			if (position < 0 && account !== null) {
				throw(new HistoryStartNotListed(account, start));
			}
			if (position < 0) {
				return([]);
			}
			first = position + 1;
		}
		return(newestFirst.slice(first, first + limit).map(function(row): VoteBlockHash {
			return(row.blocksHash);
		}));
	}

	/*
	 * The votes of main staples made at or after the moment, by when each was
	 * made, then by the sequence it was stored with, in pages of at most the
	 * page size, rounded up, as upstream asks for 32 times a fractional
	 * remaining limit; a page holds at least one vote while any remains. The
	 * key is omitted on the last page, because the caller stops only when it
	 * is undefined (D8).
	 * [Keeta TS] index.js:70669-70738
	 */
	async getVotesAfter(transaction: MemoryTransaction, moment: Date, startKey?: string, options?: GetVotesAfterOptions): Promise<PaginatedVotes> {
		const overlay = await transaction.view();
		const maximumVotes = Math.max(Math.ceil(options?.maxVotesPerPage ?? DEFAULT_VOTES_PER_PAGE), 1);
		let resumeAfter: CatchUpPosition | undefined;
		if (startKey !== undefined) {
			resumeAfter = decodeCatchUpKey(startKey);
		}
		const remaining: CatchUpVote[] = [];
		for (const row of this.#confirmedStaples(overlay)) {
			let sequence = row.firstVote;
			for (const vote of row.votes.values()) {
				const position = { validityFrom: vote.validityFrom, sequence };
				sequence++;
				if (vote.validityFrom.getTime() < moment.getTime() || (resumeAfter !== undefined && compareCatchUpPositions(position, resumeAfter) <= 0)) {
					continue;
				}
				remaining.push({ position, vote });
			}
		}
		remaining.sort(function(left, right): number {
			return(compareCatchUpPositions(left.position, right.position));
		});
		const taken = remaining.slice(0, maximumVotes);
		const page: PaginatedVotes = {
			votes: taken.map(function({ vote }): Vote {
				return(vote);
			})
		};
		const last = taken.at(-1);
		if (last !== undefined && taken.length < remaining.length) {
			page.nextKey = encodeCatchUpKey(last.position);
		}
		return(page);
	}

	/*
	 * The holder of a key other than the block the caller asked to exclude:
	 * voting excludes the block it is voting on, so a permanent vote can
	 * follow the temporary vote that put the key on the side ledger. A side
	 * block holds its key only while a vote of ours on it is unexpired.
	 * [Keeta TS] index.js:70290-70295, 70747-70752
	 */
	async getIdempotentBlockHash(transaction: MemoryTransaction, idempotent: IdempotentKey, from: LedgerSelector, excludeBlockHash?: BlockHash): Promise<BlockHash | null> {
		const overlay = await transaction.view();
		const key = toIdempotentKeyString(idempotent);
		function isExcluded(hash: BlockHash): boolean {
			return(excludeBlockHash !== undefined && hash.compare(excludeBlockHash));
		}
		return(fromSelected(from, function() {
			const holder = overlay.idempotentKeys.get(key);
			if (holder === undefined || isExcluded(holder)) {
				return(null);
			}
			return(holder);
		}, () => {
			for (const blockKey of overlay.sideIdempotentKeys.get(key) ?? []) {
				const holder = this.#sideBlock(overlay, blockKey, transaction.moment);
				if (holder !== null && !isExcluded(holder.hash)) {
					return(holder.hash);
				}
			}
			return(null);
		}));
	}

	/*
	 * Distinct accounts holding OWNER on the identifier: the ledger requires
	 * exactly one owner to remain, so a principal listed twice would refuse a
	 * valid staple. Certificates cannot own an identifier.
	 * [Keeta TS] index.js:71082-71114
	 */
	async listOwners(transaction: MemoryTransaction, identifier: IdentifierAddress, target?: GenericAccount): Promise<GenericAccount[]> {
		const overlay = await transaction.view();
		const owners = new Map<AccountKey, GenericAccount>();
		for (const row of rowsOfEntity(overlay, identifier)) {
			if (row.principalType !== 'ACCOUNT' || !row.permissions.has(['OWNER'])) {
				continue;
			}
			if (target !== undefined && !row.target.comparePublicKey(target)) {
				continue;
			}
			owners.set(toAccountKey(row.principal), row.principal);
		}
		return(Array.from(owners.values()));
	}

	async listACLsByEntity(transaction: MemoryTransaction, entity: GenericAccount, options?: ListACLsByEntityFilters): Promise<ACLRow[]> {
		const overlay = await transaction.view();
		const principalType = options?.principalType;
		return(rowsOfEntity(overlay, entity).filter(function(row): boolean {
			return(principalType === undefined || row.principalType === principalType);
		}));
	}

	async getAccountCertificates(transaction: MemoryTransaction, account: GenericAccount): Promise<CertificateWithIntermediates[]> {
		const { certificates } = await transaction.view();
		return(Array.from(certificates.get(toAccountKey(account))?.values() ?? []));
	}

	/*
	 * Voting stores each vote it issues here, a temporary vote and later the
	 * permanent one for the same blocks plus a fee block; the permanent vote
	 * is added beside the temporary vote, which stays until it expires. The
	 * writes land together as a unit of their own, taken in the transaction's
	 * turn so that they never join a unit that is open and may still fail.
	 * [Keeta TS] index.js:70346-70352, 70378-70390
	 */
	async addPendingVote(transaction: MemoryTransaction, staple: VoteStaple): Promise<void> {
		await this.runIsolatedInTurn(transaction, async () => {
			const overlay = await transaction.view();
			for (const vote of staple.votes) {
				this.#writeSideVote(overlay, vote, staple.blocks);
			}
		});
	}

	/*
	 * Read from the committed state, outside any transaction: commits apply
	 * without yielding, so the snapshot is exact and its moment has no range.
	 */
	protected countLedger(): Promise<LedgerCountsSnapshot> {
		const committed = this.#committed;
		let transactionCount = 0;
		for (const row of committed.blocks.values()) {
			transactionCount += row.block.operations.length;
		}
		let representativeCount = 0;
		for (const weight of committed.weights.values()) {
			if (weight > 0n) {
				representativeCount++;
			}
		}
		return(Promise.resolve({
			moment: new Date(),
			momentRange: 0,
			blockCount: committed.blocks.size,
			transactionCount,
			representativeCount
		}));
	}

	bootstrapStage(): BootstrapStage {
		return(this.#stage);
	}

	/* Read from the committed state, as the counts are. */
	listStrandedDeferredStaples(before: Date, limit: number, after?: StrandedDeferredStaple): Promise<readonly StrandedDeferredStaple[]> {
		const committed = this.#committed;
		const stranded: { readonly latestVote: number; readonly key: StapleKey; readonly found: StrandedDeferredStaple }[] = [];
		for (const [key, row] of committed.deferredStaples.entries()) {
			const latestVote = Math.max(...row.staple.votes.map(function(vote): number {
				return(vote.validityFrom.getTime());
			}));
			const lacked = new Set(row.waitingOn.filter(function(blockKey): boolean {
				return(committed.blocks.get(blockKey) === undefined);
			}));
			if (latestVote >= before.getTime() || lacked.size === 0) {
				continue;
			}
			// The keys name previous blocks of the staple's own blocks, whose hashes it holds.
			const lacks = new Map<BlockHashKey, BlockHash>();
			for (const block of row.staple.blocks) {
				const previousKey = toBlockHashKey(block.previous);
				if (lacked.has(previousKey)) {
					lacks.set(previousKey, block.previous);
				}
			}
			stranded.push({ latestVote, key, found: { staple: row.staple, latestVote: new Date(latestVote), lacks: [...lacks.entries()].sort(compareKeyed).map(function([, hash]): BlockHash {
				return(hash);
			}) } });
		}
		const order = function(left: { readonly latestVote: number; readonly key: string }, right: { readonly latestVote: number; readonly key: string }): number {
			return(left.latestVote - right.latestVote || compareText(left.key, right.key));
		};
		stranded.sort(order);
		let from = { latestVote: Number.NEGATIVE_INFINITY, key: '' };
		if (after !== undefined) {
			from = { latestVote: after.latestVote.getTime(), key: toStapleKey(after.staple.blocksHash) };
		}
		return(Promise.resolve(stranded.filter(function(entry): boolean {
			return(order(entry, from) > 0);
		}).slice(0, limit).map(function({ found }): StrandedDeferredStaple {
			return(found);
		})));
	}

	/* Read from the committed state, as the counts are. */
	ledgerChecksum(): Promise<LedgerChecksum> {
		return(Promise.resolve({ moment: new Date(), momentRange: 0, checksum: this.#committed.ledgerChecksum.get('main') ?? 0n }));
	}

	/*
	 * The writes are staged over the transaction and land together, so a
	 * change that fails part-way leaves the transaction as it was.
	 */
	protected async persistConfirmedStaple(transaction: MemoryTransaction, change: ConfirmedStapleChange): Promise<void> {
		const overlay = openOverlay(await transaction.view());
		this.#assertIdempotentKeysFree(overlay, change);
		const stapleKey = this.#writeStaple(overlay, change);
		this.#writeBalances(overlay, change);
		this.#writeSupplies(overlay, change);
		this.#writeWeights(overlay, change);
		this.#writeDelegations(overlay, change);
		this.#writePermissions(overlay, change);
		this.#writeAccountInfo(overlay, change);
		this.#writeCertificates(overlay, change);
		this.#writeIdempotentKeys(overlay, change);
		this.#writeAccountsAndHistory(overlay, change, stapleKey);
		this.#promoteSideRows(overlay, change);
		commitOverlay(overlay);
	}

	protected async storeDeferredStaple(transaction: MemoryTransaction, staple: VoteStaple, waitingOn: readonly BlockHash[]): Promise<void> {
		const overlay = await transaction.view();
		const key = toStapleKey(staple.blocksHash);
		this.#forgetDeferredStaple(overlay, key);
		const waitingKeys = waitingOn.map(toBlockHashKey);
		overlay.deferredStaples.set(key, { staple, waitingOn: waitingKeys });
		for (const blockKey of waitingKeys) {
			addMember(overlay.deferredWaiters, blockKey, key);
		}
	}

	protected async listDeferredStaplesWaitingOn(transaction: MemoryTransaction, blockHashes: readonly BlockHash[]): Promise<readonly VoteStaple[]> {
		const overlay = await transaction.view();
		const found = new Map<StapleKey, VoteStaple>();
		for (const hash of blockHashes) {
			for (const key of overlay.deferredWaiters.get(toBlockHashKey(hash)) ?? []) {
				const row = overlay.deferredStaples.get(key);
				if (row !== undefined) {
					found.set(key, row.staple);
				}
			}
		}
		return(Array.from(found.values()));
	}

	protected async removeDeferredStaple(transaction: MemoryTransaction, blocksHash: StapleKey): Promise<void> {
		this.#forgetDeferredStaple(await transaction.view(), blocksHash);
	}

	protected async listReleasedDeferredStaples(transaction: MemoryTransaction, limit: number, exclude: ReadonlySet<StapleKey>): Promise<readonly VoteStaple[]> {
		const overlay = await transaction.view();
		const released: VoteStaple[] = [];
		for (const [key, row] of overlay.deferredStaples.entries()) {
			if (released.length >= limit) {
				break;
			}
			if (exclude.has(key)) {
				continue;
			}
			if (row.waitingOn.every(function(blockKey): boolean {
				return(overlay.blocks.get(blockKey) !== undefined);
			})) {
				released.push(row.staple);
			}
		}
		return(released);
	}

	protected async collectDeadDeferredStaples(transaction: MemoryTransaction, limit: number): Promise<CollectedDeferredStaples> {
		const overlay = await transaction.view();
		const dead: [StapleKey, VoteStaple][] = [];
		for (const [key, row] of overlay.deferredStaples.entries()) {
			if (row.staple.blocks.some(function(block): boolean {
				return(overlay.successors.get(toBlockHashKey(block.previous)) !== undefined);
			})) {
				dead.push([key, row.staple]);
			}
		}
		const collected = dead.slice(0, limit);
		for (const [key] of collected) {
			this.#forgetDeferredStaple(overlay, key);
		}
		return({
			collected: collected.map(function([, staple]): VoteStaple {
				return(staple);
			}),
			more: dead.length > limit
		});
	}

	protected async countOrphanedSideRows(transaction: MemoryTransaction): Promise<number> {
		const overlay = await transaction.view();
		const uncovered = new Set<BlockHashKey>();
		for (const [blockKey] of overlay.sideBlocks.entries()) {
			// An index entry left empty covers nothing, as one never written does.
			if (overlay.blocks.get(blockKey) !== undefined || !hasMembers(overlay.sideVotesByBlock.get(blockKey))) {
				uncovered.add(blockKey);
			}
		}
		let orphaned = uncovered.size;
		for (const [, blockKeys] of overlay.sideIdempotentKeys.entries()) {
			for (const blockKey of blockKeys) {
				if (uncovered.has(blockKey) || overlay.sideBlocks.get(blockKey) === undefined) {
					orphaned++;
				}
			}
		}
		return(orphaned);
	}

	protected async collectObsoleteSideVotes(transaction: MemoryTransaction, limit: number): Promise<boolean> {
		const overlay = await transaction.view();
		const obsolete: VoteKey[] = [];
		for (const [key, row] of overlay.sideVotes.entries()) {
			// A block whose previous already has a confirmed successor is on
			// main itself or competes with what is: either way the staple can
			// never be added.
			if (!isVoteUnexpired(row.vote, transaction.moment) || row.blocks.some(function(block): boolean {
				return(overlay.successors.get(toBlockHashKey(block.previous)) !== undefined);
			})) {
				obsolete.push(key);
			}
		}
		for (const key of obsolete.slice(0, limit)) {
			this.#collectSideVote(overlay, key);
		}
		return(obsolete.length > limit);
	}

	#forgetDeferredStaple(overlay: LedgerOverlay, key: StapleKey): void {
		const row = overlay.deferredStaples.get(key);
		if (row === undefined) {
			return;
		}
		overlay.deferredStaples.delete(key);
		for (const blockKey of row.waitingOn) {
			removeMember(overlay.deferredWaiters, blockKey, key);
		}
	}

	/*
	 * A block already on main gets no side copy: main answers for it, and its
	 * idempotent key is already held there.
	 */
	#writeSideVote(overlay: LedgerOverlay, vote: Vote, blocks: readonly Block[]): void {
		const key = toVoteKey(vote);
		this.#forgetSideVote(overlay, key);
		overlay.sideVotes.set(key, { vote, blocks });
		addMember(overlay.sideVotesByStaple, toStapleKey(vote.blocksHash), key);
		for (const block of blocks) {
			const blockKey = toBlockHashKey(block.hash);
			addMember(overlay.sideVotesByBlock, blockKey, key);
			addMember(overlay.sideVotesByPrevious, toBlockHashKey(block.previous), key);
			if (overlay.blocks.get(blockKey) !== undefined) {
				continue;
			}
			overlay.sideBlocks.set(blockKey, block);
			const idempotentKey = idempotentKeyOf(block);
			if (idempotentKey !== undefined) {
				addMember(overlay.sideIdempotentKeys, idempotentKey, blockKey);
			}
		}
	}

	/** Drops a pending vote and its links; the side blocks it covered stay. */
	#forgetSideVote(overlay: LedgerOverlay, key: VoteKey): void {
		const row = overlay.sideVotes.get(key);
		if (row === undefined) {
			return;
		}
		overlay.sideVotes.delete(key);
		removeMember(overlay.sideVotesByStaple, toStapleKey(row.vote.blocksHash), key);
		for (const block of row.blocks) {
			removeMember(overlay.sideVotesByBlock, toBlockHashKey(block.hash), key);
			removeMember(overlay.sideVotesByPrevious, toBlockHashKey(block.previous), key);
		}
	}

	/** Drops a pending vote, then each side block it covered that no other pending vote covers. */
	#collectSideVote(overlay: LedgerOverlay, key: VoteKey): void {
		const row = overlay.sideVotes.get(key);
		if (row === undefined) {
			return;
		}
		this.#forgetSideVote(overlay, key);
		for (const block of row.blocks) {
			if (overlay.sideVotesByBlock.get(toBlockHashKey(block.hash)) === undefined) {
				this.#dropSideBlock(overlay, block);
			}
		}
	}

	#dropSideBlock(overlay: LedgerOverlay, block: Block): void {
		const blockKey = toBlockHashKey(block.hash);
		overlay.sideBlocks.delete(blockKey);
		const idempotentKey = idempotentKeyOf(block);
		if (idempotentKey !== undefined) {
			removeMember(overlay.sideIdempotentKeys, idempotentKey, blockKey);
		}
	}

	/*
	 * A confirmed row exists once, on main, so the side copies of the staple's
	 * blocks and of any of its votes that we issued are dropped. Every other
	 * pending vote stays until gc collects it: our temporary vote on these
	 * blocks, which settlement statistics were measured from, and our votes on
	 * blocks that compete with them.
	 */
	#promoteSideRows(overlay: LedgerOverlay, change: ConfirmedStapleChange): void {
		for (const vote of change.staple.votes) {
			this.#forgetSideVote(overlay, toVoteKey(vote));
		}
		for (const block of change.staple.blocks) {
			this.#dropSideBlock(overlay, block);
		}
	}

	/*
	 * Expiry is judged at the transaction's moment, so every read in one
	 * transaction agrees, and nothing depends on expired votes having been
	 * collected. A vote issued after that moment still counts: the moment
	 * may be stale, and hiding the vote could let the node sign a competitor.
	 */
	#unexpiredSideVoteRows(overlay: LedgerOverlay, keys: Iterable<VoteKey> | undefined, moment: Date): SideVoteRow[] {
		const rows: SideVoteRow[] = [];
		for (const key of keys ?? []) {
			const row = overlay.sideVotes.get(key);
			if (row === undefined) {
				throw(new Error(`internal error: pending vote ${key} is indexed but not stored`));
			}
			if (isVoteUnexpired(row.vote, moment)) {
				rows.push(row);
			}
		}
		return(rows);
	}

	/** A side block counts only while a vote of ours on it is unexpired. */
	#sideBlock(overlay: LedgerOverlay, key: BlockHashKey, moment: Date): Block | null {
		const block = overlay.sideBlocks.get(key);
		if (block === undefined || this.#unexpiredSideVoteRows(overlay, overlay.sideVotesByBlock.get(key), moment).length === 0) {
			return(null);
		}
		return(block);
	}

	/*
	 * A staple holds votes of one permanence only, so permanent votes, when
	 * there are any, are preferred over temporary ones for the same blocks.
	 * [Keeta TS] index.js:81947-81979
	 */
	#sideStaple(overlay: LedgerOverlay, key: StapleKey, moment: Date): VoteStaple | null {
		const unexpired = this.#unexpiredSideVoteRows(overlay, overlay.sideVotesByStaple.get(key), moment);
		let chosen = unexpired.filter(function(row): boolean {
			return(row.vote.$permanent);
		});
		if (chosen.length === 0) {
			chosen = unexpired;
		}
		const [first] = chosen;
		if (first === undefined) {
			return(null);
		}
		return(lib.Vote.Staple.fromVotesAndBlocks(chosen.map(function(row): Vote {
			return(row.vote);
		}), [...first.blocks]));
	}

	#successorVotes(overlay: LedgerOverlay, previous: BlockHash, issuer: Account | undefined): Vote[] | null {
		const successor = overlay.successors.get(toBlockHashKey(previous));
		if (successor === undefined) {
			return(null);
		}
		const row = overlay.blocks.get(successor);
		if (row === undefined) {
			throw(new Error(`internal error: confirmed block ${successor} is referenced but not stored`));
		}
		const votes = Array.from(this.#confirmedStaple(overlay, row.staple).votes.values()).filter(function(vote): boolean {
			return(issuer === undefined || vote.issuer.comparePublicKey(issuer));
		});
		if (votes.length === 0) {
			return(null);
		}
		return(votes);
	}

	/** The staple as the bytes it was received as, which the network names it by (schema/migrations/0003_staple_bytes.sql). */
	#voteStapleOf(row: StapleRow): VoteStaple {
		return(new lib.Vote.Staple(row.bytes));
	}

	#historyOf(overlay: LedgerOverlay, account: GenericAccount | null): StapleRow[] {
		if (account === null) {
			return(this.#confirmedStaples(overlay));
		}
		return((overlay.history.get(toAccountKey(account)) ?? []).map((key): StapleRow => {
			return(this.#confirmedStaple(overlay, key));
		}));
	}

	#confirmedStaples(overlay: LedgerOverlay): StapleRow[] {
		return(Array.from(overlay.staples.entries(), function([, row]): StapleRow {
			return(row);
		}));
	}

	#headBlock(overlay: LedgerOverlay, account: AccountKey, from: LedgerSelector): Block | null {
		switch (from) {
			case 'side':
				return(null);
			case 'main':
			case 'both': {
				const head = overlay.chainHeads.get(account);
				if (head === undefined) {
					return(null);
				}
				return(this.#confirmedBlock(overlay, head));
			}
			default:
				return(assertNever(from));
		}
	}

	/** -1 for an account without a chain, so its opening block becomes the head. */
	#headHeight(overlay: LedgerOverlay, account: AccountKey): bigint {
		const head = overlay.chainHeads.get(account);
		if (head === undefined) {
			return(-1n);
		}
		return(overlay.blocks.get(head)?.height ?? -1n);
	}

	#confirmedBlock(overlay: LedgerOverlay, hash: BlockHashKey): Block {
		const row = overlay.blocks.get(hash);
		if (row === undefined) {
			throw(new Error(`internal error: confirmed block ${hash} is referenced but not stored`));
		}
		return(row.block);
	}

	#confirmedStaple(overlay: LedgerOverlay, key: StapleKey): StapleRow {
		const row = overlay.staples.get(key);
		if (row === undefined) {
			throw(new Error(`internal error: confirmed staple ${key} is referenced but not stored`));
		}
		return(row);
	}

	/*
	 * Two different confirmed blocks may not claim one idempotent key.
	 * [Keeta TS] index.js:70290-70295
	 */
	#assertIdempotentKeysFree(overlay: LedgerOverlay, change: ConfirmedStapleChange): void {
		const claimed = new Map<IdempotentKeyString, BlockHash>();
		for (const { key, block, idempotent } of change.idempotentKeys) {
			const existing = claimed.get(key) ?? overlay.idempotentKeys.get(key);
			if (existing !== undefined && !existing.compare(block.hash)) {
				throw(createIdempotentKeyError({ blockHash: block.hash, existingBlockHash: existing, account: block.account, idempotent }));
			}
			claimed.set(key, block.hash);
		}
	}

	#writeStaple(overlay: LedgerOverlay, change: ConfirmedStapleChange): StapleKey {
		const { staple, blockHeights } = change;
		const stapleKey = toStapleKey(staple.blocksHash);
		const votes = new Map<VoteKey, Vote>();
		for (const vote of staple.votes) {
			votes.set(toVoteKey(vote), vote);
		}
		overlay.staples.set(stapleKey, {
			blocksHash: staple.blocksHash,
			votes,
			bytes: staple.toBytes(),
			stapleTime: staple.timestamp(),
			firstVote: this.#takeVoteSequences(votes.size),
			checksum: change.checksum
		});
		overlay.ledgerChecksum.set('main', (overlay.ledgerChecksum.get('main') ?? 0n) ^ change.checksum);

		for (const block of staple.blocks) {
			const blockKey = toBlockHashKey(block.hash);
			const height = blockHeights.get(blockKey);
			if (height === undefined) {
				throw(new Error(`internal error: no height for block ${blockKey}`));
			}
			const previousKey = toBlockHashKey(block.previous);
			// Confirmed history is never overwritten, even if the earlier check raced.
			if (overlay.blocks.get(blockKey) !== undefined) {
				throw(createLedgerError('LEDGER_BLOCK_ALREADY_EXISTS', `Block Already Exists: ${blockKey}`));
			}
			const successor = overlay.successors.get(previousKey);
			if (successor !== undefined) {
				throw(this.confirmedHistoryConflict(block, `previous already has the confirmed successor ${successor}`));
			}
			overlay.blocks.set(blockKey, { block, height, staple: stapleKey });
			overlay.successors.set(previousKey, blockKey);
			const account = toAccountKey(block.account);
			if (this.#headHeight(overlay, account) < height) {
				overlay.chainHeads.set(account, blockKey);
			}
		}
		return(stapleKey);
	}

	/*
	 * Changes are deltas. Stored balances may go negative while a funding
	 * staple is missing, and are kept exactly as computed.
	 * [Keeta TS] index.js:68546-68572
	 */
	#writeBalances(overlay: LedgerOverlay, change: ConfirmedStapleChange): void {
		for (const [accountPublicKey, tokens] of Object.entries(change.ledgerEffect.balances)) {
			const account = toAccountKey(accountPublicKey);
			let rows: ReadonlyMap<AccountKey, BalanceRow> | undefined = overlay.balances.get(account);
			for (const [tokenPublicKey, effect] of Object.entries(tokens)) {
				if (effect.change === 0n) {
					continue;
				}
				const token = lib.Account.fromPublicKeyString(tokenPublicKey).assertKeyType(lib.Account.AccountKeyAlgorithm.TOKEN);
				const tokenKey = toAccountKey(token);
				const balance = (rows?.get(tokenKey)?.balance ?? 0n) + effect.change;
				rows = withEntry(rows, tokenKey, { token, balance });
			}
			if (rows !== undefined) {
				overlay.balances.set(account, rows);
			}
		}
	}

	#writeSupplies(overlay: LedgerOverlay, change: ConfirmedStapleChange): void {
		for (const [tokenPublicKey, effect] of Object.entries(change.ledgerEffect.supplies)) {
			const token = toAccountKey(tokenPublicKey);
			const row = overlay.accountInfo.get(token);
			overlay.accountInfo.set(token, { ...row, supply: (row?.supply ?? 0n) + effect.change });
		}
	}

	#writeWeights(overlay: LedgerOverlay, change: ConfirmedStapleChange): void {
		for (const [representativePublicKey, effect] of Object.entries(change.ledgerEffect.weights)) {
			const representative = toAccountKey(representativePublicKey);
			overlay.weights.set(representative, (overlay.weights.get(representative) ?? 0n) + effect.change);
		}
	}

	#writeDelegations(overlay: LedgerOverlay, change: ConfirmedStapleChange): void {
		for (const [account, representative] of change.delegations) {
			overlay.representatives.set(account, representative);
		}
	}

	/*
	 * Applied exactly as resolved: null deletes the row, while a SET without
	 * flags keeps an empty row, because deleting an emptied exact-target row
	 * would let the entity-wide row match again.
	 * [Keeta TS] index.js:68145-68168, 68503-68522
	 */
	#writePermissions(overlay: LedgerOverlay, change: ConfirmedStapleChange): void {
		for (const update of change.ledgerEffect.permissions) {
			const principal = toPrincipalKey(update.principal);
			const scope = toACLScopeKey(update.entity, update.target);
			const rows = overlay.acls.get(principal);
			if (update.permissions === null) {
				setOrDeleteEntries(overlay.acls, principal, withoutEntry(rows, scope));
				continue;
			}
			if (update.method !== lib.Block.AdjustMethod.SET) {
				throw(new Error(`internal error: unresolved permission update with method ${String(update.method)}`));
			}
			overlay.acls.set(principal, withEntry(rows, scope, toACLRow(update, update.permissions)));
		}
	}

	#writeAccountInfo(overlay: LedgerOverlay, change: ConfirmedStapleChange): void {
		for (const [account, update] of change.infoUpdates) {
			overlay.accountInfo.set(account, mergeAccountInfo(overlay.accountInfo.get(account), update));
		}
	}

	#writeCertificates(overlay: LedgerOverlay, change: ConfirmedStapleChange): void {
		for (const { account, update } of change.certificateUpdates) {
			const holder = toAccountKey(account);
			const certificates = overlay.certificates.get(holder);
			const hash = toCertificateHashKey(update.certificateHash);
			switch (update.method) {
				case lib.Block.AdjustMethod.ADD:
					overlay.certificates.set(holder, withEntry(certificates, hash, { certificate: update.certificate, intermediates: update.intermediateCertificates }));
					break;
				case lib.Block.AdjustMethod.SUBTRACT:
					setOrDeleteEntries(overlay.certificates, holder, withoutEntry(certificates, hash));
					break;
				default:
					assertNever(update);
			}
		}
	}

	#writeIdempotentKeys(overlay: LedgerOverlay, change: ConfirmedStapleChange): void {
		for (const { key, block } of change.idempotentKeys) {
			overlay.idempotentKeys.set(key, block.hash);
		}
	}

	/*
	 * The accounts of historyAccounts get the staple in their history, and
	 * every account the staple touches or may have created gets a row (D18).
	 */
	#writeAccountsAndHistory(overlay: LedgerOverlay, change: ConfirmedStapleChange, staple: StapleKey): void {
		for (const account of new Set([...change.newAccounts, ...change.historyAccounts])) {
			if (overlay.accounts.get(account) === undefined) {
				overlay.accounts.set(account, { firstStaple: staple });
			}
		}
		for (const account of change.historyAccounts) {
			overlay.history.set(account, [...(overlay.history.get(account) ?? []), staple]);
		}
	}

	/** The first of that many node-local vote sequences, never handed out again. */
	#takeVoteSequences(count: number): bigint {
		const first = this.#nextVoteSequence;
		this.#nextVoteSequence += BigInt(count);
		return(first);
	}
}

/*
 * The storage contract accepts a public key string wherever it accepts an
 * account; the key type of such a string is whatever the caller asserted.
 */
function resolveAccount<T extends AccountKeyAlgorithm>(account: Account<T> | string): Account<T> {
	if (typeof account !== 'string') {
		return(account);
	}
	// The caller's type parameter is the only key-type information a string carries.
	return(lib.Account.fromPublicKeyString(account) as Account<T>);
}

function compareKeyed(left: readonly [string, unknown], right: readonly [string, unknown]): number {
	return(compareText(left[0], right[0]));
}
