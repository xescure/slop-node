import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, AccountKeyAlgorithm } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { ComputedEffectOfBlocks } from '@keetanetwork/keetanet-client/lib/ledger/effects.js';
import type {
	Ledger,
	LedgerConfig,
	LedgerStorageAPI,
	LedgerStorageTransactionBase
} from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { AccountInfoForType, LedgerStatistics } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals, StatsPending } from '../../upstream/internals.js';
import { assertNever } from '../../util/assert-never.js';
import { blockHeightsOf, computeConfirmedStapleChange } from './confirmed.js';
import type { ConfirmedStapleChange } from './confirmed.js';
import { createLedgerError, describeError, isKeetaNetError } from './errors.js';
import { toBlockHashKey, toStapleKey } from './keys.js';
import type { BlockHashKey, StapleKey } from './keys.js';

/** The options Ledger passes when it opens a transaction. */
export type TransactionOptions = Parameters<LedgerStorageAPI['beginTransaction']>[0];

/**
 * What every driver transaction carries for upstream: the node, the moment the
 * attempt began, its identifier, whether it may write, and the statistics that
 * Ledger merges into the node only after a successful commit.
 * [Keeta TS] index.js:68952-68960, 69001-69006
 */
export class LedgerDriverTransaction implements LedgerStorageTransactionBase {
	readonly node?: NonNullable<TransactionOptions['node']>;
	readonly moment: Date;
	readonly identifier: string;
	readonly readOnly: boolean;
	readonly statsPending: InstanceType<typeof StatsPending>;

	constructor(options: TransactionOptions) {
		if (options.node !== undefined) {
			this.node = options.node;
		}
		this.moment = options.moment ?? new Date();
		this.identifier = options.identifier;
		this.readOnly = options.readOnly ?? true;
		this.statsPending = new StatsPending();
	}
}

/** Raised when a driver is used before Ledger has called init(). */
export class StorageDriverNotInitializedError extends Error {
	constructor() {
		super('storage driver used before Ledger called init()');
		this.name = 'StorageDriverNotInitializedError';
	}
}

type InitializedDriver = {
	readonly config: LedgerConfig;
	readonly ledger: Ledger;
};

type DriverState =
	| { readonly state: 'uninitialized' }
	| ({ readonly state: 'initialized' } & InitializedDriver);

type StorageMember = keyof LedgerStorageAPI;

type ArgumentsAfterTransaction<Member extends StorageMember> = Parameters<NonNullable<LedgerStorageAPI[Member]>> extends [unknown, ...infer Rest] ? Rest : never;

type MemberResult<Member extends StorageMember> = ReturnType<NonNullable<LedgerStorageAPI[Member]>>;

type ReplayState = {
	readonly mayDefer: boolean;
	readonly completed: Set<StapleKey>;
	readonly deadline: number;
};

/**
 * What a driver counts for stats(), and when: the moment its snapshot
 * describes, and how many milliseconds either side of it the snapshot may
 * actually come from.
 */
export type LedgerCountsSnapshot = Pick<LedgerStatistics, 'momentRange' | 'blockCount' | 'transactionCount' | 'representativeCount'> & {
	readonly moment: Date;
};

/** Documented default of LedgerConfig.heapProcessWindowMs. */
const DEFAULT_HEAP_PROCESS_WINDOW_MILLISECONDS = 5000;

// Upstream's gc loop checks its time budget only between batches, so a batch stays small.
const GC_BATCH_LIMIT = 100;

const LEDGER_CHECKSUM_KEY = 'ledgerChecksum';

const LOG_SOURCE = 'ledger';

// Where upstream's ledger records its own node statistics.
const STATS_ARENA = 'ledger';

// Test hooks answer only to this key, so callers outside the test suite cannot use them by accident.
const TESTING_KEY = 'ba48dff1-fc9c-4834-abc0-68434c8dc29b';

/**
 * The shared part of every storage driver. Upstream's own LedgerStorageBase
 * supplies preAdjust, the height and head helpers and the gc loop unchanged;
 * this class adds adjust, deferral and error evaluation on top, and declares
 * every remaining member abstract so that a driver missing one does not compile.
 */
export abstract class LedgerStorageDriverBase<Transaction extends LedgerDriverTransaction = LedgerDriverTransaction> extends LedgerInternals.LedgerStorageBase implements LedgerStorageAPI {
	#driver: DriverState = { state: 'uninitialized' };
	// Deferred staples each gc transaction has already retried; one that fails is not retried again in the same pass.
	readonly #retriedByGc = new WeakMap<Transaction, Set<StapleKey>>();

	/**
	 * Called once, synchronously, by the Ledger constructor; Ledger.copy shares
	 * the driver without calling it again. A second call would bind one store to
	 * two configurations, so it is refused.
	 * [Keeta TS] index.js:70254-70266
	 */
	init(config: LedgerConfig, ledger: Ledger): void {
		if (this.#driver.state === 'initialized') {
			throw(new Error('storage driver is already initialized'));
		}
		// Upstream's base class logs through its own config field.
		this.config = config;
		this.#driver = { state: 'initialized', config, ledger };
	}

	protected get initialized(): InitializedDriver {
		const driver = this.#driver;
		switch (driver.state) {
			case 'initialized':
				return(driver);
			case 'uninitialized':
				throw(new StorageDriverNotInitializedError());
			default:
				return(assertNever(driver));
		}
	}

	/**
	 * Applies a confirmed staple, then every deferred staple that was waiting on
	 * one of its blocks, all inside the caller's transaction. Returns each
	 * applied staple once, or nothing when the staple had to be deferred, because
	 * Ledger.add folds every returned block into the ledger checksum.
	 * [Keeta TS] index.js:69404-69417
	 */
	async adjust(transaction: Transaction, input: VoteStaple, changes: ComputedEffectOfBlocks): Promise<VoteStaple[]> {
		const windowMilliseconds = this.initialized.config.heapProcessWindowMs ?? DEFAULT_HEAP_PROCESS_WINDOW_MILLISECONDS;
		return(await this.#applyConfirmedStaple(transaction, input, changes, {
			mayDefer: true,
			completed: new Set(),
			deadline: Date.now() + windowMilliseconds
		}));
	}

	/**
	 * Keeta errors pass through with their codes, so Ledger.run retries exactly
	 * the ones that ask for it. Anything else becomes a non-retryable ledger
	 * error: Ledger.run reruns the whole transaction on a retry, which is safe
	 * only for failures a driver knows to be transient.
	 * [Keeta TS] index.js:70325-70375
	 */
	evaluateError(error: unknown): Promise<unknown> {
		if (isKeetaNetError(error)) {
			return(Promise.resolve(error));
		}
		const wrapped = createLedgerError('LEDGER_OTHER', describeError(error));
		wrapped.cause = error;
		return(Promise.resolve(wrapped));
	}

	/**
	 * Ledger statistics: the driver's counts of its main ledger, with the
	 * settlement times and transaction retries that only the node records.
	 * Without a node these are reported as unknown, the way upstream reports a
	 * statistic it cannot read.
	 * [Keeta TS] index.js:70537-70551, 70379, 74388-74396, 74451-74472
	 */
	async stats(): Promise<LedgerStatistics> {
		const { moment, momentRange, blockCount, transactionCount, representativeCount } = await this.countLedger();
		// Read lazily: a node creates its ledger before its statistics exist.
		const node = this.initialized.ledger.node;
		let retries = -1;
		let settlementTimes = KeetaNet.lib.Stats.placeholderTimingData();
		if (node !== undefined) {
			retries = await node.stats.get(STATS_ARENA, 'dbRetries');
			settlementTimes = await node.stats.getTimingData(STATS_ARENA, 'settlementTime');
		}
		return({
			moment: moment.toISOString(),
			momentRange,
			blockCount,
			transactionCount,
			representativeCount,
			db: { retries },
			settlementTimes
		});
	}

	/**
	 * One batch of upstream's gc loop, which runs batches in one transaction
	 * until a batch reports that nothing remains or the time budget is spent.
	 * [Keeta TS] index.js:67852-67862
	 */
	protected override async gcBatch(transaction: Transaction): Promise<boolean> {
		return(await this.#gcBatch(transaction, GC_BATCH_LIMIT));
	}

	/**
	 * Records the staple as waiting on each previous block that its own chain
	 * lacks; a block whose previous is inside the staple waits on nothing.
	 * [Keeta TS] index.js:67717-67728
	 */
	protected override async adjustDefer(transaction: Transaction, input: VoteStaple): Promise<void> {
		const external = blocksWithExternalPrevious(input).filter(function(block): boolean {
			return(!block.$opening);
		});
		const heights = await this.getBlockHeights(transaction, external.map(function(block) {
			return({ blockHash: block.previous, account: block.account });
		}));
		const waitingOn = new Map<BlockHashKey, BlockHash>();
		for (const block of external) {
			const previous = toBlockHashKey(block.previous);
			if (heights[previous] === null) {
				waitingOn.set(previous, block.previous);
			}
		}
		// No arriving block would ever release a staple that waits on nothing.
		if (waitingOn.size === 0) {
			throw(new Error(`internal error: staple ${toStapleKey(input.blocksHash)} was deferred but misses no previous block`));
		}
		await this.storeDeferredStaple(transaction, input, [...waitingOn.values()]);
	}

	/** @internal */
	_Testing(key: string): {
		deferredStaplesWaitingOn(transaction: Transaction, blockHashes: readonly BlockHash[]): Promise<readonly VoteStaple[]>;
		gcBatch(transaction: Transaction, limit: number): Promise<boolean>;
		persist(transaction: Transaction, change: ConfirmedStapleChange): Promise<void>;
	} {
		if (key !== TESTING_KEY) {
			throw(new Error('This is a testing only method'));
		}
		return({
			deferredStaplesWaitingOn: (transaction, blockHashes) => {
				return(this.listDeferredStaplesWaitingOn(transaction, blockHashes));
			},
			gcBatch: (transaction, limit) => {
				return(this.#gcBatch(transaction, limit));
			},
			persist: (transaction, change) => {
				return(this.persistConfirmedStaple(transaction, change));
			}
		});
	}

	/**
	 * Writes everything a confirmed staple changes. It must apply the whole
	 * change or nothing, because a deferred staple that fails during replay is
	 * skipped while the transaction carries on.
	 */
	protected abstract persistConfirmedStaple(transaction: Transaction, change: ConfirmedStapleChange): Promise<void>;

	/** Stores a staple that is missing previous blocks, replacing an earlier copy. */
	protected abstract storeDeferredStaple(transaction: Transaction, staple: VoteStaple, waitingOn: readonly BlockHash[]): Promise<void>;

	/** Deferred staples waiting on any of these blocks, each listed once. */
	protected abstract listDeferredStaplesWaitingOn(transaction: Transaction, blockHashes: readonly BlockHash[]): Promise<readonly VoteStaple[]>;

	/** Forgets a deferred staple; a staple that is not deferred is no error. */
	protected abstract removeDeferredStaple(transaction: Transaction, blocksHash: StapleKey): Promise<void>;

	/**
	 * Up to limit deferred staples, other than those excluded, whose every
	 * awaited block is now on the main ledger. Arrival normally replays them at
	 * once; these are the ones it missed.
	 */
	protected abstract listReleasedDeferredStaples(transaction: Transaction, limit: number, exclude: ReadonlySet<StapleKey>): Promise<readonly VoteStaple[]>;

	/**
	 * Removes up to limit side votes that no longer matter, with the side
	 * blocks and idempotent keys that only they held, and reports whether more
	 * such votes remain. A side vote no longer matters once it has expired at
	 * the transaction's moment, or once the previous of any block it covers
	 * has a confirmed successor: that block is then on the main ledger or
	 * competes with one that is, and its staple can never be added. A vote
	 * kept on a dead competitor would hold its idempotent keys forever.
	 */
	protected abstract collectObsoleteSideVotes(transaction: Transaction, limit: number): Promise<boolean>;

	/** The counts stats() reports, as of one consistent snapshot of the main ledger. */
	protected abstract countLedger(): Promise<LedgerCountsSnapshot>;

	abstract beginTransaction(options: TransactionOptions): Promise<Transaction>;
	abstract commitTransaction(transaction: Transaction): MemberResult<'commitTransaction'>;
	abstract abortTransaction(transaction: Transaction): MemberResult<'abortTransaction'>;
	abstract delegatedWeight(transaction: Transaction, ...input: ArgumentsAfterTransaction<'delegatedWeight'>): MemberResult<'delegatedWeight'>;
	abstract getBalance(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getBalance'>): MemberResult<'getBalance'>;
	abstract getAllBalances(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getAllBalances'>): MemberResult<'getAllBalances'>;
	// Written out because a generic signature cannot be derived through Parameters and ReturnType.
	abstract getAccountInfo<T extends AccountKeyAlgorithm = AccountKeyAlgorithm>(transaction: Transaction, account: Account<T> | string): Promise<AccountInfoForType<T>>;
	abstract listOwners(transaction: Transaction, ...input: ArgumentsAfterTransaction<'listOwners'>): MemberResult<'listOwners'>;
	abstract listACLsByPrincipal(transaction: Transaction, ...input: ArgumentsAfterTransaction<'listACLsByPrincipal'>): MemberResult<'listACLsByPrincipal'>;
	abstract listACLsByEntity(transaction: Transaction, ...input: ArgumentsAfterTransaction<'listACLsByEntity'>): MemberResult<'listACLsByEntity'>;
	abstract addPendingVote(transaction: Transaction, ...input: ArgumentsAfterTransaction<'addPendingVote'>): MemberResult<'addPendingVote'>;
	abstract getBlock(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getBlock'>): MemberResult<'getBlock'>;
	abstract override getBlockHeight(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getBlockHeight'>): MemberResult<'getBlockHeight'>;
	abstract getVotes(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getVotes'>): MemberResult<'getVotes'>;
	abstract override getVotesFromMultiplePrevious(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getVotesFromMultiplePrevious'>): MemberResult<'getVotesFromMultiplePrevious'>;
	abstract getVoteStaples(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getVoteStaples'>): MemberResult<'getVoteStaples'>;
	abstract getHistory(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getHistory'>): MemberResult<'getHistory'>;
	abstract override getHeadBlocks(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getHeadBlocks'>): MemberResult<'getHeadBlocks'>;
	abstract getBlockFromPrevious(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getBlockFromPrevious'>): MemberResult<'getBlockFromPrevious'>;
	abstract getAccountRep(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getAccountRep'>): MemberResult<'getAccountRep'>;
	abstract getVotesAfter(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getVotesAfter'>): MemberResult<'getVotesAfter'>;
	abstract getNextSerialNumber(transaction?: Transaction): MemberResult<'getNextSerialNumber'>;
	abstract getAccountCertificates(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getAccountCertificates'>): MemberResult<'getAccountCertificates'>;
	abstract getAccountCertificateByHash(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getAccountCertificateByHash'>): MemberResult<'getAccountCertificateByHash'>;
	abstract getIdempotentBlockHash(transaction: Transaction, ...input: ArgumentsAfterTransaction<'getIdempotentBlockHash'>): MemberResult<'getIdempotentBlockHash'>;

	/*
	 * The template behind adjust: upstream's preAdjust assigns heights or
	 * defers, the driver refuses forks, and only a fully computed change is
	 * written.
	 */
	async #applyConfirmedStaple(transaction: Transaction, staple: VoteStaple, effects: ComputedEffectOfBlocks, replay: ReplayState): Promise<VoteStaple[]> {
		this.#assertChainOrder(staple);
		this.#assertDistinctPrevious(staple);
		const heights = await this.preAdjust(staple, replay.mayDefer, transaction);
		// An empty result means preAdjust deferred the staple, or found it already deferred.
		if (Object.keys(heights).length === 0) {
			return([]);
		}
		await this.#assertExtendsConfirmedHistory(transaction, staple);

		const { config, ledger } = this.initialized;
		// Our temporary side vote is still in place here, which the settlement
		// time is measured from; the increments are kept until the staple
		// applies. The node is the transaction's, because Ledger.copy shares one
		// driver between nodes.
		const settlementStatistics = await LedgerInternals.addTimeStatistic(transaction.node, staple.blocks, 'main', this, transaction, true);
		const change = await computeConfirmedStapleChange({
			transaction,
			staple,
			effects,
			blockHeights: blockHeightsOf(staple, heights),
			storage: this,
			network: config.network,
			baseToken: ledger.baseToken,
			moment: transaction.moment
		});
		await this.persistConfirmedStaple(transaction, change);
		const stapleKey = toStapleKey(staple.blocksHash);
		// A staple can arrive again on its own after it was deferred, for example
		// when its replay was cut short; once applied it must stop waiting.
		await this.removeDeferredStaple(transaction, stapleKey);
		for (const increase of settlementStatistics) {
			transaction.statsPending.incr(...increase);
		}
		replay.completed.add(stapleKey);

		const replayed = await this.#replayWaiters(transaction, staple, replay);
		return([staple, ...replayed]);
	}

	/*
	 * Replay never defers again: a waiter that still lacks another previous
	 * stays where it is. A waiter that fails is logged and left in place, and
	 * the staple that released it still applies.
	 * [Keeta TS] index.js:67722-67725
	 */
	async #replayWaiters(transaction: Transaction, released: VoteStaple, replay: ReplayState): Promise<VoteStaple[]> {
		const { config, ledger } = this.initialized;
		const waiters = await this.listDeferredStaplesWaitingOn(transaction, released.blocks.map(function(block): BlockHash {
			return(block.hash);
		}));
		const applied: VoteStaple[] = [];
		for (const waiter of waiters) {
			const waiterKey = toStapleKey(waiter.blocksHash);
			if (replay.completed.has(waiterKey)) {
				continue;
			}
			// A window of zero replays nothing; every waiter stays for a later pass.
			if (Date.now() >= replay.deadline) {
				config.log?.warn(LOG_SOURCE, `deferred staple replay window elapsed; ${waiterKey} stays deferred`);
				break;
			}
			try {
				const effects = LedgerInternals.computeEffectOfBlocks(waiter.blocks, ledger);
				applied.push(...await this.#applyConfirmedStaple(transaction, waiter, effects, { ...replay, mayDefer: false }));
			} catch (error: unknown) {
				config.log?.error(LOG_SOURCE, `replaying deferred staple ${waiterKey} failed; it stays deferred`, error);
			}
		}
		return(applied);
	}

	/*
	 * Deferred staples are retried first, because applying one can leave more
	 * side votes with a block on main.
	 */
	async #gcBatch(transaction: Transaction, limit: number): Promise<boolean> {
		const moreDeferred = await this.#retryReleasedDeferredStaples(transaction, limit);
		const moreSideVotes = await this.collectObsoleteSideVotes(transaction, limit);
		return(moreDeferred || moreSideVotes);
	}

	/*
	 * A deferred staple whose awaited blocks are all on main should have been
	 * replayed when the last of them arrived; the replay window may have run
	 * out, or the replay failed. It is retried the way a replay would run it.
	 * One that fails again stays deferred and is logged, and is not retried
	 * again by the same gc pass, so it never keeps the pass going.
	 */
	async #retryReleasedDeferredStaples(transaction: Transaction, limit: number): Promise<boolean> {
		const { config, ledger } = this.initialized;
		const retried = this.#retriedByGc.get(transaction) ?? new Set<StapleKey>();
		this.#retriedByGc.set(transaction, retried);
		const replay: ReplayState = {
			mayDefer: false,
			completed: new Set(),
			deadline: Date.now() + (config.heapProcessWindowMs ?? DEFAULT_HEAP_PROCESS_WINDOW_MILLISECONDS)
		};
		for (const staple of await this.listReleasedDeferredStaples(transaction, limit, retried)) {
			const stapleKey = toStapleKey(staple.blocksHash);
			retried.add(stapleKey);
			try {
				const applied = await this.#applyConfirmedStaple(transaction, staple, LedgerInternals.computeEffectOfBlocks(staple.blocks, ledger), replay);
				foldIntoLedgerChecksum(transaction, applied);
			} catch (error: unknown) {
				config.log?.error(LOG_SOURCE, `retrying deferred staple ${stapleKey} failed; it stays deferred`, error);
			}
		}
		return((await this.listReleasedDeferredStaples(transaction, 1, retried)).length > 0);
	}

	/*
	 * Upstream's preAdjust assigns heights but never notices that a previous
	 * block already has a confirmed successor, or that an opening block arrives
	 * for an account that already has a chain. Applying such a staple would
	 * overwrite confirmed history, so it is refused and reported.
	 * [Keeta TS] index.js:67678-67732
	 */
	async #assertExtendsConfirmedHistory(transaction: Transaction, staple: VoteStaple): Promise<void> {
		await Promise.all(blocksWithExternalPrevious(staple).map(async (block): Promise<void> => {
			if (block.$opening) {
				const head = await this.getHeadBlock(transaction, block.account, 'main');
				if (head !== null) {
					throw(this.confirmedHistoryConflict(block, `opening block for an account whose chain already ends at ${head.hash.toString()}`));
				}
				return;
			}
			const successor = await this.getBlockFromPrevious(transaction, block.previous, 'main');
			if (successor !== null) {
				throw(this.confirmedHistoryConflict(block, `previous already has the confirmed successor ${successor.hash.toString()}`));
			}
		}));
	}

	/*
	 * Two blocks of one staple that claim the same previous are a fork within
	 * the staple. It is refused before preAdjust, which would otherwise defer
	 * it when that previous is missing and leave it failing on every replay.
	 */
	#assertDistinctPrevious(staple: VoteStaple): void {
		const claimedPrevious = new Set<BlockHashKey>();
		for (const block of staple.blocks) {
			const previous = toBlockHashKey(block.previous);
			if (claimedPrevious.has(previous)) {
				throw(this.confirmedHistoryConflict(block, 'another block of the same staple has the same previous'));
			}
			claimedPrevious.add(previous);
		}
	}

	/*
	 * Upstream's preAdjust assigns a block its height only when its previous
	 * came earlier in the staple, and otherwise defers; a staple that lists a
	 * block before its own previous would wait for a block it carries itself,
	 * and no arrival would ever release it. It is refused with the code vote
	 * validation uses for the same ordering fault.
	 * [Keeta TS] index.js:67691-67728 (deferral), 70150-70160 (error code)
	 */
	#assertChainOrder(staple: VoteStaple): void {
		const later = new Set<BlockHashKey>(staple.blocks.map(function(block): BlockHashKey {
			return(toBlockHashKey(block.hash));
		}));
		for (const block of staple.blocks) {
			later.delete(toBlockHashKey(block.hash));
			if (later.has(toBlockHashKey(block.previous))) {
				const message = `staple ${toStapleKey(staple.blocksHash)} lists block ${block.hash.toString()} before its previous ${block.previous.toString()}, so its blocks are out of order`;
				this.initialized.config.log?.warn(LOG_SOURCE, message);
				throw(createLedgerError('LEDGER_PREVIOUS_NOT_SEEN', message));
			}
		}
	}

	/**
	 * The error for a confirmed block that would overwrite confirmed history,
	 * logged as a network integrity alarm: a quorum confirmed a fork.
	 */
	protected confirmedHistoryConflict(block: Block, reason: string): Error {
		const message = `confirmed block ${block.hash.toString()} conflicts with confirmed history: ${reason}`;
		this.initialized.config.log?.error(LOG_SOURCE, `network integrity alarm: ${message}`);
		return(createLedgerError('LEDGER_PREVIOUS_ALREADY_USED', message));
	}
}

/*
 * Ledger.add folds the staples adjust returns into the node's checksum, and
 * the transaction's statistics reach the node only on commit; staples that gc
 * applies are folded in the same way.
 * [Keeta TS] index.js:69413-69417, 69001-69006
 */
function foldIntoLedgerChecksum(transaction: LedgerDriverTransaction, staples: readonly VoteStaple[]): void {
	for (const staple of staples) {
		for (const block of staple.blocks) {
			transaction.statsPending.xor(LEDGER_CHECKSUM_KEY, block.hash);
		}
	}
}

function blocksWithExternalPrevious(staple: VoteStaple): Block[] {
	const inStaple = new Set<BlockHashKey>(staple.blocks.map(function(block): BlockHashKey {
		return(toBlockHashKey(block.hash));
	}));
	return(staple.blocks.filter(function(block): boolean {
		return(!inStaple.has(toBlockHashKey(block.previous)));
	}));
}
