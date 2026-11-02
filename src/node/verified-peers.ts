import type { KVGenericOptionsType, KVSetOptionsType, KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { BufferStorage } from '@keetanetwork/keetanet-client/lib/utils/buffer.js';
import type { JSONSerializable, JSONSerializableObject } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { manualPeerOf } from './config.js';

/** The arenas a peer's greeting is recorded in, by whether the node dialed it [Keeta TS] index.js:74734-74739. */
const GREETING_ARENAS = ['knownPeers', 'potentialPeers'] as const;

function isObject(value: JSONSerializable | undefined): value is JSONSerializableObject {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** The record, if it is a representative's advertisement signed by the key it is filed under. */
function signedBy(key: string, value: JSONSerializable | undefined): JSONSerializableObject | undefined {
	if (!isObject(value)) {
		return(undefined);
	}
	const peer = manualPeerOf(value);
	if (peer === undefined || peer.key.publicKeyString.get() !== key) {
		return(undefined);
	}
	return(value);
}

/**
 * The switch's store, which keeps a peer's signed advertisement where the
 * switch would replace it with an unsigned record.
 *
 * A manual peer given without a signature is dialed, greets back with its
 * advertisement signed by its own key, and the switch then records the
 * manual peer as it was given [Keeta TS] index.js:74796-74815, which it
 * never lists as known [Keeta TS] index.js:73742-73747, 72999-73003. The
 * greeting proves the record as a signature in the setting would, so it is
 * kept instead.
 */
export class VerifiedPeerStore implements KVStorageProviderAPI {
	readonly #store: KVStorageProviderAPI;

	constructor(store: KVStorageProviderAPI) {
		this.#store = store;
	}

	async set(arena: string, key: string, value: JSONSerializable | undefined, options?: KVSetOptionsType): Promise<void> {
		await this.#store.set(arena, key, await this.#recorded(arena, key, value), options);
	}

	/** The record to keep: the greeting signed by the peer's key, in place of a known peer's record without a signature. */
	async #recorded(arena: string, key: string, value: JSONSerializable | undefined): Promise<JSONSerializable | undefined> {
		if (arena !== 'knownPeers' || value === undefined || signedBy(key, value) !== undefined) {
			return(value);
		}
		for (const greetingArena of GREETING_ARENAS) {
			const greeting = signedBy(key, await this.#store.get(greetingArena, key));
			if (greeting !== undefined) {
				return(greeting);
			}
		}
		return(value);
	}

	get(arena: string | null, key: string, options?: KVGenericOptionsType): Promise<JSONSerializable | undefined> {
		return(this.#store.get(arena, key, options));
	}

	getAll(arena: string, options?: KVGenericOptionsType): Promise<{ [key: string]: JSONSerializable }> {
		return(this.#store.getAll(arena, options));
	}

	list(arena: string, options?: KVGenericOptionsType): Promise<string[]> {
		return(this.#store.list(arena, options));
	}

	incr(arena: string, key: string, change: number, options?: KVGenericOptionsType): Promise<bigint> {
		return(this.#store.incr(arena, key, change, options));
	}

	xor(arena: null, key: string, change: BufferStorage, options?: KVGenericOptionsType): Promise<void> {
		return(this.#store.xor(arena, key, change, options));
	}
}
