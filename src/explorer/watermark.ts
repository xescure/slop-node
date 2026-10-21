/** A position in the node's `public.staples` identity column. */
export type StapleSequence = bigint & { readonly __stapleSequence: never };

export type Watermark = {
	readonly through: StapleSequence;
	readonly missingSince: ReadonlyMap<StapleSequence, number>;
};

export const GAP_GRACE_MILLISECONDS = 60_000;

export function toStapleSequence(value: bigint): StapleSequence {
	if (value < 0n) {
		throw(new RangeError(`A staple sequence is not negative: ${value.toString()}`));
	}

	// The brand marks a value that passed the non-negative check above.
	return(value as StapleSequence);
}

/*
 * Sequences commit out of order and a rolled-back attempt leaves a gap for
 * good, so a missing sequence is waited for only until it has been missing
 * for the grace. Every gap in the walk is timed, not only the first, so later
 * gaps are already old when the first one is passed.
 */
export function advanceWatermark(current: Watermark, indexedAbove: readonly StapleSequence[], now: number, grace: number = GAP_GRACE_MILLISECONDS): Watermark {
	const last = indexedAbove.at(-1);
	if (last === undefined) {
		return(current);
	}

	const indexed = new Set<StapleSequence>(indexedAbove);
	const missingSince = new Map<StapleSequence, number>();
	let through = current.through;
	let passable = true;
	for (let sequence = current.through + 1n; sequence <= last; sequence++) {
		const key = toStapleSequence(sequence);
		if (indexed.has(key)) {
			if (passable) {
				through = key;
			}
			continue;
		}

		const since = current.missingSince.get(key) ?? now;
		missingSince.set(key, since);
		// A gap past its grace is passed by the next sequence indexed, which the walk always ends on.
		if (now - since < grace) {
			passable = false;
		}
	}

	for (const key of [...missingSince.keys()]) {
		if (key <= through) {
			missingSince.delete(key);
		}
	}

	return({ through, missingSince });
}
