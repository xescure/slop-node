import type { KVStorageProviderAPI } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import { inject } from 'vitest';
import { createDatabase } from '../../testing/postgres.js';
import type { TestDatabase } from '../../testing/postgres.js';
import { KVInternals } from '../../upstream/internals.js';
import { PostgresKVStorage } from '../postgres.js';
import type { KVProviderUnderTest } from './types.js';

type PostgresInstance = {
	readonly database: TestDatabase;
	readonly siblings: PostgresKVStorage[];
};

const postgresInstances = new WeakMap<KVStorageProviderAPI, PostgresInstance>();

const postgresInstanceOf = function(store: KVStorageProviderAPI): PostgresInstance {
	const instance = postgresInstances.get(store);
	if (instance === undefined) {
		throw(new Error('this store was not created by the postgres entry'));
	}
	return(instance);
};

const openPostgresStore = function(database: TestDatabase): PostgresKVStorage {
	return(new PostgresKVStorage({ kind: 'connection-string', connectionString: database.connectionString }));
};

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
				const instance = postgresInstanceOf(store);
				const sibling = openPostgresStore(instance.database);
				instance.siblings.push(sibling);
				return(Promise.resolve(sibling));
			}
		},
		// Each instance is a fresh database copied from the migrated template, dropped with it.
		create: async function(): Promise<KVStorageProviderAPI> {
			const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
			const store = openPostgresStore(database);
			postgresInstances.set(store, { database, siblings: [] });
			return(store);
		},
		destroy: async function(store: KVStorageProviderAPI): Promise<void> {
			const instance = postgresInstanceOf(store);
			postgresInstances.delete(store);
			for (const sibling of instance.siblings.splice(0)) {
				await sibling.destroy();
			}
			await store.destroy?.();
			await instance.database.drop();
		}
	}
];
