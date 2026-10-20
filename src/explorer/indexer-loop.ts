import type pg from 'pg';
import type { LogEntry, LogTarget } from '@keetanetwork/keetanet-client/lib/log/common.js';
import type { LogLevel } from '@keetanetwork/keetanet-client/lib/log/index.js';
import { describeError } from '../ledger/storage/errors.js';
import { assertNever } from '../util/assert-never.js';
import {
	checkHoldings,
	indexBatch,
	pausedReason,
	reconcile,
	startingState,
	type BatchResult,
	type HoldingsCatchUp,
	type IndexerFault,
	type IndexerSettings,
	type IndexerState
} from './indexer.js';

const LOG_FROM = 'explorer/indexer';

const describeFault = function(fault: IndexerFault): string {
	switch (fault.kind) {
		case 'missed-staple':
			return(`indexer fault: staple ${fault.blocksHash} at sequence ${fault.sequence.toString()} was passed by the watermark but not indexed`);
		case 'holding-differs':
			return(`indexer fault: holding of token ${fault.tokenID} by account ${fault.accountID} was ${fault.explorer ?? 'absent'}, the node holds ${fault.node ?? 'none'}`);
		case 'holdings-unchecked':
			return(`indexer fault: ${String(fault.remaining)} more holdings differ from the node's than one check compares; the next check takes them`);
		default:
			return(assertNever(fault));
	}
};

/*
 * A deploy starts the new container before it stops the old one, and two
 * indexers would race on the watermark, so one session lock, held on a
 * connection of its own for the indexer's life, lets one index at a time.
 * Its key is ASCII keetaidx, distinct from both migration locks.
 */
const INDEXER_LOCK_KEY = 0x6b65657461696478n;

type Step = 'lock' | 'index' | 'reconcile' | 'holdings';

const STEP_FAILURES: Readonly<Record<Step, string>> = {
	lock: 'the indexer lock could not be taken',
	index: 'indexing stopped',
	reconcile: 'the reconcile failed',
	holdings: 'the holdings check failed'
};

const WAITING_MESSAGE = 'another indexer holds the indexer lock; waiting for it to stop';

const LOST_MESSAGE = 'the indexer lock was lost with its connection; indexing stops until it is taken again';

/**
 * The connection that holds the indexer lock. The server ending its session
 * ends the lock, and the client reports that as an error event, which would
 * end the process if nothing listened for it.
 */
class HeldLock {
	readonly #client: pg.PoolClient;
	readonly #onError: () => void;
	#held = false;
	#lost = false;

	constructor(client: pg.PoolClient, onLost: () => void) {
		this.#client = client;
		this.#onError = () => {
			this.#lost = true;
			onLost();
		};
		client.on('error', this.#onError);
	}

	get lost(): boolean {
		return(this.#lost);
	}

	async take(): Promise<boolean> {
		const result = await this.#client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS locked', [INDEXER_LOCK_KEY.toString()]);
		this.#held = result.rows[0]?.locked === true;
		return(this.#held);
	}

	// The error event can come after a query on the dead session has failed, so a failed query also marks the lock lost.
	async alive(): Promise<boolean> {
		if (!this.#lost) {
			await this.#client.query('SELECT 1').catch(() => {
				this.#lost = true;
			});
		}
		return(!this.#lost);
	}

	async release(): Promise<void> {
		if (this.#held && !this.#lost) {
			await this.#client.query('SELECT pg_advisory_unlock($1::bigint)', [INDEXER_LOCK_KEY.toString()]).catch(() => {
				this.#lost = true;
			});
		}
		if (!this.#lost) {
			this.#client.removeListener('error', this.#onError);
		}
		// A lost connection is destroyed rather than returned to the pool.
		this.#client.release(this.#lost);
	}
}

/** Runs the batches, the reconcile and the holdings check on their schedules until stopped, while it holds the indexer lock. */
export class Indexer {
	readonly #writer: pg.Pool;
	readonly #settings: IndexerSettings;
	readonly #log: LogTarget;
	#running: Promise<void> | null = null;
	#stopping = false;
	#wake: (() => void) | null = null;
	readonly #lastErrors = new Map<Step, string>();

	constructor(writer: pg.Pool, settings: IndexerSettings, log: LogTarget) {
		this.#writer = writer;
		this.#settings = settings;
		this.#log = log;
	}

	start(): void {
		if (this.#running !== null) {
			return;
		}
		this.#stopping = false;
		this.#running = this.#run();
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		this.#wake?.();
		await this.#running;
		this.#running = null;
	}

	#emit(level: LogLevel, message: string): void {
		const entry: LogEntry = { options: {}, level, from: LOG_FROM, args: [message] };
		this.#log.emitLogs([entry]).catch(function() {
			// A target that cannot write has nowhere to report that it cannot.
		});
	}

	#fault = (fault: IndexerFault): void => {
		this.#emit('ERROR', describeFault(fault));
	};

	// A failure that persists is logged once, not once a poll, until the step succeeds or fails otherwise.
	async #attempt<Result>(step: Step, work: () => Promise<Result>): Promise<Result | undefined> {
		try {
			const result = await work();
			this.#lastErrors.delete(step);
			return(result);
		} catch (error: unknown) {
			const message = describeError(error);
			if (this.#lastErrors.get(step) !== message) {
				this.#emit('ERROR', `${STEP_FAILURES[step]}: ${message}`);
			}
			this.#lastErrors.set(step, message);
			return(undefined);
		}
	}

	// A stop during a batch finds no sleep to wake, so the sleep that follows the batch ends at once.
	#sleep(milliseconds: number): Promise<void> {
		return(new Promise((resolve) => {
			if (this.#stopping) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, milliseconds);
			this.#wake = function() {
				clearTimeout(timer);
				resolve();
			};
		}));
	}

	// The lock if it was taken, null if another indexer holds it.
	async #tryLock(): Promise<HeldLock | null> {
		const lock = new HeldLock(await this.#writer.connect(), () => {
			this.#wake?.();
		});
		try {
			if (await lock.take()) {
				return(lock);
			}
		} catch (error: unknown) {
			await lock.release();
			throw(error);
		}
		await lock.release();
		return(null);
	}

	async #acquire(): Promise<HeldLock | undefined> {
		let waiting = false;
		while (!this.#stopping) {
			const lock = await this.#attempt('lock', () => {
				return(this.#tryLock());
			});
			if (lock !== undefined && lock !== null) {
				return(lock);
			}
			if (lock === null && !waiting) {
				this.#emit('INFO', WAITING_MESSAGE);
				waiting = true;
			}
			await this.#sleep(this.#settings.pollMilliseconds);
		}
		return(undefined);
	}

	async #run(): Promise<void> {
		while (!this.#stopping) {
			const lock = await this.#acquire();
			if (lock === undefined) {
				return;
			}
			try {
				await this.#index(lock);
			} finally {
				await lock.release();
			}
			if (lock.lost) {
				this.#emit('ERROR', LOST_MESSAGE);
				// Another indexer may be waiting for the lock; it gets a poll to take it.
				await this.#sleep(this.#settings.pollMilliseconds);
			}
		}
	}

	async #batch(state: IndexerState | undefined): Promise<BatchResult> {
		const before = state ?? await startingState(this.#writer);
		const result = await indexBatch(this.#writer, before, this.#settings, Date.now, () => {
			return(this.#stopping);
		});
		if (result.state.kind === 'paused' && before.kind !== 'paused') {
			this.#emit('ERROR', `indexing paused: ${pausedReason(result.state.nodeVersion, result.state.newestKnown)}`);
		}
		return(result);
	}

	// A full batch leaves more to index, so the next comes after the short pause that throttles a backfill.
	#pauseAfter(result: BatchResult | undefined): number {
		if (result !== undefined && result.indexed >= this.#settings.batchStaples) {
			return(this.#settings.batchPauseMilliseconds);
		}
		return(this.#settings.pollMilliseconds);
	}

	#catchUp(lock: HeldLock): HoldingsCatchUp {
		return({
			settings: this.#settings,
			stopping: () => {
				return(this.#stopping || lock.lost);
			},
			sleep: (milliseconds) => {
				return(this.#sleep(milliseconds));
			}
		});
	}

	/*
	 * Each round first checks that the lock's connection is alive, so an
	 * indexer that lost the lock writes nothing more. The state starts afresh
	 * with each lock taken, since another indexer may have moved on meanwhile.
	 */
	async #index(lock: HeldLock): Promise<void> {
		let state: IndexerState | undefined;
		let reconciled = Date.now();
		let holdingsChecked = Date.now();
		while (!this.#stopping && await lock.alive()) {
			const result = await this.#attempt('index', () => {
				return(this.#batch(state));
			});
			state = result?.state ?? state;
			// Under a node schema this build does not know, nothing is written.
			const running = state?.kind === 'running' && !lock.lost;
			if (running && Date.now() - reconciled >= this.#settings.reconcileMilliseconds) {
				reconciled = Date.now();
				await this.#attempt('reconcile', () => {
					return(reconcile(this.#writer, this.#fault));
				});
			}
			// While a backfill runs the check waits: its catch-up would be the backfill.
			const caughtUp = result !== undefined && result.indexed < this.#settings.batchStaples;
			if (running && caughtUp && Date.now() - holdingsChecked >= this.#settings.holdingsCheckMilliseconds) {
				holdingsChecked = Date.now();
				await this.#attempt('holdings', () => {
					return(checkHoldings(this.#writer, this.#fault, this.#catchUp(lock)));
				});
			}
			await this.#sleep(this.#pauseAfter(result));
		}
	}
}
