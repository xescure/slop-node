import { eachAtMost } from '../util/concurrency.js';
import type { PeerProgress } from './bootstrap-pass.js';

/** How an update's passes over a peer ended. */
export type PeerResult =
	/** The pass from where the last reached completed: the node held or queued every staple the peer had applied before its horizon. */
	| 'completed'
	/** It reached its bound first, having moved on; the next update continues it. */
	| 'bounded'
	/** It failed, and the next update tries the peer again. */
	| 'failed';

/** What an update keeps of its peers. */
export type UpdateIO = {
	readProgress(peer: string): Promise<PeerProgress | undefined>;
	writeProgress(peer: string, progress: PeerProgress): Promise<void>;
	/** The horizon of the latest pass over any peer that completed, or nothing while none has. */
	readCaughtUp(): Promise<Date | undefined>;
	writeCaughtUp(horizon: Date): Promise<void>;
};

/** An update's passes over the peer, those over a peer the node has no progress on starting from the moment given. */
export type CatchUp = (peer: string, from: Date) => Promise<PeerResult>;

const EPOCH = new Date(0);

function later(left: Date, right: Date): Date {
	return(new Date(Math.max(left.getTime(), right.getTime())));
}

/** The peers the node has reached furthest on first, in the order given where it has reached as far, or nowhere. */
async function furthestFirst(peers: readonly string[], io: UpdateIO): Promise<string[]> {
	const reached = new Map<string, number>();
	for (const peer of peers) {
		reached.set(peer, (await io.readProgress(peer))?.reached.getTime() ?? -1);
	}
	return([...peers].sort(function(left, right): number {
		return((reached.get(right) ?? -1) - (reached.get(left) ?? -1));
	}));
}

/** Records that the pass over the peer completed, so that its horizon, where its progress now stands, is the latest one known. */
async function recordCompleted(peer: string, io: UpdateIO, known: Date | undefined): Promise<Date | undefined> {
	const horizon = (await io.readProgress(peer))?.reached;
	if (horizon === undefined || (known !== undefined && horizon.getTime() <= known.getTime())) {
		return(known);
	}
	await io.writeCaughtUp(horizon);
	return(horizon);
}

/** Moves every peer the node has reached less far on than the horizon on to it, deep re-scans included. */
async function moveOnTo(horizon: Date, peers: readonly string[], io: UpdateIO): Promise<void> {
	for (const peer of peers) {
		const progress = await io.readProgress(peer);
		if (progress !== undefined && progress.reached.getTime() < horizon.getTime()) {
			await io.writeProgress(peer, { ...progress, reached: horizon, deepScanFrom: later(progress.deepScanFrom, horizon) });
		}
	}
}

/**
 * An update's passes over every peer, and how each ended.
 *
 * Until a pass over some peer has completed, the node holds little, and
 * each peer would send it the same history, none of which a filter can name
 * yet. So it reads one peer at a time: the one it has reached furthest on,
 * or the first, until that one's pass either completes, or ends at its
 * bound, which ends the update, or fails, when the next is read in its
 * place. Once one completes, its horizon is where the node is known to
 * hold or have queued everything before: every representative applies the
 * same staples to its main ledger, and the passes over that peer read
 * whatever it applies from there on. The other peers then start from that
 * horizon, those the node had reached less far on included, so the history
 * is downloaded once. From then on every peer is read on every update, a
 * few at a time, from where the node reached on it, as before; one the node
 * has not read yet starts from the latest horizon a pass completed at.
 */
export async function updatePeers(peers: readonly string[], io: UpdateIO, concurrency: number, catchUp: CatchUp): Promise<ReadonlyMap<string, PeerResult>> {
	const results = new Map<string, PeerResult>();
	let caughtUp = await io.readCaughtUp();
	if (caughtUp === undefined) {
		for (const peer of await furthestFirst(peers, io)) {
			const result = await catchUp(peer, EPOCH);
			results.set(peer, result);
			if (result === 'completed') {
				caughtUp = await recordCompleted(peer, io, undefined);
				break;
			}
			if (result === 'bounded') {
				return(results);
			}
		}
		if (caughtUp === undefined) {
			return(results);
		}
		await moveOnTo(caughtUp, peers.filter(function(peer): boolean {
			return(results.get(peer) !== 'completed');
		}), io);
	}
	const from = caughtUp;
	const rest = peers.filter(function(peer): boolean {
		return(!results.has(peer));
	});
	const ended = await eachAtMost(rest, concurrency, async function(peer): Promise<[string, PeerResult]> {
		return([peer, await catchUp(peer, from)]);
	});
	for (const [peer, result] of ended) {
		results.set(peer, result);
		if (result === 'completed') {
			caughtUp = await recordCompleted(peer, io, caughtUp);
		}
	}
	return(results);
}
