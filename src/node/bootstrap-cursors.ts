import type { KVStorageProvider } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { PeerProgress } from './bootstrap-pass.js';

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
	readonly deepScanFrom: number;
	readonly completions: number;
	readonly deepScanning: boolean;
};

function isWholeNumber(value: unknown): value is number {
	return(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

function progressOf(value: unknown): PeerProgress | undefined {
	if (!isRecord(value)) {
		return(undefined);
	}
	const { reached, deepScanFrom, completions, deepScanning } = value;
	if (!isWholeNumber(reached) || !isWholeNumber(deepScanFrom) || !isWholeNumber(completions) || typeof deepScanning !== 'boolean') {
		return(undefined);
	}
	return({ reached: new Date(reached), deepScanFrom: new Date(deepScanFrom), completions, deepScanning });
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
			deepScanFrom: progress.deepScanFrom.getTime(),
			completions: progress.completions,
			deepScanning: progress.deepScanning
		};
		await this.#kv.set(BOOTSTRAP_CURSOR_ARENA, endpoint, stored);
	}

	async clear(): Promise<void> {
		for (const endpoint of await this.#kv.list(BOOTSTRAP_CURSOR_ARENA)) {
			await this.#kv.set(BOOTSTRAP_CURSOR_ARENA, endpoint, undefined);
		}
	}
}
