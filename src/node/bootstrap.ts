import { createHash } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BootstrapClient as DeclaredBootstrapClient, BootstrapConfig } from '@keetanetwork/keetanet-client/lib/bootstrap.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { KVInternals } from '../upstream/internals.js';
import { assertNever } from '../util/assert-never.js';
import { eachAtMost } from '../util/concurrency.js';
import type { AssertNever } from '../util/assert-never.js';
import type { ClassSurface } from '../util/class-surface.js';
import { BootstrapCursors } from './bootstrap-cursors.js';
import { PageError, PageFetcher } from './bootstrap-page.js';
import { DEEP_SCAN_PERIOD_MILLISECONDS, bootstrapPeer } from './bootstrap-pass.js';
import type { Added, PassAnswer, PassRequest, PeerIO } from './bootstrap-pass.js';
import { bootstrapSources } from './bootstrap-peers.js';
import type { BootstrapNode } from './bootstrap-peers.js';

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

/** How many peers an update reads at once; the others wait for one of them to finish its pass. */
const MAX_CONCURRENT_PASSES = 4;

type UpdateResult = { complete: boolean };

type Callback = NonNullable<BootstrapConfig['callback']>;

function positiveMilliseconds(name: string, value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw(new RangeError(`the bootstrap ${name} must be a positive number of milliseconds (it is ${String(value)})`));
	}
	return(value);
}

/** When in each period the deep re-scans of the peer fall, the same for it on every node, and spread across peers. */
function staggerOf(endpoint: string): number {
	return(createHash('sha256').update(endpoint).digest().readUInt32BE(0) % DEEP_SCAN_PERIOD_MILLISECONDS);
}

function pageLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
		throw(new RangeError(`a bootstrap page holds from 1 to ${String(MAX_PAGE_LIMIT)} staples (${String(limit)} were asked for)`));
	}
	return(limit);
}

/**
 * Catches the node up on the staples its peers hold, as declared by
 * upstream's typings (lib/bootstrap.d.ts), whose bundle has no
 * implementation.
 *
 * An update makes one pass over each peer, a few peers at a time: it pages
 * through the peer's staples from where the node last reached on that peer
 * (src/node/bootstrap-pass.ts), adds each staple to the ledger as a
 * bootstrap, and is done with the peer once it is shown to hold every staple
 * the peer had applied before the margin before the pass began. A deep
 * re-scan of the peer, when one is under way, runs alongside. A pass is
 * bounded in requests and time, and one that reaches its bound is continued
 * on the next update; a peer that fails is logged and tried again on the
 * next update. Neither holds up any other peer for longer.
 *
 * stats() counts the updates in a row that were complete: every peer's pass
 * completed, so the node held all its peers had applied before the margin
 * before each pass began. An incomplete update sets the count back to 0, so
 * a count above 0 says the node is caught up.
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

	/** Updates now, and again that many milliseconds after each update ends, whether or not it succeeded, until stopped. */
	#updateEvery(period: number): void {
		const scheduleNext = (): void => {
			if (this.#stopping.signal.aborted) {
				return;
			}
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#updateEvery(period);
			}, period);
		};
		this.update().then(scheduleNext, (error: unknown) => {
			this.#node.log.error(LOG_SOURCE, 'A scheduled bootstrap update failed:', error);
			scheduleNext();
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
			const caughtUp = await eachAtMost(sources, MAX_CONCURRENT_PASSES, (endpoint) => {
				return(this.#catchUpLogged(endpoint, limit, fetcher));
			});
			const complete = caughtUp.every(Boolean) && !this.#stopping.signal.aborted;
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

	async #catchUpLogged(endpoint: string, limit: number, fetcher: PageFetcher): Promise<boolean> {
		try {
			return(await this.#catchUp(endpoint, limit, fetcher));
		} catch (error: unknown) {
			if (this.#stopping.signal.aborted) {
				this.#node.log.debug(LOG_SOURCE, `Stopped bootstrapping from ${endpoint}`);
			} else {
				this.#node.log.warn(LOG_SOURCE, `Bootstrapping from ${endpoint} failed; it is tried again on the next update:`, error);
			}
			return(false);
		}
	}

	/** The update's passes over the peer, which answer whether the node caught up on it. */
	async #catchUp(endpoint: string, limit: number, fetcher: PageFetcher): Promise<boolean> {
		const io: PeerIO<VoteStaple> = {
			page: (request) => {
				return(this.#page(fetcher, endpoint, request));
			},
			held: (from, count) => {
				return(this.#node.ledger.getVoteStaplesAfter(from, count));
			},
			add: (staple) => {
				return(this.#add(staple));
			},
			readProgress: () => {
				return(this.#cursors.read(endpoint));
			},
			writeProgress: (progress) => {
				return(this.#cursors.write(endpoint, progress));
			}
		};
		const { live: outcome } = await bootstrapPeer(io, { limit, stagger: staggerOf(endpoint) });
		switch (outcome.kind) {
			case 'drained':
			case 'caught-up':
				return(true);
			case 'bounded':
				this.#node.log.info(LOG_SOURCE, `Bootstrapping from ${endpoint} reached ${outcome.reached.toISOString()} within this update's bound; it continues on the next update`);
				return(false);
			default:
				return(assertNever(outcome));
		}
	}

	async #page(fetcher: PageFetcher, endpoint: string, request: PassRequest): Promise<PassAnswer<VoteStaple>> {
		try {
			return({ kind: 'page', staples: await fetcher.page({ endpoint, ...request }, this.timeout, this.#stopping.signal) });
		} catch (error: unknown) {
			if (error instanceof PageError && error.problem.kind === 'too-large') {
				return({ kind: 'too-large' });
			}
			throw(error);
		}
	}

	/** Whether the main ledger holds the staple's blocks already. */
	async #holds(staple: VoteStaple): Promise<boolean> {
		return(await this.#node.ledger.getVoteStaple(staple.blocksHash, 'main') !== null);
	}

	/**
	 * The ledger refuses a staple whose blocks it holds already, as a block
	 * that exists [Keeta TS] index.js:67683-67687, or, for genesis, as votes
	 * without weight once genesis has assigned it
	 * [Keeta TS] index.js:69398-69401, whatever votes the staple carries. So
	 * a staple whose blocks are held is skipped before it is added, and so is
	 * one refused because another peer's pass or a P2P message added it
	 * meanwhile. One that fills a gap may release staples deferred until
	 * then, and the callback hears of each staple added
	 * [Keeta TS] index.js:69361-69420. Once the client is stopped, the rest of
	 * a page already fetched is not added: the node stopping it may close its
	 * storage next.
	 */
	async #add(staple: VoteStaple): Promise<Added> {
		if (await this.#holds(staple)) {
			return('held');
		}
		this.#stopping.signal.throwIfAborted();
		let added: VoteStaple[];
		try {
			added = await this.#node.ledger.add(staple, 'bootstrap');
		} catch (error: unknown) {
			if (await this.#holds(staple)) {
				return('held');
			}
			throw(error);
		}
		for (const each of added) {
			await this.#tell(each);
		}
		return('added');
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
