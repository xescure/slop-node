import type { KVGenericOptionsType, KVSetOptionsType, KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { BufferStorage } from '@keetanetwork/keetanet-client/lib/utils/buffer.js';
import type { JSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { KVInternals } from '../upstream/internals.js';

function ignoreOutcome(): void {
	// Only that the operation has settled matters here; its caller hears how.
}

/**
 * The store a switch keeps its peers and the messages it has seen in, which
 * passes every operation to the node's store until the node stops.
 *
 * A broadcast returns once one peer has the message
 * [Keeta TS] index.js:73324, and its sends to the other peers carry on with
 * nothing to wait for them: a send that fails redials the peer
 * [Keeta TS] index.js:73211-73235, records it in the store
 * [Keeta TS] index.js:73633-73644, and sends again, recording the message
 * without waiting for that write [Keeta TS] index.js:73015-73017. Such work
 * can outlive the node, so once the node has stopped, the switch's
 * operations go to a store in memory that is then dropped, and the node's
 * store may be closed as soon as the operations it was already given have
 * settled.
 */
export class SwitchStore implements KVStorageProviderAPI {
	readonly #store: KVStorageProviderAPI;
	readonly #inFlight = new Set<Promise<void>>();
	#target: KVStorageProviderAPI;

	constructor(store: KVStorageProviderAPI) {
		this.#store = store;
		this.#target = store;
	}

	set(arena: string, key: string, value: JSONSerializable | undefined, options?: KVSetOptionsType): Promise<void> {
		return(this.#forward(function(target): Promise<void> {
			return(target.set(arena, key, value, options));
		}));
	}

	get(arena: string | null, key: string, options?: KVGenericOptionsType): Promise<JSONSerializable | undefined> {
		return(this.#forward(function(target): Promise<JSONSerializable | undefined> {
			return(target.get(arena, key, options));
		}));
	}

	getAll(arena: string, options?: KVGenericOptionsType): Promise<{ [key: string]: JSONSerializable }> {
		return(this.#forward(function(target): Promise<{ [key: string]: JSONSerializable }> {
			return(target.getAll(arena, options));
		}));
	}

	list(arena: string, options?: KVGenericOptionsType): Promise<string[]> {
		return(this.#forward(function(target): Promise<string[]> {
			return(target.list(arena, options));
		}));
	}

	incr(arena: string, key: string, change: number, options?: KVGenericOptionsType): Promise<bigint> {
		return(this.#forward(function(target): Promise<bigint> {
			return(target.incr(arena, key, change, options));
		}));
	}

	xor(arena: null, key: string, change: BufferStorage, options?: KVGenericOptionsType): Promise<void> {
		return(this.#forward(function(target): Promise<void> {
			return(target.xor(arena, key, change, options));
		}));
	}

	/** Passes operations to the node's store again, as the node runs. */
	attach(): void {
		this.#target = this.#store;
	}

	/**
	 * Sends every later operation to a store in memory of its own, and
	 * resolves once every operation already passed to the node's store has
	 * settled.
	 */
	async detach(): Promise<void> {
		this.#target = new KVInternals.KVStorageProviderMemory();
		while (this.#inFlight.size > 0) {
			await Promise.all(this.#inFlight);
		}
	}

	#forward<Result>(operation: (target: KVStorageProviderAPI) => Promise<Result>): Promise<Result> {
		const target = this.#target;
		const result = operation(target);
		if (target === this.#store) {
			const settled = result.then(ignoreOutcome, ignoreOutcome).finally(() => {
				this.#inFlight.delete(settled);
			});
			this.#inFlight.add(settled);
		}
		return(result);
	}
}
