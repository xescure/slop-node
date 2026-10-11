import { everyChainAccount } from './follower-store.js';
import type { FollowerStore, KnownAccount } from './follower-store.js';
import type { PacerClock } from './representative-pacer.js';

/**
 * What pg-pool and pg raise when no session came within the pool's
 * connection timeout: the pool's sessions all busy, or the cluster slow to
 * hand out another.
 */
const CONNECT_TIMEOUT_MESSAGES: ReadonlySet<string> = new Set(['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout', 'Connection terminated unexpectedly']);

/**
 * Codes of a read the cluster's load or a restart of the follower, not the
 * read, failed: SQLSTATEs of a statement canceled by its timeout (57014), a
 * cluster with no connection left (53300), one starting up (57P03) and one
 * shutting down (57P01), and the system's codes of a socket with no server
 * behind it (ECONNREFUSED) or none at all (ENOENT), as while the follower's
 * cluster restarts; pg then reports a session the restart ended without a
 * code.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['57014', '53300', '57P03', '57P01', 'ECONNREFUSED', 'ENOENT']);

const FIRST_WAIT_MILLISECONDS = 1000;

const LONGEST_WAIT_MILLISECONDS = 30_000;

/** Whether a read of the follower's database failed for the cluster's load, so that the same read may succeed later. */
export function isTransientStoreError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return(false);
	}
	if (CONNECT_TIMEOUT_MESSAGES.has(error.message)) {
		return(true);
	}
	const code: unknown = Reflect.get(error, 'code');
	return(typeof code === 'string' && TRANSIENT_CODES.has(code));
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

/**
 * Runs the read until it succeeds, waiting out each failure the cluster's
 * load caused, 1 s at first and doubled each time up to 30 s: the
 * follower's cluster serves the node, the offline ledger of the shadow
 * votes and the tools at once, and a walk that stopped on one busy moment
 * would lose its batch. Any other failure, or one once stopped, is thrown.
 */
export async function retryingTransient<Result>(read: () => Promise<Result>, retry: TransientRetry): Promise<Result> {
	const began = retry.clock.now();
	let waitMilliseconds = FIRST_WAIT_MILLISECONDS;
	for (let attempt = 1; ; attempt++) {
		try {
			return(await read());
		} catch (error: unknown) {
			if (!isTransientStoreError(error) || retry.stopped.aborted) {
				throw(error);
			}
			retry.retrying?.(error, { attempt, elapsedMilliseconds: retry.clock.now() - began, waitMilliseconds });
			try {
				await retry.clock.pause(waitMilliseconds, retry.stopped);
			} catch {
				throw(error);
			}
			waitMilliseconds = Math.min(waitMilliseconds * 2, LONGEST_WAIT_MILLISECONDS);
		}
	}
}

/**
 * The store, each of its reads run until it succeeds through the cluster's
 * load (retryingTransient). Every account with a chain is read page by page,
 * as the store reads it, each page waited out alone, so that a busy moment
 * reads again from the page it cut, not from the first.
 */
export function retryingStore(store: FollowerStore, retry: TransientRetry): FollowerStore {
	function retrying<Args extends readonly unknown[], Result>(read: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
		return(function(...args: Args): Promise<Result> {
			return(retryingTransient(function(): Promise<Result> {
				return(read(...args));
			}, retry));
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
