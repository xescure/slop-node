import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, AccountKeyAlgorithm, GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { LedgerSelector, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { ACLRow, ACLUpdate, AccountInfoForType, CertificateWithIntermediates, GetAllBalancesResponse } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { Vote, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { assertNever } from '../../../util/assert-never.js';
import { LedgerDriverTransaction, LedgerStorageDriverBase } from '../base.js';
import type { TransactionOptions } from '../base.js';
import type { AccountInfoUpdate, ConfirmedStapleChange } from '../confirmed.js';
import { createIdempotentKeyError, createLedgerError } from '../errors.js';
import {
	toACLScopeKey,
	toAccountKey,
	toBlockHashKey,
	toCertificateHashKey,
	toPrincipalKey,
	toStapleKey,
	toVoteKey
} from '../keys.js';
import type { AccountKey, BlockHashKey, IdempotentKeyString, StapleKey, VoteKey } from '../keys.js';
import { commitOverlay, createCommittedLedger, openOverlay } from './state.js';
import type { AccountInfoRow, BalanceRow, CommittedLedger, LedgerOverlay, TableOverlay } from './state.js';

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

	constructor(options: TransactionOptions, overlay: LedgerOverlay, release: Release) {
		super(options);
		this.#state = { status: 'open', overlay, release };
	}

	/** The transaction's view of the ledger; rejects once the transaction has ended. */
	view(): Promise<LedgerOverlay> {
		return(new Promise((resolve) => {
			resolve(this.#open().overlay);
		}));
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

// Every operation but init is asynchronous upstream, so callers attach their
// error handling to the returned promise; a synchronous throw would bypass it.
function rejectNotImplemented(member: string): Promise<never> {
	return(Promise.reject(new Error(`not implemented: ${member}`)));
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
 * [Keeta TS] index.js:67467-67486, 67109-67132
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
	#nextStapleSequence = 0n;

	async beginTransaction(options: TransactionOptions): Promise<MemoryTransaction> {
		const release = await this.#lock.acquire();
		return(new MemoryTransaction(options, openOverlay(this.#committed), release));
	}

	commitTransaction(transaction: MemoryTransaction): Promise<void> {
		return(transaction.end('committed', commitOverlay));
	}

	abortTransaction(transaction: MemoryTransaction): Promise<void> {
		return(transaction.end('aborted', function() {
			// Dropping the overlay is the whole of an abort.
		}));
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
		const { blocks } = await transaction.view();
		switch (from) {
			case 'main':
				return(blocks.get(toBlockHashKey(hash))?.block ?? null);
			case 'side':
			case 'both':
				return(await rejectNotImplemented(`getBlock('${from}')`));
			default:
				return(assertNever(from));
		}
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
	 * [Keeta TS] index.js:69260-69276
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

	async getBlockFromPrevious(transaction: MemoryTransaction, previous: BlockHash, from: LedgerSelector): Promise<Block | null> {
		const overlay = await transaction.view();
		switch (from) {
			case 'main': {
				const successor = overlay.successors.get(toBlockHashKey(previous));
				if (successor === undefined) {
					return(null);
				}
				return(this.#confirmedBlock(overlay, successor));
			}
			case 'side':
			case 'both':
				return(await rejectNotImplemented(`getBlockFromPrevious('${from}')`));
			default:
				return(assertNever(from));
		}
	}

	/*
	 * Absent is null, never an empty list: upstream reads the first vote's
	 * blocks of any non-null result.
	 * [Keeta TS] index.js:69577-69580
	 */
	async getVotes(transaction: MemoryTransaction, hash: BlockHash, from: LedgerSelector): Promise<Vote[] | null> {
		const overlay = await transaction.view();
		switch (from) {
			case 'main': {
				const row = overlay.blocks.get(toBlockHashKey(hash));
				if (row === undefined) {
					return(null);
				}
				return(Array.from(this.#confirmedStaple(overlay, row.staple).votes.values()));
			}
			case 'side':
			case 'both':
				return(await rejectNotImplemented(`getVotes('${from}')`));
			default:
				return(assertNever(from));
		}
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

	getVotesAfter(..._args: Parameters<LedgerStorageAPI['getVotesAfter']>): ReturnType<LedgerStorageAPI['getVotesAfter']> {
		return(rejectNotImplemented('getVotesAfter'));
	}

	getIdempotentBlockHash(..._args: Parameters<LedgerStorageAPI['getIdempotentBlockHash']>): ReturnType<LedgerStorageAPI['getIdempotentBlockHash']> {
		return(rejectNotImplemented('getIdempotentBlockHash'));
	}

	listOwners(..._args: Parameters<LedgerStorageAPI['listOwners']>): ReturnType<LedgerStorageAPI['listOwners']> {
		return(rejectNotImplemented('listOwners'));
	}

	listACLsByEntity(..._args: Parameters<LedgerStorageAPI['listACLsByEntity']>): ReturnType<LedgerStorageAPI['listACLsByEntity']> {
		return(rejectNotImplemented('listACLsByEntity'));
	}

	getAccountCertificates(..._args: Parameters<LedgerStorageAPI['getAccountCertificates']>): ReturnType<LedgerStorageAPI['getAccountCertificates']> {
		return(rejectNotImplemented('getAccountCertificates'));
	}

	addPendingVote(..._args: Parameters<LedgerStorageAPI['addPendingVote']>): ReturnType<LedgerStorageAPI['addPendingVote']> {
		return(rejectNotImplemented('addPendingVote'));
	}

	stats(): ReturnType<LedgerStorageAPI['stats']> {
		return(rejectNotImplemented('stats'));
	}

	protected gcBatch(_transaction: MemoryTransaction): Promise<boolean> {
		return(rejectNotImplemented('gcBatch'));
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
		commitOverlay(overlay);
	}

	protected async storeDeferredStaple(transaction: MemoryTransaction, staple: VoteStaple, waitingOn: readonly BlockHash[]): Promise<void> {
		const overlay = await transaction.view();
		const key = toStapleKey(staple.blocksHash);
		this.#forgetDeferredStaple(overlay, key);
		const waitingKeys = waitingOn.map(toBlockHashKey);
		overlay.deferredStaples.set(key, { staple, waitingOn: waitingKeys });
		for (const blockKey of waitingKeys) {
			const waiters = new Set(overlay.deferredWaiters.get(blockKey));
			waiters.add(key);
			overlay.deferredWaiters.set(blockKey, waiters);
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

	#forgetDeferredStaple(overlay: LedgerOverlay, key: StapleKey): void {
		const row = overlay.deferredStaples.get(key);
		if (row === undefined) {
			return;
		}
		overlay.deferredStaples.delete(key);
		for (const blockKey of row.waitingOn) {
			const waiters = new Set(overlay.deferredWaiters.get(blockKey));
			waiters.delete(key);
			if (waiters.size === 0) {
				overlay.deferredWaiters.delete(blockKey);
			} else {
				overlay.deferredWaiters.set(blockKey, waiters);
			}
		}
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

	#confirmedStaple(overlay: LedgerOverlay, key: StapleKey): NonNullable<ReturnType<LedgerOverlay['staples']['get']>> {
		const row = overlay.staples.get(key);
		if (row === undefined) {
			throw(new Error(`internal error: confirmed staple ${key} is referenced but not stored`));
		}
		return(row);
	}

	/*
	 * Two different confirmed blocks may not claim one idempotent key.
	 * [Keeta TS] index.js:69254-69259
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
		const { staple, blockHeights, moment } = change;
		const stapleKey = toStapleKey(staple.blocksHash);
		const votes = new Map<VoteKey, Vote>();
		for (const vote of staple.votes) {
			votes.set(toVoteKey(vote), vote);
		}
		overlay.staples.set(stapleKey, {
			blocksHash: staple.blocksHash,
			blocks: staple.blocks.map(function(block): BlockHashKey {
				return(toBlockHashKey(block.hash));
			}),
			votes,
			moment,
			sequence: this.#takeStapleSequence()
		});

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
	 * [Keeta TS] index.js:67510-67536
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
	 * [Keeta TS] index.js:67109-67132, 67467-67486
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
	 * Every touched account gets the staple in its history, and every account
	 * the staple may have created gets a row.
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

	#takeStapleSequence(): bigint {
		const sequence = this.#nextStapleSequence;
		this.#nextStapleSequence += 1n;
		return(sequence);
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
