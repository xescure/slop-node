import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { ProjectionBackfill } from '../ledger/storage/postgres/driver.js';

const LOG_SOURCE = 'PROJECTION';

/** How often a waiting backfill asks whether the node has caught up; asking reads a count the bootstrap keeps in memory. */
export const CAUGHT_UP_POLL_MILLISECONDS = 1000;

/** How long after a failed batch the backfill tries it again. */
export const BACKFILL_RETRY_MILLISECONDS = 60_000;

export type ProjectionBackfillIO = {
	/** Whether the node has caught up with its peers, so that applying their staples is not behind. */
	readonly caughtUp: () => Promise<boolean>;
	readonly backfill: (progress: (done: ProjectionBackfill) => Promise<void>) => Promise<ProjectionBackfill>;
	readonly log: Logger;
	/** Resolves after that long, or rejects once the signal aborts. */
	readonly pause: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
	return(sleep(milliseconds, undefined, { signal }));
}

function describeBackfill(done: ProjectionBackfill): string {
	return(`${String(done.staples)} staples, ${String(done.operations)} operations filled in; every staple from the one stored as ${done.completeFrom.toString()} has its rows`);
}

/**
 * Runs the projection backfill once beside the node, from when the node has
 * caught up with its peers, and between its batches only while it stays
 * caught up. A batch that fails is logged and tried again after a pause; a
 * backfill that has run to its end is not run again.
 */
export class ProjectionBackfillRunner {
	readonly #io: ProjectionBackfillIO;
	readonly #stopping = new AbortController();
	readonly #ran: Promise<void>;

	constructor(io: ProjectionBackfillIO) {
		this.#io = io;
		this.#ran = this.#run();
	}

	/** Waits for the batch in hand, if any, and begins no other. */
	async stop(): Promise<void> {
		this.#stopping.abort();
		await this.#ran;
	}

	async #run(): Promise<void> {
		const { signal } = this.#stopping;
		for (;;) {
			try {
				await this.#whenCaughtUp();
				const done = await this.#io.backfill(async (progress) => {
					this.#io.log.info(LOG_SOURCE, `Projection backfill: ${describeBackfill(progress)}`);
					await this.#whenCaughtUp();
				});
				this.#io.log.info(LOG_SOURCE, `Projection backfill done: ${describeBackfill(done)}`);
				return;
			} catch (error: unknown) {
				if (signal.aborted) {
					return;
				}
				this.#io.log.warn(LOG_SOURCE, `Projection backfill failed; it is tried again in ${String(BACKFILL_RETRY_MILLISECONDS / 1000)} s:`, error);
			}
			try {
				await this.#io.pause(BACKFILL_RETRY_MILLISECONDS, signal);
			} catch {
				return;
			}
		}
	}

	async #whenCaughtUp(): Promise<void> {
		const { signal } = this.#stopping;
		signal.throwIfAborted();
		if (await this.#io.caughtUp()) {
			return;
		}
		this.#io.log.info(LOG_SOURCE, 'Projection backfill waits until the node has caught up with its peers');
		do {
			await this.#io.pause(CAUGHT_UP_POLL_MILLISECONDS, signal);
		} while (!(await this.#io.caughtUp()));
		this.#io.log.info(LOG_SOURCE, 'Projection backfill goes on: the node has caught up with its peers');
	}
}
