import { describe, expect, test } from 'vitest';
import type { PeerProgress } from './bootstrap-pass.js';
import { updatePeers } from './bootstrap-update.js';
import type { PeerResult, UpdateIO } from './bootstrap-update.js';

const EPOCH = new Date(0);
const HORIZON = new Date(Date.UTC(2026, 9, 8, 12));

function progressAt(reached: Date, caughtUp = false): PeerProgress {
	return({ reached, caughtUp, deepScanFrom: EPOCH, nextDeepScan: new Date(HORIZON.getTime() + 3_600_000), deepScan: undefined });
}

/** What the node keeps of its peers, in memory, and the passes an update runs over them, which end as each peer's script says. */
class Harness implements UpdateIO {
	readonly progress = new Map<string, PeerProgress>();
	caughtUp: Date | undefined;
	/** Each pass run, in the order begun, with where it started a peer with no progress. */
	readonly runs: { readonly peer: string; readonly from: number }[] = [];
	readonly #script: ReadonlyMap<string, PeerResult>;

	constructor(script: Readonly<Record<string, PeerResult>>) {
		this.#script = new Map(Object.entries(script));
	}

	readProgress(peer: string): Promise<PeerProgress | undefined> {
		return(Promise.resolve(this.progress.get(peer)));
	}

	writeProgress(peer: string, progress: PeerProgress): Promise<void> {
		this.progress.set(peer, progress);
		return(Promise.resolve());
	}

	readCaughtUp(): Promise<Date | undefined> {
		return(Promise.resolve(this.caughtUp));
	}

	writeCaughtUp(horizon: Date): Promise<void> {
		this.caughtUp = horizon;
		return(Promise.resolve());
	}

	/** A pass that completes records its horizon as where the node reached, as bootstrapPeer does. */
	update(peers: readonly string[]): Promise<ReadonlyMap<string, PeerResult>> {
		return(updatePeers(peers, this, 4, (peer, from) => {
			this.runs.push({ peer, from: from.getTime() });
			const result = this.#script.get(peer) ?? 'failed';
			const current = this.progress.get(peer) ?? progressAt(from);
			if (result === 'completed') {
				this.progress.set(peer, { ...current, reached: HORIZON, caughtUp: true });
			} else {
				this.progress.set(peer, current);
			}
			return(Promise.resolve(result));
		}));
	}

	peersRun(): string[] {
		return(this.runs.map(function(run): string {
			return(run.peer);
		}));
	}
}

describe('an update over every peer', function() {
	test('reads one peer at a time until a pass completes, then the others from its horizon', async function() {
		const harness = new Harness({ rep1: 'completed', rep2: 'completed', rep3: 'completed' });

		const results = await harness.update(['rep1', 'rep2', 'rep3']);

		expect(harness.runs).toEqual([{ peer: 'rep1', from: 0 }, { peer: 'rep2', from: HORIZON.getTime() }, { peer: 'rep3', from: HORIZON.getTime() }]);
		expect([...results.values()]).toEqual(['completed', 'completed', 'completed']);
		expect(harness.caughtUp).toEqual(HORIZON);
	});

	test('ends the update when the one peer read reaches its bound, and continues on it the next update', async function() {
		const harness = new Harness({ rep1: 'bounded', rep2: 'completed' });

		expect([...(await harness.update(['rep1', 'rep2'])).entries()]).toEqual([['rep1', 'bounded']]);
		harness.progress.set('rep1', progressAt(new Date(1000)));
		await harness.update(['rep2', 'rep1']);

		expect(harness.peersRun()).toEqual(['rep1', 'rep1']);
		expect(harness.caughtUp).toBeUndefined();
	});

	test('reads first the peer the node has reached furthest on, as after a restart', async function() {
		const harness = new Harness({ rep1: 'bounded', rep2: 'bounded' });
		harness.progress.set('rep1', progressAt(new Date(1000)));
		harness.progress.set('rep2', progressAt(new Date(5000)));

		await harness.update(['rep1', 'rep2']);

		expect(harness.peersRun()).toEqual(['rep2']);
	});

	test('reads the next peer in place of one that fails, and leaves the one that failed to the next update', async function() {
		const harness = new Harness({ rep1: 'failed', rep2: 'completed', rep3: 'completed' });

		const results = await harness.update(['rep1', 'rep2', 'rep3']);

		expect(harness.peersRun()).toEqual(['rep1', 'rep2', 'rep3']);
		expect(results.get('rep1')).toBe('failed');
		expect(harness.progress.get('rep1')?.reached).toEqual(HORIZON);
		await harness.update(['rep1', 'rep2', 'rep3']);
		expect(harness.peersRun().slice(3).sort()).toEqual(['rep1', 'rep2', 'rep3']);
	});

	test('moves the peers the node reached less far on to the horizon of the first pass to complete, deep re-scans included', async function() {
		const harness = new Harness({ rep1: 'completed', rep2: 'bounded' });
		harness.progress.set('rep1', progressAt(new Date(9000)));
		harness.progress.set('rep2', progressAt(new Date(2000)));

		await harness.update(['rep1', 'rep2']);

		expect(harness.progress.get('rep2')).toMatchObject({ reached: HORIZON, deepScanFrom: HORIZON });
	});

	test('reads every peer once a pass has completed, a peer it has no progress on from the latest horizon', async function() {
		const harness = new Harness({ rep1: 'bounded', rep2: 'completed', rep3: 'completed' });
		const earlier = new Date(HORIZON.getTime() - 60_000);
		harness.caughtUp = earlier;
		harness.progress.set('rep1', progressAt(new Date(1000)));

		await harness.update(['rep1', 'rep2']);
		await harness.update(['rep1', 'rep2', 'rep3']);

		expect(harness.runs.filter(function(run): boolean {
			return(run.peer !== 'rep3');
		}).map(function(run): string {
			return(run.peer);
		})).toEqual(['rep1', 'rep2', 'rep1', 'rep2']);
		expect(harness.runs.find(function(run): boolean {
			return(run.peer === 'rep2');
		})?.from).toBe(earlier.getTime());
		expect(harness.runs.find(function(run): boolean {
			return(run.peer === 'rep3');
		})?.from).toBe(HORIZON.getTime());
		expect(harness.progress.get('rep1')?.reached).toEqual(new Date(1000));
	});
});
