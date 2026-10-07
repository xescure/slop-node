import { inject } from 'vitest';
import { createDatabase } from './postgres.js';
import type { TestDatabase } from './postgres.js';

/** A store the suites open on a test database: a ledger driver or a key-value store. */
export type PostgresStore = {
	destroy(): Promise<void>;
};

type Instance<Store> = {
	readonly store: Store;
	readonly database: TestDatabase;
	readonly siblings: Store[];
};

/**
 * The stores a suite opens, each on a fresh database copied from the migrated
 * template, with the siblings opened beside them on the same database. A
 * store is released with its siblings, and its database dropped after them.
 */
export class PostgresInstances<Store extends PostgresStore> {
	readonly #open: (database: TestDatabase) => Store;
	// Keyed by any reference to the store, as the suites hold it by a wider type.
	readonly #instances = new WeakMap<object, Instance<Store>>();

	constructor(open: (database: TestDatabase) => Store) {
		this.#open = open;
	}

	async create(): Promise<Store> {
		const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
		const store = this.#open(database);
		this.#instances.set(store, { store, database, siblings: [] });
		return(store);
	}

	/** Another store on the same database, with connections of its own: another process of the same node. */
	openSibling(store: object): Store {
		const instance = this.#instanceOf(store);
		const sibling = this.#open(instance.database);
		instance.siblings.push(sibling);
		return(sibling);
	}

	async destroy(store: object): Promise<void> {
		const instance = this.#instanceOf(store);
		this.#instances.delete(store);
		for (const sibling of instance.siblings.splice(0)) {
			await sibling.destroy();
		}
		await instance.store.destroy();
		await instance.database.drop();
	}

	#instanceOf(store: object): Instance<Store> {
		const instance = this.#instances.get(store);
		if (instance === undefined) {
			throw(new Error('this store was not created by these instances'));
		}
		return(instance);
	}
}
