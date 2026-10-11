import { everyChainAccount } from './follower-store.js';
import type { FollowerStore, KnownAccount } from './follower-store.js';
import type { PacerClock } from './representative-pacer.js';

/**
 * What pg-pool and pg raise when no session came within the pool's
 * connection timeout: the pool's sessions all busy, or the cluster slow to
 * hand out another.
 */
const LOAD_MESSAGES: ReadonlySet<string> = new Set(['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout']);

/** SQLSTATEs of a statement canceled by its timeout (57014), and of a cluster with no connection left (53300). */
const LOAD_CODES: ReadonlySet<string> = new Set(['57014', '53300']);

/** What pg raises for a session the server ended without a code, as a restart of the follower's cluster does. */
const UNREACHABLE_MESSAGES: ReadonlySet<string> = new Set(['Connection terminated unexpectedly']);

/**
 * Codes of a cluster that is not serving: SQLSTATEs of one starting up
 * (57P03) and one shutting down (57P01), and the system's codes of a socket
 * with no server behind it (ECONNREFUSED) or none at all (ENOENT).
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['57P03', '57P01', 'ECONNREFUSED', 'ENOENT']);

const FIRST_WAIT_MILLISECONDS = 1000;

const LONGEST_WAIT_MILLISECONDS = 30_000;

/** How long a command that has read the follower's database waits for it to serve again, as through a restart of the follower. */
export const UNREACHABLE_LIMIT_MILLISECONDS: number = 15 * 60_000;

/**
 * Why a read of the follower's database failed when the same read may
 * succeed later: the cluster's load, or the cluster not serving.
 */
export type TransientCause = 'load' | 'unreachable';

export function transientCauseOf(error: unknown): TransientCause | undefined {
	if (!(error instanceof Error)) {
		return(undefined);
	}
	const code: unknown = Reflect.get(error, 'code');
	if (LOAD_MESSAGES.has(error.message) || (typeof code === 'string' && LOAD_CODES.has(code))) {
		return('load');
	}
	if (UNREACHABLE_MESSAGES.has(error.message) || (typeof code === 'string' && UNREACHABLE_CODES.has(code))) {
		return('unreachable');
	}
	return(undefined);
}

/** A failure waited out: which attempt at the read it ended, how long since the read began, and how long the wait is. */
export type TransientFailure = {
	readonly attempt: number;
	readonly elapsedMilliseconds: number;
	readonly waitMilliseconds: number;
};

export type TransientRetry = {
	readonly clock: PacerClock;
	/** Ends the waiting: the read's error is then thrown. */
	readonly stopped: AbortSignal;
	/** Told of each failure waited out, so that a read failing on and on shows. */
	readonly retrying?: (error: unknown, failure: TransientFailure) => void;
};

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return(error.message);
	}
	return(String(error));
}

/**
 * Runs reads of the follower's database until each succeeds, waiting out
 * each failure the cluster's load caused, 1 s at first and doubled each
 * time up to 30 s: the follower's cluster serves the node, the offline
 * ledger of the shadow votes and the tools at once, and a walk that stopped
 * on one busy moment would lose its batch. A cluster not serving is waited
 * out the same way, as through a restart of the follower, but only once a
 * read has succeeded, and for 15 minutes at most: before that, it is a
 * follower that is not running, or a directory that is not its, which no
 * wait mends. Any other failure, or one once stopped, is thrown.
 */
class TransientReads {
	readonly #retry: TransientRetry;
	#reached = false;

	constructor(retry: TransientRetry) {
		this.#retry = retry;
	}

	async run<Result>(read: () => Promise<Result>): Promise<Result> {
		const { clock, stopped } = this.#retry;
		const began = clock.now();
		let unreachableSince: number | undefined;
		let waitMilliseconds = FIRST_WAIT_MILLISECONDS;
		for (let attempt = 1; ; attempt++) {
			try {
				const result = await read();
				this.#reached = true;
				return(result);
			} catch (error: unknown) {
				const cause = transientCauseOf(error);
				if (cause === undefined || stopped.aborted) {
					throw(error);
				}
				if (cause === 'unreachable') {
					if (!this.#reached) {
						throw(new Error(`the follower's database cannot be reached (${messageOf(error)}): is the follower running, and is this its directory?`, { cause: error }));
					}
					unreachableSince ??= clock.now();
					if (clock.now() - unreachableSince >= UNREACHABLE_LIMIT_MILLISECONDS) {
						throw(new Error(`the follower's database has not been reachable for ${String(Math.round((clock.now() - unreachableSince) / 60_000))} min (${messageOf(error)}); the read is given up`, { cause: error }));
					}
				} else {
					unreachableSince = undefined;
				}
				this.#retry.retrying?.(error, { attempt, elapsedMilliseconds: clock.now() - began, waitMilliseconds });
				try {
					await clock.pause(waitMilliseconds, stopped);
				} catch {
					throw(error);
				}
				waitMilliseconds = Math.min(waitMilliseconds * 2, LONGEST_WAIT_MILLISECONDS);
			}
		}
	}
}

/**
 * The store, each of its reads run until it succeeds through the cluster's
 * load (TransientReads). Every account with a chain is read page by page,
 * as the store reads it, each page waited out alone, so that a busy moment
 * reads again from the page it cut, not from the first.
 */
export function retryingStore(store: FollowerStore, retry: TransientRetry): FollowerStore {
	const reads = new TransientReads(retry);
	function retrying<Args extends readonly unknown[], Result>(read: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
		return(function(...args: Args): Promise<Result> {
			return(reads.run(function(): Promise<Result> {
				return(read(...args));
			}));
		});
	}
	const chainAccountsAfter = retrying(store.chainAccountsAfter.bind(store));
	return({
		progress: retrying(store.progress.bind(store)),
		chainAccountsAfter,
		passiveAccountsAfter: retrying(store.passiveAccountsAfter.bind(store)),
		accountCount: retrying(store.accountCount.bind(store)),
		chainAccounts(): Promise<readonly KnownAccount[]> {
			return(everyChainAccount(chainAccountsAfter));
		},
		rowIDsOf: retrying(store.rowIDsOf.bind(store)),
		historyHolds: retrying(store.historyHolds.bind(store)),
		checksumSnapshot: retrying(store.checksumSnapshot.bind(store)),
		quietAccounts: retrying(store.quietAccounts.bind(store)),
		heldBlocks: retrying(store.heldBlocks.bind(store)),
		blockPages: retrying(store.blockPages.bind(store)),
		heldBlocksInPages: retrying(store.heldBlocksInPages.bind(store)),
		heldBlocksOfStaples: retrying(store.heldBlocksOfStaples.bind(store)),
		lastSequence: retrying(store.lastSequence.bind(store)),
		stapleAt: retrying(store.stapleAt.bind(store)),
		staplesAfter: retrying(store.staplesAfter.bind(store)),
		staplesOf: retrying(store.staplesOf.bind(store)),
		newestStaples: retrying(store.newestStaples.bind(store)),
		close: store.close.bind(store)
	});
}
