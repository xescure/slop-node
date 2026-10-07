import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, AccountKeyAlgorithm, GenericAccount, IdentifierAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { KeetaNetLedgerError } from '@keetanetwork/keetanet-client/lib/error/ledger.js';
import type { GetVotesAfterOptions, IdempotentKey, Ledger, LedgerConfig, LedgerSelector, LedgerStorageAPI, ListACLsByEntityFilters, PaginatedVotes } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { ACLRow, ACLUpdate, AccountInfoForType, CertificateWithIntermediates, GetAllBalancesResponse } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { Vote, VoteBlockHash, VoteBlockHashMap, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type pg from 'pg';
import { assertNever } from '../../../util/assert-never.js';
import { LedgerDriverTransaction, LedgerStorageDriverBase } from '../base.js';
import type { CollectedDeferredStaples, LedgerCountsSnapshot, TransactionOptions } from '../base.js';
import type { AccountInfoUpdate, ConfirmedStapleChange } from '../confirmed.js';
import { createIdempotentKeyError, createLedgerError } from '../errors.js';
import { voteExpirySlopMilliseconds } from '../expiry.js';
import { toAccountKey, toBlockHashKey } from '../keys.js';
import type { AccountKey, StapleKey } from '../keys.js';
import type { AccountInfoRow } from '../memory/state.js';
import { mapDatabaseError } from './errors.js';
import { SCHEMA_MIGRATIONS, applyMigrations } from './migrations.js';
import { PostgresPool } from './pool.js';
import type { PostgresPoolSource } from './pool.js';
import {
	accountInfoOf,
	aclsOfPrincipal,
	addBalances,
	addCertificate,
	addSupplies,
	addWeights,
	appendHistory,
	balanceOf,
	bytesOf,
	deferredStaplesWaitingOn,
	deleteACL,
	deleteDeferredStaple,
	deleteSideIdempotentKeys,
	deleteSideVotes,
	fromInteger,
	hashBytes,
	headsOf,
	insertChain,
	insertMainBlocks,
	insertMainIdempotentKeys,
	insertMainVotes,
	insertStaple,
	internAccounts,
	mainBlock,
	mainBlockHeight,
	mainBlocksOrSuccessors,
	mainIdempotentKeys,
	mainSuccessor,
	mainVotesOfBlock,
	markInvolved,
	mergeAccountInfo,
	nextSerial,
	nonZeroBalances,
	publicKeyOf,
	raiseHeads,
	removeCertificate,
	representativeOf,
	setACL,
	setDelegations,
	sideBlock,
	sideSuccessor,
	sideVotesOfBlock,
	stapleKeyBytes,
	toBlockHash,
	toNumeric,
	totalWeight,
	weightOf
} from './sql.js';
import type {
	AccountID,
	AccountIDs,
	AccountInfoColumns,
	ACLColumns,
	IntegerText,
	SQLValue,
	Statement,
	VoteColumns
} from './sql.js';

const lib = KeetaNet.lib;

type Outcome = 'committed' | 'aborted' | 'failed';

type TransactionState =
	| { readonly status: 'open'; readonly client: pg.PoolClient }
	| { readonly status: 'ending' }
	| { readonly status: 'finished'; readonly outcome: Outcome };

/** A row of a query the caller wrote, whose columns it knows. */
export type UntypedRow = Readonly<Record<string, unknown>>;

function ignoreOutcome(): void {
	// The queue only orders statements; each caller sees its own outcome.
}

/*
 * pg reports a connection lost while a client is checked out as an event,
 * which would end the process without a listener; the next statement fails
 * and reports it instead.
 */
function ignoreConnectionError(): void {
	// The failing statement carries the error.
}

/**
 * A Postgres transaction: one pooled connection inside BEGIN ISOLATION LEVEL
 * SERIALIZABLE, held until commit or abort. Upstream issues calls on one
 * transaction concurrently, so its statements run one at a time, in the order
 * they were issued.
 */
export class PostgresTransaction extends LedgerDriverTransaction {
	#state: TransactionState;
	#tail: Promise<void> = Promise.resolve();
	#depth = 0;
	// A conflict seen anywhere dooms the attempt, even one a unit rolled back
	// and its caller handled: what the attempt read may already be stale.
	#conflict: KeetaNetLedgerError | undefined;

	constructor(options: TransactionOptions, client: pg.PoolClient) {
		super(options);
		client.on('error', ignoreConnectionError);
		this.#state = { status: 'open', client };
	}

	/** Runs a prepared statement of the driver's in this transaction. */
	async run<Parameters extends readonly SQLValue[], Row extends object>(query: Statement<Parameters, Row>, parameters: Parameters): Promise<Row[]> {
		const result = await this.#perform(function(client) {
			return(client.query<Row & pg.QueryResultRow>({ name: query.name, text: query.text, values: [...parameters] }));
		});
		return(result.rows);
	}

	/** Runs SQL whose rows the caller reads by column name. */
	async execute(text: string, values: readonly SQLValue[] = []): Promise<UntypedRow[]> {
		const result = await this.#perform(function(client) {
			return(client.query<UntypedRow & pg.QueryResultRow>(text, [...values]));
		});
		return(result.rows);
	}

	/**
	 * Runs a unit inside a savepoint named by its depth: released when the
	 * unit succeeds, rolled back to and released when it fails, so the
	 * transaction carries on as it was before the unit. The base never runs
	 * two units of one transaction at once, so depth names each uniquely.
	 */
	async isolate<Result>(unit: () => Promise<Result>): Promise<Result> {
		const savepoint = `unit_${String(this.#depth)}`;
		await this.execute(`SAVEPOINT ${savepoint}`);
		this.#depth++;
		let result: Result;
		try {
			result = await unit();
		} catch (error: unknown) {
			this.#depth--;
			await this.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`);
			await this.execute(`RELEASE SAVEPOINT ${savepoint}`);
			throw(error);
		}
		this.#depth--;
		await this.execute(`RELEASE SAVEPOINT ${savepoint}`);
		return(result);
	}

	/**
	 * Commits once every issued statement has run. A conflict seen during the
	 * attempt rolls it back instead and is reported, retryable. A failed
	 * COMMIT leaves the transaction finished: Ledger never aborts after one.
	 * [Keeta TS] index.js:70337-70347
	 */
	async commit(): Promise<void> {
		const client = await this.#beginEnding();
		const conflict = this.#conflict;
		if (conflict !== undefined) {
			const rolledBack = await this.#rollback(client);
			this.#finish(client, 'failed', !rolledBack);
			throw(conflict);
		}
		let committed: pg.QueryResult;
		try {
			committed = await client.query('COMMIT');
		} catch (error: unknown) {
			this.#finish(client, 'failed', true);
			throw(mapDatabaseError(error).error);
		}
		// Postgres answers COMMIT of a transaction that a failed statement aborted with ROLLBACK.
		if (committed.command !== 'COMMIT') {
			this.#finish(client, 'failed', false);
			throw(new Error(`transaction ${this.identifier} was rolled back by a statement that failed earlier`));
		}
		this.#finish(client, 'committed', false);
	}

	/**
	 * Rolls back once every issued statement has run. A connection that cannot
	 * roll back is closed, which rolls back too, so abort itself never fails:
	 * Ledger reports the error of the attempt, not of its abort.
	 */
	async abort(): Promise<void> {
		const client = await this.#beginEnding();
		const closed = !(await this.#rollback(client));
		this.#finish(client, 'aborted', closed);
	}

	async #rollback(client: pg.PoolClient): Promise<boolean> {
		try {
			await client.query('ROLLBACK');
		} catch {
			return(false);
		}
		return(true);
	}

	async #beginEnding(): Promise<pg.PoolClient> {
		const { client } = this.#open();
		this.#state = { status: 'ending' };
		await this.#tail;
		return(client);
	}

	#finish(client: pg.PoolClient, outcome: Outcome, closeConnection: boolean): void {
		this.#state = { status: 'finished', outcome };
		client.removeListener('error', ignoreConnectionError);
		client.release(closeConnection);
	}

	#open(): Extract<TransactionState, { status: 'open' }> {
		const state = this.#state;
		switch (state.status) {
			case 'open':
				return(state);
			case 'ending':
				throw(new Error(`transaction ${this.identifier} is already ending`));
			case 'finished':
				throw(new Error(`transaction ${this.identifier} is already ${state.outcome}`));
			default:
				return(assertNever(state));
		}
	}

	async #perform<Result>(work: (client: pg.PoolClient) => Promise<Result>): Promise<Result> {
		const { client } = this.#open();
		const turn = this.#tail.then(function() {
			return(work(client));
		});
		this.#tail = turn.then(ignoreOutcome, ignoreOutcome);
		try {
			return(await turn);
		} catch (error: unknown) {
			const mapped = mapDatabaseError(error);
			if (mapped.kind === 'conflict') {
				this.#conflict ??= mapped.error;
			}
			throw(mapped.error);
		}
	}
}

/** The moment from which a side vote that has expired by the transaction's moment no longer counts (D4). */
function unexpiredSince(moment: Date): Date {
	return(new Date(moment.getTime() - voteExpirySlopMilliseconds));
}

function decodeBlock(bytes: Buffer): Block {
	return(new lib.Block(bytes));
}

/*
 * A stored vote is judged by the driver's own predicates at the transaction's
 * moment; decoding it as of its own issue time keeps the Vote class from
 * judging it again against the wall clock.
 * [Keeta TS] index.js:80376-80390, 80640-80648
 */
function decodeVote({ bytes, validity_from }: VoteColumns): Vote {
	return(new lib.Vote(bytes, { now: validity_from }));
}

function nullWhenEmpty<Item>(items: Item[]): Item[] | null {
	if (items.length === 0) {
		return(null);
	}
	return(items);
}

function onlyRow<Row>(rows: readonly Row[]): Row | undefined {
	if (rows.length > 1) {
		throw(new Error(`internal error: expected at most one row, got ${String(rows.length)}`));
	}
	return(rows[0]);
}

function permissionsOf(base: IntegerText, external: IntegerText): InstanceType<typeof lib.Permissions> {
	return(new lib.Permissions(fromInteger(base), fromInteger(external)));
}

function toACLRow(row: ACLColumns): ACLRow {
	const principal = lib.Account.fromPublicKeyString(row.principal);
	const entity = lib.Account.fromPublicKeyString(row.entity);
	const target = lib.Account.fromPublicKeyString(row.target);
	const permissions = permissionsOf(row.base_permissions, row.external_permissions);
	if (row.certificate === null) {
		return({ principalType: 'ACCOUNT', principal, entity, target, permissions });
	}
	const certificate = new lib.Utils.Certificate.CertificateHash(row.certificate);
	return({ principalType: 'CERTIFICATE', principal: { usingCertificate: true, certificate, certificateAccount: principal }, entity, target, permissions });
}

function toAccountInfoRow(row: AccountInfoColumns | undefined): AccountInfoRow {
	const info: { -readonly [Field in keyof AccountInfoRow]: AccountInfoRow[Field] } = {};
	if (row === undefined) {
		return(info);
	}
	if (row.name !== null) {
		info.name = row.name;
	}
	if (row.description !== null) {
		info.description = row.description;
	}
	if (row.metadata !== null) {
		info.metadata = row.metadata;
	}
	if (row.supply !== null) {
		info.supply = fromInteger(row.supply);
	}
	if (row.multisig_quorum !== null) {
		info.multisigQuorum = fromInteger(row.multisig_quorum);
	}
	if (row.default_base_permission !== null && row.default_external_permission !== null) {
		const permissions = permissionsOf(row.default_base_permission, row.default_external_permission);
		info.defaultBasePermission = permissions.base;
		info.defaultExternalPermission = permissions.external;
	}
	return(info);
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

/** Every account a confirmed change names, with its key type, keyed by public key. */
function accountsNamedBy(change: ConfirmedStapleChange): Map<string, AccountKeyAlgorithm> {
	const named = new Map<string, AccountKeyAlgorithm>();
	function add(account: GenericAccount | string): void {
		let resolved: GenericAccount;
		if (typeof account === 'string') {
			resolved = lib.Account.fromPublicKeyString(account);
		} else {
			resolved = account;
		}
		named.set(resolved.publicKeyString.get(), resolved.keyType);
	}
	for (const block of change.staple.blocks) {
		add(block.account);
	}
	for (const vote of change.staple.votes) {
		add(vote.issuer);
	}
	const { balances, supplies, weights, permissions } = change.ledgerEffect;
	for (const [holder, tokens] of Object.entries(balances)) {
		add(holder);
		for (const token of Object.keys(tokens)) {
			add(token);
		}
	}
	for (const token of Object.keys(supplies)) {
		add(token);
	}
	for (const representative of Object.keys(weights)) {
		add(representative);
	}
	for (const [holder, representative] of change.delegations) {
		add(holder);
		add(representative);
	}
	for (const update of permissions) {
		add(principalAccountOf(update));
		add(update.entity);
		add(update.target ?? update.entity);
	}
	for (const holder of change.infoUpdates.keys()) {
		add(holder);
	}
	for (const { account } of change.certificateUpdates) {
		add(account);
	}
	for (const account of [...change.historyAccounts, ...change.newAccounts]) {
		add(account);
	}
	return(named);
}

function principalAccountOf(update: ACLUpdate): GenericAccount {
	switch (update.principalType) {
		case 'ACCOUNT':
			return(update.principal);
		case 'CERTIFICATE':
			return(update.principal.certificateAccount);
		default:
			return(assertNever(update));
	}
}

function principalCertificateOf(update: ACLUpdate): Buffer | null {
	switch (update.principalType) {
		case 'ACCOUNT':
			return(null);
		case 'CERTIFICATE':
			return(hashBytes(update.principal.certificate));
		default:
			return(assertNever(update));
	}
}

function idOf(ids: AccountIDs, account: GenericAccount | string): AccountID {
	const id = ids.get(publicKeyOf(account));
	if (id === undefined) {
		throw(new Error(`internal error: account ${publicKeyOf(account)} was not interned`));
	}
	return(id);
}

function textOrNull(value: string | undefined): string | null {
	return(value ?? null);
}

/** The value written for each info field: null keeps the stored one. */
function infoParameters(update: AccountInfoUpdate): [string | null, string | null, string | null, string | null, string | null, string | null, boolean] {
	let base: string | null = null;
	let external: string | null = null;
	if (update.defaultPermission !== undefined) {
		base = toNumeric(update.defaultPermission.base.bigint);
		external = toNumeric(update.defaultPermission.external.bigint);
	}
	let quorum: string | null = null;
	if (update.multisigQuorum !== undefined && update.multisigQuorum !== null) {
		quorum = toNumeric(update.multisigQuorum);
	}
	return([textOrNull(update.name), textOrNull(update.description), textOrNull(update.metadata), base, external, quorum, update.multisigQuorum !== undefined]);
}

function notYetImplemented(member: string, task: 'Task 3' | 'Task 4'): Promise<never> {
	return(Promise.reject(new Error(`PostgresLedgerStorage.${member} is not implemented yet (${task})`)));
}

/**
 * The ledger in Postgres. Transactions are SERIALIZABLE, so several processes
 * can serve one representative from one database: a conflict between them
 * rolls one attempt back and Ledger.run retries it. Nothing in the process is
 * relied on for correctness.
 */
export class PostgresLedgerStorage extends LedgerStorageDriverBase<PostgresTransaction> implements LedgerStorageAPI {
	readonly #source: PostgresPoolSource;
	#connecting: Promise<PostgresPool> | undefined;
	#destroyed = false;

	constructor(source: PostgresPoolSource) {
		super();
		this.#source = source;
	}

	/**
	 * Ledger calls init synchronously and cannot wait, so the migration starts
	 * here and the first transaction waits for it; a failed migration is
	 * reported by that transaction, and tried again by the next.
	 * [Keeta TS] index.js:70250-70255
	 */
	override init(config: LedgerConfig, ledger: Ledger): void {
		super.init(config, ledger);
		this.#connection().catch(ignoreOutcome);
	}

	/** Ends the pool if the driver opened it; an injected pool is left to its owner (G8). */
	async destroy(): Promise<void> {
		this.#destroyed = true;
		const connecting = this.#connecting;
		this.#connecting = undefined;
		if (connecting === undefined) {
			return;
		}
		const connection = await connecting.catch(function() {
			return(undefined);
		});
		await connection?.close();
	}

	async beginTransaction(options: TransactionOptions): Promise<PostgresTransaction> {
		const { pool } = await this.#connection();
		const client = await pool.connect();
		let begin = 'BEGIN ISOLATION LEVEL SERIALIZABLE';
		// Upstream opens read-only transactions only for reads (CONTRACT 3.2), which lets Postgres track fewer conflicts.
		if (options.readOnly ?? true) {
			begin = `${begin} READ ONLY`;
		}
		try {
			await client.query(begin);
		} catch (error: unknown) {
			client.release(true);
			throw(mapDatabaseError(error).error);
		}
		return(new PostgresTransaction(options, client));
	}

	commitTransaction(transaction: PostgresTransaction): Promise<void> {
		return(transaction.commit());
	}

	abortTransaction(transaction: PostgresTransaction): Promise<void> {
		return(transaction.abort());
	}

	protected override runIsolated<Result>(transaction: PostgresTransaction, unit: () => Promise<Result>): Promise<Result> {
		return(transaction.isolate(unit));
	}

	/*
	 * Taken outside the transaction: nextval never rolls back, so a serial
	 * taken by an aborted attempt is never issued again (D16).
	 */
	async getNextSerialNumber(_transaction?: PostgresTransaction): Promise<bigint> {
		const { pool } = await this.#connection();
		const result = await pool.query<{ serial: IntegerText }>({ name: nextSerial.name, text: nextSerial.text });
		const row = onlyRow(result.rows);
		if (row === undefined) {
			throw(new Error('internal error: nextval returned no row'));
		}
		return(fromInteger(row.serial));
	}

	async delegatedWeight(transaction: PostgresTransaction, representative?: Parameters<LedgerStorageAPI['delegatedWeight']>[1]): Promise<bigint> {
		let rows: { total: IntegerText }[];
		if (representative === undefined) {
			rows = await transaction.run(totalWeight, []);
		} else if (lib.Account.isInstance(representative)) {
			rows = await transaction.run(weightOf, [[publicKeyOf(representative)]]);
		} else {
			// Account.Set holds each account once, and the join counts each weight row once.
			rows = await transaction.run(weightOf, [Array.from(representative, publicKeyOf)]);
		}
		const row = onlyRow(rows);
		if (row === undefined) {
			throw(new Error('internal error: a sum returned no row'));
		}
		return(fromInteger(row.total));
	}

	async getBalance(transaction: PostgresTransaction, account: GenericAccount, token: TokenAddress): Promise<bigint> {
		const row = onlyRow(await transaction.run(balanceOf, [publicKeyOf(account), publicKeyOf(token)]));
		if (row === undefined) {
			return(0n);
		}
		return(fromInteger(row.balance));
	}

	async getAllBalances(transaction: PostgresTransaction, account: GenericAccount): Promise<GetAllBalancesResponse> {
		const rows = await transaction.run(nonZeroBalances, [publicKeyOf(account)]);
		return(rows.map(function(row) {
			return({ token: lib.Account.fromPublicKeyString(row.token).assertKeyType(lib.Account.AccountKeyAlgorithm.TOKEN), balance: fromInteger(row.balance) });
		}));
	}

	async getAccountInfo<T extends AccountKeyAlgorithm = AccountKeyAlgorithm>(transaction: PostgresTransaction, account: Account<T> | string): Promise<AccountInfoForType<T>> {
		const resolved = resolveAccount(account);
		const row = onlyRow(await transaction.run(accountInfoOf, [publicKeyOf(resolved)]));
		return(this._formatAccountInfoFromRow(resolved, toAccountInfoRow(row)));
	}

	async getAccountRep(transaction: PostgresTransaction, account: GenericAccount | string): Promise<Account | null> {
		const row = onlyRow(await transaction.run(representativeOf, [publicKeyOf(account)]));
		if (row === undefined) {
			return(null);
		}
		return(lib.Account.fromPublicKeyString(row.representative).assertAccount());
	}

	async listACLsByPrincipal(transaction: PostgresTransaction, principal: ACLRow['principal'], entityList?: GenericAccount[]): Promise<ACLRow[]> {
		let entities: string[] | null = null;
		if (entityList !== undefined) {
			entities = entityList.map(publicKeyOf);
		}
		let holder: GenericAccount;
		let certificate: Buffer | null = null;
		if (lib.Account.isInstance(principal)) {
			holder = principal;
		} else {
			holder = principal.certificateAccount;
			certificate = hashBytes(principal.certificate);
		}
		const rows = await transaction.run(aclsOfPrincipal, [publicKeyOf(holder), certificate, entities]);
		return(rows.map(toACLRow));
	}

	async getBlock(transaction: PostgresTransaction, hash: BlockHash, from: LedgerSelector): Promise<Block | null> {
		const key = hashBytes(hash);
		const readMain = async (): Promise<Block | null> => {
			return(this.#block(await transaction.run(mainBlock, [key])));
		};
		const readSide = async (): Promise<Block | null> => {
			return(this.#block(await transaction.run(sideBlock, [key, unexpiredSince(transaction.moment)])));
		};
		return(await fromSelected(from, readMain, readSide));
	}

	async getBlockHeight(transaction: PostgresTransaction, hash: BlockHash, account: GenericAccount): Promise<bigint | null> {
		const row = onlyRow(await transaction.run(mainBlockHeight, [hashBytes(hash), publicKeyOf(account)]));
		if (row === undefined) {
			return(null);
		}
		return(fromInteger(row.height));
	}

	/*
	 * Heads are main-chain only, even under 'both' (D5).
	 * [Keeta TS] index.js:69260-69276
	 */
	async getHeadBlocks(transaction: PostgresTransaction, accounts: GenericAccount[], from: LedgerSelector): Promise<{ [account: string]: Block | null }> {
		const heads: { [account: string]: Block | null } = {};
		for (const account of accounts) {
			heads[toAccountKey(account)] = null;
		}
		switch (from) {
			case 'side':
				return(heads);
			case 'main':
			case 'both':
				break;
			default:
				return(assertNever(from));
		}
		const rows = await transaction.run(headsOf, [accounts.map(publicKeyOf)]);
		for (const row of rows) {
			heads[toAccountKey(row.public_key)] = decodeBlock(row.bytes);
		}
		return(heads);
	}

	async getBlockFromPrevious(transaction: PostgresTransaction, previous: BlockHash, from: LedgerSelector): Promise<Block | null> {
		const key = hashBytes(previous);
		const readMain = async (): Promise<Block | null> => {
			return(this.#block(await transaction.run(mainSuccessor, [key])));
		};
		const readSide = async (): Promise<Block | null> => {
			return(this.#block(await transaction.run(sideSuccessor, [key, unexpiredSince(transaction.moment)])));
		};
		return(await fromSelected(from, readMain, readSide));
	}

	/*
	 * Absent is null, never an empty list: upstream reads the first vote's
	 * blocks of any non-null result.
	 * [Keeta TS] index.js:69577-69580
	 */
	async getVotes(transaction: PostgresTransaction, hash: BlockHash, from: LedgerSelector): Promise<Vote[] | null> {
		const key = hashBytes(hash);
		async function readMain(): Promise<Vote[] | null> {
			return(nullWhenEmpty((await transaction.run(mainVotesOfBlock, [key])).map(decodeVote)));
		}
		async function readSide(): Promise<Vote[] | null> {
			return(nullWhenEmpty((await transaction.run(sideVotesOfBlock, [key, unexpiredSince(transaction.moment)])).map(decodeVote)));
		}
		return(await fromSelected(from, readMain, readSide));
	}

	getVotesFromMultiplePrevious(_transaction: PostgresTransaction, _previousBlocks: BlockHash[], _from: LedgerSelector, _issuer?: Account): Promise<{ [hash: string]: Vote[] | null }> {
		return(notYetImplemented('getVotesFromMultiplePrevious', 'Task 3'));
	}

	getVoteStaples(_transaction: PostgresTransaction, _voteBlockHashes: VoteBlockHash[], _from: LedgerSelector): Promise<VoteBlockHashMap<VoteStaple | null>> {
		return(notYetImplemented('getVoteStaples', 'Task 3'));
	}

	getHistory(_transaction: PostgresTransaction, _account: GenericAccount | null, _start: VoteBlockHash | null, _limit?: number): Promise<VoteBlockHash[]> {
		return(notYetImplemented('getHistory', 'Task 3'));
	}

	getVotesAfter(_transaction: PostgresTransaction, _moment: Date, _startKey?: string, _options?: GetVotesAfterOptions): Promise<PaginatedVotes> {
		return(notYetImplemented('getVotesAfter', 'Task 3'));
	}

	getIdempotentBlockHash(_transaction: PostgresTransaction, _idempotent: IdempotentKey, _from: LedgerSelector, _excludeBlockHash?: BlockHash): Promise<BlockHash | null> {
		return(notYetImplemented('getIdempotentBlockHash', 'Task 3'));
	}

	listOwners(_transaction: PostgresTransaction, _identifier: IdentifierAddress, _target?: GenericAccount): Promise<GenericAccount[]> {
		return(notYetImplemented('listOwners', 'Task 3'));
	}

	listACLsByEntity(_transaction: PostgresTransaction, _entity: GenericAccount, _options?: ListACLsByEntityFilters): Promise<ACLRow[]> {
		return(notYetImplemented('listACLsByEntity', 'Task 3'));
	}

	getAccountCertificates(_transaction: PostgresTransaction, _account: GenericAccount): Promise<CertificateWithIntermediates[]> {
		return(notYetImplemented('getAccountCertificates', 'Task 3'));
	}

	getAccountCertificateByHash(_transaction: PostgresTransaction, _account: GenericAccount, _hash: Parameters<LedgerStorageAPI['getAccountCertificateByHash']>[2]): Promise<CertificateWithIntermediates | null> {
		return(notYetImplemented('getAccountCertificateByHash', 'Task 3'));
	}

	addPendingVote(_transaction: PostgresTransaction, _staple: VoteStaple): Promise<void> {
		return(notYetImplemented('addPendingVote', 'Task 4'));
	}

	protected countLedger(): Promise<LedgerCountsSnapshot> {
		return(notYetImplemented('countLedger', 'Task 3'));
	}

	/*
	 * The change lands in a savepoint of its own, so a refusal or a failed
	 * statement leaves the transaction as it was and usable, whether or not
	 * the staple runs inside a unit.
	 */
	protected async persistConfirmedStaple(transaction: PostgresTransaction, change: ConfirmedStapleChange): Promise<void> {
		await transaction.isolate(async () => {
			await this.#assertIdempotentKeysFree(transaction, change);
			await this.#assertExtendsMainChains(transaction, change);
			const ids = await this.#intern(transaction, accountsNamedBy(change));
			const blocksHash = hashBytes(change.staple.blocksHash);
			await transaction.run(insertStaple, [blocksHash, change.staple.timestamp(), change.moment]);
			await this.#writeBlocks(transaction, change, ids, blocksHash);
			await this.#writeVotes(transaction, change, ids, blocksHash);
			await this.#writeAmounts(transaction, change, ids);
			await this.#writeDelegations(transaction, change, ids);
			await this.#writePermissions(transaction, change, ids);
			await this.#writeAccountInfo(transaction, change, ids);
			await this.#writeCertificates(transaction, change, ids);
			await this.#writeIdempotentKeys(transaction, change);
			await this.#writeHistory(transaction, change, ids, blocksHash);
		});
	}

	protected storeDeferredStaple(_transaction: PostgresTransaction, _staple: VoteStaple, _waitingOn: readonly BlockHash[]): Promise<void> {
		return(notYetImplemented('storeDeferredStaple', 'Task 4'));
	}

	protected async listDeferredStaplesWaitingOn(transaction: PostgresTransaction, blockHashes: readonly BlockHash[]): Promise<readonly VoteStaple[]> {
		const rows = await transaction.run(deferredStaplesWaitingOn, [blockHashes.map(hashBytes)]);
		return(rows.map(function(row): VoteStaple {
			return(new lib.Vote.Staple(row.bytes, { now: row.latest_vote_from }));
		}));
	}

	protected async removeDeferredStaple(transaction: PostgresTransaction, blocksHash: StapleKey): Promise<void> {
		await transaction.run(deleteDeferredStaple, [stapleKeyBytes(blocksHash)]);
	}

	protected collectDeadDeferredStaples(_transaction: PostgresTransaction, _limit: number): Promise<CollectedDeferredStaples> {
		return(notYetImplemented('collectDeadDeferredStaples', 'Task 4'));
	}

	protected listReleasedDeferredStaples(_transaction: PostgresTransaction, _limit: number, _exclude: ReadonlySet<StapleKey>): Promise<readonly VoteStaple[]> {
		return(notYetImplemented('listReleasedDeferredStaples', 'Task 4'));
	}

	protected collectObsoleteSideVotes(_transaction: PostgresTransaction, _limit: number): Promise<boolean> {
		return(notYetImplemented('collectObsoleteSideVotes', 'Task 4'));
	}

	#connection(): Promise<PostgresPool> {
		if (this.#destroyed) {
			return(Promise.reject(new Error('storage driver is destroyed')));
		}
		this.#connecting ??= this.#connect();
		return(this.#connecting);
	}

	async #connect(): Promise<PostgresPool> {
		const connection = await PostgresPool.open(this.#source);
		try {
			await applyMigrations(connection.pool, SCHEMA_MIGRATIONS);
		} catch (error: unknown) {
			this.#connecting = undefined;
			await connection.close();
			throw(error);
		}
		return(connection);
	}

	#block(rows: readonly { bytes: Buffer }[]): Block | null {
		const row = onlyRow(rows);
		if (row === undefined) {
			return(null);
		}
		return(decodeBlock(row.bytes));
	}

	/*
	 * Interning tolerates another process interning the same account at once:
	 * the insert skips existing rows, and a row it cannot yet see is a
	 * serialization failure, which the retry resolves.
	 */
	async #intern(transaction: PostgresTransaction, accounts: ReadonlyMap<string, AccountKeyAlgorithm>): Promise<AccountIDs> {
		const publicKeys = Array.from(accounts.keys()).sort();
		const keyTypes = publicKeys.map(function(publicKey): number {
			const keyType = accounts.get(publicKey);
			if (keyType === undefined) {
				throw(new Error(`internal error: no key type for ${publicKey}`));
			}
			return(keyType);
		});
		const rows = await transaction.run(internAccounts, [publicKeys, keyTypes]);
		return(new Map(rows.map(function(row): [string, AccountID] {
			return([row.public_key, row.id]);
		})));
	}

	/*
	 * Two different confirmed blocks may not claim one idempotent key, whether
	 * the other is already on main or earlier in the same change (D12).
	 * [Keeta TS] index.js:69254-69259
	 */
	async #assertIdempotentKeysFree(transaction: PostgresTransaction, change: ConfirmedStapleChange): Promise<void> {
		if (change.idempotentKeys.length === 0) {
			return;
		}
		const keys = change.idempotentKeys.map(function({ key }): Buffer {
			return(Buffer.from(key, 'hex'));
		});
		const held = new Map<string, BlockHash>();
		for (const row of await transaction.run(mainIdempotentKeys, [keys])) {
			held.set(row.key.toString('hex'), toBlockHash(row.block_hash));
		}
		for (const { key, block, idempotent } of change.idempotentKeys) {
			const hex = Buffer.from(key, 'hex').toString('hex');
			const existing = held.get(hex);
			if (existing !== undefined && !existing.compare(block.hash)) {
				throw(createIdempotentKeyError({ blockHash: block.hash, existingBlockHash: existing, account: block.account, idempotent }));
			}
			held.set(hex, block.hash);
		}
	}

	/*
	 * Confirmed history is never overwritten, even if the base's earlier
	 * check raced (D14).
	 */
	async #assertExtendsMainChains(transaction: PostgresTransaction, change: ConfirmedStapleChange): Promise<void> {
		const { blocks } = change.staple;
		const rows = await transaction.run(mainBlocksOrSuccessors, [blocks.map(function(block) {
			return(hashBytes(block.hash));
		}), blocks.map(function(block) {
			return(hashBytes(block.previous));
		})]);
		const onMain = new Set<string>();
		const successorOf = new Map<string, string>();
		for (const row of rows) {
			const hash = toBlockHashKey(toBlockHash(row.hash));
			onMain.add(hash);
			successorOf.set(toBlockHashKey(toBlockHash(row.previous)), hash);
		}
		for (const block of blocks) {
			const hash = toBlockHashKey(block.hash);
			if (onMain.has(hash)) {
				throw(createLedgerError('LEDGER_BLOCK_ALREADY_EXISTS', `Block Already Exists: ${hash}`));
			}
			const successor = successorOf.get(toBlockHashKey(block.previous));
			if (successor !== undefined) {
				throw(this.confirmedHistoryConflict(block, `previous already has the confirmed successor ${successor}`));
			}
		}
	}

	/*
	 * Each block is stored, recorded as the successor of its previous through
	 * the main successor index, placed on its account's chain, and raised to
	 * head when it is higher than the current head. The side copies of the
	 * staple's blocks become these rows, and their side idempotent claims go.
	 */
	async #writeBlocks(transaction: PostgresTransaction, change: ConfirmedStapleChange, ids: AccountIDs, blocksHash: Buffer): Promise<void> {
		const { blocks } = change.staple;
		const hashes = blocks.map(function(block) {
			return(hashBytes(block.hash));
		});
		const accountIDs = blocks.map(function(block) {
			return(idOf(ids, block.account));
		});
		const inserted = await transaction.run(insertMainBlocks, [
			hashes,
			accountIDs,
			blocks.map(function(block) {
				return(hashBytes(block.previous));
			}),
			blocks.map(function(block) {
				return(block.operations.length);
			}),
			blocks.map(function(block) {
				return(bytesOf(block.toBytes()));
			}),
			blocks.map(function(_block, index) {
				return(index);
			}),
			blocksHash
		]);
		if (inserted.length !== blocks.length) {
			throw(createLedgerError('LEDGER_BLOCK_ALREADY_EXISTS', `Block Already Exists in staple ${change.staple.blocksHash.toString()}`));
		}
		await transaction.run(deleteSideIdempotentKeys, [hashes]);

		const heights = blocks.map(function(block): bigint {
			const height = change.blockHeights.get(toBlockHashKey(block.hash));
			if (height === undefined) {
				throw(new Error(`internal error: no height for block ${block.hash.toString()}`));
			}
			return(height);
		});
		await transaction.run(insertChain, [accountIDs, heights.map(toNumeric), hashes]);

		// One upsert may not touch a row twice, so each account's highest block is chosen here.
		const highest = new Map<AccountID, { hash: Buffer; height: bigint }>();
		for (const [index, accountID] of accountIDs.entries()) {
			const height = heights[index];
			const hash = hashes[index];
			if (height === undefined || hash === undefined) {
				throw(new Error('internal error: block lists of unequal length'));
			}
			const current = highest.get(accountID);
			if (current === undefined || current.height < height) {
				highest.set(accountID, { hash, height });
			}
		}
		const raised = Array.from(highest.entries());
		await transaction.run(raiseHeads, [
			raised.map(function([accountID]) {
				return(accountID);
			}),
			raised.map(function([, { hash }]) {
				return(hash);
			}),
			raised.map(function([, { height }]) {
				return(toNumeric(height));
			})
		]);
	}

	/*
	 * The staple's votes are stored with it, and the side copies of any of
	 * them are dropped. Every other side vote stays, this node's temporary
	 * vote on these blocks included (D6).
	 */
	async #writeVotes(transaction: PostgresTransaction, change: ConfirmedStapleChange, ids: AccountIDs, blocksHash: Buffer): Promise<void> {
		const { votes } = change.staple;
		const identities = votes.map(function(vote): string {
			return(vote.$uid);
		});
		await transaction.run(deleteSideVotes, [identities]);
		await transaction.run(insertMainVotes, [
			blocksHash,
			identities,
			votes.map(function(vote) {
				return(idOf(ids, vote.issuer));
			}),
			votes.map(function(vote) {
				return(vote.validityFrom);
			}),
			votes.map(function(vote) {
				return(vote.validityTo);
			}),
			votes.map(function(vote) {
				return(vote.$permanent);
			}),
			votes.map(function(vote) {
				return(bytesOf(vote.toBytes()));
			})
		]);
	}

	/*
	 * Changes are deltas, added to the stored values and never clamped (D9).
	 * A zero balance change creates no row.
	 * [Keeta TS] index.js:67510-67536
	 */
	async #writeAmounts(transaction: PostgresTransaction, change: ConfirmedStapleChange, ids: AccountIDs): Promise<void> {
		const { balances, supplies, weights } = change.ledgerEffect;
		const holders: AccountID[] = [];
		const tokens: AccountID[] = [];
		const deltas: string[] = [];
		for (const [holder, effects] of Object.entries(balances)) {
			for (const [token, effect] of Object.entries(effects)) {
				if (effect.change === 0n) {
					continue;
				}
				holders.push(idOf(ids, holder));
				tokens.push(idOf(ids, token));
				deltas.push(toNumeric(effect.change));
			}
		}
		await transaction.run(addBalances, [holders, tokens, deltas]);

		const supplyEntries = Object.entries(supplies);
		await transaction.run(addSupplies, [supplyEntries.map(function([token]) {
			return(idOf(ids, token));
		}), supplyEntries.map(function([, effect]) {
			return(toNumeric(effect.change));
		})]);

		const weightEntries = Object.entries(weights);
		await transaction.run(addWeights, [weightEntries.map(function([representative]) {
			return(idOf(ids, representative));
		}), weightEntries.map(function([, effect]) {
			return(toNumeric(effect.change));
		})]);
	}

	async #writeDelegations(transaction: PostgresTransaction, change: ConfirmedStapleChange, ids: AccountIDs): Promise<void> {
		const delegations = Array.from(change.delegations.entries());
		if (delegations.length === 0) {
			return;
		}
		await transaction.run(setDelegations, [delegations.map(function([holder]) {
			return(idOf(ids, holder));
		}), delegations.map(function([, representative]) {
			return(idOf(ids, representative));
		})]);
	}

	/*
	 * Applied in order, exactly as resolved: null deletes the row, while a SET
	 * without flags keeps an empty row, because deleting an emptied
	 * exact-target row would let the entity-wide row match again (D10).
	 * [Keeta TS] index.js:67109-67132, 67467-67486
	 */
	async #writePermissions(transaction: PostgresTransaction, change: ConfirmedStapleChange, ids: AccountIDs): Promise<void> {
		for (const update of change.ledgerEffect.permissions) {
			const principal = idOf(ids, principalAccountOf(update));
			const certificate = principalCertificateOf(update);
			const entity = idOf(ids, update.entity);
			const target = idOf(ids, update.target ?? update.entity);
			if (update.permissions === null) {
				await transaction.run(deleteACL, [principal, certificate, entity, target]);
				continue;
			}
			if (update.method !== lib.Block.AdjustMethod.SET) {
				throw(new Error(`internal error: unresolved permission update with method ${String(update.method)}`));
			}
			await transaction.run(setACL, [principal, certificate, entity, target, toNumeric(update.permissions.base.bigint), toNumeric(update.permissions.external.bigint)]);
		}
	}

	async #writeAccountInfo(transaction: PostgresTransaction, change: ConfirmedStapleChange, ids: AccountIDs): Promise<void> {
		for (const [account, update] of change.infoUpdates) {
			await transaction.run(mergeAccountInfo, [idOf(ids, account), ...infoParameters(update)]);
		}
	}

	async #writeCertificates(transaction: PostgresTransaction, change: ConfirmedStapleChange, ids: AccountIDs): Promise<void> {
		for (const { account, update } of change.certificateUpdates) {
			const holder = idOf(ids, account);
			const hash = hashBytes(update.certificateHash);
			switch (update.method) {
				case lib.Block.AdjustMethod.ADD:
					await transaction.run(addCertificate, [holder, hash, bytesOf(update.certificate.toDER()), update.intermediateCertificates?.getDERBuffer() ?? null]);
					break;
				case lib.Block.AdjustMethod.SUBTRACT:
					await transaction.run(removeCertificate, [holder, hash]);
					break;
				default:
					assertNever(update);
			}
		}
	}

	async #writeIdempotentKeys(transaction: PostgresTransaction, change: ConfirmedStapleChange): Promise<void> {
		if (change.idempotentKeys.length === 0) {
			return;
		}
		await transaction.run(insertMainIdempotentKeys, [change.idempotentKeys.map(function({ key }) {
			return(Buffer.from(key, 'hex'));
		}), change.idempotentKeys.map(function({ block }) {
			return(hashBytes(block.hash));
		})]);
	}

	/*
	 * Every touched account lists the staple in its history, under the
	 * staple's own time (D8), and every account the staple may have created
	 * is marked as involved (D18).
	 */
	async #writeHistory(transaction: PostgresTransaction, change: ConfirmedStapleChange, ids: AccountIDs, blocksHash: Buffer): Promise<void> {
		const involved = new Set<AccountKey>([...change.newAccounts, ...change.historyAccounts]);
		await transaction.run(markInvolved, [Array.from(involved, function(account) {
			return(idOf(ids, account));
		}), blocksHash]);
		await transaction.run(appendHistory, [Array.from(change.historyAccounts, function(account) {
			return(idOf(ids, account));
		}), blocksHash, change.staple.timestamp()]);
	}
}

/*
 * Under 'both' the main ledger answers whenever it has an answer, so whatever
 * has been confirmed reads as confirmed (D7).
 */
async function fromSelected<Result>(from: LedgerSelector, readMain: () => Promise<Result | null>, readSide: () => Promise<Result | null>): Promise<Result | null> {
	switch (from) {
		case 'main':
			return(await readMain());
		case 'side':
			return(await readSide());
		case 'both':
			return(await readMain() ?? await readSide());
		default:
			return(assertNever(from));
	}
}
