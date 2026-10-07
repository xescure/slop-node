import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BootstrapClient as DeclaredBootstrapClient, BootstrapConfig } from '@keetanetwork/keetanet-client/lib/bootstrap.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { KVInternals } from '../upstream/internals.js';
import type { AssertNever } from '../util/assert-never.js';
import type { ClassSurface } from '../util/class-surface.js';
import { BootstrapCursors } from './bootstrap-cursors.js';
import { PageFetcher } from './bootstrap-page.js';
import { bootstrapSources } from './bootstrap-peers.js';
import type { BootstrapNode } from './bootstrap-peers.js';
import { BLOOM_CAPACITY, BOOTSTRAP_OVERLAP_MILLISECONDS, BootstrapWindow } from './bootstrap-window.js';

export type { BootstrapConfig } from '@keetanetwork/keetanet-client/lib/bootstrap.js';

const lib = KeetaNet.lib;

const LOG_SOURCE = 'BOOTSTRAP';

/** How long one request to a peer may take unless configured otherwise. */
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;

/**
 * The most staples a representative sends in one page, its own default
 * [Keeta TS] index.js:69633, and what a page holds unless fewer are asked for.
 */
const MAX_PAGE_LIMIT = 1000;

type UpdateResult = { complete: boolean };

type Callback = NonNullable<BootstrapConfig['callback']>;

function positiveMilliseconds(name: string, value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw(new RangeError(`the bootstrap ${name} must be a positive number of milliseconds (it is ${String(value)})`));
	}
	return(value);
}

function pageLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
		throw(new RangeError(`a bootstrap page holds from 1 to ${String(MAX_PAGE_LIMIT)} staples (${String(limit)} were asked for)`));
	}
	return(limit);
}

/** Where a pass over a peer starts: the overlap before the moment last reached, or the beginning of its ledger. */
function passStart(reached: Date | undefined): Date {
	if (reached === undefined) {
		return(new Date(0));
	}
	return(new Date(Math.max(0, reached.getTime() - BOOTSTRAP_OVERLAP_MILLISECONDS)));
}

/**
 * Catches the node up on the staples its peers hold, as declared by
 * upstream's typings (lib/bootstrap.d.ts), whose bundle has no
 * implementation.
 *
 * An update makes one pass over each peer at once: it pages through the
 * peer's staples from where the node last reached on that peer, adds each
 * staple to the ledger as a bootstrap, and is done with the peer once a page
 * comes back empty. A peer that fails is logged and tried again on the next
 * update, and holds up no other.
 *
 * stats() counts the updates in a row that were complete: every peer was
 * drained, so the node held all its peers held when each pass ended. An
 * incomplete update sets the count back to 0, so a count above 0 says the
 * node is caught up.
 */
export class BootstrapClient {
	static isInstance: (obj: unknown, strict?: boolean) => obj is BootstrapClient = lib.Utils.Helper.checkableGenerator(BootstrapClient);

	/** How long one request to a peer may take, in milliseconds. */
	timeout: number;
	readonly #node: BootstrapNode;
	readonly #cursors: BootstrapCursors;
	readonly #callback: Callback | undefined;
	readonly #stopping = new AbortController();
	/** Updates and resets run one after another, each after those called before it. */
	#queue: Promise<unknown> = Promise.resolve();
	#timer: NodeJS.Timeout | undefined;
	#lastUpdate: Date | undefined;
	#completeCount = 0;

	/**
	 * With a period, an update runs at once and then that many milliseconds
	 * after each one ends, until the client is stopped; without one, only
	 * when update() is called. Cursors are kept in the store given, or in
	 * memory.
	 */
	constructor(node: BootstrapNode, config: BootstrapConfig = {}) {
		this.#node = node;
		this.timeout = positiveMilliseconds('timeout', config.timeout ?? DEFAULT_TIMEOUT_MILLISECONDS);
		this.#cursors = new BootstrapCursors(config.kv ?? new KVInternals.KVStorageProviderMemory());
		this.#callback = config.callback;
		if (config.period !== undefined) {
			this.#updateEvery(positiveMilliseconds('period', config.period));
		}
	}

	/** Forgets where the node has reached on every peer, so that the next update reads each from the beginning. */
	resetKV(): Promise<void> {
		return(this.#enqueue(() => {
			return(this.#cursors.clear());
		}));
	}

	stats(): Promise<{ lastUpdate: Date | undefined; completeCount: number }> {
		return(Promise.resolve({ lastUpdate: this.#lastUpdate, completeCount: this.#completeCount }));
	}

	/** One pass over every peer, with pages of at most that many staples. */
	async update(limit: number = MAX_PAGE_LIMIT): Promise<UpdateResult> {
		const pageSize = pageLimit(limit);
		return(await this.#enqueue(() => {
			return(this.#updateNow(pageSize));
		}));
	}

	/** Ends the scheduled updates and the requests in flight, and waits for the update running, which is then incomplete. */
	async stop(): Promise<void> {
		this.#stopping.abort();
		clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#queue;
	}

	#enqueue<Result>(work: () => Promise<Result>): Promise<Result> {
		const run = this.#queue.then(work);
		this.#queue = run.catch(function(): void {
			// The caller of the work hears of its failure; the work queued after it still runs.
		});
		return(run);
	}

	/** Updates now, and again that many milliseconds after each update ends, until stopped. */
	#updateEvery(period: number): void {
		this.update().then(() => {
			if (this.#stopping.signal.aborted) {
				return;
			}
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#updateEvery(period);
			}, period);
		}, (error: unknown) => {
			this.#node.log.error(LOG_SOURCE, 'A scheduled bootstrap update failed:', error);
		});
	}

	async #updateNow(limit: number): Promise<UpdateResult> {
		if (this.#stopping.signal.aborted) {
			return({ complete: false });
		}
		let sources: string[];
		try {
			sources = await bootstrapSources(this.#node);
		} catch (error: unknown) {
			this.#node.log.warn(LOG_SOURCE, 'Finding the peers to bootstrap from failed; they are looked for again on the next update:', error);
			this.#record(false);
			return({ complete: false });
		}
		const fetcher = new PageFetcher();
		try {
			const drained = await Promise.all(sources.map((endpoint) => {
				return(this.#drainLogged(endpoint, limit, fetcher));
			}));
			const complete = drained.every(Boolean) && !this.#stopping.signal.aborted;
			this.#record(complete);
			return({ complete });
		} finally {
			fetcher.close();
		}
	}

	#record(complete: boolean): void {
		this.#lastUpdate = new Date();
		if (complete) {
			this.#completeCount++;
		} else {
			this.#completeCount = 0;
		}
	}

	async #drainLogged(endpoint: string, limit: number, fetcher: PageFetcher): Promise<boolean> {
		try {
			await this.#drain(endpoint, limit, fetcher);
			return(true);
		} catch (error: unknown) {
			if (this.#stopping.signal.aborted) {
				this.#node.log.debug(LOG_SOURCE, `Stopped bootstrapping from ${endpoint}`);
			} else {
								this.#node.log.warn(LOG_SOURCE, `Bootstrapping from ${endpoint} failed; it is tried again on the next update:`, error);
			}
			return(false);
		}
	}

	/**
	 * Pages through the peer's staples until a page comes back empty. The
	 * cursor follows the window as it moves, so that an interrupted pass
	 * resumes near where it stopped; once the peer is drained it records the
	 * moment the pass began, since anything the peer applies later is applied
	 * at a later moment, save for the late commits the overlap is for.
	 */
	async #drain(endpoint: string, limit: number, fetcher: PageFetcher): Promise<void> {
		const began = new Date();
		const start = passStart(await this.#cursors.read(endpoint));
		const window = new BootstrapWindow(start, await this.#node.ledger.getVoteStaplesAfter(start, BLOOM_CAPACITY));
		for (;;) {
			const filter = window.filter();
			let bloomFilter: string | undefined;
			if (filter !== undefined) {
				bloomFilter = lib.Utils.Bloom.serializeBloomFilter(filter);
			}
			const page = await fetcher.page({ endpoint, start: window.start, limit, bloomFilter }, this.timeout, this.#stopping.signal);
			if (page.length === 0) {
				await this.#cursors.write(endpoint, began);
				return;
			}
			for (const staple of page) {
				await this.#add(staple);
			}
			if (!window.advance(page)) {
				throw(new Error(`${endpoint} sent again only staples it had sent from ${window.start.toISOString()}, so it does not leave out those the filter names`));
			}
			await this.#cursors.write(endpoint, window.start);
		}
	}

	/** Whether the main ledger holds the staple's blocks already. */
	async #holds(staple: VoteStaple): Promise<boolean> {
		return(await this.#node.ledger.getVoteStaple(staple.blocksHash, 'main') !== null);
	}

	/**
	 * The ledger refuses a staple it holds already, as a block that exists
	 * [Keeta TS] index.js:67683-67687, or, for genesis, as votes without
	 * weight once genesis has assigned it [Keeta TS] index.js:69398-69401; a
	 * refused staple that is held, whether from before or because another
	 * peer's pass or a P2P message added it meanwhile, is skipped instead.
	 * The filter keeps most of those away, so the ledger is asked only after
	 * a refusal. One that fills a gap may release staples deferred until
	 * then, and the callback hears of each staple added
	 * [Keeta TS] index.js:69361-69420.
	 */
	async #add(staple: VoteStaple): Promise<void> {
		let added: VoteStaple[];
		try {
			added = await this.#node.ledger.add(staple, 'bootstrap');
		} catch (error: unknown) {
			if (await this.#holds(staple)) {
				return;
			}
			throw(error);
		}
		for (const each of added) {
			await this.#tell(each);
		}
	}

	async #tell(staple: VoteStaple): Promise<void> {
		if (this.#callback === undefined) {
			return;
		}
		try {
			await this.#callback(staple);
		} catch (error: unknown) {
			this.#node.log.error(LOG_SOURCE, `The bootstrap callback failed for staple ${staple.blocksHash.toString()}:`, error);
		}
	}
}

export default BootstrapClient;

type DeclaredBootstrapModule = typeof import('@keetanetwork/keetanet-client/lib/bootstrap.js');
type BootstrapModule = typeof import('./bootstrap.js');

type _HasEveryDeclaredMember = AssertNever<ClassSurface<typeof BootstrapClient> extends ClassSurface<typeof DeclaredBootstrapClient> ? never : ClassSurface<typeof BootstrapClient>>;
type _HasNoUndeclaredMember = AssertNever<ClassSurface<typeof DeclaredBootstrapClient> extends ClassSurface<typeof BootstrapClient> ? never : ClassSurface<typeof DeclaredBootstrapClient>>;
type _ExportsNoUndeclaredValue = AssertNever<Exclude<keyof BootstrapModule, keyof DeclaredBootstrapModule>>;
type _ExportsEveryDeclaredValue = AssertNever<Exclude<keyof DeclaredBootstrapModule, keyof BootstrapModule>>;
