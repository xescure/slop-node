import { afterEach, describe, expect, inject, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type pg from 'pg';
import { confirmedStaple, sendBlock } from '../../../testing/blocks.js';
import { createTestNetwork, freezeClock } from '../../../testing/network.js';
import type { TestNetwork } from '../../../testing/network.js';
import { createDatabase } from '../../../testing/postgres.js';
import type { TestDatabase } from '../../../testing/postgres.js';
import { MemoryLedgerStorage } from '../memory/driver.js';
import { blocksHashesOf, checksumOf, DEFAULT_WEIGHTS, GENESIS_MOMENT, headOf, requireAt } from '../suite/support.js';
import type { TransactionOptions } from '../base.js';
import { catchUpVotes, catchUpVotesAfter } from './confirmed-statements.js';
import { PostgresLedgerStorage } from './driver.js';
import type { HistoryReindex, PostgresTransaction } from './driver.js';
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

	test('a connection lost before commit is retried by Ledger.run', async function() {
		const database = await ledgerDatabase();
		const storage = ownedStorageOn(database);
		const ledger = await ledgerOn(storage);
		let attempts = 0;

		const outcome = await ledger.run('lost', async function() {
			attempts++;
			const transaction = storage.opened.at(-1);
			if (transaction === undefined) {
				throw(new Error('Ledger.run opened no transaction'));
			}
			if (attempts === 1) {
				await database.pool().query('SELECT pg_terminate_backend($1, 5000)', [await backendOf(transaction)]);
			}
			// The first attempt's statement fails before its COMMIT is ever sent, so nothing of it can have committed.
			await insertAccount(transaction, 'keeta_retried');
			return('done');
		});

		expect(outcome).toBe('done');
		expect(attempts).toBe(2);
		expect(await rowsOf(database.pool(), 'accounts')).toEqual(['keeta_retried']);
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
		expect(versions.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }]);
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

	test('owners are the distinct account principals whose base set holds OWNER, by target when one is given', async function() {
		const database = await ledgerDatabase();
		const storage = ownedStorageOn(database);
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const [owner, admin, certified] = network.users;
		const [first, second] = network.representatives;
		if (owner === undefined || admin === undefined || certified === undefined || first === undefined || second === undefined) {
			throw(new Error('three users and two representatives expected'));
		}
		const identifier = network.baseToken;
		const pool = database.pool();
		await pool.query('INSERT INTO accounts (public_key, key_type) SELECT unnest($1::text[]), 0', [[identifier, owner, admin, certified, first, second].map(function(account) {
			return(account.publicKeyString.get());
		})]);
		const grant = async function(principal: typeof owner, target: typeof owner, base: bigint, certificate: Buffer | null): Promise<void> {
			await pool.query(`INSERT INTO acls (principal_id, certificate, entity_id, target_id, base_permissions, external_permissions)
				SELECT principal.id, $2, entity.id, target.id, $5, 0 FROM accounts principal, accounts entity, accounts target
				WHERE principal.public_key = $1 AND entity.public_key = $3 AND target.public_key = $4`, [principal.publicKeyString.get(), certificate, identifier.publicKeyString.get(), target.publicKeyString.get(), String(base)]);
		};
		const ownerSet = new lib.Permissions(['OWNER']).base.bigint;
		await grant(owner, first, ownerSet, null);
		await grant(owner, second, ownerSet, null);
		await grant(admin, first, new lib.Permissions(['ADMIN']).base.bigint, null);
		await grant(certified, first, ownerSet, Buffer.alloc(32, 0x5a));

		const owners = await readOn(storage, async function(transaction) {
			return({
				any: await storage.listOwners(transaction, identifier),
				first: await storage.listOwners(transaction, identifier, first),
				admin: await storage.listOwners(transaction, identifier, admin)
			});
		});

		const keysOf = function(accounts: readonly { publicKeyString: { get(): string } }[]): string[] {
			return(accounts.map(function(account) {
				return(account.publicKeyString.get());
			}));
		};
		expect(keysOf(owners.any)).toEqual([owner.publicKeyString.get()]);
		expect(keysOf(owners.first)).toEqual([owner.publicKeyString.get()]);
		expect(owners.admin).toEqual([]);
	});

	test.each([
		{ name: 'from a moment', text: catchUpVotes.text, parameters: [GENESIS_MOMENT, 201] },
		{ name: 'after a key', text: catchUpVotesAfter.text, parameters: [GENESIS_MOMENT, GENESIS_MOMENT, '7', 201] }
	])('a catch-up page $name reads main votes in order from votes_catch_up, without sorting them', async function({ text, parameters }) {
		const database = await ledgerDatabase();
		await genesisOn(database);
		const client = await database.pool().connect();
		try {
			// The test tables are too small for the planner to prefer an index of its own accord.
			await client.query('SET enable_seqscan = off');
			const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, parameters)).rows.map(function(row): string {
				return(row['QUERY PLAN']);
			}).join('\n');
			expect(plan).toContain('Index Scan using votes_catch_up on votes');
			expect(plan).not.toContain('Sort');
		} finally {
			client.release();
		}
	});

	test('a staple stored before its bytes were kept is rebuilt from its votes and blocks', async function() {
		const database = await ledgerDatabase();
		const { storage, network } = await genesisOn(database);
		await database.pool().query('UPDATE staples SET bytes = NULL');

		const staples = await readOn(storage, function(transaction) {
			return(storage.getVoteStaples(transaction, [network.genesis.blocksHash], 'main'));
		});

		const rebuilt = lib.Vote.Staple.fromVotesAndBlocks(network.genesis.votes, network.genesis.blocks);
		expect(Buffer.from(staples.get(network.genesis.blocksHash)?.toBytes() ?? new ArrayBuffer(0))).toEqual(Buffer.from(rebuilt.toBytes()));
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

	test('a history reindex lists each staple under exactly the accounts D18 names, and a second resumes after the last', async function() {
		const database = await ledgerDatabase();
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const storage = ownedStorageOn(database);
		const ledger = network.createLedger(storage, requireAt(network.representatives, 0));
		await ledger.add(network.genesis);
		const sender = requireAt(network.users, 0);
		const recipient = requireAt(network.users, 1);
		const send = await sendBlock({ from: sender, previous: headOf(network.genesis, sender), to: recipient, amount: 1n, token: network.baseToken, network: network.network });
		const [sent] = await ledger.add(await confirmedStaple([send], network.representatives));
		if (sent === undefined) {
			throw(new Error('the send was not applied'));
		}
		const historyOf = async function(account: GenericAccount): Promise<string[]> {
			return(blocksHashesOf(await ledger.getHistory(account, null)));
		};
		const listedBefore = { token: await historyOf(network.baseToken), recipient: await historyOf(recipient) };
		// As an earlier rule wrote it: the token the staple only moves lists it, and a row the rule lists is missing.
		const pool = database.pool();
		await pool.query('INSERT INTO history (account_id, blocks_hash, staple_time) SELECT accounts.id, staples.blocks_hash, staples.staple_time FROM accounts, staples WHERE accounts.public_key = $1 AND staples.blocks_hash = $2', [network.baseToken.publicKeyString.get(), Buffer.from(sent.blocksHash.toString(), 'hex')]);
		await pool.query('DELETE FROM history USING accounts WHERE history.account_id = accounts.id AND accounts.public_key = $1 AND history.blocks_hash = $2', [recipient.publicKeyString.get(), Buffer.from(sent.blocksHash.toString(), 'hex')]);
		expect(await historyOf(network.baseToken)).not.toEqual(listedBefore.token);
		const context = { initialTrustedAccount: network.trustedSigner, baseToken: network.baseToken, networkAddress: network.networkAddress };

		const progress: HistoryReindex[] = [];
		expect(await storage.reindexHistory(context, function(done) {
			progress.push(done);
		})).toEqual({ after: 0n, staples: 2, removed: 1, added: 1 });

		expect(progress).toEqual([{ after: 0n, staples: 2, removed: 1, added: 1 }]);
		expect(await historyOf(network.baseToken)).toEqual(listedBefore.token);
		expect(await historyOf(recipient)).toEqual(listedBefore.recipient);
		const [last] = (await pool.query<{ sequence: string }>('SELECT max(sequence)::text AS sequence FROM staples')).rows;
		expect(await storage.reindexHistory(context)).toEqual({ after: BigInt(last?.sequence ?? '0'), staples: 0, removed: 0, added: 0 });
	});

	test('a history reindex resumes after the staple one that was stopped reached', async function() {
		const database = await ledgerDatabase();
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const storage = ownedStorageOn(database);
		const ledger = network.createLedger(storage, requireAt(network.representatives, 0));
		await ledger.add(network.genesis);
		const sender = requireAt(network.users, 0);
		const recipient = requireAt(network.users, 1);
		const [sent] = await ledger.add(await confirmedStaple([await sendBlock({ from: sender, previous: headOf(network.genesis, sender), to: recipient, amount: 1n, token: network.baseToken, network: network.network })], network.representatives));
		if (sent === undefined) {
			throw(new Error('the send was not applied'));
		}
		const pool = database.pool();
		const rowsOf = async function(staple: VoteStaple): Promise<number> {
			const counted = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM history WHERE blocks_hash = $1', [Buffer.from(staple.blocksHash.toString(), 'hex')]);
			return(Number(counted.rows[0]?.count ?? 0));
		};
		const listed = { genesis: await rowsOf(network.genesis), sent: await rowsOf(sent) };
		// Both staples lose a row of their history, and a reindex stopped earlier reached the first.
		await pool.query('DELETE FROM history USING (SELECT DISTINCT ON (blocks_hash) blocks_hash, account_id FROM history ORDER BY blocks_hash, account_id) AS one WHERE history.blocks_hash = one.blocks_hash AND history.account_id = one.account_id');
		const [genesisRow] = (await pool.query<{ sequence: string }>('SELECT sequence::text AS sequence FROM staples WHERE blocks_hash = $1', [Buffer.from(network.genesis.blocksHash.toString(), 'hex')])).rows;
		await pool.query('INSERT INTO kv_entries (arena, key, value) VALUES (\'historyReindex\', \'signers and effect accounts\', $1)', [JSON.stringify({ after: genesisRow?.sequence })]);
		const context = { initialTrustedAccount: network.trustedSigner, baseToken: network.baseToken, networkAddress: network.networkAddress };

		expect(await storage.reindexHistory(context)).toEqual({ after: BigInt(genesisRow?.sequence ?? '0'), staples: 1, removed: 0, added: 1 });

		expect({ genesis: await rowsOf(network.genesis), sent: await rowsOf(sent) }).toEqual({ genesis: listed.genesis - 1, sent: listed.sent });
	});

	test('a node killed after its commits, before it writes its statistics, leaves a checksum covering every staple it committed', async function() {
		const database = await ledgerDatabase();
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const killed = new PostgresLedgerStorage({ kind: 'connection-string', connectionString: database.connectionString });
		const node = network.createNode(killed, requireAt(network.representatives, 0));
		await node.ledger.add(network.genesis);
		const sender = requireAt(network.users, 0);
		const sent = await confirmedStaple([await sendBlock({ from: sender, previous: headOf(network.genesis, sender), to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, network: network.network })], network.representatives);
		await node.ledger.add(sent);
		// The process ends here: its connections close, and its statistics are never written.
		await killed.destroy();

		const restarted = ownedStorageOn(database);
		expect((await restarted.ledgerChecksum()).checksum).toBe(checksumOf([network.genesis, sent]));
		const folded = await database.pool().query<{ fold: string }>('SELECT bit_xor((\'x\' || encode(hash, \'hex\'))::bit(256))::text AS fold FROM blocks WHERE ledger = \'main\'');
		expect(BigInt(`0b${folded.rows[0]?.fold ?? ''}`)).toBe(checksumOf([network.genesis, sent]));
	});

	test('keeps the checksum folded in a row per first byte of the staples\' blocks hashes, which a read reads instead of the staples', async function() {
		const database = await ledgerDatabase();
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const storage = ownedStorageOn(database);
		const node = network.createNode(storage, requireAt(network.representatives, 0));
		await node.ledger.add(network.genesis);
		const sender = requireAt(network.users, 0);
		const sent = await confirmedStaple([await sendBlock({ from: sender, previous: headOf(network.genesis, sender), to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, network: network.network })], network.representatives);
		await node.ledger.add(sent);
		const pool = database.pool();

		const rows = await pool.query<{ shard: number; checksum: string }>('SELECT shard, checksum::text FROM ledger_checksum WHERE checksum <> repeat(\'0\', 256)::bit(256) ORDER BY shard');
		const shardOf = function(staple: VoteStaple): number {
			return(Number.parseInt(staple.blocksHash.toString().slice(0, 2), 16));
		};
		const expected = new Map<number, bigint>();
		for (const staple of [network.genesis, sent]) {
			expected.set(shardOf(staple), (expected.get(shardOf(staple)) ?? 0n) ^ checksumOf([staple]));
		}
		expect(rows.rows.map(function(row): [number, bigint] {
			return([row.shard, BigInt(`0b${row.checksum}`)]);
		})).toEqual([...expected].sort(function([left], [right]): number {
			return(left - right);
		}));
		expect((await pool.query('SELECT shard FROM ledger_checksum')).rowCount).toBe(256);

		// A staple row that no write of the driver folded in is no part of what a read returns.
		await pool.query('INSERT INTO staples (blocks_hash, staple_time, moment, checksum) VALUES ($1, $2, $2, repeat(\'1\', 256)::bit(256))', [Buffer.alloc(32, 7), GENESIS_MOMENT]);
		expect((await storage.ledgerChecksum()).checksum).toBe(checksumOf([network.genesis, sent]));
	});
});
