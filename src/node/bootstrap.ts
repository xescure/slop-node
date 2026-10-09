import { createHash } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BootstrapClient as DeclaredBootstrapClient, BootstrapConfig } from '@keetanetwork/keetanet-client/lib/bootstrap.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { KVInternals } from '../upstream/internals.js';
import { assertNever } from '../util/assert-never.js';
import { eachStapleOnce } from '../util/each-staple-once.js';
import type { AssertNever } from '../util/assert-never.js';
import type { ClassSurface } from '../util/class-surface.js';
import { BootstrapCursors, KVRetryStore } from './bootstrap-cursors.js';
import { PageError, PageFetcher } from './bootstrap-page.js';
import { PeerPacer } from './bootstrap-pacing.js';
import { DEEP_SCAN_PERIOD_MILLISECONDS, LongestAnswer, PrimingWindow, VOTE_KEY_TOLERANCE_MILLISECONDS, bootstrapPeer, bootstrapRange, completes } from './bootstrap-pass.js';
import type { PassAnswer, PassEvent, PassOutcome, PassRequest, PeerIO } from './bootstrap-pass.js';
import { bootstrapPacingOf, bootstrapSources } from './bootstrap-peers.js';
import type { BootstrapNode } from './bootstrap-peers.js';
import { rangeResultOf, updateRanges } from './bootstrap-ranges.js';
import type { RangeEvent, RangeIO, RangeResult, RangeTask } from './bootstrap-ranges.js';
import { RetryQueue, RetryQueueFull } from './bootstrap-retry.js';
import { awaitedOf, landedOn, weightSufficesOn } from './retry-signals.js';
import { MAX_NAMED } from './bootstrap-window.js';
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

/**
 * How long one read of what the node holds, to name in a filter, runs at
 * most, besides the read of votes under way then
 * [Keeta TS] index.js:69641-69647. It cannot be stopped otherwise, and each
 * staple read is decoded and its votes' signatures checked, a few
 * milliseconds a staple, so this bounds how long it holds up a stop. What it
 * leaves out the peer may send again, which the pass finds held.
 */
const HELD_READ_MILLISECONDS = 2000;

/**
 * How long one slice of the ledger's garbage collection runs at most, in one
 * transaction of its own [Keeta TS] index.js:67852-67861, 70517-70521, and how
 * many slices follow each update at most: it holds the ledger to itself while
 * it runs, so it is cut short rather than hold up the next update's adds.
 */
const GC_SLICE_MILLISECONDS = 2000;

const GC_SLICES = 5;

type UpdateResult = { complete: boolean };

/** What an update's passes over one peer did: its requests, and the staples it was sent, by whether the node added them, held them already or queued them. */
type PassTally = Record<'requests' | Added, number>;

function describeRange(outcome: PassOutcome, task: RangeTask): string {
	const range = `the range from ${task.reached.toISOString()} to ${task.end.toISOString()}`;
	switch (outcome.kind) {
		case 'drained':
		case 'caught-up':
			return(`read ${range}`);
		case 'bounded':
			return(`reached ${outcome.reached.toISOString()} within this update's bound (it continues on the next update), in ${range}`);
		default:
			return(assertNever(outcome));
	}
}

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

/** What the client keeps for the peer while it runs, made the first time it reads the peer. */
function keptFor<Value>(kept: Map<string, Value>, endpoint: string, make: () => Value): Value {
	let value = kept.get(endpoint);
	if (value === undefined) {
		value = make();
		kept.set(endpoint, value);
	}
	return(value);
}

/** A gateway's answer when what stands behind it took too long to answer. */
const GATEWAY_TIMEOUT_STATUS = 504;

/** What a failed request tells a pass of the peer, or nothing when it only fails the pass. */
function answerOf(error: PageError): PassAnswer<VoteStaple> | undefined {
	const problem = error.problem;
	switch (problem.kind) {
		case 'too-large':
			return({ kind: 'too-large' });
		case 'timeout':
			return({ kind: 'gave-up', reason: String(error) });
		case 'status':
			if (problem.status === GATEWAY_TIMEOUT_STATUS) {
				return({ kind: 'gave-up', reason: String(error) });
			}
			return(undefined);
		case 'protocol':
		case 'malformed':
		case 'stopped':
			return(undefined);
		default:
			return(assertNever(problem));
	}
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
	/** Where a pass over each peer last ended for naming too many staples from one start, to tell a peer it stays stuck on. */
	readonly #crowdedAt = new Map<string, number>();
	readonly #answers = new Map<string, LongestAnswer>();
	readonly #priming = new Map<string, PrimingWindow>();

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
		this.#retries = new RetryQueue<VoteStaple>({
			holds: (staple) => {
				return(this.#holds(staple));
			},
			offer: (staple) => {
				return(this.#offer(staple));
			},
			decode: function(bytes): VoteStaple {
				return(new lib.Vote.Staple(bytes));
			},
			awaited: awaitedOf,
			weightSuffices: (voterSets) => {
				return(weightSufficesOn(this.#node.ledger, voterSets));
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

	#stopped(): boolean {
		return(this.#stopping.signal.aborted);
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
		const retries = this.#retries;
		const rangeIO: RangeIO = {
			...io,
			readLayout: function() {
				return(cursors.readLayout());
			},
			writeLayout: function(layout) {
				return(cursors.writeLayout(layout));
			},
			saturated: function() {
				return(Promise.resolve(retries.saturated()));
			},
			roomAhead: function() {
				return(retries.hasRoom('ahead'));
			},
			report: (event) => {
				this.#reportRanges(event);
			}
		};
		try {
			const results = await updateRanges(sources, rangeIO, (endpoint, task) => {
				return(this.#readRangeLogged(endpoint, limit, fetcher, task));
			}) ?? await updatePeers(sources, io, MAX_CONCURRENT_PASSES, (endpoint, from) => {
				return(this.#catchUpLogged(endpoint, limit, fetcher, from));
			});
			this.#lastResults = [...results.values()];
			await this.#collect();
			const complete = sources.every(function(endpoint): boolean {
				return(results.get(endpoint) === 'completed');
			}) && !this.#stopping.signal.aborted;
			this.#record(complete);
			return({ complete });
		} finally {
			fetcher.close();
		}
	}

	/**
	 * Runs the ledger's garbage collection, which, besides what it collects,
	 * applies each deferred staple whose awaited blocks are all held
	 * (schema/CONTRACT.md, section 2.6). The ledger applies a deferred staple
	 * when the block it awaits arrives, but only for as long as the replay
	 * window allows, so of a long chain of staples a peer sent ahead of the
	 * block they extend, as a pass over a range read ahead of the earliest
	 * sends, only the collection applies the rest. Nothing else in the node runs it.
	 */
	async #collect(): Promise<void> {
		for (let slice = 0; slice < GC_SLICES && !this.#stopped(); slice++) {
			let more: boolean;
			try {
				more = await this.#node.ledger.gc(GC_SLICE_MILLISECONDS);
			} catch (error: unknown) {
				this.#node.log.warn(LOG_SOURCE, 'The ledger\'s garbage collection after a bootstrap update failed; it runs again after the next:', error);
				return;
			}
			if (!more) {
				return;
			}
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

	/** Once stopped, a pass not yet begun is not begun: it would read the node's ledger before its first request found the stop. */
	async #catchUpLogged(endpoint: string, limit: number, fetcher: PageFetcher, from: Date): Promise<PeerResult> {
		if (this.#stopped()) {
			return('failed');
		}
		try {
			return(await this.#catchUp(endpoint, limit, fetcher, from));
		} catch (error: unknown) {
			if (this.#stopped()) {
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
		const io = this.#peerIO(endpoint, fetcher, tally);
		const { live: outcome } = await bootstrapPeer(io, { limit, stagger: staggerOf(endpoint), from });
		await this.#logPass(endpoint, describeOutcome(outcome), tally, completes(outcome));
		return(resultOf(outcome));
	}

	/** An update's pass over a range of the peer's history (src/node/bootstrap-ranges.ts); a full retry queue holds it back rather than fail it, as does a stop. */
	async #readRangeLogged(endpoint: string, limit: number, fetcher: PageFetcher, task: RangeTask): Promise<RangeResult> {
		if (this.#stopped()) {
			return('stopped');
		}
		const tally: PassTally = { requests: 0, added: 0, held: 0, queued: 0 };
		try {
			const outcome = await bootstrapRange(this.#peerIO(endpoint, fetcher, tally), task, { limit, stagger: staggerOf(endpoint), from: task.from });
			await this.#logPass(endpoint, describeRange(outcome, task), tally, completes(outcome));
			return(rangeResultOf(outcome));
		} catch (error: unknown) {
			if (this.#stopped()) {
				this.#node.log.debug(LOG_SOURCE, `Stopped bootstrapping from ${endpoint}`);
				return('stopped');
			}
			if (error instanceof RetryQueueFull) {
				this.#node.log.info(LOG_SOURCE, `Bootstrap pass over ${endpoint} waits for room in the retry queue, in the range from ${task.reached.toISOString()} to ${task.end.toISOString()}: ${error.message}`);
				return('throttled');
			}
			this.#node.log.warn(LOG_SOURCE, `Bootstrapping from ${endpoint} in the range from ${task.reached.toISOString()} to ${task.end.toISOString()} failed; it is tried again on the next update:`, error);
			return('failed');
		}
	}

	async #logPass(endpoint: string, outcome: string, tally: PassTally, complete: boolean): Promise<void> {
		const summary = `Bootstrap pass over ${endpoint}: ${outcome} after ${String(tally.requests)} requests, ${String(tally.added)} staples added, ${String(tally.held)} held already, ${String(tally.queued)} queued for retry (${String(await this.#retries.size())} in the queue)`;
		// Once caught up, a pass every period adds nothing, which an operator need not read.
		if (tally.added > 0 || tally.queued > 0 || !complete) {
			this.#node.log.info(LOG_SOURCE, summary);
		} else {
			this.#node.log.debug(LOG_SOURCE, summary);
		}
	}

	/** How passes over the peer reach it and the node, counting what they do in the tally. */
	#peerIO(endpoint: string, fetcher: PageFetcher, tally: PassTally): PeerIO<VoteStaple> {
		return({
			answers: keptFor(this.#answers, endpoint, function() {
				return(new LongestAnswer());
			}),
			priming: keptFor(this.#priming, endpoint, function() {
				return(new PrimingWindow());
			}),
			page: (request) => {
				tally.requests++;
				return(this.#page(fetcher, endpoint, request));
			},
			held: async (since, count) => {
				this.#stopping.signal.throwIfAborted();
				const queued = (await this.#retries.staples()).slice(0, count);
				if (queued.length >= count) {
					return(queued);
				}
				return([...queued, ...eachStapleOnce(await this.#node.ledger.getVoteStaplesAfter(since, count - queued.length, { timeout: HELD_READ_MILLISECONDS }))]);
			},
			add: async (staple, use) => {
				this.#stopping.signal.throwIfAborted();
				const added = await this.#retries.add(staple, use);
				tally[added]++;
				return(added);
			},
			retry: async () => {
				this.#stopping.signal.throwIfAborted();
				await this.#retries.retry();
			},
			saturated: () => {
				return(Promise.resolve(this.#retries.saturated()));
			},
			report: (event) => {
				this.#reportPass(endpoint, event);
			},
			readProgress: () => {
				return(this.#cursors.read(endpoint));
			},
			writeProgress: (progress) => {
				return(this.#cursors.write(endpoint, progress));
			}
		});
	}

	async #page(fetcher: PageFetcher, endpoint: string, request: PassRequest): Promise<PassAnswer<VoteStaple>> {
		try {
			const staples = await this.#pacer.paced(endpoint, this.#stopping.signal, () => {
				return(fetcher.page({ endpoint, ...request }, this.timeout, this.#stopping.signal));
			});
			return({ kind: 'page', staples });
		} catch (error: unknown) {
			if (error instanceof PageError) {
				const answer = answerOf(error);
				if (answer !== undefined) {
					return(answer);
				}
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
		return({ kind: 'added', landed: landedOn(added) });
	}

	/**
	 * What a pass found of a peer: that it keys votes later than a pass
	 * allows, which the node hears of once, as its cursor keeps it; and a
	 * pass that ended naming too many staples from one start, logged when it
	 * ends so at the same start again, as the passes over the peer then make
	 * no progress until the peer's pages reach past it (src/node/bootstrap-pass.ts).
	 */
	#reportPass(endpoint: string, event: PassEvent): void {
		switch (event.kind) {
			case 'late-votes':
				this.#node.log.warn(LOG_SOURCE, `Bootstrap from ${endpoint}: the peer lists staples twice, as one keyed by votes does, and listed from ${event.start.toISOString()} staple ${event.staple}, none of whose votes was made within ${String(VOTE_KEY_TOLERANCE_MILLISECONDS)} ms before it or later: it keys votes later than they were made, and passes over it now move on only by what holds whatever later moment it keys them at`);
				return;
			case 'crowded': {
				const start = event.start.getTime();
				if (this.#crowdedAt.get(endpoint) === start) {
					this.#node.log.warn(LOG_SOURCE, `Bootstrap from ${endpoint}: passes again named ${String(MAX_NAMED)} staples from ${event.start.toISOString()} without a page shown to read past it; they stay there until the peer's pages do`);
				}
				this.#crowdedAt.set(endpoint, start);
				return;
			}
			default:
				assertNever(event);
		}
	}

	/** What the node reads in ranges while far behind (src/node/bootstrap-ranges.ts). */
	#reportRanges(event: RangeEvent): void {
		switch (event.kind) {
			case 'laid-out':
				this.#node.log.info(LOG_SOURCE, `Bootstrap: the node lacks the history from ${event.layout.from.toISOString()} to ${event.layout.end.toISOString()}, which its ${String(event.layout.ranges.length)} peers now read in as many ranges, side by side`);
				return;
			case 'benched':
				this.#node.log.warn(LOG_SOURCE, `Bootstrap from ${event.peer}: its passes over a range failed too often in a row, so another peer reads the range, and it reads none until ${event.until.toISOString()}`);
				return;
			case 'read':
				this.#node.log.info(LOG_SOURCE, `Bootstrap: the ranges from ${event.layout.from.toISOString()} to ${event.layout.end.toISOString()} are read; the peers are read from there on`);
				return;
			default:
				assertNever(event);
		}
	}

	/** A staple the network applied that this node's ledger still refuses: the two diverge on it. */
	#reportRefused(entry: QueuedStaple, age: number): void {
		this.#node.log.warn(LOG_SOURCE, `bootstrap: staple refused for ${String(Math.floor(age / MINUTE_MILLISECONDS))} min: ${entry.code} (staple ${entry.key})`);
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
