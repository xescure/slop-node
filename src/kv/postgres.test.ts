import { afterEach, describe, expect, inject, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BufferStorage } from '@keetanetwork/keetanet-client/lib/utils/buffer.js';
import pg from 'pg';
import { advanceClock, freezeClock } from '../testing/network.js';
import { assertNever } from '../util/assert-never.js';
import { createDatabase } from '../testing/postgres.js';
import { interceptQueries, serverError } from '../testing/query-faults.js';
import type { TestDatabase } from '../testing/postgres.js';
import { POOL_CHECKOUT_TIMEOUT_MESSAGE } from '../ledger/storage/postgres/errors.js';
import type { PostgresPoolSource } from '../ledger/storage/postgres/pool.js';
import { DEFAULT_KV_RETRY_POLICY, PostgresKVStorage } from './postgres.js';
import type { KVRetryPolicy } from './postgres.js';

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

const storeOn = function(source: PostgresPoolSource, retry?: KVRetryPolicy): PostgresKVStorage {
	const store = new PostgresKVStorage(source, retry);
	onTestFinished(function() {
		return(store.destroy());
	});
	return(store);
};

const ownedStoreOn = function(database: TestDatabase): PostgresKVStorage {
	return(storeOn({ kind: 'connection-string', connectionString: database.connectionString }));
};

const injectedStoreOn = function(pool: pg.Pool, retry?: KVRetryPolicy): PostgresKVStorage {
	return(storeOn({ kind: 'injected', pool: function() {
		return(Promise.resolve(pool));
	} }, retry));
};

const rowCount = async function(pool: pg.Pool, table: 'kv_entries' | 'kv_buffers'): Promise<number> {
	const result = await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`);
	return(result.rows[0]?.count ?? -1);
};

/** Sessions of this database waiting for a lock another transaction holds. */
const lockWaiters = async function(pool: pg.Pool): Promise<number> {
	const result = await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = \'Lock\'');
	return(result.rows[0]?.count ?? -1);
};

/** Runs the action, once, after the named statement first completes on a connection of the pool. */
const afterStatement = function(pool: pg.Pool, name: string, action: () => Promise<void>): void {
	const wrapped = new WeakSet<pg.PoolClient>();
	let pending = true;
	pool.on('acquire', function(client) {
		if (wrapped.has(client)) {
			return;
		}
		wrapped.add(client);
		const query: unknown = Reflect.get(client, 'query');
		if (typeof query !== 'function') {
			throw(new Error('the client has no query method'));
		}
		Reflect.set(client, 'query', async function(...input: unknown[]): Promise<unknown> {
			const result: unknown = await Reflect.apply(query, client, input);
			const [config] = input;
			if (pending && typeof config === 'object' && config !== null && Reflect.get(config, 'name') === name) {
				pending = false;
				await action();
			}
			return(result);
		});
	});
};

/** A policy of the default's attempts that does not wait, recording after which attempts it was asked to. */
const immediateRetries = function(): { readonly policy: KVRetryPolicy; readonly waitedAfter: number[] } {
	const waitedAfter: number[] = [];
	return({
		policy: {
			attempts: DEFAULT_KV_RETRY_POLICY.attempts,
			backoffMilliseconds: function(failedAttempt: number): number {
				waitedAfter.push(failedAttempt);
				return(0);
			}
		},
		waitedAfter
	});
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
		expect(versions.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
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
		const pool = database.pool({ max: 1 });
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

	test('a write with an expiry waiting for a key holds no lock another transaction waits for', async function() {
		freezeClock(START_MOMENT);
		const database = await freshDatabase('migrated');
		const store = ownedStoreOn(database);
		const pool = database.pool();
		await store.set('seenMessageIDs', 'expired', 1, { ttl: TTL });
		await store.set('seenMessageIDs', 'held', 1);
		advanceClock(TTL + 1);
		const holder = await pool.connect();
		onTestFinished(function() {
			holder.release(true);
		});
		// Detection runs as soon as the holder waits, so a deadlock fails the holder at once.
		await holder.query('SET deadlock_timeout = 1');
		await holder.query('BEGIN');
		await holder.query('UPDATE kv_entries SET value = \'2\' WHERE arena = \'seenMessageIDs\' AND key = \'held\'');

		const writing = store.set('seenMessageIDs', 'held', 3, { ttl: TTL });
		await expect.poll(function() {
			return(lockWaiters(pool));
		}).toBe(1);
		await holder.query('DELETE FROM kv_entries WHERE arena = \'seenMessageIDs\' AND key = \'expired\'');
		await holder.query('COMMIT');
		await writing;

		expect(await store.get('seenMessageIDs', 'held')).toBe(3);
	});

	test('an exclusive create of null never removes an entry created after its check', async function() {
		const database = await freshDatabase('migrated');
		const pool = database.pool();
		const store = injectedStoreOn(pool);
		const rival = database.pool();
		await store.list('seenMessageIDs');
		// Another process creates the key as soon as the store has found it absent.
		afterStatement(pool, 'kv_live_entry_count', async function() {
			await rival.query('INSERT INTO kv_entries (arena, key, value) VALUES (\'seenMessageIDs\', \'message-1\', \'1\')');
		});

		await store.set('seenMessageIDs', 'message-1', null, { exclusiveCreate: true });

		expect(await store.get('seenMessageIDs', 'message-1')).toBe(1);
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

describe('the Postgres key-value store after a transient failure', function() {
	test.each([
		['a serialization failure', '40001'],
		['a deadlock', '40P01']
	])('attempts a write again after %s, once', async function(_name, code) {
		const database = await freshDatabase('migrated');
		const pool = database.pool();
		const { policy, waitedAfter } = immediateRetries();
		const store = injectedStoreOn(pool, policy);
		let puts = 0;
		interceptQueries(pool, function(issued, run) {
			if (issued.name === 'kv_put_entry' && ++puts === 1) {
				return(Promise.reject(serverError(code, 'the transaction was aborted')));
			}
			return(run());
		});

		await store.set('manualPeerCheckIn', 'peer', 1);

		expect(await store.get('manualPeerCheckIn', 'peer')).toBe(1);
		expect(puts).toBe(2);
		expect(waitedAfter).toEqual([1]);
	});

	test('attempts a write again after the server ends its session before COMMIT', async function() {
		const database = await freshDatabase('migrated');
		const pool = database.pool();
		const { policy, waitedAfter } = immediateRetries();
		const store = injectedStoreOn(pool, policy);
		await store.set('lastSeenPeers', 'peer', '1');
		const holder = await pool.connect();
		onTestFinished(function() {
			holder.release(true);
		});
		await holder.query('BEGIN');
		await holder.query('UPDATE kv_entries SET value = \'"2"\' WHERE arena = \'lastSeenPeers\' AND key = \'peer\'');

		const writing = store.set('lastSeenPeers', 'peer', '3');
		await expect.poll(function() {
			return(lockWaiters(pool));
		}).toBe(1);
		await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = \'Lock\'');
		await holder.query('COMMIT');
		await writing;

		expect(await store.get('lastSeenPeers', 'peer')).toBe('3');
		expect(waitedAfter).toEqual([1]);
	});

	test('attempts an operation again when no connection could be checked out in time', async function() {
		const database = await freshDatabase('migrated');
		const pool = database.pool();
		const { policy, waitedAfter } = immediateRetries();
		const store = injectedStoreOn(pool, policy);
		vi.spyOn(pool, 'connect').mockRejectedValueOnce(new Error(POOL_CHECKOUT_TIMEOUT_MESSAGE));

		expect(await store.incr('stats', 'requests', 1)).toBe(1n);
		expect(waitedAfter).toEqual([1]);
	});

	test('gives up after the policy\'s attempts, with the last failure', async function() {
		const database = await freshDatabase('migrated');
		const pool = database.pool();
		const { policy, waitedAfter } = immediateRetries();
		const store = injectedStoreOn(pool, policy);
		let attempts = 0;
		interceptQueries(pool, function(issued, run) {
			if (issued.name === 'kv_put_entry') {
				attempts++;
				return(Promise.reject(serverError('40001', `attempt ${String(attempts)} was aborted`)));
			}
			return(run());
		});

		await expect(store.set('manualPeerCheckIn', 'peer', 1)).rejects.toThrow('attempt 3 was aborted');

		expect(attempts).toBe(DEFAULT_KV_RETRY_POLICY.attempts);
		expect(waitedAfter).toEqual([1, 2]);
		expect(await store.get('manualPeerCheckIn', 'peer')).toBeUndefined();
	});

	test('does not attempt again a failure that would only repeat', async function() {
		const database = await freshDatabase('migrated');
		const pool = database.pool();
		const { policy, waitedAfter } = immediateRetries();
		const store = injectedStoreOn(pool, policy);
		await store.incr('stats', 'large', Number.MAX_VALUE);

		await expect(store.incr('stats', 'large', Number.MAX_VALUE)).rejects.toThrow(pg.DatabaseError);
		await expect(store.set('stats', 'large', 1, { exclusiveCreate: true })).rejects.toEqual(expect.objectContaining({ code: 'KV_KEY_ALREADY_EXISTS' }));

		expect(waitedAfter).toEqual([]);
	});

	test('attempts again a COMMIT the server aborted, but not one whose connection was lost, which may have committed', async function() {
		const database = await freshDatabase('migrated');
		const pool = database.pool();
		const { policy, waitedAfter } = immediateRetries();
		const store = injectedStoreOn(pool, policy);
		let failure: 'aborted' | 'lost' | undefined = 'aborted';
		interceptQueries(pool, async function(issued, run) {
			if (issued.text !== 'COMMIT' || failure === undefined) {
				return(await run());
			}
			const failing = failure;
			failure = undefined;
			switch (failing) {
				case 'aborted':
					// The store closes a connection whose COMMIT failed, which rolls its transaction back.
					throw(serverError('40001', 'could not serialize access'));
				case 'lost':
					await run();
					throw(serverError('57P01', 'terminating connection due to administrator command'));
				default:
					return(assertNever(failing));
			}
		});

		expect(await store.incr('stats', 'requests', 1)).toBe(1n);
		expect(waitedAfter).toEqual([1]);

		failure = 'lost';
		await expect(store.incr('stats', 'requests', 1)).rejects.toThrow('terminating connection');
		expect(waitedAfter).toEqual([1]);
		expect(await store.get('stats', 'requests')).toBe(2);
	});

	test('waits up to 100 ms after the first failed attempt and up to 200 ms after the second, each at least half of that', function() {
		const random = vi.spyOn(Math, 'random');
		random.mockReturnValue(0);
		expect([1, 2].map(DEFAULT_KV_RETRY_POLICY.backoffMilliseconds)).toEqual([50, 100]);
		random.mockReturnValue(1 - Number.EPSILON);
		const longest = [1, 2].map(DEFAULT_KV_RETRY_POLICY.backoffMilliseconds);
		expect(longest[0]).toBeLessThan(100);
		expect(longest[1]).toBeLessThan(200);
		expect(DEFAULT_KV_RETRY_POLICY.attempts).toBe(3);
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
