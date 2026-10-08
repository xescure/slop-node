import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { KVStorageProvider } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { DeepScan, PeerProgress } from './bootstrap-pass.js';
import type { QueuedStaple, RetryStore } from './bootstrap-retry.js';

const lib = KeetaNet.lib;

/**
 * The arena that holds, for each representative the node bootstraps from,
 * how far it has caught up on that representative and when it re-scans it.
 * Each representative orders its staples by moments of its own, so a moment
 * reached on one says nothing about another.
 */
export const BOOTSTRAP_CURSOR_ARENA = 'bootstrapCursors';

/** The arena that holds, under CAUGHT_UP_KEY, the horizon of the latest pass over any peer that completed (src/node/bootstrap-update.ts). */
export const BOOTSTRAP_CAUGHT_UP_ARENA = 'bootstrapCaughtUp';

const CAUGHT_UP_KEY = 'horizon';

/** The arena that holds the staples the ledger refused, by the hash of their blocks, until they apply (src/node/bootstrap-retry.ts). */
export const BOOTSTRAP_RETRY_ARENA = 'bootstrapRetries';

/** A peer's progress as stored: moments in milliseconds. */
type StoredProgress = {
	readonly reached: number;
	readonly caughtUp: boolean;
	readonly deepScanFrom: number;
	readonly nextDeepScan: number;
	readonly deepScan: { readonly reached: number; readonly horizon: number } | null;
};

function isWholeNumber(value: unknown): value is number {
	return(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** The deep re-scan under way as stored, nothing when none is, or false when the value is not one. */
function deepScanOf(value: unknown): DeepScan | undefined | false {
	if (value === null) {
		return(undefined);
	}
	if (!isRecord(value) || !isWholeNumber(value['reached']) || !isWholeNumber(value['horizon'])) {
		return(false);
	}
	return({ reached: new Date(value['reached']), horizon: new Date(value['horizon']) });
}

function progressOf(value: unknown): PeerProgress | undefined {
	if (!isRecord(value)) {
		return(undefined);
	}
	const { reached, caughtUp, deepScanFrom, nextDeepScan } = value;
	const deepScan = deepScanOf(value['deepScan']);
	if (!isWholeNumber(reached) || typeof caughtUp !== 'boolean' || !isWholeNumber(deepScanFrom) || !isWholeNumber(nextDeepScan) || deepScan === false) {
		return(undefined);
	}
	return({ reached: new Date(reached), caughtUp, deepScanFrom: new Date(deepScanFrom), nextDeepScan: new Date(nextDeepScan), deepScan });
}

function storedDeepScan(deepScan: DeepScan | undefined): StoredProgress['deepScan'] {
	if (deepScan === undefined) {
		return(null);
	}
	return({ reached: deepScan.reached.getTime(), horizon: deepScan.horizon.getTime() });
}

/** How far the node has caught up on each representative, keyed by its API endpoint. */
export class BootstrapCursors {
	readonly #kv: KVStorageProvider;

	constructor(kv: KVStorageProvider) {
		this.#kv = kv;
	}

	/** A value the node did not write, from another version or by hand, counts as none, so the peer is read from the beginning. */
	async read(endpoint: string): Promise<PeerProgress | undefined> {
		return(progressOf(await this.#kv.get(BOOTSTRAP_CURSOR_ARENA, endpoint)));
	}

	async write(endpoint: string, progress: PeerProgress): Promise<void> {
		const stored: StoredProgress = {
			reached: progress.reached.getTime(),
			caughtUp: progress.caughtUp,
			deepScanFrom: progress.deepScanFrom.getTime(),
			nextDeepScan: progress.nextDeepScan.getTime(),
			deepScan: storedDeepScan(progress.deepScan)
		};
		await this.#kv.set(BOOTSTRAP_CURSOR_ARENA, endpoint, stored);
	}

	/** The horizon of the latest pass over any peer that completed, or nothing while none has. */
	async readCaughtUp(): Promise<Date | undefined> {
		const stored = await this.#kv.get(BOOTSTRAP_CAUGHT_UP_ARENA, CAUGHT_UP_KEY);
		if (!isWholeNumber(stored)) {
			return(undefined);
		}
		return(new Date(stored));
	}

	async writeCaughtUp(horizon: Date): Promise<void> {
		await this.#kv.set(BOOTSTRAP_CAUGHT_UP_ARENA, CAUGHT_UP_KEY, horizon.getTime());
	}

	/** Forgets every peer's progress, and that any pass completed; the staples queued for retry stay, as nothing reads them again. */
	async clear(): Promise<void> {
		for (const endpoint of await this.#kv.list(BOOTSTRAP_CURSOR_ARENA)) {
			await this.#kv.set(BOOTSTRAP_CURSOR_ARENA, endpoint, undefined);
		}
		await this.#kv.set(BOOTSTRAP_CAUGHT_UP_ARENA, CAUGHT_UP_KEY, undefined);
	}
}

/** A queued staple as stored: its bytes in base64. */
type StoredQueued = {
	readonly staple: string;
	readonly queuedAt: number;
	readonly code: string;
	readonly reported: boolean;
};

/** The staple of a stored value, or nothing when the node did not write it. */
function queuedOf(value: unknown): QueuedStaple<VoteStaple> | undefined {
	if (!isRecord(value)) {
		return(undefined);
	}
	const { staple, queuedAt, code, reported } = value;
	if (typeof staple !== 'string' || !isWholeNumber(queuedAt) || typeof code !== 'string' || typeof reported !== 'boolean') {
		return(undefined);
	}
	try {
		return({ staple: new lib.Vote.Staple(staple), queuedAt, code, reported });
	} catch {
		return(undefined);
	}
}

/** The staples queued for retry, kept in the node's store so that a restart loses none. */
export class KVRetryStore implements RetryStore<VoteStaple> {
	readonly #kv: KVStorageProvider;

	constructor(kv: KVStorageProvider) {
		this.#kv = kv;
	}

	/** A value the node did not write counts as none, as a cursor's does. */
	async load(): Promise<QueuedStaple<VoteStaple>[]> {
		return(Object.values(await this.#kv.getAll(BOOTSTRAP_RETRY_ARENA)).flatMap(function(value): QueuedStaple<VoteStaple>[] {
			const queued = queuedOf(value);
			if (queued === undefined) {
				return([]);
			}
			return([queued]);
		}));
	}

	async put(key: string, entry: QueuedStaple<VoteStaple>): Promise<void> {
		const stored: StoredQueued = {
			staple: Buffer.from(entry.staple.toBytes()).toString('base64'),
			queuedAt: entry.queuedAt,
			code: entry.code,
			reported: entry.reported
		};
		await this.#kv.set(BOOTSTRAP_RETRY_ARENA, key, stored);
	}

	async remove(key: string): Promise<void> {
		await this.#kv.set(BOOTSTRAP_RETRY_ARENA, key, undefined);
	}
}
