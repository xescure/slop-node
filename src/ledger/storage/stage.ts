/**
 * A staple a bootstrap read from a peer and keeps, as the bytes it came as,
 * until the node adds it in the order of its votes (src/node/bootstrap-stage.ts).
 */
export type StagedStaple = {
	/** The hash of its blocks, as `BlockHash.toString` spells it, which names it. */
	readonly key: string;
	readonly bytes: ArrayBuffer;
	/** When its earliest vote was made: where it falls in the order staples are added. */
	readonly firstVote: Date;
	/** When its latest vote was made: a peer keyed by votes lists it from any moment up to this one. */
	readonly lastVote: Date;
};

/** How many staples a stage holds, or a change to it moved, and their bytes. */
export type StagedCounts = {
	readonly staples: number;
	readonly bytes: number;
};

export const NO_STAGED: StagedCounts = { staples: 0, bytes: 0 };

/**
 * Where a node keeps the staples its bootstrap read but has not added yet,
 * durably where its ledger is durable (schema/CONTRACT.md, section 4.3).
 */
export type BootstrapStage = {
	/** Keeps the staples, but those it holds under the same key already, and answers what it kept. */
	put(staples: readonly StagedStaple[]): Promise<StagedCounts>;
	holds(key: string): Promise<boolean>;
	/** Up to so many staples whose first vote was made before the moment, but those of the keys left out, by their first votes, then their keys. */
	firstBefore(moment: Date, count: number, leftOut?: readonly string[]): Promise<StagedStaple[]>;
	/** Up to so many staples with a vote made at or after the moment, by their last votes, then their keys. */
	lastFrom(moment: Date, count: number): Promise<StagedStaple[]>;
	/** Drops the staples of these keys it holds, and answers what it dropped. */
	remove(keys: readonly string[]): Promise<StagedCounts>;
	counts(): Promise<StagedCounts>;
};

type Ordered = { readonly at: number; readonly key: string };

function compareOrdered(left: Ordered, right: Ordered): number {
	if (left.at !== right.at) {
		return(left.at - right.at);
	}
	if (left.key < right.key) {
		return(-1);
	}
	if (left.key > right.key) {
		return(1);
	}
	return(0);
}

/** Where the entry falls in the ordered list: the index of the first that is not before it. */
function placeOf(list: readonly Ordered[], entry: Ordered): number {
	let low = 0;
	let high = list.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		const at = list[middle];
		if (at !== undefined && compareOrdered(at, entry) < 0) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return(low);
}

function insertOrdered(list: Ordered[], entry: Ordered): void {
	list.splice(placeOf(list, entry), 0, entry);
}

function removeOrdered(list: Ordered[], entry: Ordered): void {
	const at = placeOf(list, entry);
	if (compareOrdered(list[at] ?? { at: Number.NaN, key: '' }, entry) === 0) {
		list.splice(at, 1);
	}
}

/** A stage in the process's memory, as the memory driver's ledger is. */
export class MemoryBootstrapStage implements BootstrapStage {
	readonly #staples = new Map<string, StagedStaple>();
	readonly #byFirst: Ordered[] = [];
	readonly #byLast: Ordered[] = [];
	#bytes = 0;

	put(staples: readonly StagedStaple[]): Promise<StagedCounts> {
		let kept = 0;
		let bytes = 0;
		for (const staple of staples) {
			if (this.#staples.has(staple.key)) {
				continue;
			}
			this.#staples.set(staple.key, staple);
			insertOrdered(this.#byFirst, { at: staple.firstVote.getTime(), key: staple.key });
			insertOrdered(this.#byLast, { at: staple.lastVote.getTime(), key: staple.key });
			kept++;
			bytes += staple.bytes.byteLength;
		}
		this.#bytes += bytes;
		return(Promise.resolve({ staples: kept, bytes }));
	}

	holds(key: string): Promise<boolean> {
		return(Promise.resolve(this.#staples.has(key)));
	}

	firstBefore(moment: Date, count: number, leftOut: readonly string[] = []): Promise<StagedStaple[]> {
		const skipped = new Set(leftOut);
		const found: StagedStaple[] = [];
		for (const { at, key } of this.#byFirst) {
			if (found.length >= count || at >= moment.getTime()) {
				break;
			}
			const staple = this.#staples.get(key);
			if (staple !== undefined && !skipped.has(key)) {
				found.push(staple);
			}
		}
		return(Promise.resolve(found));
	}

	lastFrom(moment: Date, count: number): Promise<StagedStaple[]> {
		const found: StagedStaple[] = [];
		for (let at = placeOf(this.#byLast, { at: moment.getTime(), key: '' }); at < this.#byLast.length && found.length < count; at++) {
			const staple = this.#staples.get(this.#byLast[at]?.key ?? '');
			if (staple !== undefined) {
				found.push(staple);
			}
		}
		return(Promise.resolve(found));
	}

	remove(keys: readonly string[]): Promise<StagedCounts> {
		let dropped = 0;
		let bytes = 0;
		for (const key of keys) {
			const staple = this.#staples.get(key);
			if (staple === undefined) {
				continue;
			}
			this.#staples.delete(key);
			removeOrdered(this.#byFirst, { at: staple.firstVote.getTime(), key });
			removeOrdered(this.#byLast, { at: staple.lastVote.getTime(), key });
			dropped++;
			bytes += staple.bytes.byteLength;
		}
		this.#bytes -= bytes;
		return(Promise.resolve({ staples: dropped, bytes }));
	}

	counts(): Promise<StagedCounts> {
		return(Promise.resolve({ staples: this.#staples.size, bytes: this.#bytes }));
	}
}
