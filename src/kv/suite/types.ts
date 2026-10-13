import type { KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';

/**
 * What a store does with an entry whose expiry has passed. Upstream's memory
 * store forgets such an entry only when get reads it; until then, list still
 * names it and an exclusive create still finds it
 * [Keeta TS] index.js:67914-67921, 67933-67950, 67963-67966. A database store
 * treats it as absent everywhere.
 */
export type ExpiredEntryHandling = 'forgotten-on-read' | 'absent';

/**
 * Whether other processes can open the store an instance keeps: a sibling on
 * the same database, with its own pool, stands for another process of the
 * same node.
 */
export type KVStoreSharing =
	| { readonly kind: 'process-local' }
	| { readonly kind: 'shared'; openSibling(store: KVStorageProviderAPI): Promise<KVStorageProviderAPI> };

/** What an exclusive create of a key that exists is refused with. */
export type ExistingKeyRefusal =
	| { readonly code: 'KV_KEY_ALREADY_EXISTS' }
	// Upstream's memory store raises a plain error [Keeta TS] index.js:67916-67920.
	| { readonly message: string };

/** One entry of the shared key-value suite. */
export type KVProviderUnderTest = {
	readonly name: string;
	readonly expiredEntries: ExpiredEntryHandling;
	readonly existingKeyRefusal: ExistingKeyRefusal;
	/** A sibling is released with the instance it was opened beside. */
	readonly sharing: KVStoreSharing;
	create(): Promise<KVStorageProviderAPI>;
	destroy(store: KVStorageProviderAPI): Promise<void>;
};
