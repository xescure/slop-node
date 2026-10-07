import type { KVStorageProvider } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { DeepScan, PeerProgress } from './bootstrap-pass.js';

/**
 * The arena that holds, for each representative the node bootstraps from,
 * how far it has caught up on that representative and when it re-scans it.
 * Each representative orders its staples by moments of its own, so a moment
 * reached on one says nothing about another.
 */
export const BOOTSTRAP_CURSOR_ARENA = 'bootstrapCursors';

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

	async clear(): Promise<void> {
		for (const endpoint of await this.#kv.list(BOOTSTRAP_CURSOR_ARENA)) {
			await this.#kv.set(BOOTSTRAP_CURSOR_ARENA, endpoint, undefined);
		}
	}
}
