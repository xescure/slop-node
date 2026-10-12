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
 * The share of the queue's bounds only a deep re-scan may fill. A pass from
 * where the last reached that a full queue stops cannot bring a staple the
 * queued ones need that a pass missed before it: only a deep re-scan reads
 * that far back, and one that met a full queue would stop at the first
 * staple refused while its dependencies are a page later.
 */
const DEEP_SCAN_SHARE = 1 / 10;

/**
 * The share of the queue's bounds a pass over a range read ahead of the
 * earliest may fill (src/node/bootstrap-ranges.ts). Its staples may need
 * staples of the ranges before it, which only those bring, so it waits once
 * this much is queued; the passes over the earliest range and those near it,
 * which read on as a pass from where the last reached does, keep the rest of
 * that pass's share for the staples they read before their dependencies.
 */
const AHEAD_SHARE = 1 / 2;

/**
 * How long the ledger may refuse a staple before the node reports it, once,
 * as one it cannot apply although the network did: by then every staple a
 * page or two later has long been read.
 */
export const REPORT_REFUSED_AFTER_MILLISECONDS: number = 60 * 60_000;

/**
 * The shortest wait before a refused staple is offered again when nothing it
 * awaits has come: about the time a pass takes for a page.
 */
export const FIRST_BACKOFF_MILLISECONDS: number = 30_000;

/**
 * The longest wait between two offers of a refused staple. Each refusal
 * doubles the wait up to this, so a staple the network applied but this
 * ledger never will is still offered twice an hour, and a full queue costs
 * about as many refused transactions a minute as it holds staples divided
 * by thirty.
 */
export const LAST_BACKOFF_MILLISECONDS: number = 30 * 60_000;

/** How long after its last offer a staple refused that many times is offered again however nothing it awaits has come. */
export function backoffAfter(refusals: number): number {
	return(Math.min(FIRST_BACKOFF_MILLISECONDS * 2 ** Math.max(refusals - 1, 0), LAST_BACKOFF_MILLISECONDS));
}

/** What a refused staple waits for before it is worth offering again. */
export type Awaited =
	/** Voting weight: the voters, by public key, whose weight was too little [Keeta TS] index.js:69740-69760. */
	| { readonly kind: 'weight'; readonly voters: readonly string[] }
	/** A staple that lands on one of these accounts, by public key: a credit, a grant, the block a chain lacks. */
	| { readonly kind: 'accounts'; readonly accounts: readonly string[] }
	/** Nothing the queue watches for, as for a staple queued by an earlier build: only its wait makes it due. */
	| { readonly kind: 'unknown' };

/** What the ledger did with a staple offered to it. */
export type Offered =
	/** It added the staple, and any it released, which landed on these accounts, by public key. */
	| { readonly kind: 'added'; readonly landed: readonly string[] }
	/** It refused the staple, for the reason the code names. */
	| { readonly kind: 'refused'; readonly code: string };

/** The ledger a queue offers its staples to, and how it reads a queued staple. */
export type RetryLedger<Staple> = {
	/** Whether it holds the staple's blocks, with these votes or others. */
	holds(staple: Staple): Promise<boolean>;
	offer(staple: Staple): Promise<Offered>;
	/** The staple of bytes the queue kept, as toBytes gave them. */
	decode(bytes: ArrayBuffer): Staple;
	/** What a staple refused with the code awaits. */
	awaited(staple: Staple, code: string): Awaited;
	/**
	 * For each set of voters, whether their weight would now let a staple
	 * they voted for in, as the ledger's own check reads it, all from one
	 * view of the ledger.
	 */
	weightSuffices(voterSets: readonly (readonly string[])[]): Promise<readonly boolean[]>;
};

/** A staple the ledger refused, waiting to be offered again, kept as the bytes it came as. */
export type QueuedStaple = {
	/** The hash of its blocks, which names it in the queue. */
	readonly key: string;
	readonly bytes: ArrayBuffer;
	/** When the ledger first refused it, on the node's clock. */
	readonly queuedAt: number;
	/** Why the ledger refused it the last time. */
	readonly code: string;
	/** Whether it was reported as refused for long. */
	readonly reported: boolean;
	readonly awaited: Awaited;
};

/** Where a queue keeps its staples, by the hash of their blocks, so that they outlive the process. */
export type RetryStore = {
	load(): Promise<readonly QueuedStaple[]>;
	put(entry: QueuedStaple): Promise<void>;
	remove(key: string): Promise<void>;
};

export type QueueBounds = {
	readonly staples: number;
	readonly bytes: number;
};

const DEFAULT_BOUNDS: QueueBounds = { staples: MAX_QUEUED_STAPLES, bytes: MAX_QUEUED_BYTES };

/** What a queue of those bounds leaves a pass from where the last reached, and the stage's adding: all but the deep re-scans' share. */
function liveBoundsOf(bounds: QueueBounds): QueueBounds {
	return({ staples: bounds.staples - Math.ceil(bounds.staples * DEEP_SCAN_SHARE), bytes: bounds.bytes - Math.ceil(bounds.bytes * DEEP_SCAN_SHARE) });
}

/** The live share of a queue of the default bounds: a node whose queue holds as many has no room for what its passes from where the last reached, or its stage, are refused. */
export const LIVE_QUEUE_BOUNDS: QueueBounds = liveBoundsOf(DEFAULT_BOUNDS);

/** Whether a staple a pass was sent was new to the node, one it held already, perhaps with other votes, or one the ledger refused and the queue holds. */
export type Added = 'added' | 'held' | 'queued';

/**
 * Which pass adds a staple: one from where the last reached, or over the
 * earliest range or one near it, leaves the deep re-scans their share of the
 * queue; one over a range read ahead of the earliest fills at most
 * AHEAD_SHARE of it.
 */
export type QueueUse = 'live' | 'ahead' | 'deep';

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

/** What an entry holds in memory, which the bound in bytes counts: its bytes and the accounts it names. */
export function sizeOf(entry: QueuedStaple): number {
	let named = 0;
	switch (entry.awaited.kind) {
		case 'weight':
			named = entry.awaited.voters.length;
			break;
		case 'accounts':
			named = entry.awaited.accounts.length;
			break;
		case 'unknown':
			break;
		default:
			assertNever(entry.awaited);
	}
	return(entry.bytes.byteLength + named * ACCOUNT_KEY_BYTES);
}

/** About what a public key string of an account takes in memory. */
const ACCOUNT_KEY_BYTES = 128;

function earliestFirst(left: QueuedStaple, right: QueuedStaple): number {
	return(left.queuedAt - right.queuedAt);
}

/** A queued staple as the passes name it to a peer: by the bytes it came as. */
function namedOf(entry: QueuedStaple): NamedStaple {
	return({
		blocksHash: { toString: function(): string {
			return(entry.key);
		} },
		toBytes: function(): ArrayBuffer {
			return(entry.bytes);
		}
	});
}

/** An entry with when the queue last offered it, which nothing keeps across a restart. */
type Waiting = {
	entry: QueuedStaple;
	/** How often the ledger refused it since the queue was built; none for an entry loaded from the store, which waits as one refused once. */
	refusals: number;
	/** When it was last offered, or for an entry loaded from the store, when the queue loaded it. */
	lastOffered: number;
};

/**
 * Staples the ledger refused that it does not hold, offered to it again
 * until it accepts them or holds their blocks.
 *
 * A peer serves its staples in the order it applied them, which need not be
 * causal, so the ledger refuses a staple whose dependencies come later: the
 * voting weight of genesis or a delegation, a credit a debit spends, a
 * token's supply. Such a staple is not held, but it is not lost either: it
 * stays here, durably, as the bytes it came as, and is offered again when
 * what it awaits may have come, and otherwise after a wait that doubles
 * with each refusal, up to LAST_BACKOFF_MILLISECONDS, so that it is offered
 * again forever. A staple refused for want of voting weight is due once its
 * voters' weight suffices, as the ledger reads it; one refused for anything
 * else once a staple the queue adds lands on an account it names. Retries
 * run after each page that added a staple and at the end of each pass,
 * round after round while a round applies any, since one applied can let
 * others through. A staple is decoded only to be offered.
 */
export class RetryQueue<Staple extends NamedStaple> {
	readonly #ledger: RetryLedger<Staple>;
	readonly #store: RetryStore;
	readonly #report: (entry: QueuedStaple, age: number) => void;
	readonly #bounds: QueueBounds;
	readonly #liveBounds: QueueBounds;
	readonly #aheadBounds: QueueBounds;
	#entries: Promise<Map<string, Waiting>> | undefined;
	#bytes = 0;
	/** The entries awaiting a staple on each account, by account. */
	readonly #watching = new Map<string, Set<string>>();
	/** The entries a staple landed on an account of since they were last offered. */
	readonly #landed = new Set<string>();
	/** Whether a pass from where the last reached found no room since a staple last left the queue. */
	#stoppedLive = false;
	/** Retries run one after another, so that a staple is offered by one at a time. */
	#retrying: Promise<unknown> = Promise.resolve();

	/** The report hears, once, of each staple refused for longer than REPORT_REFUSED_AFTER_MILLISECONDS, and for how long. */
	constructor(ledger: RetryLedger<Staple>, store: RetryStore, report: (entry: QueuedStaple, age: number) => void, bounds: QueueBounds = DEFAULT_BOUNDS) {
		this.#ledger = ledger;
		this.#store = store;
		this.#report = report;
		this.#bounds = bounds;
		this.#liveBounds = liveBoundsOf(bounds);
		this.#aheadBounds = { staples: Math.floor(bounds.staples * AHEAD_SHARE), bytes: Math.floor(bounds.bytes * AHEAD_SHARE) };
	}

	/** Whether a pass of that use finds room for one more refused staple, but for its size. */
	async hasRoom(use: QueueUse): Promise<boolean> {
		const entries = await this.#load();
		const bounds = this.#boundsOf(use);
		return(entries.size < bounds.staples && this.#bytes < bounds.bytes);
	}

	#boundsOf(use: QueueUse): QueueBounds {
		switch (use) {
			case 'live':
				return(this.#liveBounds);
			case 'ahead':
				return(this.#aheadBounds);
			case 'deep':
				return(this.#bounds);
			default:
				return(assertNever(use));
		}
	}

	/** Whether the queue stopped a pass from where the last reached, and no staple has left it since. */
	saturated(): boolean {
		return(this.#stoppedLive);
	}

	async size(): Promise<number> {
		return((await this.#load()).size);
	}

	/** Whether it holds the staple of these blocks. */
	async queues(staple: NamedStaple): Promise<boolean> {
		return((await this.#load()).has(keyOf(staple)));
	}

	/** The staples queued, the earliest refused first, named by the bytes they came as. */
	async staples(): Promise<NamedStaple[]> {
		return([...(await this.#load()).values()].map(function({ entry }): NamedStaple {
			return(namedOf(entry));
		}));
	}

	/** The staples queued, the earliest refused first, as kept. */
	async entries(): Promise<QueuedStaple[]> {
		return([...(await this.#load()).values()].map(function({ entry }): QueuedStaple {
			return(entry);
		}));
	}

	/**
	 * Adds the staple, or queues it when the ledger refuses it and does not
	 * hold its blocks; one queued already is left to the retries. Throws
	 * RetryQueueFull when the queue has no room for it, which, for a pass
	 * from where the last reached, is short of the deep re-scans' share, and
	 * for one over a range read ahead, AHEAD_SHARE.
	 */
	async add(staple: Staple, use: QueueUse): Promise<Added> {
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
				this.#land(offered.landed);
				return('added');
			case 'refused':
				if (await this.#ledger.holds(staple)) {
					return('held');
				}
				await this.#enqueue(entries, key, staple, offered.code, use);
				return('queued');
			default:
				return(assertNever(offered));
		}
	}

	/** Offers again every queued staple that is due, round after round while a round applies any, and answers how many left the queue, applied or held by other means. */
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
			for (const [key, waiting] of await this.#due(entries)) {
				if (await this.#settled(entries, key, waiting)) {
					applied++;
					progressed = true;
				}
			}
		}
		await this.#reportRefusedForLong(entries);
		return(applied);
	}

	/**
	 * The entries due now, the earliest refused first: those whose wait
	 * since their last offer has passed, those a staple landed on an account
	 * of, and those awaiting weight that their voters now have.
	 */
	async #due(entries: Map<string, Waiting>): Promise<[string, Waiting][]> {
		const now = Date.now();
		const due = new Set<string>();
		const weighed: [string, readonly string[]][] = [];
		for (const [key, waiting] of entries) {
			const { awaited } = waiting.entry;
			if (now >= waiting.lastOffered + backoffAfter(waiting.refusals) || this.#landed.has(key)) {
				due.add(key);
			} else if (awaited.kind === 'weight') {
				weighed.push([key, awaited.voters]);
			}
		}
		if (weighed.length > 0) {
			const suffices = await this.#ledger.weightSuffices(weighed.map(function([, voters]) {
				return(voters);
			}));
			for (const [index, [key]] of weighed.entries()) {
				if (suffices[index] === true) {
					due.add(key);
				}
			}
		}
		return([...entries].filter(function([key]): boolean {
			return(due.has(key));
		}));
	}

	/** Whether the staple left the queue: applied now, or held by the ledger already. */
	async #settled(entries: Map<string, Waiting>, key: string, waiting: Waiting): Promise<boolean> {
		const staple = this.#ledger.decode(waiting.entry.bytes);
		if (!await this.#ledger.holds(staple)) {
			const offered = await this.#ledger.offer(staple);
			switch (offered.kind) {
				case 'added':
					this.#land(offered.landed);
					break;
				case 'refused': {
					if (await this.#ledger.holds(staple)) {
						break;
					}
					this.#landed.delete(key);
					waiting.refusals++;
					waiting.lastOffered = Date.now();
					if (offered.code !== waiting.entry.code || waiting.entry.awaited.kind === 'unknown') {
						await this.#put(entries, { ...waiting.entry, code: offered.code, awaited: this.#ledger.awaited(staple, offered.code) });
					}
					return(false);
				}
				default:
					return(assertNever(offered));
			}
		}
		await this.#remove(entries, key);
		return(true);
	}

	/** Marks due the entries that await a staple on any of the accounts. */
	#land(accounts: readonly string[]): void {
		for (const account of accounts) {
			for (const key of this.#watching.get(account) ?? []) {
				this.#landed.add(key);
			}
		}
	}

	async #reportRefusedForLong(entries: Map<string, Waiting>): Promise<void> {
		const now = Date.now();
		for (const { entry } of [...entries.values()]) {
			const age = now - entry.queuedAt;
			if (!entry.reported && age >= REPORT_REFUSED_AFTER_MILLISECONDS) {
				this.#report(entry, age);
				await this.#put(entries, { ...entry, reported: true });
			}
		}
	}

	/** Queues the staple, unless another pass, sent it too, queued it meanwhile. */
	async #enqueue(entries: Map<string, Waiting>, key: string, staple: Staple, code: string, use: QueueUse): Promise<void> {
		if (entries.has(key)) {
			return;
		}
		const now = Date.now();
		const entry: QueuedStaple = { key, bytes: staple.toBytes(), queuedAt: now, code, reported: false, awaited: this.#ledger.awaited(staple, code) };
		const bounds = this.#boundsOf(use);
		if (entries.size >= bounds.staples || this.#bytes + sizeOf(entry) > bounds.bytes) {
			if (use === 'live') {
				this.#stoppedLive = true;
			}
			throw(new RetryQueueFull(key, bounds));
		}
		// Room is taken before the write, so that two passes cannot both take the last of it, and given back if the write fails: a staple not stored is not queued, and the next pass sent it offers it again.
		const waiting = { entry, refusals: 1, lastOffered: now };
		this.#track(waiting, entries);
		try {
			await this.#store.put(entry);
		} catch (error: unknown) {
			entries.delete(key);
			this.#untrack(waiting);
			throw(error);
		}
	}

	/** Replaces an entry's record, keeping when it was last offered. */
	async #put(entries: Map<string, Waiting>, entry: QueuedStaple): Promise<void> {
		const waiting = entries.get(entry.key);
		if (waiting === undefined) {
			return;
		}
		this.#untrack(waiting);
		this.#track({ ...waiting, entry }, entries);
		await this.#store.put(entry);
	}

	async #remove(entries: Map<string, Waiting>, key: string): Promise<void> {
		const waiting = entries.get(key);
		if (waiting === undefined) {
			return;
		}
		entries.delete(key);
		this.#untrack(waiting);
		this.#landed.delete(key);
		this.#stoppedLive = false;
		await this.#store.remove(key);
	}

	#track(waiting: Waiting, entries: Map<string, Waiting>): void {
		const { entry } = waiting;
		entries.set(entry.key, waiting);
		this.#bytes += sizeOf(entry);
		if (entry.awaited.kind !== 'accounts') {
			return;
		}
		for (const account of entry.awaited.accounts) {
			let watchers = this.#watching.get(account);
			if (watchers === undefined) {
				watchers = new Set();
				this.#watching.set(account, watchers);
			}
			watchers.add(entry.key);
		}
	}

	#untrack(waiting: Waiting): void {
		const { entry } = waiting;
		this.#bytes -= sizeOf(entry);
		if (entry.awaited.kind !== 'accounts') {
			return;
		}
		for (const account of entry.awaited.accounts) {
			const watchers = this.#watching.get(account);
			watchers?.delete(entry.key);
			if (watchers?.size === 0) {
				this.#watching.delete(account);
			}
		}
	}

	/** The queue, read from the store once; a read that fails is tried again by the next caller. */
	#load(): Promise<Map<string, Waiting>> {
		if (this.#entries !== undefined) {
			return(this.#entries);
		}
		const loading = this.#store.load().then((stored) => {
			const entries = new Map<string, Waiting>();
			const loadedAt = Date.now();
			for (const entry of [...stored].sort(earliestFirst)) {
				this.#track({ entry, refusals: 0, lastOffered: loadedAt }, entries);
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
