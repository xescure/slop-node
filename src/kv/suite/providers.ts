import type { KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import { PostgresInstances } from '../../testing/postgres-instances.js';
import { KVInternals } from '../../upstream/internals.js';
import { PostgresKVStorage } from '../postgres.js';
import type { KVProviderUnderTest } from './types.js';

const postgresInstances = new PostgresInstances(function(database): PostgresKVStorage {
	return(new PostgresKVStorage({ kind: 'connection-string', connectionString: database.connectionString }));
});

/** Every key-value store the shared suite runs against; upstream's memory store is the reference. */
export const providersUnderTest: readonly KVProviderUnderTest[] = [
	{
		name: 'upstream memory',
		expiredEntries: 'forgotten-on-read',
		existingKeyRefusal: { message: 'unable to exclusively create this item, already exists' },
		sharing: { kind: 'process-local' },
		create: function(): Promise<KVStorageProviderAPI> {
			return(Promise.resolve(new KVInternals.KVStorageProviderMemory()));
		},
		destroy: function(): Promise<void> {
			return(Promise.resolve());
		}
	},
	{
		name: 'postgres',
		expiredEntries: 'absent',
		existingKeyRefusal: { code: 'KV_KEY_ALREADY_EXISTS' },
		sharing: {
			kind: 'shared',
			openSibling: function(store: KVStorageProviderAPI): Promise<KVStorageProviderAPI> {
				return(Promise.resolve(postgresInstances.openSibling(store)));
			}
		},
		create: function(): Promise<KVStorageProviderAPI> {
			return(postgresInstances.create());
		},
		destroy: function(store: KVStorageProviderAPI): Promise<void> {
			return(postgresInstances.destroy(store));
		}
	}
];
