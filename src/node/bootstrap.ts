import { createHash, randomInt } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BootstrapClient as DeclaredBootstrapClient, BootstrapConfig } from '@keetanetwork/keetanet-client/lib/bootstrap.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import type { StrandedDeferredStaple } from '../ledger/storage/base.js';
import { MemoryBootstrapStage } from '../ledger/storage/stage.js';
import type { BootstrapStage } from '../ledger/storage/stage.js';
import { KVInternals } from '../upstream/internals.js';
import { assertNever } from '../util/assert-never.js';
import { eachStapleOnce } from '../util/each-staple-once.js';
import type { AssertNever } from '../util/assert-never.js';
import type { ClassSurface } from '../util/class-surface.js';
import { BootstrapCursors, KVRetryStore } from './bootstrap-cursors.js';
import { PageError, PageFetcher } from './bootstrap-page.js';
import type { PageProblem } from './bootstrap-page.js';
import { PeerPacer, PeerThrottled } from './bootstrap-pacing.js';
import { VOTE_KEY_TOLERANCE_MILLISECONDS } from './bootstrap-evidence.js';
import { DEEP_SCAN_PERIOD_MILLISECONDS, LongestAnswer, MAX_PASS_MILLISECONDS, PageLimits, PrimingWindow, bootstrapPeer, bootstrapRange, completes } from './bootstrap-pass.js';
import type { PassAnswer, PassEvent, PassOutcome, PassRequest, PeerIO } from './bootstrap-pass.js';
import { bootstrapPacingOf, bootstrapSources } from './bootstrap-peers.js';
import type { BootstrapNode } from './bootstrap-peers.js';
import { rangeResultOf, updateRanges } from './bootstrap-ranges.js';
import type { RangeEvent, RangeIO, RangeLayout, RangeResult, RangeTask } from './bootstrap-ranges.js';
import { RetryQueue, RetryQueueFull } from './bootstrap-retry.js';
import { StageFull, Staging, applyFrontier } from './bootstrap-stage.js';
import type { Applied } from './bootstrap-stage.js';
import { MOST_LACKED_PER_UPDATE, STRANDED_READ, awaitedOf, dueLackedBlocks, landedOn, weightSufficesOn } from './retry-signals.js';
import type { Unanswered } from './retry-signals.js';
import { BOOTSTRAP_MARGIN_MILLISECONDS, MAX_NAMED, NamedStaples } from './bootstrap-window.js';
import type { NamedStaple } from './bootstrap-window.js';
import type { Added, Offered, QueuedStaple, QueueUse } from './bootstrap-retry.js';
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
 * transaction of its own [Keeta TS] index.js:67852-67861, 70517-70521, so
 * that a stop waits on one slice at most.
 */
const GC_SLICE_MILLISECONDS = 2000;

type UpdateResult = { complete: boolean };

/** What an update's passes over one peer did: its requests, and the staples it was sent, by whether the node added them, staged them, held them already or queued them. */
type PassTally = Record<'requests' | 'staged' | Added, number>;

/**
 * How a pass treats what it is sent: adds it, as once the node has caught up
 * on the history it lacked, or stages it, to be added in the order of its
 * votes, while the node reads that history in ranges or has not added all
 * it staged (src/node/bootstrap-stage.ts).
 */
type Taking = 'add' | 'stage';

const BYTES_PER_MIB = 1024 * 1024;

function describeRange(outcome: PassOutcome, task: RangeTask): string {
	const range = `the range from ${task.reached.toISOString()} to ${task.end().toISOString()}`;
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

/** What became of a staple the node fetched that its ledger did not apply, as its log says it. */
function describeNotApplied(added: Added): string {
	switch (added) {
		case 'added':
			return('deferred');
		case 'held':
			return('held already');
		case 'queued':
			return('queued for retry');
		default:
			return(assertNever(added));
	}
}

/** The pages the node reads from a fetched staple's earliest vote for the bytes the peer serves of it, before it adds the staple as built; and the staples each asks for, a read's worth. */
const SERVED_BYTES_PAGES = 3;
const SERVED_BYTES_PAGE_LIMIT = 200;

/** Seeds for the filters of those pages, as a pass draws its own (src/node/bootstrap-pass.ts). */
const FILTER_SEED_LIMIT = 2 ** 31;

/** The updates in a row a full retry queue blocks the adding of the stage for before the node says it is stalled. */
const STALLED_AFTER_UPDATES = 3;

/** A gateway's answer when what stands behind it took too long to answer. */
const GATEWAY_TIMEOUT_STATUS = 504;

/** The statuses a peer asks the node to slow down with: too many requests, and a service unavailable for now (RFC 9110, sections 15.6.4; RFC 6585, section 4). */
const THROTTLING_STATUSES: readonly number[] = [429, 503];

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

/** Whether the failure is a peer's answer asking the node to slow down. */
function isThrottling(error: unknown): error is PageError & { readonly problem: Extract<PageProblem, { readonly kind: 'status' }> } {
	return(error instanceof PageError && error.problem.kind === 'status' && THROTTLING_STATUSES.includes(error.problem.status));
}

function resultOf(outcome: PassOutcome): PeerResult {
	if (completes(outcome)) {
		return('completed');
	}
	return('bounded');
}

/** Where the node keeps what its bootstrap stages: its storage driver's stage, or, on a driver of another kind, one in memory. */
function stageOf(node: BootstrapNode): BootstrapStage {
	const storage = node.config.ledger.storageDriver;
	if (storage instanceof LedgerStorageDriverBase) {
		return(storage.bootstrapStage());
	}
	return(new MemoryBootstrapStage());
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
 * under way, runs alongside. While the node reads the history it lacks in
 * ranges (src/node/bootstrap-ranges.ts), or has not added all it read so,
 * the passes stage what they are sent instead of adding it, and the node
 * adds the staged staples in the order of their votes alongside the passes
 * (src/node/bootstrap-stage.ts). A pass is bounded in requests and time, and
 * one that reaches its bound is continued on the next update, which a
 * client updating on a period then begins at once; a peer that
 * fails is logged and tried again on the next update. Neither holds up any
 * other peer for longer. Requests to a peer are paced as the node's
 * configuration asks (paceBootstrap), the pause counting towards the pass's
 * bound in time.
 *
 * stats() counts the updates in a row that were complete: every peer's pass
 * completed, so the node held or queued all its peers had applied before
 * the margin before each pass began, nothing was left staged, nothing was
 * left queued for retry, and no staple deferred before that margin awaits a
 * block the ledger lacks, so the ledger applied all of it. An incomplete
 * update sets the count back to 0, so a count above 0 says the node is
 * caught up.
 */
export class BootstrapClient {
	static isInstance: (obj: unknown, strict?: boolean) => obj is BootstrapClient = lib.Utils.Helper.checkableGenerator(BootstrapClient);

	/** How long one request to a peer may take, in milliseconds. */
	timeout: number;
	readonly #node: BootstrapNode;
	readonly #cursors: BootstrapCursors;
	readonly #retries: RetryQueue<VoteStaple>;
	readonly #staging: Staging<VoteStaple>;
	/** The ranges as the node last read or wrote them, which say up to where it adds what it staged. */
	#layout: RangeLayout | undefined;
	/** Kept across updates, so that the first request of an update is paced after the last of the one before. */
	readonly #pacer: PeerPacer;
	readonly #callback: Callback | undefined;
	readonly #stopping = new AbortController();
	/** Updates and resets run one after another, each after those called before it. */
	#queue: Promise<unknown> = Promise.resolve();
	#timer: NodeJS.Timeout | undefined;
	#lastUpdate: Date | undefined;
	#completeCount = 0;
	/** The updates in a row whose adding a full retry queue blocked (Applied). */
	#blockedUpdates = 0;
	/** How the last update's passes ended, which says whether the next starts at once. */
	#lastResults: readonly PeerResult[] = [];
	/** Where a pass over each peer last ended for naming too many staples from one start, to tell a peer it stays stuck on. */
	readonly #crowdedAt = new Map<string, number>();
	readonly #answers = new Map<string, LongestAnswer>();
	readonly #priming = new Map<string, PrimingWindow>();
	readonly #pageLimits = new Map<string, PageLimits>();
	/** The lacked blocks asked for that did not land, by hash, asked for again only after a wait that doubles each time. */
	readonly #unanswered = new Map<string, Unanswered>();
	/** The last stranded staple read, after which the next update reads, and the blocks the pages of this round carry; none once a page was the last. */
	#strandedAfter: StrandedDeferredStaple | undefined;
	readonly #carriedThisRound = new Set<string>();

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
		this.#staging = new Staging<VoteStaple>(stageOf(node), this.#retries, {
			holds: (staple) => {
				return(this.#holds(staple));
			},
			decode: function(bytes): VoteStaple {
				return(new lib.Vote.Staple(bytes));
			}
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
		const began = Date.now();
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
		const staging = this.#staging;
		const rangeIO: RangeIO = {
			...io,
			readLayout: function() {
				return(cursors.readLayout());
			},
			writeLayout: async (layout) => {
				await cursors.writeLayout(layout);
				this.#layout = layout;
				staging.moved();
			},
			saturated: function() {
				return(Promise.resolve(retries.saturated()));
			},
			roomAhead: function() {
				return(staging.roomAhead());
			},
			report: (event) => {
				this.#reportRanges(event);
			}
		};
		try {
			this.#layout = await cursors.readLayout();
			let taking: Taking = 'add';
			if (this.#layout !== undefined || !await staging.isEmpty()) {
				taking = 'stage';
			}
			const passes = (async (): Promise<ReadonlyMap<string, PeerResult>> => {
				return(await updateRanges(sources, rangeIO, (endpoint, task) => {
					return(this.#readRangeLogged(endpoint, limit, fetcher, task));
				}) ?? await updatePeers(sources, io, MAX_CONCURRENT_PASSES, (endpoint, from) => {
					return(this.#catchUpLogged(endpoint, limit, fetcher, from, taking));
				}));
			})();
			const { result: results, applied } = await staging.alongside(passes, () => {
				return(applyFrontier(this.#layout));
			}, Date.now() + MAX_PASS_MILLISECONDS, () => {
				return(this.#stopped());
			});
			await this.#logApplied(applied);
			await this.#logBlocked(applied);
			this.#lastResults = [...results.values()];
			if (applied.backlog) {
				// What is left to add makes the update incomplete, and the next begins at once to add it.
				this.#lastResults = [...this.#lastResults, 'bounded'];
			}
			await this.#collect();
			const stageEmpty = await staging.isEmpty();
			const passesComplete = sources.every(function(endpoint): boolean {
				return(results.get(endpoint) === 'completed');
			}) && !this.#stopped() && stageEmpty;
			// One peer that read the node up to the margin shows the deferred staples before it wait on what no pass brings; a peer failing meanwhile changes nothing of that.
			const anyCompleted = sources.some(function(endpoint): boolean {
				return(results.get(endpoint) === 'completed');
			});
			if (anyCompleted && stageEmpty && !this.#stopped()) {
				await this.#fetchLacked(sources, fetcher, began);
			}
			const complete = passesComplete && await this.#appliedAllRead(began);
			this.#record(complete);
			return({ complete });
		} finally {
			fetcher.close();
		}
	}

	/** What the update added of what was staged, logged when it added any or left some. */
	async #logApplied(applied: Applied): Promise<void> {
		if (applied.left === 0 && !applied.backlog) {
			return;
		}
		const staged = await this.#staging.counts();
		let frontier = 'every staple';
		const layout = this.#layout;
		if (layout !== undefined && layout.ranges.length > 0) {
			frontier = `those whose earliest vote was made before ${new Date(applyFrontier(layout)).toISOString()}`;
		}
		let left = '';
		if (applied.backlog) {
			left = '; more of those are left to add';
		}
		this.#node.log.info(LOG_SOURCE, `Bootstrap: added ${String(applied.left)} staged staples, by their votes, of ${frontier}${left}; ${String(staged.staples)} staples (${String(Math.round(staged.bytes / BYTES_PER_MIB))} MiB) remain staged`);
	}

	/**
	 * Says when a retry queue full of staples the ledger keeps refusing has
	 * blocked the adding of the stage for STALLED_AFTER_UPDATES updates in a
	 * row, and when it no longer does: until then the node adds nothing it
	 * staged, and no update completes.
	 */
	async #logBlocked(applied: Applied): Promise<void> {
		if (!applied.blocked) {
			if (this.#blockedUpdates >= STALLED_AFTER_UPDATES) {
				this.#node.log.info(LOG_SOURCE, 'Bootstrap is no longer stalled: the node adds what it staged again');
			}
			this.#blockedUpdates = 0;
			return;
		}
		this.#blockedUpdates++;
		if (this.#blockedUpdates !== STALLED_AFTER_UPDATES) {
			return;
		}
		const staged = await this.#staging.counts();
		const codes = new Map<string, number>();
		for (const entry of await this.#retries.entries()) {
			codes.set(entry.code, (codes.get(entry.code) ?? 0) + 1);
		}
		const refusals = [...codes].map(function([code, count]): string {
			return(`${String(count)} ${code}`);
		}).join(', ');
		this.#node.log.error(LOG_SOURCE, `Bootstrap is stalled: the retry queue is full of staples the ledger keeps refusing (${refusals}), so none of the ${String(staged.staples)} staged staples is added and no update completes, for ${String(STALLED_AFTER_UPDATES)} updates now; it goes on once one of those staples applies`);
	}

	/**
	 * Runs the ledger's garbage collection, slice after slice, until it
	 * reports nothing left, which, besides what it collects, applies each
	 * deferred staple whose awaited blocks are all held, but for one whose
	 * last retry failed, which waits until a staple is applied since
	 * (schema/CONTRACT.md, section 2.6). The ledger applies a deferred staple when the block it
	 * awaits arrives, but only for as long as the replay window allows, so of
	 * a long chain of staples deferred behind one block, only the collection
	 * applies the rest, about a window's worth a slice. Each staple of the
	 * chain the next update adds before the chain is applied is deferred
	 * behind it too, so a collection cut short after a few slices fell behind
	 * an account that sends a staple every few seconds of its history: on the
	 * main network such a chain grew past a hundred thousand staples. Every
	 * staple it applies precedes, by its votes, whatever the next update adds.
	 * Nothing else in the node runs it.
	 */
	async #collect(): Promise<void> {
		while (!this.#stopped()) {
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

	/**
	 * Asks the peers for the staples holding blocks that deferred staples
	 * await, once a pass over some peer has completed with nothing staged.
	 * A completed pass shows the node holds every staple that peer keyed
	 * before the margin before the update began, as its pages listed them;
	 * but a main network representative leaves out of a page a vote made a
	 * millisecond or less after the last vote of one of its reads, as its
	 * reads resume past that vote, so a pass moves past a staple whose votes
	 * are all left out so. One staple of a chain lost so leaves every later
	 * one deferred for good. Only deferred staples voted before the margin
	 * are read, those whose dependencies the passes have read past, a page at
	 * a time from after the last page read, round after round. A block they
	 * await that none of them carries is asked for from each peer in turn, as
	 * the client asks for a block's staple, and the staple added, which
	 * applies the deferred staples after it. A block not applied so, whether
	 * no peer held it, or the ledger queued, deferred or refused its staple,
	 * is asked for again only after a wait that doubles each time.
	 */
	async #fetchLacked(sources: readonly string[], fetcher: PageFetcher, began: number): Promise<void> {
		const storage = this.#node.config.ledger.storageDriver;
		if (!(storage instanceof LedgerStorageDriverBase)) {
			return;
		}
		let stranded: readonly StrandedDeferredStaple[];
		try {
			stranded = await storage.listStrandedDeferredStaples(new Date(began - BOOTSTRAP_MARGIN_MILLISECONDS), STRANDED_READ, this.#strandedAfter);
		} catch (error: unknown) {
			this.#node.log.warn(LOG_SOURCE, 'Reading the deferred staples that await blocks the ledger lacks failed; it is read again after the next update:', error);
			return;
		}
		const due = dueLackedBlocks(stranded, this.#carriedThisRound, this.#unanswered, Date.now(), MOST_LACKED_PER_UPDATE);
		this.#strandedAfter = stranded.at(-1);
		for (const { staple } of stranded) {
			for (const block of staple.blocks) {
				this.#carriedThisRound.add(block.hash.toString());
			}
		}
		if (stranded.length < STRANDED_READ) {
			this.#strandedAfter = undefined;
			this.#carriedThisRound.clear();
		}
		for (const block of due) {
			if (this.#stopped()) {
				return;
			}
			if (!await this.#fetchHolding(block, sources, fetcher)) {
				const unanswered = this.#unanswered.get(block.toString());
				this.#unanswered.set(block.toString(), { asked: (unanswered?.asked ?? 0) + 1, at: Date.now() });
			}
		}
	}

	/**
	 * Asks each peer in turn for the staple holding the block, and adds the
	 * first one found; answers whether the ledger then holds it. The staple
	 * is built from its votes and blocks as the client builds it, whose bytes
	 * are another zlib stream than the one the peer holds (schema/CONTRACT.md,
	 * section 1, "Staple bytes"), so the node adds the peer's own bytes when
	 * pages from its earliest vote show them (#asTheyAreServed): then its API
	 * serves them as the peers do, and its filters name them, so that no pass
	 * downloads the staple again. Otherwise it adds the rebuilt bytes
	 * (conformance/API.md).
	 */
	async #fetchHolding(block: BlockHash, sources: readonly string[], fetcher: PageFetcher): Promise<boolean> {
		const key = block.toString();
		for (const endpoint of sources) {
			let staple: VoteStaple | undefined;
			try {
				staple = await fetcher.stapleHolding(endpoint, block, this.timeout, this.#stopping.signal, (request) => {
					return(this.#pacer.paced(endpoint, this.#stopping.signal, request));
				});
			} catch (error: unknown) {
				if (this.#stopped()) {
					return(false);
				}
				this.#noteThrottling(endpoint, error);
				this.#node.log.warn(LOG_SOURCE, `Asking ${endpoint} for the staple holding block ${key}, which deferred staples await, failed:`, error);
				continue;
			}
			if (staple === undefined) {
				continue;
			}
			staple = await this.#asTheyAreServed(endpoint, staple, fetcher);
			let added: Added;
			try {
				added = await this.#retries.add(staple, 'deep');
			} catch (error: unknown) {
				if (!this.#stopped()) {
					this.#node.log.warn(LOG_SOURCE, `Adding staple ${staple.blocksHash.toString()}, which holds block ${key} that deferred staples await, failed; it is asked for again later:`, error);
				}
				return(false);
			}
			if (await this.#holds(staple)) {
				this.#unanswered.delete(key);
				this.#node.log.info(LOG_SOURCE, `Bootstrap: the node lacked block ${key}, which deferred staples await; staple ${staple.blocksHash.toString()} holding it, from ${endpoint}, was added`);
				return(true);
			}
			this.#node.log.warn(LOG_SOURCE, `Bootstrap: the node lacks block ${key}, which deferred staples await; staple ${staple.blocksHash.toString()} holding it, from ${endpoint}, was ${describeNotApplied(added)}; it is asked for again later`);
			return(false);
		}
		this.#node.log.warn(LOG_SOURCE, `Bootstrap: the node lacks block ${key}, which deferred staples await, and none of its peers holds a staple holding it; it asks again later`);
		return(false);
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
	async #catchUpLogged(endpoint: string, limit: number, fetcher: PageFetcher, from: Date, taking: Taking): Promise<PeerResult> {
		if (this.#stopped()) {
			return('failed');
		}
		try {
			return(await this.#catchUp(endpoint, limit, fetcher, from, taking));
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
	async #catchUp(endpoint: string, limit: number, fetcher: PageFetcher, from: Date, taking: Taking): Promise<PeerResult> {
		const tally: PassTally = { requests: 0, added: 0, staged: 0, held: 0, queued: 0 };
		const io = this.#peerIO(endpoint, fetcher, tally, taking);
		const { live: outcome } = await bootstrapPeer(io, { limit, stagger: staggerOf(endpoint), from });
		await this.#logPass(endpoint, describeOutcome(outcome), tally, completes(outcome));
		return(resultOf(outcome));
	}

	/** An update's pass over a range of the peer's history (src/node/bootstrap-ranges.ts); a full retry queue holds it back rather than fail it, as does a stop. */
	async #readRangeLogged(endpoint: string, limit: number, fetcher: PageFetcher, task: RangeTask): Promise<RangeResult> {
		if (this.#stopped()) {
			return('stopped');
		}
		const tally: PassTally = { requests: 0, added: 0, staged: 0, held: 0, queued: 0 };
		try {
			const outcome = await bootstrapRange(this.#peerIO(endpoint, fetcher, tally, 'stage'), task, { limit, stagger: staggerOf(endpoint), from: task.from });
			await this.#logPass(endpoint, describeRange(outcome, task), tally, completes(outcome));
			return(rangeResultOf(outcome));
		} catch (error: unknown) {
			if (this.#stopped()) {
				this.#node.log.debug(LOG_SOURCE, `Stopped bootstrapping from ${endpoint}`);
				return('stopped');
			}
			if (error instanceof RetryQueueFull || error instanceof StageFull) {
				this.#node.log.info(LOG_SOURCE, `Bootstrap pass over ${endpoint} waits for room, in the range from ${task.reached.toISOString()} to ${task.end().toISOString()}: ${error.message}`);
				return('throttled');
			}
			// A peer that asked the node to slow down is waited for, and not benched for failing meanwhile.
			if (error instanceof PeerThrottled || isThrottling(error)) {
				this.#node.log.info(LOG_SOURCE, `Bootstrap pass over ${endpoint} waits, as the peer asked, in the range from ${task.reached.toISOString()} to ${task.end().toISOString()}: ${error.message}`);
				return('throttled');
			}
			this.#node.log.warn(LOG_SOURCE, `Bootstrapping from ${endpoint} in the range from ${task.reached.toISOString()} to ${task.end().toISOString()} failed; it is tried again on the next update:`, error);
			return('failed');
		}
	}

	async #logPass(endpoint: string, outcome: string, tally: PassTally, complete: boolean): Promise<void> {
		const summary = `Bootstrap pass over ${endpoint}: ${outcome} after ${String(tally.requests)} requests, ${String(tally.added)} staples added, ${String(tally.held)} held already, ${String(tally.queued)} queued for retry, ${String(tally.staged)} staged (${String(await this.#retries.size())} in the queue)`;
		// Once caught up, a pass every period adds nothing, which an operator need not read.
		if (tally.added > 0 || tally.staged > 0 || tally.queued > 0 || !complete) {
			this.#node.log.info(LOG_SOURCE, summary);
		} else {
			this.#node.log.debug(LOG_SOURCE, summary);
		}
	}

	/** How passes over the peer reach it and the node, adding or staging what they are sent as told, counting what they do in the tally. */
	#peerIO(endpoint: string, fetcher: PageFetcher, tally: PassTally, taking: Taking): PeerIO<VoteStaple> {
		return({
			answers: keptFor(this.#answers, endpoint, function() {
				return(new LongestAnswer());
			}),
			priming: keptFor(this.#priming, endpoint, function() {
				return(new PrimingWindow());
			}),
			pageLimits: keptFor(this.#pageLimits, endpoint, function() {
				return(new PageLimits());
			}),
			page: (request) => {
				tally.requests++;
				return(this.#page(fetcher, endpoint, request));
			},
			held: async (since, count) => {
				this.#stopping.signal.throwIfAborted();
				const queued = (await this.#retries.staples()).slice(0, count);
				const staged = await this.#stagedNamed(taking, since, count - queued.length);
				const named = [...queued, ...staged];
				if (named.length >= count) {
					return(named);
				}
				return([...named, ...eachStapleOnce(await this.#node.ledger.getVoteStaplesAfter(since, count - named.length, { timeout: HELD_READ_MILLISECONDS }))]);
			},
			add: async (staple, use) => {
				this.#stopping.signal.throwIfAborted();
				const added = await this.#take(taking, staple, use);
				switch (added) {
					case 'added':
						if (taking === 'stage') {
							tally.staged++;
							return(added);
						}
						break;
					case 'held':
					case 'queued':
						break;
					default:
						assertNever(added);
				}
				tally[added]++;
				return(added);
			},
			retry: async () => {
				this.#stopping.signal.throwIfAborted();
				// What is staged is added, and the queue offered again, by the node adding it.
				if (taking === 'add') {
					await this.#retries.retry();
				}
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

	#take(taking: Taking, staple: VoteStaple, use: QueueUse): Promise<Added> {
		switch (taking) {
			case 'add':
				return(this.#retries.add(staple, use));
			case 'stage':
				return(this.#staging.take(staple, use));
			default:
				return(assertNever(taking));
		}
	}

	async #stagedNamed(taking: Taking, since: Date, count: number): Promise<readonly NamedStaple[]> {
		switch (taking) {
			case 'add':
				return([]);
			case 'stage':
				return(await this.#staging.named(since, count));
			default:
				return(assertNever(taking));
		}
	}

	async #page(fetcher: PageFetcher, endpoint: string, request: PassRequest): Promise<PassAnswer<VoteStaple>> {
		try {
			const staples = await this.#pacer.paced(endpoint, this.#stopping.signal, () => {
				return(fetcher.page({ endpoint, ...request }, this.timeout, this.#stopping.signal));
			});
			return({ kind: 'page', staples });
		} catch (error: unknown) {
			this.#noteThrottling(endpoint, error);
			if (error instanceof PageError) {
				const answer = answerOf(error);
				if (answer !== undefined) {
					return(answer);
				}
			}
			throw(error);
		}
	}

	/**
	 * Whether the ledger applied everything the passes read: no staple waits
	 * in the retry queue, refused, and none deferred before the margin before
	 * the update began awaits a block the main ledger lacks. Either leaves
	 * the ledger without staples its peers hold, so the node is not caught
	 * up while one does, though every pass completed. A driver of another
	 * kind keeps no deferred staples apart to ask about.
	 */
	async #appliedAllRead(began: number): Promise<boolean> {
		if (await this.#retries.size() > 0) {
			return(false);
		}
		const storage = this.#node.config.ledger.storageDriver;
		if (!(storage instanceof LedgerStorageDriverBase)) {
			return(true);
		}
		try {
			return((await storage.listStrandedDeferredStaples(new Date(began - BOOTSTRAP_MARGIN_MILLISECONDS), 1)).length === 0);
		} catch (error: unknown) {
			this.#node.log.warn(LOG_SOURCE, 'Reading whether deferred staples await blocks the ledger lacks failed; the update counts as incomplete:', error);
			return(false);
		}
	}

	/**
	 * The staple as the peer serves it in its pages, if it serves it. A peer
	 * keyed by votes lists it for its earliest vote in a read from there,
	 * which a page cut short may leave for the next, asked for with a filter
	 * naming what came before. A read from earlier would end, on the main
	 * network, on the vote a millisecond or less before, which is how the
	 * staple was lost, and skip it; so only a peer that lists none of it
	 * from its vote's own moment, as one keying votes a little early would,
	 * is read again from the tolerance before. A peer that lists it in
	 * neither, or fails, leaves the staple as it was built; one that asks
	 * the node to slow down is left alone.
	 */
	async #asTheyAreServed(endpoint: string, built: VoteStaple, fetcher: PageFetcher): Promise<VoteStaple> {
		const earliest = Math.min(...built.votes.map(function(vote): number {
			return(vote.validityFrom.getTime());
		}));
		const key = built.blocksHash.toString();
		try {
			for (const start of [earliest, earliest - VOTE_KEY_TOLERANCE_MILLISECONDS]) {
				const served = await this.#servedFrom(endpoint, key, new Date(start), fetcher);
				if (served !== undefined) {
					return(served);
				}
			}
		} catch (error: unknown) {
			this.#noteThrottling(endpoint, error);
			this.#node.log.debug(LOG_SOURCE, `Asking ${endpoint} for the bytes it serves of staple ${key} failed; the node adds it as built from its votes and blocks:`, error);
		}
		return(built);
	}

	/** The staple of that key in the peer's pages from the start, at most SERVED_BYTES_PAGES of them. */
	async #servedFrom(endpoint: string, key: string, start: Date, fetcher: PageFetcher): Promise<VoteStaple | undefined> {
		const named = new NamedStaples();
		for (let page = 0; page < SERVED_BYTES_PAGES; page++) {
			const bloomFilter = named.filter(randomInt(FILTER_SEED_LIMIT)).serialized;
			const staples = await this.#pacer.paced(endpoint, this.#stopping.signal, () => {
				return(fetcher.page({ endpoint, start, limit: SERVED_BYTES_PAGE_LIMIT, bloomFilter }, this.timeout, this.#stopping.signal));
			});
			const served = staples.find(function(listed): boolean {
				return(listed.blocksHash.toString() === key);
			});
			if (served !== undefined || staples.length === 0) {
				return(served);
			}
			named.receive(staples);
		}
		return(undefined);
	}

	/** A peer that answered with a status asking the node to slow down is left alone for a while (PeerPacer). */
	#noteThrottling(endpoint: string, error: unknown): void {
		if (isThrottling(error)) {
			this.#pacer.throttled(endpoint, error.problem.retryAfterMilliseconds);
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
			case 'split':
				this.#node.log.info(LOG_SOURCE, `Bootstrap from ${event.peer}: takes on the range from ${event.taken.reached.toISOString()} to ${event.taken.end.toISOString()}, the later part of the one ${event.left.peer ?? 'no peer'} reads, which reached ${event.left.reached.toISOString()} and now ends at ${event.left.end.toISOString()}`);
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
