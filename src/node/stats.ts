import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { Stats, StatsConfig } from '@keetanetwork/keetanet-client/lib/stats.js';
import type { BufferStorage } from '@keetanetwork/keetanet-client/lib/utils/buffer.js';
import { KVInternals } from '../upstream/internals.js';

const lib = KeetaNet.lib;

const ClientStats: typeof Stats = lib.Stats;

/** A ledger checksum and every other xor statistic is a hash's width [Keeta TS] index.js:75430. */
const XOR_BUFFER_SIZE = lib.Utils.Hash.HashFunctionLength;

function ignoreFailure(): void {
	// A sync that failed is reported to its own caller, not to those after it.
}

/**
 * The node's statistics, which survive a store that fails for a while.
 *
 * Upstream's sync keeps the promise of a sync that failed, and every later
 * sync, get and getXor awaits it first [Keeta TS] index.js:75545-75546,
 * 75579-75580, 75621-75644: one failed write, such as one made while
 * Postgres restarts, fails all of them until the process restarts, and the
 * changes that sync had taken are lost, the ledger checksum's among them.
 * Here each sync follows the one before it however that one ended, and a
 * change whose write failed is taken back, for the next sync to write. A
 * write that failed as it committed is then applied twice, where the store
 * cannot tell whether it committed: a counter is over-counted by that change,
 * and an xor statistic loses it, because xor-ing the same change twice
 * cancels it, which leaves the ledger checksum without that change.
 */
export class NodeStats extends ClientStats {
	readonly #kv: KVStorageProviderAPI;
	#syncing: Promise<void> | undefined;

	constructor(config: StatsConfig) {
		const kv = config.kv ?? new KVInternals.KVStorageProviderMemory();
		super({ kv });
		this.#kv = kv;
	}

	override async sync(): Promise<void> {
		const { incrChanges, xorChanges } = this.consume();
		const previous = this.#syncing;
		const syncing = (async (): Promise<void> => {
			await previous?.catch(ignoreFailure);
			const writes = await Promise.allSettled([
				...Object.entries(incrChanges).map(async ([key, change]): Promise<void> => {
					try {
						await this.#kv.incr('stats', key, change);
					} catch (error: unknown) {
						this.incrCompoundKey(key, change);
						throw(error);
					}
				}),
				...Object.entries(xorChanges).map(async ([key, change]): Promise<void> => {
					try {
						await this.#kv.xor(null, `@buffer:${key}`, new lib.Utils.Buffer.BufferStorage(change, XOR_BUFFER_SIZE));
					} catch (error: unknown) {
						this.xor(key, change);
						throw(error);
					}
				})
			]);
			// Every write has ended, and each failed one is back in the changes, before the first refusal is thrown.
			for (const write of writes) {
				if (write.status === 'rejected') {
					throw(write.reason);
				}
			}
		})();
		this.#syncing = syncing;
		try {
			await syncing;
		} finally {
			if (this.#syncing === syncing) {
				this.#syncing = undefined;
			}
		}
	}

	override async get(arena: string, key: string): Promise<number> {
		await this.#syncing?.catch(ignoreFailure);
		return(await super.get(arena, key));
	}

	override async getXor(key: string): Promise<BufferStorage> {
		await this.#syncing?.catch(ignoreFailure);
		return(await super.getXor(key));
	}
}
