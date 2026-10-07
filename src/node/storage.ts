import { PostgresKVStorage } from '../kv/postgres.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import { assertNever } from '../util/assert-never.js';
import type { NodeResources, StorageChoice } from './config.js';

/** The stores a storage choice opens. */
export type OpenedStorage =
	| { readonly kind: 'memory'; readonly ledger: MemoryLedgerStorage }
	| { readonly kind: 'postgres'; readonly ledger: PostgresLedgerStorage; readonly kv: PostgresKVStorage };

/** Opening connects lazily: Postgres is first reached, and migrated, by the first transaction. */
export function openStorage(choice: StorageChoice): OpenedStorage {
	switch (choice.kind) {
		case 'memory':
			return({ kind: 'memory', ledger: new MemoryLedgerStorage() });
		case 'postgres': {
			const source = { kind: 'connection-string', connectionString: choice.connectionString } as const;
			return({ kind: 'postgres', ledger: new PostgresLedgerStorage(source), kv: new PostgresKVStorage(source) });
		}
		default:
			return(assertNever(choice));
	}
}

export function nodeResourcesOf(storage: OpenedStorage, log: NodeResources['log']): NodeResources {
	switch (storage.kind) {
		case 'memory':
			return({ storageDriver: storage.ledger, kv: null, log });
		case 'postgres':
			return({ storageDriver: storage.ledger, kv: storage.kv, log });
		default:
			return(assertNever(storage));
	}
}

/** Ends the connections a Postgres choice opened; memory holds none. */
export async function closeStorage(storage: OpenedStorage): Promise<void> {
	switch (storage.kind) {
		case 'memory':
			return;
		case 'postgres':
			await Promise.all([storage.ledger.destroy(), storage.kv.destroy()]);
			return;
		default:
			assertNever(storage);
	}
}
