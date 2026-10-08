import { vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Node, NodeConfig } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { freezeClock } from '../../testing/network.js';
import { MAINNET_NETWORK, mainnetLedgerSettings, mainnetReplayRepresentative, mainnetTrustedRoot } from './fixture.js';

const lib = KeetaNet.lib;

export type ReplayOptions = {
	/**
	 * Runs with the clock already frozen at the staple's timestamp, just before
	 * the staple is added, with the ledger that adds it.
	 */
	readonly beforeAdd?: (staple: VoteStaple, ledger: Ledger) => Promise<void>;
};

export type ReplayResult = {
	readonly ledger: Ledger;
	/** The staples of the input that are on the main ledger once deferral is drained. */
	readonly applied: number;
	/** The staples of the input that are on the main ledger, in replay order. */
	readonly appliedStaples: readonly VoteStaple[];
	/** The staples of the input that are not on the main ledger, in replay order. */
	readonly deferred: readonly VoteStaple[];
	/** What the node's statistics hold under ledgerChecksum: the XOR of the hash of every block applied. */
	readonly ledgerChecksum: bigint;
};

export function compareText(left: string, right: string): number {
	if (left < right) {
		return(-1);
	}
	if (left > right) {
		return(1);
	}
	return(0);
}

export type Orderable = {
	timestamp(): Date;
	readonly blocksHash: { toString(): string };
};

/** Oldest first; staples with the same timestamp are ordered by their blocks hash, so the order never depends on the file's. */
export function replayOrder<Staple extends Orderable>(staples: readonly Staple[]): Staple[] {
	return([...staples].sort(function(left, right): number {
		const byTimestamp = left.timestamp().valueOf() - right.timestamp().valueOf();
		if (byTimestamp !== 0) {
			return(byTimestamp);
		}
		return(compareText(left.blocksHash.toString(), right.blocksHash.toString()));
	}));
}

/** A representative of the mainnet holding the replay key, its ledger on the storage. */
export function mainnetNodeConfig(storage: LedgerStorageAPI): NodeConfig {
	return({
		kind: lib.Node.Kind.REPRESENTATIVE,
		// A log without targets discards everything.
		log: new lib.Log(),
		initialTrustedAccount: mainnetTrustedRoot(),
		ledgerPrivateKey: mainnetReplayRepresentative(),
		network: MAINNET_NETWORK,
		networkAlias: 'main',
		ledger: mainnetLedgerSettings(storage),
		stats: { kv: null }
	});
}

/*
 * The ledger belongs to a node so that the checksum its adds and gc passes
 * fold is recorded: a bare ledger discards those statistics.
 * [Keeta TS] index.js:69001-69006
 */
function createReplayNode(storage: LedgerStorageAPI): Node {
	return(new lib.Node(mainnetNodeConfig(storage)));
}

/** gc reports whether more work remains once its time budget is spent. */
async function drainDeferral(ledger: Ledger): Promise<void> {
	while (await ledger.gc()) {
		// Each pass retries the staples that the earlier passes released.
	}
}

async function appliedAmong(ledger: Ledger, staples: readonly VoteStaple[]): Promise<ReadonlySet<VoteStaple>> {
	const stored = await ledger.getVoteStaples(staples.map(function(staple) {
		return(staple.blocksHash);
	}), 'main');
	return(new Set(staples.filter(function(staple): boolean {
		return(stored.get(staple.blocksHash) !== null);
	})));
}

/**
 * Hands each staple to add, oldest first, with the clock frozen at the
 * staple's timestamp, and then runs gc until nothing remains to retry.
 */
export async function addInReplayOrder(ledger: Ledger, staples: readonly VoteStaple[], add: (staple: VoteStaple) => Promise<void>): Promise<void> {
	try {
		for (const staple of replayOrder(staples)) {
			freezeClock(staple.timestamp());
			await add(staple);
		}
		await drainDeferral(ledger);
	} finally {
		vi.useRealTimers();
	}
}

/**
 * Adds every staple to the node's ledger as replayMainnet does, without
 * stopping the node, so that it can go on to serve the replayed ledger.
 */
export async function replayOn(node: Node, staples: readonly VoteStaple[], options: ReplayOptions = {}): Promise<ReplayResult> {
	const { ledger } = node;
	await addInReplayOrder(ledger, staples, async function(staple) {
		await options.beforeAdd?.(staple, ledger);
		await ledger.add(staple);
	});
	const ordered = replayOrder(staples);
	const applied = await appliedAmong(ledger, staples);
	return({
		ledger,
		applied: applied.size,
		appliedStaples: ordered.filter(function(staple): boolean {
			return(applied.has(staple));
		}),
		deferred: ordered.filter(function(staple): boolean {
			return(!applied.has(staple));
		}),
		ledgerChecksum: (await node.stats.getXor('ledgerChecksum')).toBigInt()
	});
}

/**
 * Adds every staple to a fresh representative ledger on the storage, oldest
 * first, with the clock frozen at each staple's timestamp, and then runs gc
 * until nothing remains to retry. A staple that the ledger refuses fails the
 * replay; one that is deferred is reported if gc could not apply it.
 * [Keeta TS] index.js:67852-67863
 */
export async function replayMainnet(storage: LedgerStorageAPI, staples: readonly VoteStaple[], options: ReplayOptions = {}): Promise<ReplayResult> {
	const node = createReplayNode(storage);
	try {
		return(await replayOn(node, staples, options));
	} finally {
		/*
		 * Stopping flushes the node's statistics and closes its switch, which
		 * never had a peer. The ledger stays readable: it never uses the
		 * switch, and later transactions still merge their statistics into
		 * the node.
		 * [Keeta TS] index.js:71373-71383
		 */
		await node.stop();
	}
}
