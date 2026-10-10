import type { BootstrapStage, StagedCounts, StagedStaple } from '../ledger/storage/stage.js';
import type { PassStaple } from './bootstrap-pass.js';
import { RANGE_OVERLAP_MILLISECONDS } from './bootstrap-ranges.js';
import type { RangeLayout } from './bootstrap-ranges.js';
import { RetryQueueFull } from './bootstrap-retry.js';
import type { Added, QueueUse, RetryQueue } from './bootstrap-retry.js';
import type { NamedStaple } from './bootstrap-window.js';

/**
 * The most bytes the stage holds before the passes over the ranges read
 * ahead of the earliest wait for the node to add what it staged: about
 * twice the main network's history to date, so that on it they never wait,
 * while a history far larger is read no further ahead than this.
 */
export const STAGE_AHEAD_BYTES: number = 4 * 1024 ** 3;

/** How many staged staples the node reads at a time to add them. */
const APPLY_BATCH = 64;

/** The latest moment a `Date` holds: a frontier past every staple. */
const END_OF_TIME = 8.64e15;

/**
 * The stage held its bound when a pass over a range read ahead of the
 * earliest was sent one more staple. The staple is not staged, so the pass
 * must not move past it; it waits, as for room in the retry queue.
 */
export class StageFull extends Error {
	constructor(blocksHash: string, bound: number) {
		super(`the bootstrap stage held its bound of ${String(bound)} bytes when staple ${blocksHash} came from a range read ahead`);
		this.name = 'StageFull';
	}
}

/** The staple as the stage keeps it: its bytes, and when its earliest and latest votes were made. */
export function stagedOf(staple: PassStaple): StagedStaple {
	let firstVote = Number.POSITIVE_INFINITY;
	let lastVote = Number.NEGATIVE_INFINITY;
	for (const vote of staple.votes) {
		firstVote = Math.min(firstVote, vote.validityFrom.getTime());
		lastVote = Math.max(lastVote, vote.validityFrom.getTime());
	}
	return({ key: staple.blocksHash.toString(), bytes: staple.toBytes(), firstVote: new Date(firstVote), lastVote: new Date(lastVote) });
}

/** A staged staple as the passes name it to a peer: by the bytes it came as. */
function namedOf(staged: StagedStaple): NamedStaple {
	return({
		blocksHash: { toString: function(): string {
			return(staged.key);
		} },
		toBytes: function(): ArrayBuffer {
			return(staged.bytes);
		}
	});
}

/**
 * The moment before which the node adds what it staged: the overlap before
 * where the range that reached least has reached, or, with no ranges left to
 * read, past every staple.
 */
export function applyFrontier(layout: RangeLayout | undefined): number {
	if (layout === undefined || layout.ranges.length === 0) {
		return(END_OF_TIME);
	}
	let earliest = Number.POSITIVE_INFINITY;
	for (const range of layout.ranges) {
		earliest = Math.min(earliest, range.reached.getTime());
	}
	return(earliest - RANGE_OVERLAP_MILLISECONDS);
}

function ignoreFailure(): void {
	// The failure is heard where the promise is awaited.
}

function plus(left: StagedCounts, right: StagedCounts): StagedCounts {
	return({ staples: left.staples + right.staples, bytes: left.bytes + right.bytes });
}

function minus(left: StagedCounts, right: StagedCounts): StagedCounts {
	return({ staples: left.staples - right.staples, bytes: left.bytes - right.bytes });
}

/** A wait for the next change, which every change before it has already ended. */
class Changes {
	#next: Promise<void>;
	#resolve: () => void = function(): void {
		// Replaced as soon as the first wait is made.
	};

	constructor() {
		this.#next = this.#fresh();
	}

	#fresh(): Promise<void> {
		return(new Promise<void>((resolve) => {
			this.#resolve = resolve;
		}));
	}

	/** Resolves once something changes after now. */
	next(): Promise<void> {
		return(this.#next);
	}

	changed(): void {
		this.#resolve();
		this.#next = this.#fresh();
	}
}

/** What the ledger the stage adds to holds, and how a staged staple is read back. */
export type StagedLedger<Staple extends PassStaple> = {
	/** Whether it holds the staple's blocks, with these votes or others. */
	holds(staple: Staple): Promise<boolean>;
	/** The staple of bytes the stage kept, as toBytes gave them. */
	decode(bytes: ArrayBuffer): Staple;
};

/** How a run of adding alongside the passes ended: whether staples staged before the frontier were left. */
export type Applied = {
	/** The staples that left the stage, added, held already or queued. */
	readonly left: number;
	readonly backlog: boolean;
};

/**
 * The staples a node far behind reads from its peers in ranges side by
 * side, kept until it adds them, which it does in the order of their votes.
 *
 * Why. The ledger judges a staple by the voting weight it holds when the
 * staple is added [Keeta TS] index.js:69419-69423, 69761-69779, and nothing
 * in upstream relaxes that for a bootstrap: a bootstrap add only passes a
 * ledger that is otherwise read-only [Keeta TS] index.js:69385-69392. Upstream
 * serves the history in the order of its votes [Keeta TS] index.js:69655-69702,
 * one page after another from a moment, so a node reading it from the start
 * adds each staple onto the history before it, as the representatives that
 * voted it held it. Ranges read side by side, each added as it comes, add
 * later history before earlier, and the weights they move can leave the
 * ledger where no stretch of the history ever was, refusing for good staples
 * the network applied. So the passes over the ranges only stage what they
 * read, and the node adds it in the order a single catch-up would.
 *
 * Staging (take). A pass moves past a staple only once take answered: the
 * ledger holds it, the retry queue holds it, or the stage holds it, each
 * durably, so every argument a pass makes for "held or queued" holds for
 * "held, queued or staged" (src/node/bootstrap-ranges.ts). A pass over a
 * range read ahead of the earliest is refused (StageFull) once the stage
 * holds STAGE_AHEAD_BYTES, before the staple, and waits as for room in the
 * retry queue; the others stage whatever they read, at most the
 * FAR_AHEAD_MILLISECONDS of history past the earliest range each, so the
 * stage holds at most the bound, that stretch and a page per pass.
 *
 * Adding (alongside). While the passes run and after, the node adds the
 * staged staples whose earliest vote was made before the frontier
 * (applyFrontier), by their earliest votes, then their keys, each through the
 * retry queue, and drops each from the stage only once the ledger or the
 * queue holds it: a stop between the two leaves it staged, and it is found
 * held when offered again. The frontier is the overlap before where the
 * range that reached least has reached. Every staple with a vote made
 * before it is held, queued or staged: a peer keyed by votes keys a vote
 * within the tolerance of when it was made, so a staple whose earliest vote
 * was made before the frontier has a vote keyed before where every range
 * reached, which the range reading that stretch listed. So the node adds a
 * prefix of the history, by votes, with every staple of it, as one pass from
 * the beginning would; a staple's dependencies have votes made before its
 * own but for the slop a vote may be timestamped ahead, which the overlap
 * also covers, and one added before a dependency within that slop is
 * refused, queued, and added once the dependency is, as a pass's disorder
 * always was. With no range left to read, every staged staple is added.
 *
 * Reading and removing beside the adding. The node reads the batch after a
 * full one while it adds that one, leaving out the batch and every staple
 * still leaving, and removes a batch that left while it adds the next, one
 * removal at a time, every later read leaving its staples out until it
 * finishes; the adding ends only once the last removal has. A staple still
 * leaves the stage only after the ledger or the queue holds it, so the
 * argument above is unchanged. The batch read ahead is the one a read after
 * the removal would return, but for a staple staged in between: one whose
 * earliest vote is not after the end of the batch read ahead has it read
 * again, and one after it comes in a later batch, as it would have. A frontier
 * that moved in between cuts the batch at the frontier. So the node adds the
 * staples in the order it would without reading ahead.
 *
 * Liveness. The earliest range is read whatever else is, and never waits on
 * the stage, so the frontier moves on while its peer answers; everything
 * staged before the frontier is added unless the retry queue is full when
 * the ledger refuses one, in which case the node waits on its retries, as a
 * pass that met a full queue did. Staples left before the frontier make the
 * update incomplete, and the next begins at once.
 */
export class Staging<Staple extends PassStaple> {
	readonly #stage: BootstrapStage;
	readonly #retries: RetryQueue<Staple>;
	readonly #ledger: StagedLedger<Staple>;
	readonly #bound: number;
	readonly #changes = new Changes();
	#counts: Promise<StagedCounts> | undefined;
	/** The batch after the one being added, read while it is added. */
	#ahead: Promise<StagedStaple[]> | undefined;
	/** The earliest first vote of a staple staged since the batch ahead was read. */
	#stagedSinceAhead = Number.POSITIVE_INFINITY;
	/** The staples added or queued whose removal from the stage has not finished, which a read leaves out. */
	readonly #leaving = new Set<string>();
	/** The removal of the last batch added, which runs while the next is added. */
	#removal: Promise<void> = Promise.resolve();

	constructor(stage: BootstrapStage, retries: RetryQueue<Staple>, ledger: StagedLedger<Staple>, bound: number = STAGE_AHEAD_BYTES) {
		this.#stage = stage;
		this.#retries = retries;
		this.#ledger = ledger;
		this.#bound = bound;
	}

	/** What the stage holds, read from it once and then kept as the stage changes; read again after a failure. */
	counts(): Promise<StagedCounts> {
		return(this.#counts ?? this.#keep(this.#stage.counts()));
	}

	#keep(counts: Promise<StagedCounts>): Promise<StagedCounts> {
		this.#counts = counts;
		counts.catch(() => {
			if (this.#counts === counts) {
				this.#counts = undefined;
			}
		});
		return(counts);
	}

	/** Changes the counts kept after every change before it, whose own counts it reads. */
	#count(change: (counts: StagedCounts) => StagedCounts): void {
		void this.#keep(this.counts().then(change));
	}

	async isEmpty(): Promise<boolean> {
		return((await this.counts()).staples === 0);
	}

	/** Whether a pass over a range read ahead of the earliest may stage another staple. */
	async roomAhead(): Promise<boolean> {
		return((await this.counts()).bytes < this.#bound);
	}

	/** Tells the node adding that the frontier may have moved. */
	moved(): void {
		this.#changes.changed();
	}

	/** Stages the staple a pass was sent, unless the ledger, the queue or the stage holds it; refuses it from a range read ahead once the stage holds its bound. */
	async take(staple: Staple, use: QueueUse): Promise<Added> {
		if (await this.#ledger.holds(staple) || await this.#stage.holds(staple.blocksHash.toString())) {
			return('held');
		}
		if (await this.#retries.queues(staple)) {
			return('queued');
		}
		// Read before the stage changes, so that the counts kept never count the staple twice.
		const counts = await this.counts();
		if (use === 'ahead' && counts.bytes >= this.#bound) {
			throw(new StageFull(staple.blocksHash.toString(), this.#bound));
		}
		const staged = stagedOf(staple);
		const kept = await this.#stage.put([staged]);
		this.#count(function(counts): StagedCounts {
			return(plus(counts, kept));
		});
		// Noted once the put is done, so that a read issued after this either sees the staple or is told of it.
		this.#stagedSinceAhead = Math.min(this.#stagedSinceAhead, staged.firstVote.getTime());
		this.#changes.changed();
		return('added');
	}

	/** Up to so many staged staples with a vote made at or after the moment, for a filter to name. */
	async named(from: Date, count: number): Promise<NamedStaple[]> {
		if (count <= 0) {
			return([]);
		}
		return((await this.#stage.lastFrom(from, count)).map(namedOf));
	}

	/**
	 * Adds what is staged before the frontier as the work runs, and after it
	 * until nothing is left before the frontier or the moment given has
	 * passed; stopping ends it after the staple being added.
	 */
	async alongside<Result>(work: Promise<Result>, frontier: () => number, until: number, stopped: () => boolean): Promise<{ readonly result: Result; readonly applied: Applied }> {
		const ran: { done: boolean } = { done: false };
		const finished = work.finally(() => {
			ran.done = true;
			this.#changes.changed();
		});
		// The work's failure is the caller's to hear, through the await below, whenever adding ends.
		finished.catch(function(): void {
			// Heard below.
		});
		let left = 0;
		let full = false;
		try {
			while (!stopped()) {
				const changed = this.#changes.next();
				const round = await this.#addBefore(frontier(), stopped);
				left += round.left;
				full = round.full;
				const late = ran.done && Date.now() >= until;
				if (round.left > 0 && !full && !late) {
					continue;
				}
				if (ran.done && (full || late || round.left === 0)) {
					break;
				}
				await changed;
			}
		} catch (error: unknown) {
			await Promise.allSettled([finished, this.#settle()]);
			throw(error);
		}
		await this.#settle();
		const result = await finished;
		return({ result, applied: { left, backlog: full || await this.#backlog(frontier()) } });
	}

	async #backlog(frontier: number): Promise<boolean> {
		return((await this.#stage.firstBefore(new Date(frontier), 1)).length > 0);
	}

	/** Drops what was read ahead, and waits for the last removal, whose failure it throws. */
	async #settle(): Promise<void> {
		this.#ahead = undefined;
		await this.#removal;
	}

	/**
	 * The batch read ahead while the one before it was added, as far as it
	 * lies before the frontier: it is what a read now would return, unless a
	 * staple staged since sorts before its end, when the batch is read again.
	 */
	async #nextBatch(frontier: number): Promise<StagedStaple[]> {
		const ahead = this.#ahead;
		this.#ahead = undefined;
		if (ahead !== undefined) {
			const batch = await ahead;
			const last = batch.at(-1);
			if (last !== undefined && this.#stagedSinceAhead > last.firstVote.getTime()) {
				return(batch.filter(function(staged): boolean {
					return(staged.firstVote.getTime() < frontier);
				}));
			}
		}
		return(await this.#stage.firstBefore(new Date(frontier), APPLY_BATCH, [...this.#leaving]));
	}

	/** Reads the batch after a full one while it is added, leaving it out with every staple still leaving. */
	#readAhead(frontier: number, batch: readonly StagedStaple[]): Promise<StagedStaple[]> | undefined {
		if (batch.length < APPLY_BATCH) {
			return(undefined);
		}
		this.#stagedSinceAhead = Number.POSITIVE_INFINITY;
		const ahead = this.#stage.firstBefore(new Date(frontier), APPLY_BATCH, [...this.#leaving, ...batch.map(function(staged): string {
			return(staged.key);
		})]);
		// Its failure is heard when it is taken, or not at all once it is dropped.
		ahead.catch(ignoreFailure);
		return(ahead);
	}

	/**
	 * Removes the staples of a batch that left while the next batch is added,
	 * once the removal before it has finished, whose failure it throws.
	 */
	async #leave(settled: readonly string[]): Promise<void> {
		if (settled.length === 0) {
			await this.#removal;
			return;
		}
		// Read before the stage changes, so that the counts kept never count a staple twice.
		await this.counts();
		for (const key of settled) {
			this.#leaving.add(key);
		}
		const previous = this.#removal;
		this.#removal = this.#remove(settled);
		// Its failure is heard by the next batch's removal, or when adding ends.
		this.#removal.catch(ignoreFailure);
		await previous;
	}

	async #remove(keys: readonly string[]): Promise<void> {
		try {
			const dropped = await this.#stage.remove(keys);
			this.#count(function(counts): StagedCounts {
				return(minus(counts, dropped));
			});
		} finally {
			for (const key of keys) {
				this.#leaving.delete(key);
			}
		}
	}

	/** One batch of the staples staged before the frontier, in order, each added or queued; answers how many left the stage, and whether the queue had no room for one the ledger refused. */
	async #addBefore(frontier: number, stopped: () => boolean): Promise<{ readonly left: number; readonly full: boolean }> {
		const batch = await this.#nextBatch(frontier);
		const ahead = this.#readAhead(frontier, batch);
		const settled: string[] = [];
		let added = false;
		let full = false;
		for (const staged of batch) {
			if (stopped()) {
				break;
			}
			let outcome: Added;
			try {
				outcome = await this.#retries.add(this.#ledger.decode(staged.bytes), 'live');
			} catch (error: unknown) {
				if (!(error instanceof RetryQueueFull)) {
					throw(error);
				}
				full = true;
				break;
			}
			added ||= outcome === 'added';
			settled.push(staged.key);
		}
		// What was read ahead left out the whole batch, so it follows the batch only once the whole batch left.
		if (ahead !== undefined && settled.length === batch.length) {
			this.#ahead = ahead;
		}
		await this.#leave(settled);
		// The queue offers again what an added staple may let in; with no room left, what is due may make some.
		let retried = 0;
		if (added || full) {
			retried = await this.#retries.retry();
		}
		return({ left: settled.length, full: full && retried === 0 });
	}
}
