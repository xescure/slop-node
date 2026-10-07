import { afterEach, describe, expect, inject, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type pg from 'pg';
import { sendBlock } from '../../../testing/blocks.js';
import { createTestNetwork, freezeClock } from '../../../testing/network.js';
import type { TestNetwork } from '../../../testing/network.js';
import { createDatabase } from '../../../testing/postgres.js';
import type { TestDatabase } from '../../../testing/postgres.js';
import { MemoryLedgerStorage } from '../memory/driver.js';
import { DEFAULT_WEIGHTS, GENESIS_MOMENT, headOf, requireAt } from '../suite/support.js';
import type { TransactionOptions } from '../base.js';
import { PostgresLedgerStorage } from './driver.js';
import type { PostgresTransaction } from './driver.js';
import type { PostgresPoolSource } from './pool.js';

const lib = KeetaNet.lib;

// A vote on a test database takes tens of milliseconds.
const ONE_CONNECTION_TIMEOUT_MILLISECONDS = 10000;

/** Keeps every transaction it opens, so a case can act on the one Ledger.run is using. */
class RecordingStorage extends PostgresLedgerStorage {
	readonly opened: PostgresTransaction[] = [];

	override async beginTransaction(options: TransactionOptions): Promise<PostgresTransaction> {
		const transaction = await super.beginTransaction(options);
		this.opened.push(transaction);
		return(transaction);
	}

	isolate<Result>(transaction: PostgresTransaction, unit: () => Promise<Result>): Promise<Result> {
		return(this.runIsolated(transaction, unit));
	}
}

const ledgerDatabase = async function(): Promise<TestDatabase> {
	const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	onTestFinished(function() {
		return(database.drop());
	});
	return(database);
};

const storageOn = function(source: PostgresPoolSource): RecordingStorage {
	const storage = new RecordingStorage(source);
	onTestFinished(function() {
		return(storage.destroy());
	});
	return(storage);
};

const ownedStorageOn = function(database: TestDatabase): RecordingStorage {
	return(storageOn({ kind: 'connection-string', connectionString: database.connectionString }));
};

/** A ledger on the storage, for Ledger.run; nothing needs genesis. */
const ledgerOn = async function(storage: PostgresLedgerStorage): Promise<Ledger> {
	freezeClock(GENESIS_MOMENT);
	const network = await createTestNetwork({ representativeWeights: [1000n] });
	return(network.createLedger(storage, requireAt(network.representatives, 0)));
};

/** A storage on a fresh database whose ledger has applied genesis, with the network that made it. */
const genesisOn = async function(database: TestDatabase): Promise<{ readonly storage: RecordingStorage; readonly network: TestNetwork }> {
	freezeClock(GENESIS_MOMENT);
	const network = await createTestNetwork({ representativeWeights: [1000n] });
	const storage = ownedStorageOn(database);
	await network.createLedger(storage, requireAt(network.representatives, 0)).add(network.genesis);
	return({ storage, network });
};

const readOn = async function<Result>(storage: PostgresLedgerStorage, read: (transaction: PostgresTransaction) => Promise<Result>): Promise<Result> {
	const transaction = await storage.beginTransaction({ identifier: 'read', readOnly: true });
	try {
		return(await read(transaction));
	} finally {
		await storage.abortTransaction(transaction);
	}
};

const createSkewTable = async function(pool: pg.Pool): Promise<void> {
	await pool.query('CREATE TABLE skew (id integer PRIMARY KEY, on_call boolean NOT NULL)');
	await pool.query('INSERT INTO skew (id, on_call) VALUES (1, true), (2, true)');
};

const onCall = async function(pool: pg.Pool): Promise<number[]> {
	const result = await pool.query<{ id: number }>('SELECT id FROM skew WHERE on_call ORDER BY id');
	return(result.rows.map(function(row) {
		return(row.id);
	}));
};

/** Each of two doctors goes off call only if the other is still on call: the textbook write skew. */
const goOffCall = async function(transaction: PostgresTransaction, doctor: number): Promise<void> {
	const others = await transaction.execute('SELECT count(*)::integer AS count FROM skew WHERE on_call AND id <> $1', [doctor]);
	if (others[0]?.['count'] === 0) {
		throw(new Error('nobody else is on call'));
	}
	await transaction.execute('UPDATE skew SET on_call = false WHERE id = $1', [doctor]);
};

const backendOf = async function(transaction: PostgresTransaction): Promise<number> {
	const rows = await transaction.execute('SELECT pg_backend_pid() AS pid');
	const pid = rows[0]?.['pid'];
	if (typeof pid !== 'number') {
		throw(new Error('no backend process ID'));
	}
	return(pid);
};

const rowsOf = async function(pool: pg.Pool, table: string): Promise<string[]> {
	const result = await pool.query<{ public_key: string }>(`SELECT public_key FROM ${table} ORDER BY public_key`);
	return(result.rows.map(function(row) {
		return(row.public_key);
	}));
};

const insertAccount = function(transaction: PostgresTransaction, publicKey: string): Promise<unknown> {
	return(transaction.execute('INSERT INTO accounts (public_key, key_type) VALUES ($1, 0)', [publicKey]));
};

describe('the Postgres driver', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('a serialization failure at commit is retried by Ledger.run', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool();
		await createSkewTable(pool);
		const storage = ownedStorageOn(database);
		const ledger = await ledgerOn(storage);
		const rival = ownedStorageOn(database);
		let attempts = 0;
		let finishedFirstAttempt = false;

		const result = await ledger.run('skew', async function() {
			attempts++;
			const transaction = storage.opened.at(-1);
			if (transaction === undefined) {
				throw(new Error('Ledger.run opened no transaction'));
			}
			await goOffCall(transaction, 1);
			if (attempts === 1) {
				const competing = await rival.beginTransaction({ identifier: 'rival', readOnly: false });
				await goOffCall(competing, 2);
				await rival.commitTransaction(competing);
				finishedFirstAttempt = true;
			}
			return('done');
		}).catch(function(error: unknown) {
			return(error);
		});

		// The first attempt ran to its end, so only its commit can have failed.
		expect(finishedFirstAttempt).toBe(true);
		expect(attempts).toBe(2);
		expect(result).toMatchObject({ code: 'LEDGER_OTHER', message: 'nobody else is on call' });
		expect(await onCall(pool)).toEqual([1]);
	});

	test('a serialization failure at commit is reported as retryable', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool();
		await createSkewTable(pool);
		const storage = ownedStorageOn(database);
		const first = await storage.beginTransaction({ identifier: 'first', readOnly: false });
		const second = await storage.beginTransaction({ identifier: 'second', readOnly: false });
		await goOffCall(first, 1);
		await goOffCall(second, 2);
		await storage.commitTransaction(second);

		const failure = storage.commitTransaction(first);

		await expect(failure).rejects.toMatchObject({ code: 'LEDGER_TRANSACTION_ABORTED', shouldRetry: true, cause: { code: '40001' } });
		await expect(storage.abortTransaction(first)).rejects.toThrow('already');
		expect(await onCall(pool)).toEqual([1]);
	});

	test('a broken connection at commit is not retried', async function() {
		const database = await ledgerDatabase();
		const storage = ownedStorageOn(database);
		const ledger = await ledgerOn(storage);
		let attempts = 0;

		const outcome = await ledger.run('broken', async function() {
			attempts++;
			const transaction = storage.opened.at(-1);
			if (transaction === undefined) {
				throw(new Error('Ledger.run opened no transaction'));
			}
			await insertAccount(transaction, 'keeta_broken');
			await database.pool().query('SELECT pg_terminate_backend($1, 5000)', [await backendOf(transaction)]);
			return('done');
		}).catch(function(error: unknown) {
			return(error);
		});

		expect(attempts).toBe(1);
		expect(lib.Error.isInstance(outcome)).toBe(true);
		expect(outcome).toMatchObject({ type: 'LEDGER', code: 'LEDGER_OTHER', shouldRetry: false });
		expect(await rowsOf(database.pool(), 'accounts')).toEqual([]);
	});

	test('a failed unit rolls back to its own savepoint and the transaction carries on', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool();
		await pool.query('CREATE TABLE written (name text PRIMARY KEY)');
		const storage = ownedStorageOn(database);
		const transaction = await storage.beginTransaction({ identifier: 'units', readOnly: false });
		const write = function(name: string): Promise<unknown> {
			return(transaction.execute('INSERT INTO written (name) VALUES ($1)', [name]));
		};

		await storage.isolate(transaction, async function() {
			await write('outer');
			// A failing statement aborts only the unit it runs in.
			await expect(storage.isolate(transaction, async function() {
				await write('inner');
				await write('inner');
			})).rejects.toMatchObject({ code: '23505' });
			await expect(storage.isolate(transaction, async function() {
				await write('thrown');
				throw(new Error('the unit fails after its write'));
			})).rejects.toThrow('after its write');
			await write('after');
		});
		await storage.commitTransaction(transaction);

		const result = await pool.query<{ name: string }>('SELECT name FROM written ORDER BY name');
		expect(result.rows.map(function(row) {
			return(row.name);
		})).toEqual(['after', 'outer']);
	});

	test('pending votes added concurrently on one transaction open their units one at a time', async function() {
		const database = await ledgerDatabase();
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: [400n, 300n, 300n] });
		const storage = ownedStorageOn(database);
		const representative = requireAt(network.representatives, 0);
		await network.createLedger(storage, representative).add(network.genesis);
		const voter = network.createLedger(new MemoryLedgerStorage(), representative);
		await voter.add(network.genesis);
		const staples = await Promise.all([0, 1].map(async function(index) {
			const from = requireAt(network.users, index);
			const send = await sendBlock({ from, previous: headOf(network.genesis, from), to: requireAt(network.users, 2), amount: 1n, token: network.baseToken, network: network.network });
			return(lib.Vote.Staple.fromVotesAndBlocks([await voter.vote([send])], [send]));
		}));
		const transaction = await storage.beginTransaction({ identifier: 'concurrent-votes', readOnly: false });
		const isolate = transaction.isolate.bind(transaction);
		let open = 0;
		let mostOpen = 0;
		const tracked: PostgresTransaction['isolate'] = async function(unit) {
			open++;
			mostOpen = Math.max(mostOpen, open);
			try {
				return(await isolate(unit));
			} finally {
				open--;
			}
		};
		Reflect.set(transaction, 'isolate', tracked);

		await Promise.all(staples.map(function(staple) {
			return(storage.addPendingVote(transaction, staple));
		}));
		await storage.commitTransaction(transaction);

		expect(mostOpen).toBe(1);
		for (const staple of staples) {
			const stored = await readOn(storage, function(reading) {
				return(storage.getVotes(reading, requireAt(staple.blocks, 0).hash, 'side'));
			});
			expect(stored?.map(function(vote) {
				return(vote.$uid);
			})).toEqual(staple.votes.map(function(vote) {
				return(vote.$uid);
			}));
		}
	});

	test('a conflict inside a unit fails the commit even when the unit\'s failure is handled', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool();
		await createSkewTable(pool);
		const storage = ownedStorageOn(database);
		const transaction = await storage.beginTransaction({ identifier: 'doomed', readOnly: false });
		await transaction.execute('SELECT on_call FROM skew');
		await pool.query('UPDATE skew SET on_call = false WHERE id = 2');

		await expect(storage.isolate(transaction, function() {
			return(transaction.execute('UPDATE skew SET on_call = false WHERE id = 2'));
		})).rejects.toMatchObject({ code: 'LEDGER_TRANSACTION_ABORTED' });
		await insertAccount(transaction, 'keeta_after_conflict');

		await expect(storage.commitTransaction(transaction)).rejects.toMatchObject({ code: 'LEDGER_TRANSACTION_ABORTED', shouldRetry: true });
		expect(await rowsOf(pool, 'accounts')).toEqual([]);
	});

	/*
	 * Upstream takes the serial inside the vote's own transaction, so a serial
	 * taken on another pooled connection would wait for the connection the
	 * vote holds. A hang shows as the test timing out.
	 */
	test('votes complete on a pool of one connection, alone and concurrently', { timeout: ONE_CONNECTION_TIMEOUT_MILLISECONDS }, async function() {
		const database = await ledgerDatabase();
		const pool = database.pool({ max: 1 });
		const storage = storageOn({ kind: 'injected', pool: function() {
			return(Promise.resolve(pool));
		} });
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const ledger = network.createLedger(storage, requireAt(network.representatives, 0));
		await ledger.add(network.genesis);
		const [first, ...others] = await Promise.all(network.users.map(function(from, index) {
			const to = requireAt(network.users, (index + 1) % network.users.length);
			return(sendBlock({ from, previous: headOf(network.genesis, from), to, amount: 1n, token: network.baseToken, network: network.network }));
		}));
		if (first === undefined) {
			throw(new Error('the network has no users'));
		}

		const alone = await ledger.vote([first]);
		const concurrent = await Promise.all(others.map(function(send) {
			return(ledger.vote([send]));
		}));

		const serials = [alone, ...concurrent].map(function(vote) {
			return(vote.serial);
		});
		expect(new Set(serials).size).toBe(network.users.length);
	});

	test('serials strictly increase across processes and survive rolled-back attempts', async function() {
		const database = await ledgerDatabase();
		const first = ownedStorageOn(database);
		const second = ownedStorageOn(database);
		const abandoned = await first.beginTransaction({ identifier: 'abandoned', readOnly: false });

		const serials = [
			await first.getNextSerialNumber(abandoned),
			await second.getNextSerialNumber(),
			await first.getNextSerialNumber()
		];
		await first.abortTransaction(abandoned);
		serials.push(await second.getNextSerialNumber());

		expect(serials).toEqual([1n, 2n, 3n, 4n]);
	});

	test('the first use migrates an empty database', async function() {
		const database = await createDatabase(inject('postgresCluster'));
		onTestFinished(function() {
			return(database.drop());
		});
		const storage = ownedStorageOn(database);

		const transaction = await storage.beginTransaction({ identifier: 'first', readOnly: true });
		await storage.abortTransaction(transaction);

		const versions = await database.pool().query<{ version: number }>('SELECT version FROM schema_version ORDER BY version');
		expect(versions.rows).toEqual([{ version: 1 }, { version: 2 }]);
	});

	test('destroy ends a pool the driver opened and leaves an injected pool to its owner', async function() {
		const database = await ledgerDatabase();
		const injectedPool = database.pool();
		const owned = ownedStorageOn(database);
		const injected = storageOn({ kind: 'injected', pool: function() {
			return(Promise.resolve(injectedPool));
		} });
		await owned.getNextSerialNumber();
		await injected.getNextSerialNumber();

		await owned.destroy();
		await injected.destroy();

		await expect(owned.getNextSerialNumber()).rejects.toThrow('destroyed');
		await expect(injected.beginTransaction({ identifier: 'after', readOnly: true })).rejects.toThrow('destroyed');
		expect(injectedPool.ended).toBe(false);
		expect((await injectedPool.query<{ one: number }>('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
	});

	test('an error event while BEGIN runs does not end the process', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool();
		// pg emits error on an unexpected end even while a query is running, and the pool stops listening at checkout.
		pool.on('acquire', function(client) {
			const query: unknown = Reflect.get(client, 'query');
			if (typeof query !== 'function') {
				throw(new Error('the client has no query method'));
			}
			Reflect.set(client, 'query', function(...input: unknown[]): unknown {
				Reflect.deleteProperty(client, 'query');
				client.emit('error', new Error('the connection was lost'));
				const running: unknown = Reflect.apply(query, client, input);
				return(running);
			});
		});
		const storage = storageOn({ kind: 'injected', pool: function() {
			return(Promise.resolve(pool));
		} });

		const transaction = await storage.beginTransaction({ identifier: 'lost', readOnly: true });

		await storage.abortTransaction(transaction);
	});

	test('a negative external permission set round-trips', async function() {
		const database = await ledgerDatabase();
		const { storage, network } = await genesisOn(database);
		// Upstream decodes a negative ASN.1 INTEGER as a negative set, and validation accepts it.
		const negative = new lib.Permissions(['ACCESS'], -1n);
		expect(negative.validate(network.network)).toBe(true);

		await database.pool().query('UPDATE acls SET external_permissions = $1', [String(negative.external.bigint)]);
		const rows = await readOn(storage, function(transaction) {
			return(storage.listACLsByPrincipal(transaction, network.trustedRoot));
		});

		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.permissions.external.bigint).toBe(-1n);
		}
	});

	test('a stored vote whose permanence disagrees with its bytes is an integrity error', async function() {
		const database = await ledgerDatabase();
		const { storage, network } = await genesisOn(database);
		const block = requireAt(network.genesis.blocks, 0);
		await database.pool().query('UPDATE votes SET permanent = false');

		const read = readOn(storage, function(transaction) {
			return(storage.getVotes(transaction, block.hash, 'main'));
		});

		await expect(read).rejects.toThrow('integrity');
	});
});
