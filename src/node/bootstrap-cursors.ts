import type { KVStorageProvider } from '@keetanetwork/keetanet-client/lib/kv/index.js';

/**
 * The arena that holds, for each representative the node bootstraps from,
 * the moment it has caught up to on that representative, in milliseconds.
 * Each representative orders its staples by moments of its own, so a moment
 * reached on one says nothing about another.
 */
export const BOOTSTRAP_CURSOR_ARENA = 'bootstrapCursors';

/** Where the node has caught up to on each representative, keyed by its API endpoint. */
export class BootstrapCursors {
	readonly #kv: KVStorageProvider;

	constructor(kv: KVStorageProvider) {
		this.#kv = kv;
	}

	/** A value the node did not write, from another version or by hand, counts as no cursor, so the peer is read from the beginning. */
	async read(endpoint: string): Promise<Date | undefined> {
		const value = await this.#kv.get(BOOTSTRAP_CURSOR_ARENA, endpoint);
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
			return(undefined);
		}
		return(new Date(value));
	}

	async write(endpoint: string, reached: Date): Promise<void> {
		await this.#kv.set(BOOTSTRAP_CURSOR_ARENA, endpoint, reached.getTime());
	}

	async clear(): Promise<void> {
		for (const endpoint of await this.#kv.list(BOOTSTRAP_CURSOR_ARENA)) {
			await this.#kv.set(BOOTSTRAP_CURSOR_ARENA, endpoint, undefined);
		}
	}
}
