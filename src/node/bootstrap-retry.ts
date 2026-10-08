import { assertNever } from '../util/assert-never.js';
import type { NamedStaple } from './bootstrap-window.js';

/**
 * The most staples the queue holds. A main network representative serves
 * its history in the order it applied it, which is not causal: the first
 * page from the beginning holds four staples before the genesis staple that
 * gives their voters weight. A staple waits in the queue until the staples it
 * needs arrive, which a page or a few later bring, so it holds a handful at a
 * time; this bound is far above that, and a retry offers every one of them
 * to the ledger again.
 */
export const MAX_QUEUED_STAPLES = 1000;

/** The most bytes of staples the queue holds, about a thousand staples of the main network's largest. */
export const MAX_QUEUED_BYTES: number = 16 * 1024 * 1024;

/**
 * How long the ledger may refuse a staple before the node reports it, once,
 * as one it cannot apply although the network did: by then every staple a
 * page or two later has long been read.
 */
export const REPORT_REFUSED_AFTER_MILLISECONDS: number = 60 * 60_000;

/** What the ledger did with a staple offered to it. */
export type Offered =
	| { readonly kind: 'added' }
	/** It refused the staple, for the reason the code names. */
	| { readonly kind: 'refused'; readonly code: string };

/** The ledger a queue offers its staples to. */
export type RetryLedger<Staple> = {
	/** Whether it holds the staple's blocks, with these votes or others. */
	holds(staple: Staple): Promise<boolean>;
	offer(staple: Staple): Promise<Offered>;
};

/** A staple the ledger refused, waiting to be offered again. */
export type QueuedStaple<Staple> = {
	readonly staple: Staple;
	/** When the ledger first refused it, on the node's clock. */
	readonly queuedAt: number;
	/** Why the ledger refused it the last time. */
	readonly code: string;
	/** Whether it was reported as refused for long. */
	readonly reported: boolean;
};

/** Where a queue keeps its staples, by the hash of their blocks, so that they outlive the process. */
export type RetryStore<Staple> = {
	load(): Promise<readonly QueuedStaple<Staple>[]>;
	put(key: string, entry: QueuedStaple<Staple>): Promise<void>;
	remove(key: string): Promise<void>;
};

export type QueueBounds = {
	readonly staples: number;
	readonly bytes: number;
};

const DEFAULT_BOUNDS: QueueBounds = { staples: MAX_QUEUED_STAPLES, bytes: MAX_QUEUED_BYTES };

/** Whether a staple a pass was sent was new to the node, one it held already, perhaps with other votes, or one the ledger refused and the queue holds. */
export type Added = 'added' | 'held' | 'queued';

/**
 * The queue was full when the ledger refused one more staple. The staple is
 * not held, so the pass that was sent it must not move past it; the pass
 * fails, and the next reads it again, once a retry may have made room.
 */
export class RetryQueueFull extends Error {
	constructor(blocksHash: string, bounds: QueueBounds) {
		super(`the ledger refused staple ${blocksHash} while the bootstrap retry queue was full (it holds at most ${String(bounds.staples)} staples, ${String(bounds.bytes)} bytes)`);
		this.name = 'RetryQueueFull';
	}
}

function keyOf(staple: NamedStaple): string {
	return(staple.blocksHash.toString());
}

function sizeOf(staple: NamedStaple): number {
	return(staple.toBytes().byteLength);
}

function earliestFirst<Staple>(left: QueuedStaple<Staple>, right: QueuedStaple<Staple>): number {
	return(left.queuedAt - right.queuedAt);
}

/**
 * Staples the ledger refused that it does not hold, offered to it again
 * until it accepts them or holds their blocks.
 *
 * A peer serves its staples in the order it applied them, which need not be
 * causal, so the ledger refuses a staple whose dependencies come later: the
 * voting weight of genesis or a delegation, a credit a debit spends, a
 * token's supply. Such a staple is not held, but it is not lost either: it
 * stays here, durably, and is offered again after each page that added a
 * staple and at the end of each pass, round after round while a round
 * applies any, since one applied can let others through.
 */
export class RetryQueue<Staple extends NamedStaple> {
	readonly #ledger: RetryLedger<Staple>;
	readonly #store: RetryStore<Staple>;
	readonly #report: (entry: QueuedStaple<Staple>, age: number) => void;
	readonly #bounds: QueueBounds;
	#entries: Promise<Map<string, QueuedStaple<Staple>>> | undefined;
	#bytes = 0;
	/** Retries run one after another, so that a staple is offered by one at a time. */
	#retrying: Promise<unknown> = Promise.resolve();

	/** The report hears, once, of each staple refused for longer than REPORT_REFUSED_AFTER_MILLISECONDS, and for how long. */
	constructor(ledger: RetryLedger<Staple>, store: RetryStore<Staple>, report: (entry: QueuedStaple<Staple>, age: number) => void, bounds: QueueBounds = DEFAULT_BOUNDS) {
		this.#ledger = ledger;
		this.#store = store;
		this.#report = report;
		this.#bounds = bounds;
	}

	async size(): Promise<number> {
		return((await this.#load()).size);
	}

	/** The staples queued, the earliest refused first. */
	async staples(): Promise<Staple[]> {
		return([...(await this.#load()).values()].map(function(entry): Staple {
			return(entry.staple);
		}));
	}

	/**
	 * Adds the staple, or queues it when the ledger refuses it and does not
	 * hold its blocks; one queued already is left to the retries. Throws
	 * RetryQueueFull when the queue has no room for it.
	 */
	async add(staple: Staple): Promise<Added> {
		const entries = await this.#load();
		if (await this.#ledger.holds(staple)) {
			return('held');
		}
		const key = keyOf(staple);
		if (entries.has(key)) {
			return('queued');
		}
		const offered = await this.#ledger.offer(staple);
		switch (offered.kind) {
			case 'added':
				return('added');
			case 'refused':
				if (await this.#ledger.holds(staple)) {
					return('held');
				}
				await this.#enqueue(entries, key, staple, offered.code);
				return('queued');
			default:
				return(assertNever(offered));
		}
	}

	/** Offers every queued staple again, round after round while a round applies any, and answers how many left the queue, applied or held by other means. */
	retry(): Promise<number> {
		const run = this.#retrying.then(() => {
			return(this.#retryNow());
		});
		this.#retrying = run.catch(function(): void {
			// The caller hears of the failure; the next retry runs all the same.
		});
		return(run);
	}

	async #retryNow(): Promise<number> {
		const entries = await this.#load();
		let applied = 0;
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const [key, entry] of [...entries]) {
				if (await this.#settled(entries, key, entry)) {
					applied++;
					progressed = true;
				}
			}
		}
		await this.#reportRefusedForLong(entries);
		return(applied);
	}

	/** Whether the staple left the queue: applied now, or held by the ledger already. */
	async #settled(entries: Map<string, QueuedStaple<Staple>>, key: string, entry: QueuedStaple<Staple>): Promise<boolean> {
		if (!await this.#ledger.holds(entry.staple)) {
			const offered = await this.#ledger.offer(entry.staple);
			switch (offered.kind) {
				case 'added':
					break;
				case 'refused':
					if (await this.#ledger.holds(entry.staple)) {
						break;
					}
					if (offered.code !== entry.code) {
						await this.#put(entries, key, { ...entry, code: offered.code });
					}
					return(false);
				default:
					return(assertNever(offered));
			}
		}
		await this.#remove(entries, key);
		return(true);
	}

	async #reportRefusedForLong(entries: Map<string, QueuedStaple<Staple>>): Promise<void> {
		const now = Date.now();
		for (const [key, entry] of [...entries]) {
			const age = now - entry.queuedAt;
			if (!entry.reported && age >= REPORT_REFUSED_AFTER_MILLISECONDS) {
				this.#report(entry, age);
				await this.#put(entries, key, { ...entry, reported: true });
			}
		}
	}

	/** Queues the staple, unless another pass, sent it too, queued it meanwhile. */
	async #enqueue(entries: Map<string, QueuedStaple<Staple>>, key: string, staple: Staple, code: string): Promise<void> {
		if (entries.has(key)) {
			return;
		}
		if (entries.size >= this.#bounds.staples || this.#bytes + sizeOf(staple) > this.#bounds.bytes) {
			throw(new RetryQueueFull(key, this.#bounds));
		}
		this.#bytes += sizeOf(staple);
		await this.#put(entries, key, { staple, queuedAt: Date.now(), code, reported: false });
	}

	async #put(entries: Map<string, QueuedStaple<Staple>>, key: string, entry: QueuedStaple<Staple>): Promise<void> {
		entries.set(key, entry);
		await this.#store.put(key, entry);
	}

	async #remove(entries: Map<string, QueuedStaple<Staple>>, key: string): Promise<void> {
		const entry = entries.get(key);
		if (entry === undefined) {
			return;
		}
		entries.delete(key);
		this.#bytes -= sizeOf(entry.staple);
		await this.#store.remove(key);
	}

	/** The queue, read from the store once; a read that fails is tried again by the next caller. */
	#load(): Promise<Map<string, QueuedStaple<Staple>>> {
		if (this.#entries !== undefined) {
			return(this.#entries);
		}
		const loading = this.#store.load().then((stored) => {
			const entries = new Map<string, QueuedStaple<Staple>>();
			for (const entry of [...stored].sort(earliestFirst)) {
				entries.set(keyOf(entry.staple), entry);
				this.#bytes += sizeOf(entry.staple);
			}
			return(entries);
		});
		this.#entries = loading;
		loading.catch(() => {
			if (this.#entries === loading) {
				this.#entries = undefined;
			}
		});
		return(loading);
	}
}
