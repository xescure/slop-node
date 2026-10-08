import { createHash } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BootstrapClient as DeclaredBootstrapClient, BootstrapConfig } from '@keetanetwork/keetanet-client/lib/bootstrap.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { KVInternals } from '../upstream/internals.js';
import { assertNever } from '../util/assert-never.js';
import type { AssertNever } from '../util/assert-never.js';
import type { ClassSurface } from '../util/class-surface.js';
import { BootstrapCursors, KVRetryStore } from './bootstrap-cursors.js';
import { PageError, PageFetcher } from './bootstrap-page.js';
import { PeerPacer } from './bootstrap-pacing.js';
import { DEEP_SCAN_PERIOD_MILLISECONDS, bootstrapPeer, completes } from './bootstrap-pass.js';
import type { PassAnswer, PassOutcome, PassRequest, PeerIO } from './bootstrap-pass.js';
import { bootstrapPacingOf, bootstrapSources } from './bootstrap-peers.js';
import type { BootstrapNode } from './bootstrap-peers.js';
import { RetryQueue } from './bootstrap-retry.js';
import type { Added, Offered, QueuedStaple } from './bootstrap-retry.js';
import { nextUpdateDelay, updatePeers } from './bootstrap-update.js';
import type { PeerResult, UpdateIO } from './bootstrap-update.js';

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

/** The most of a refusal's message kept as its code when the error carries no code. */
const MAX_REFUSAL_LENGTH = 200;

const MINUTE_MILLISECONDS = 60_000;

type UpdateResult = { complete: boolean };

/** What an update's passes over one peer did: its requests, and the staples it was sent, by whether the node added them, held them already or queued them. */
type PassTally = Record<'requests' | Added, number>;

function describeOutcome(outcome: PassOutcome): string {
	switch (outcome.kind) {
		case 'drained':
			return('drained');
		case 'caught-up':
			return('caught up');
		case 'bounded':
			return(`reached ${outcome.reached.toISOString()} within this update's bound (it continues on the next update)`);
		default:
			return(assertNever(outcome));
	}
}

type Callback = NonNullable<BootstrapConfig['callback']>;

/** What names why the ledger refused a staple: the code upstream's errors carry, or the message of one without. */
function refusalOf(error: unknown): string {
	if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
		return(error.code);
	}
	if (error instanceof Error) {
		return(`${error.name}: ${error.message}`.slice(0, MAX_REFUSAL_LENGTH));
	}
	return(String(error).slice(0, MAX_REFUSAL_LENGTH));
}

function resultOf(outcome: PassOutcome): PeerResult {
	if (completes(outcome)) {
		return('completed');
	}
	return('bounded');
}

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
 * An update makes one pass over each peer, a few peers at a time, or one
 * at a time until a pass has completed (src/node/bootstrap-update.ts): it
 * pages through the peer's staples from where the node last reached on that
 * peer (src/node/bootstrap-pass.ts), adds each staple to the ledger as a
 * bootstrap, queuing for retry each the ledger refuses
 * (src/node/bootstrap-retry.ts), and is done with the peer once it is shown
 * to hold or have queued every staple the peer had applied before the
 * margin before the pass began. A deep re-scan of the peer, when one is
 * under way, runs alongside. A pass is bounded in requests and time, and
 * one that reaches its bound is continued on the next update, which a
 * client updating on a period then begins at once; a peer that
 * fails is logged and tried again on the next update. Neither holds up any
 * other peer for longer. Requests to a peer are paced as the node's
 * configuration asks (paceBootstrap), the pause counting towards the pass's
 * bound in time.
 *
 * stats() counts the updates in a row that were complete: every peer's pass
 * completed, so the node held or queued all its peers had applied before
 * the margin before each pass began. An incomplete update sets the count
 * back to 0, so a count above 0 says the node is caught up.
 */
export class BootstrapClient {
	static isInstance: (obj: unknown, strict?: boolean) => obj is BootstrapClient = lib.Utils.Helper.checkableGenerator(BootstrapClient);

	/** How long one request to a peer may take, in milliseconds. */
	timeout: number;
	readonly #node: BootstrapNode;
	readonly #cursors: BootstrapCursors;
	readonly #retries: RetryQueue<VoteStaple>;
	/** Kept across updates, so that the first request of an update is paced after the last of the one before. */
	readonly #pacer: PeerPacer;
	readonly #callback: Callback | undefined;
	readonly #stopping = new AbortController();
	/** Updates and resets run one after another, each after those called before it. */
	#queue: Promise<unknown> = Promise.resolve();
	#timer: NodeJS.Timeout | undefined;
	#lastUpdate: Date | undefined;
	#completeCount = 0;
	/** How the last update's passes ended, which says whether the next starts at once. */
	#lastResults: readonly PeerResult[] = [];

	/**
	 * With a period, an update runs at once and then that many milliseconds
	 * after each one ends, or at once after one whose pass over some peer
	 * ended at its bound (nextUpdateDelay), until the client is stopped;
	 * without one, only when update() is called. Cursors are kept in the store given, or in
	 * memory.
	 */
	constructor(node: BootstrapNode, config: BootstrapConfig = {}) {
		this.#node = node;
		this.timeout = positiveMilliseconds('timeout', config.timeout ?? DEFAULT_TIMEOUT_MILLISECONDS);
		const kv = config.kv ?? new KVInternals.KVStorageProviderMemory();
		this.#cursors = new BootstrapCursors(kv);
		this.#retries = new RetryQueue({
			holds: (staple) => {
				return(this.#holds(staple));
			},
			offer: (staple) => {
				return(this.#offer(staple));
			}
		}, new KVRetryStore(kv), (entry, age) => {
			this.#reportRefused(entry, age);
		});
		this.#pacer = new PeerPacer(bootstrapPacingOf(node.config));
		this.#callback = config.callback;
		if (config.period !== undefined) {
			this.#updateEvery(positiveMilliseconds('period', config.period));
		}
	}

	/** Forgets where the node has reached on every peer, so that the next update reads each from the beginning, one at a time until a pass completes. */
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

	/** Updates now, and again after each update ends, whether or not it succeeded, until stopped. */
	#updateEvery(period: number): void {
		const scheduleNext = (): void => {
			if (this.#stopping.signal.aborted) {
				return;
			}
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#updateEvery(period);
			}, nextUpdateDelay(this.#lastResults, period));
		};
		this.update().then(scheduleNext, (error: unknown) => {
			this.#node.log.error(LOG_SOURCE, 'A scheduled bootstrap update failed:', error);
			scheduleNext();
		});
	}

	async #updateNow(limit: number): Promise<UpdateResult> {
		this.#lastResults = [];
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
		const cursors = this.#cursors;
		const io: UpdateIO = {
			readProgress: function(endpoint) {
				return(cursors.read(endpoint));
			},
			writeProgress: function(endpoint, progress) {
				return(cursors.write(endpoint, progress));
			},
			readCaughtUp: function() {
				return(cursors.readCaughtUp());
			},
			writeCaughtUp: function(horizon) {
				return(cursors.writeCaughtUp(horizon));
			}
		};
		try {
			const results = await updatePeers(sources, io, MAX_CONCURRENT_PASSES, (endpoint, from) => {
				return(this.#catchUpLogged(endpoint, limit, fetcher, from));
			});
			this.#lastResults = [...results.values()];
			const complete = sources.every(function(endpoint): boolean {
				return(results.get(endpoint) === 'completed');
			}) && !this.#stopping.signal.aborted;
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

	async #catchUpLogged(endpoint: string, limit: number, fetcher: PageFetcher, from: Date): Promise<PeerResult> {
		try {
			return(await this.#catchUp(endpoint, limit, fetcher, from));
		} catch (error: unknown) {
			if (this.#stopping.signal.aborted) {
				this.#node.log.debug(LOG_SOURCE, `Stopped bootstrapping from ${endpoint}`);
			} else {
				this.#node.log.warn(LOG_SOURCE, `Bootstrapping from ${endpoint} failed; it is tried again on the next update:`, error);
			}
			return('failed');
		}
	}

	/** The update's passes over the peer, those over a peer it has no progress on starting from the moment given. */
	async #catchUp(endpoint: string, limit: number, fetcher: PageFetcher, from: Date): Promise<PeerResult> {
		const tally: PassTally = { requests: 0, added: 0, held: 0, queued: 0 };
		const io: PeerIO<VoteStaple> = {
			page: (request) => {
				tally.requests++;
				return(this.#page(fetcher, endpoint, request));
			},
			held: async (since, count) => {
				const queued = (await this.#retries.staples()).slice(0, count);
				if (queued.length >= count) {
					return(queued);
				}
				return([...queued, ...await this.#node.ledger.getVoteStaplesAfter(since, count - queued.length)]);
			},
			add: async (staple) => {
				this.#stopping.signal.throwIfAborted();
				const added = await this.#retries.add(staple);
				tally[added]++;
				return(added);
			},
			retry: async () => {
				this.#stopping.signal.throwIfAborted();
				await this.#retries.retry();
			},
			readProgress: () => {
				return(this.#cursors.read(endpoint));
			},
			writeProgress: (progress) => {
				return(this.#cursors.write(endpoint, progress));
			}
		};
		const { live: outcome } = await bootstrapPeer(io, { limit, stagger: staggerOf(endpoint), from });
		const summary = `Bootstrap pass over ${endpoint}: ${describeOutcome(outcome)} after ${String(tally.requests)} requests, ${String(tally.added)} staples added, ${String(tally.held)} held already, ${String(tally.queued)} queued for retry (${String(await this.#retries.size())} in the queue)`;
		// Once caught up, a pass every period adds nothing, which an operator need not read.
		if (tally.added > 0 || tally.queued > 0 || !completes(outcome)) {
			this.#node.log.info(LOG_SOURCE, summary);
		} else {
			this.#node.log.debug(LOG_SOURCE, summary);
		}
		return(resultOf(outcome));
	}

	async #page(fetcher: PageFetcher, endpoint: string, request: PassRequest): Promise<PassAnswer<VoteStaple>> {
		try {
			const staples = await this.#pacer.paced(endpoint, this.#stopping.signal, () => {
				return(fetcher.page({ endpoint, ...request }, this.timeout, this.#stopping.signal));
			});
			return({ kind: 'page', staples });
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
	 * [Keeta TS] index.js:69398-69401, whatever votes the staple carries; the
	 * queue skips a staple whose blocks are held before it offers it, and
	 * counts one refused because another peer's pass or a P2P message added
	 * it meanwhile as held. The ledger also refuses a staple whose
	 * dependencies it lacks, as votes without weight before the staples that
	 * give the voters weight [Keeta TS] index.js:69397-69400, 69740-69752,
	 * which the queue keeps until they arrive. One that fills a gap may
	 * release staples deferred until then, and the callback hears of each
	 * staple added [Keeta TS] index.js:69361-69420.
	 * Once the client is stopped, nothing more is offered, the rest of a page
	 * already fetched included, and a refusal is not queued: the node
	 * stopping it may close its storage next.
	 */
	async #offer(staple: VoteStaple): Promise<Offered> {
		this.#stopping.signal.throwIfAborted();
		let added: VoteStaple[];
		try {
			added = await this.#node.ledger.add(staple, 'bootstrap');
		} catch (error: unknown) {
			this.#stopping.signal.throwIfAborted();
			return({ kind: 'refused', code: refusalOf(error) });
		}
		for (const each of added) {
			await this.#tell(each);
		}
		return({ kind: 'added' });
	}

	/** A staple the network applied that this node's ledger still refuses: the two diverge on it. */
	#reportRefused(entry: QueuedStaple<VoteStaple>, age: number): void {
		this.#node.log.warn(LOG_SOURCE, `bootstrap: staple refused for ${String(Math.floor(age / MINUTE_MILLISECONDS))} min: ${entry.code} (staple ${entry.staple.blocksHash.toString()})`);
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
