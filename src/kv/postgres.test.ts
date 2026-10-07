import { afterEach, describe, expect, inject, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BufferStorage } from '@keetanetwork/keetanet-client/lib/utils/buffer.js';
import pg from 'pg';
import { advanceClock, freezeClock } from '../testing/network.js';
import { createDatabase } from '../testing/postgres.js';
import type { TestDatabase } from '../testing/postgres.js';
import type { PostgresPoolSource } from '../ledger/storage/postgres/pool.js';
import { PostgresKVStorage } from './postgres.js';

const BufferStorageClass = KeetaNet.lib.Utils.Buffer.BufferStorage;

const START_MOMENT = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const TTL = 60000;

const freshDatabase = async function(template?: 'migrated'): Promise<TestDatabase> {
	let database: TestDatabase;
	if (template === 'migrated') {
		database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	} else {
		database = await createDatabase(inject('postgresCluster'));
	}
	onTestFinished(function() {
		return(database.drop());
	});
	return(database);
};

const storeOn = function(source: PostgresPoolSource): PostgresKVStorage {
	const store = new PostgresKVStorage(source);
	onTestFinished(function() {
		return(store.destroy());
	});
	return(store);
};

const ownedStoreOn = function(database: TestDatabase): PostgresKVStorage {
	return(storeOn({ kind: 'connection-string', connectionString: database.connectionString }));
};

const injectedStoreOn = function(pool: pg.Pool): PostgresKVStorage {
	return(storeOn({ kind: 'injected', pool: function() {
		return(Promise.resolve(pool));
	} }));
};

const rowCount = async function(pool: pg.Pool, table: 'kv_entries' | 'kv_buffers'): Promise<number> {
	const result = await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`);
	return(result.rows[0]?.count ?? -1);
};

describe('the Postgres key-value store', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('the first use migrates an empty database', async function() {
		const database = await freshDatabase();
		const store = ownedStoreOn(database);

		await store.set('stats', 'probe', 1);

		const versions = await database.pool().query<{ version: number }>('SELECT version FROM schema_version ORDER BY version');
		expect(versions.rows).toEqual([{ version: 1 }, { version: 2 }]);
		expect(await store.get('stats', 'probe')).toBe(1);
	});

	test('a ttl that names no moment a Date can hold is refused with KV_TTL_NOT_SUPPORTED, and nothing is stored', async function() {
		const database = await freshDatabase('migrated');
		const store = ownedStoreOn(database);

		for (const ttl of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e20]) {
			await expect(store.set('seenMessageIDs', 'message-1', 1, { ttl })).rejects.toEqual(expect.objectContaining({ code: 'KV_TTL_NOT_SUPPORTED' }));
		}
		expect(await store.list('seenMessageIDs')).toEqual([]);
	});

	test('a number JSON cannot hold is refused, in a value or as an increment', async function() {
		const database = await freshDatabase('migrated');
		const store = ownedStoreOn(database);

		await expect(store.set('stats', 'ratio', Number.NaN)).rejects.toThrow(TypeError);
		await expect(store.set('stats', 'nested', { values: [1, Number.POSITIVE_INFINITY] })).rejects.toThrow(TypeError);
		await expect(store.incr('stats', 'count', Number.NaN)).rejects.toThrow(TypeError);
		expect(await store.getAll('stats')).toEqual({});
	});

	test('a statement that fails rolls back and returns its connection to the pool', async function() {
		const database = await freshDatabase('migrated');
		const pool = new pg.Pool({ connectionString: database.connectionString, max: 1 });
		onTestFinished(function() {
			return(pool.end());
		});
		const store = injectedStoreOn(pool);
		await store.incr('stats', 'large', Number.MAX_VALUE);

		// A double cannot hold the sum, which Postgres refuses as out of range.
		await expect(store.incr('stats', 'large', Number.MAX_VALUE)).rejects.toThrow(pg.DatabaseError);

		expect(await store.get('stats', 'large')).toBe(Number.MAX_VALUE);
		expect(await store.incr('stats', 'other', 1)).toBe(1n);
	});

	test('a write that sets an expiry removes expired entries of its arena, a few at a time', async function() {
		freezeClock(START_MOMENT);
		const database = await freshDatabase('migrated');
		const store = ownedStoreOn(database);
		const pool = database.pool();
		for (const key of ['old-1', 'old-2', 'old-3', 'old-4', 'old-5']) {
			await store.set('seenMessageIDs', key, 1, { ttl: TTL });
		}
		await store.set('knownPeers', 'expiring', 1, { ttl: TTL });
		await store.set('seenMessageIDs', 'lasting', 1);
		advanceClock(TTL + 1);

		await store.set('seenMessageIDs', 'new-1', 1, { ttl: TTL });
		expect(await rowCount(pool, 'kv_entries')).toBe(6);

		await store.set('seenMessageIDs', 'new-2', 1, { ttl: TTL });
		await store.set('seenMessageIDs', 'new-3', 1, { ttl: TTL });
		expect(await rowCount(pool, 'kv_entries')).toBe(5);
		expect(await store.list('seenMessageIDs')).toEqual(['lasting', 'new-1', 'new-2', 'new-3']);
		expect(await store.list('knownPeers')).toEqual([]);
	});

	test('concurrent increments sum exactly even where the database defaults to SERIALIZABLE', async function() {
		const database = await freshDatabase('migrated');
		await database.pool().query(`ALTER DATABASE ${pg.escapeIdentifier(database.name)} SET default_transaction_isolation = 'serializable'`);
		await database.endPools();
		const first = ownedStoreOn(database);
		const second = ownedStoreOn(database);

		await Promise.all(Array.from({ length: 40 }, function(_ignored, index) {
			const store = [first, second][index % 2];
			if (store === undefined) {
				throw(new Error('two stores expected'));
			}
			return(Promise.all([store.incr('stats', 'requests', 1), store.xor(null, '@buffer:checksum', checksumByte(index))]));
		}));

		expect(await first.get('stats', 'requests')).toBe(40);
		expect(await second.get(null, '@buffer:checksum')).toBe(expectedChecksum(40));
	});

	test('destroy ends a pool the store opened and leaves an injected pool to its owner', async function() {
		const database = await freshDatabase('migrated');
		const injectedPool = database.pool();
		const owned = ownedStoreOn(database);
		const injected = injectedStoreOn(injectedPool);
		await owned.set('stats', 'probe', 1);
		await injected.set('stats', 'probe', 2);

		await owned.destroy();
		await injected.destroy();

		await expect(owned.get('stats', 'probe')).rejects.toThrow('destroyed');
		await expect(injected.get('stats', 'probe')).rejects.toThrow('destroyed');
		expect(injectedPool.ended).toBe(false);
		expect(await rowCount(injectedPool, 'kv_entries')).toBe(1);
	});
});

// A one-byte buffer whose bits fold to a known value.
function checksumByte(index: number): BufferStorage {
	return(new BufferStorageClass(BigInt(index), 1));
}

function expectedChecksum(count: number): string {
	let folded = 0;
	for (let index = 0; index < count; index++) {
		folded ^= index;
	}
	return(folded.toString(16).toUpperCase().padStart(2, '0'));
}
