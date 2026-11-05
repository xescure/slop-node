import { afterEach, describe, expect, inject, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type pg from 'pg';
import {
	confirmedStaple,
	createMultisigBlock,
	createTokenBlock,
	manageCertificateBlock,
	modifyPermissionsBlock,
	multisigSendBlock,
	operationsBlock,
	receiveBlock,
	sendBlock,
	setInfoBlock,
	tokenSupplyBlock
} from '../../../testing/blocks.js';
import { advanceClock, createTestNetwork, freezeClock } from '../../../testing/network.js';
import type { TestNetwork } from '../../../testing/network.js';
import { createDatabase } from '../../../testing/postgres.js';
import type { TestDatabase } from '../../../testing/postgres.js';
import { interceptQueries, serverError } from '../../../testing/query-faults.js';
import { MemoryLedgerStorage } from '../memory/driver.js';
import { blocksHashesOf, certificateFor, certificateIssuedBy, ChainCursor, checksumOf, DEFAULT_WEIGHTS, GENESIS_MOMENT, headOf, requireAt } from '../suite/support.js';
import type { TransactionOptions } from '../base.js';
import { backfillOperations, catchUpVotes, catchUpVotesAfter, foldLedgerChecksum, insertBlockDetails, insertMainVotes, insertOperations, mainLedgerCounts, readLedgerChecksum } from './confirmed-statements.js';
import { addressesOf, decodeBlock } from './decode.js';
import type { Address, DecodedBlock } from './decode.js';
import { BACKFILL_BATCH_STAPLES, PostgresLedgerStorage, projectionRowsOf } from './driver.js';
import type { HistoryReindex, PostgresTransaction, ProjectionBackfill } from './driver.js';
import type { PostgresPoolSource } from './pool.js';
import type { AccountID } from './sql.js';

const lib = KeetaNet.lib;

const NEWCOMER_SEED = '5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b';

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

/** A storage on a pool the case holds, so that it sees what becomes of each connection. */
const injectedStorageOn = function(pool: pg.Pool): RecordingStorage {
	return(storageOn({ kind: 'injected', pool: function() {
		return(Promise.resolve(pool));
	} }));
};

/** Fails each statement whose text the predicate picks, as the server would with the error. */
const failing = function(pool: pg.Pool, picks: (text: string) => boolean, error: () => Error): void {
	interceptQueries(pool, function(issued, run) {
		if (picks(issued.text)) {
			return(Promise.reject(error()));
		}
		return(run());
	});
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
		expect(versions.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }]);
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

		await expect(owned.getNextSerialNumber()).rejects.toThrow('storage driver is destroyed');
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

		await expect(read).rejects.toThrow(/^storage integrity error: vote \S+ is stored as temporary but its bytes decode as permanent$/);
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
		expect(storage.opened.map(function(transaction): string {
			return(transaction.identifier);
		}).filter(function(identifier): boolean {
			return(identifier.startsWith('reindex'));
		})).toEqual(['reindex-history-after-0']);
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

		// Two transactions at once that fold into different rows find each row through the key, so neither reads what the other writes, however the table's statistics stand.
		await pool.query('ANALYZE ledger_checksum');
		const [first, second] = [await pool.connect(), await pool.connect()];
		try {
			for (const [client, shard] of [[first, 1], [second, 2]] as const) {
				await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
				await client.query(foldLedgerChecksum.text, [shard, '01'.repeat(32)]);
			}
			await first.query('COMMIT');
			await second.query('COMMIT');
		} finally {
			first.release();
			second.release();
		}
		const plan = await pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${foldLedgerChecksum.text.replace('$1', '7').replace('$2', '\'00\'')}`);
		expect(plan.rows.map(function(row): string {
			return(row['QUERY PLAN']);
		}).join('\n')).toContain('Index Scan using ledger_checksum_pkey');
		for (const shard of [1, 2]) {
			expected.set(shard, (expected.get(shard) ?? 0n) ^ BigInt(`0x${'01'.repeat(32)}`));
		}
		let folded = 0n;
		for (const value of expected.values()) {
			folded ^= value;
		}
		expect((await storage.ledgerChecksum()).checksum).toBe(folded);

		// A staple row that no write of the driver folded in is no part of what a read returns.
		await pool.query('INSERT INTO staples (blocks_hash, staple_time, moment, checksum) VALUES ($1, $2, $2, repeat(\'1\', 256)::bit(256))', [Buffer.alloc(32, 7), GENESIS_MOMENT]);
		expect((await storage.ledgerChecksum()).checksum).toBe(folded);
	});

	test('a transaction returns its connection to the pool once it commits or aborts, listening for its errors only while it runs', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool({ max: 1 });
		const storage = injectedStorageOn(pool);
		const listening: number[] = [];

		for (const outcome of ['commit', 'abort', 'commit'] as const) {
			const transaction = await storage.beginTransaction({ identifier: outcome, readOnly: false });
			await insertAccount(transaction, `keeta_${outcome}_${String(listening.length)}`);
			if (outcome === 'commit') {
				await transaction.commit();
			} else {
				await transaction.abort();
			}
			expect([pool.totalCount, pool.idleCount], outcome).toEqual([1, 1]);
			const client = await pool.connect();
			listening.push(client.listenerCount('error'));
			client.release();
		}

		expect(new Set(listening).size).toBe(1);
		expect(await rowsOf(pool, 'accounts')).toEqual(['keeta_commit_0', 'keeta_commit_2']);
	});

	test('a transaction whose rollback fails closes its connection, which rolls it back, and is aborted all the same', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool({ max: 1 });
		failing(pool, function(text) {
			return(text === 'ROLLBACK');
		}, function() {
			return(serverError('57P01', 'terminating connection due to administrator command'));
		});
		const storage = injectedStorageOn(pool);
		const transaction = await storage.beginTransaction({ identifier: 'unrolled', readOnly: false });

		await transaction.abort();

		expect(pool.totalCount).toBe(0);
		await expect(transaction.execute('SELECT 1')).rejects.toThrow('transaction unrolled is already aborted');
	});

	test('a commit a conflict refuses rolls back and returns the connection, and leaves the transaction failed', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool({ max: 2 });
		await createSkewTable(pool);
		const storage = injectedStorageOn(pool);
		const transaction = await storage.beginTransaction({ identifier: 'conflicted', readOnly: false });
		await transaction.execute('SELECT on_call FROM skew');
		await pool.query('UPDATE skew SET on_call = false WHERE id = 2');
		await expect(transaction.execute('UPDATE skew SET on_call = false WHERE id = 2')).rejects.toMatchObject({ code: 'LEDGER_TRANSACTION_ABORTED' });

		await expect(transaction.commit()).rejects.toMatchObject({ code: 'LEDGER_TRANSACTION_ABORTED', shouldRetry: true });

		expect([pool.totalCount, pool.idleCount]).toEqual([2, 2]);
		await expect(transaction.execute('SELECT 1')).rejects.toThrow('transaction conflicted is already failed');
	});

	test('a COMMIT that fails closes the connection, since nobody knows whether it committed, and leaves the transaction failed', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool({ max: 1 });
		failing(pool, function(text) {
			return(text === 'COMMIT');
		}, function() {
			return(serverError('XX000', 'the server failed'));
		});
		const storage = injectedStorageOn(pool);
		const transaction = await storage.beginTransaction({ identifier: 'unknown', readOnly: false });

		await expect(transaction.commit()).rejects.toMatchObject({ code: 'XX000' });

		expect(pool.totalCount).toBe(0);
		await expect(transaction.execute('SELECT 1')).rejects.toThrow('transaction unknown is already failed');
	});

	test('a commit after a failed statement is refused, as Postgres rolls it back, and the connection is returned', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool({ max: 1 });
		const storage = injectedStorageOn(pool);
		const transaction = await storage.beginTransaction({ identifier: 'failed-earlier', readOnly: false });
		await insertAccount(transaction, 'keeta_failed_earlier');
		await expect(transaction.execute('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' });

		await expect(transaction.commit()).rejects.toThrow('transaction failed-earlier was rolled back by a statement that failed earlier');

		expect([pool.totalCount, pool.idleCount]).toEqual([1, 1]);
		await expect(transaction.execute('SELECT 1')).rejects.toThrow('transaction failed-earlier is already failed');
		expect(await rowsOf(pool, 'accounts')).toEqual([]);
	});

	test('a statement issued while the transaction ends is refused', async function() {
		const database = await ledgerDatabase();
		const storage = ownedStorageOn(database);
		const transaction = await storage.beginTransaction({ identifier: 'ending', readOnly: true });

		const committing = transaction.commit();

		await expect(transaction.execute('SELECT 1')).rejects.toThrow('transaction ending is already ending');
		await committing;
		await expect(transaction.execute('SELECT 1')).rejects.toThrow('transaction ending is already committed');
	});

	test('a transaction is read-only unless it is opened for writing, and the database refuses its writes', async function() {
		const database = await ledgerDatabase();
		const storage = ownedStorageOn(database);

		for (const options of [{ identifier: 'read-only', readOnly: true }, { identifier: 'unstated' }]) {
			const transaction = await storage.beginTransaction(options);
			await expect(insertAccount(transaction, `keeta_${options.identifier}`), options.identifier).rejects.toMatchObject({ code: '25006' });
			await transaction.abort();
		}
		const writing = await storage.beginTransaction({ identifier: 'writing', readOnly: false });
		await insertAccount(writing, 'keeta_writing');
		await writing.commit();

		expect(await rowsOf(database.pool(), 'accounts')).toEqual(['keeta_writing']);
	});

	test('a BEGIN that fails closes its connection: a lost session is a retryable conflict, and any other failure is reported as it is', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool({ max: 1 });
		const failures = [serverError('57P01', 'terminating connection due to administrator command'), serverError('53000', 'insufficient resources')];
		interceptQueries(pool, function(issued, run) {
			const failure = failures[0];
			if (issued.text.startsWith('BEGIN') && failure !== undefined) {
				failures.shift();
				return(Promise.reject(failure));
			}
			return(run());
		});
		const storage = injectedStorageOn(pool);

		await expect(storage.beginTransaction({ identifier: 'lost', readOnly: true })).rejects.toMatchObject({ code: 'LEDGER_TRANSACTION_ABORTED', shouldRetry: true, cause: { code: '57P01' } });
		expect(pool.totalCount).toBe(0);
		await expect(storage.beginTransaction({ identifier: 'refused', readOnly: true })).rejects.toMatchObject({ code: '53000' });
		expect(pool.totalCount).toBe(0);

		const transaction = await storage.beginTransaction({ identifier: 'after', readOnly: true });
		await transaction.abort();
	});

	test('each statement of the driver is prepared on a connection under its own name', async function() {
		const database = await ledgerDatabase();
		const { storage, network } = await genesisOn(database);

		const prepared = await readOn(storage, async function(transaction) {
			for (const user of network.users) {
				await storage.getBalance(transaction, user, network.baseToken);
			}
			return(await transaction.execute('SELECT name FROM pg_prepared_statements WHERE name = \'ledger_balance_of\''));
		});

		expect(prepared).toEqual([{ name: 'ledger_balance_of' }]);
	});

	test('statistics and the checksum are dated in the middle of the statement that read them', async function() {
		const database = await ledgerDatabase();
		const pool = database.pool();
		const storage = injectedStorageOn(pool);
		await ledgerOn(storage);
		const counted = new Set([mainLedgerCounts.name, readLedgerChecksum.name]);
		// Each read takes ten milliseconds, by the clock the driver reads.
		interceptQueries(pool, async function(issued, run) {
			const result = await run();
			if (issued.name !== undefined && counted.has(issued.name)) {
				advanceClock(10);
			}
			return(result);
		});

		const stats = await storage.stats();
		const checksum = await storage.ledgerChecksum();

		expect([stats.moment, stats.momentRange]).toEqual([new Date(GENESIS_MOMENT.getTime() + 5).toISOString(), 5]);
		expect([checksum.moment, checksum.momentRange]).toEqual([new Date(GENESIS_MOMENT.getTime() + 15), 5]);
	});

	test('a reindex begins at the first staple when where one reached is no staple sequence', async function() {
		const database = await ledgerDatabase();
		const { storage, network } = await genesisOn(database);
		const pool = database.pool();
		const context = { initialTrustedAccount: network.trustedSigner, baseToken: network.baseToken, networkAddress: network.networkAddress };
		const reached = function(value: string): Promise<unknown> {
			return(pool.query('INSERT INTO kv_entries (arena, key, value) VALUES (\'historyReindex\', \'signers and effect accounts\', $1::json) ON CONFLICT (arena, key) DO UPDATE SET value = EXCLUDED.value', [value]));
		};

		for (const value of ['null', '"7"', '{"after":7}', '{"after":"x7"}', '{"after":"7x"}', '{"reached":"7"}']) {
			await reached(value);
			expect(await storage.reindexHistory(context), value).toEqual({ after: 0n, staples: 1, removed: 0, added: 0 });
		}
		await reached('{"after":"12"}');
		expect(await storage.reindexHistory(context)).toEqual({ after: 12n, staples: 0, removed: 0, added: 0 });
	});

	test('a reindex whose batch fails rolls it back and reports the failure, and records no progress', async function() {
		const database = await ledgerDatabase();
		const { storage, network } = await genesisOn(database);
		const pool = database.pool();
		await pool.query('DELETE FROM history WHERE (account_id, blocks_hash) IN (SELECT account_id, blocks_hash FROM history LIMIT 1)');
		await pool.query('ALTER TABLE history ADD CONSTRAINT refuse_new_rows CHECK (false) NOT VALID');
		const context = { initialTrustedAccount: network.trustedSigner, baseToken: network.baseToken, networkAddress: network.networkAddress };

		await expect(storage.reindexHistory(context)).rejects.toMatchObject({ code: '23514' });

		expect((await pool.query('SELECT 1 FROM kv_entries WHERE arena = \'historyReindex\'')).rowCount).toBe(0);
	});

	test('a ledger on the driver starts migrating an empty database as it starts, before any transaction', async function() {
		const database = await createDatabase(inject('postgresCluster'));
		onTestFinished(function() {
			return(database.drop());
		});
		const storage = ownedStorageOn(database);

		await ledgerOn(storage);
		// Destroying waits for the migration the start began.
		await storage.destroy();

		expect((await database.pool().query('SELECT version FROM schema_version')).rowCount).toBeGreaterThan(0);
	});

	test('a staple rebuilt from its rows that has no votes is an integrity error', async function() {
		const database = await ledgerDatabase();
		const { storage, network } = await genesisOn(database);
		await database.pool().query('UPDATE staples SET bytes = NULL');
		await database.pool().query('DELETE FROM votes WHERE ledger = \'main\'');

		const read = readOn(storage, function(transaction) {
			return(storage.getVoteStaples(transaction, [network.genesis.blocksHash], 'main'));
		});

		await expect(read).rejects.toThrow(`storage integrity error: confirmed staple ${network.genesis.blocksHash.toString().toLowerCase()} has no votes`);
	});

	test('a side vote that covers no blocks is an integrity error', async function() {
		const database = await ledgerDatabase();
		const { storage, network } = await genesisOn(database);
		const voter = network.createLedger(new MemoryLedgerStorage(), requireAt(network.representatives, 0));
		await voter.add(network.genesis);
		const from = requireAt(network.users, 0);
		const send = await sendBlock({ from, previous: headOf(network.genesis, from), to: requireAt(network.representatives, 0), amount: 1n, token: network.baseToken, network: network.network });
		const pending = lib.Vote.Staple.fromVotesAndBlocks([await voter.vote([send])], [send]);
		const transaction = await storage.beginTransaction({ identifier: 'pending', readOnly: false });
		await storage.addPendingVote(transaction, pending);
		await storage.commitTransaction(transaction);
		await database.pool().query('DELETE FROM vote_blocks');

		const read = readOn(storage, function(reading) {
			return(storage.getVoteStaples(reading, [pending.blocksHash], 'side'));
		});

		await expect(read).rejects.toThrow(/^storage integrity error: side vote \d+ covers no blocks$/);
	});

	test('a balance change that nets to zero writes no balance row', async function() {
		const database = await ledgerDatabase();
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const storage = ownedStorageOn(database);
		const ledger = network.createLedger(storage, requireAt(network.representatives, 0));
		await ledger.add(network.genesis);
		const sender = requireAt(network.users, 0);
		const newcomer = lib.Account.fromSeed('0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0', 0);
		const out = await sendBlock({ from: sender, previous: headOf(network.genesis, sender), to: newcomer, amount: 5n, token: network.baseToken, network: network.network });
		const back = await sendBlock({ from: newcomer, previous: null, to: sender, amount: 5n, token: network.baseToken, network: network.network });
		const balanceBefore = await ledger.getBalance(sender, network.baseToken);

		await ledger.add(await confirmedStaple([out, back], network.representatives));

		expect(await ledger.getBalance(sender, network.baseToken)).toBe(balanceBefore);
		const rows = await database.pool().query('SELECT 1 FROM balances JOIN accounts ON accounts.id = balances.account_id WHERE accounts.public_key = $1', [newcomer.publicKeyString.get()]);
		expect(rows.rowCount).toBe(0);
	});
});

type ProjectedOperation = {
	readonly index: number;
	readonly type: number;
	readonly account: string | null;
	readonly counterparty: string | null;
	readonly token: string | null;
	readonly amount: string | null;
	readonly stapleTime: Date;
	readonly details: unknown;
};

type ProjectedBlock = {
	readonly date: Date;
	readonly version: number;
	readonly purpose: number;
	readonly signer: string | null;
	readonly operations: readonly ProjectedOperation[];
};

type Projection = Readonly<Record<string, ProjectedBlock>>;

type ProjectionFixture = {
	readonly pool: pg.Pool;
	readonly storage: RecordingStorage;
	readonly network: TestNetwork;
	readonly ledger: Ledger;
	readonly cursor: ChainCursor;
	readonly apply: (blocks: readonly Block[]) => Promise<VoteStaple>;
};

/** A ledger past genesis on a storage over the case's pool, so that the case sees the statements it runs. */
const projectionFixture = async function(): Promise<ProjectionFixture> {
	const database = await ledgerDatabase();
	const pool = database.pool();
	const storage = injectedStorageOn(pool);
	freezeClock(GENESIS_MOMENT);
	const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
	const ledger = network.createLedger(storage, requireAt(network.representatives, 0));
	await ledger.add(network.genesis);
	const cursor = new ChainCursor(network.genesis);
	const apply = async function(blocks: readonly Block[]): Promise<VoteStaple> {
		const staple = await confirmedStaple(blocks, network.representatives);
		await ledger.add(staple);
		return(staple);
	};
	return({ pool, storage, network, ledger, cursor, apply });
};

/** The rows of the projection by block hash, with each id read back as the public key it stands for, or null for one no account has. */
const projectionOf = async function(pool: pg.Pool): Promise<Projection> {
	const blocks = await pool.query<{ hash: Buffer; date: Date; version: number; purpose: number; signer: string | null }>(`
		SELECT block_details.hash, block_details.date, block_details.version, block_details.purpose, signer.public_key AS signer
		FROM block_details LEFT JOIN accounts signer ON signer.id = block_details.signer_id`);
	const operations = await pool.query<{ block_hash: Buffer; idx: number; type: number; account: string | null; counterparty: string | null; token: string | null; amount: string | null; staple_time: Date; details: unknown }>(`
		SELECT operations.block_hash, operations.idx, operations.type, account.public_key AS account, counterparty.public_key AS counterparty,
			token.public_key AS token, operations.amount::text AS amount, operations.staple_time, operations.details
		FROM operations
		LEFT JOIN accounts account ON account.id = operations.account_id
		LEFT JOIN accounts counterparty ON counterparty.id = operations.counterparty_id
		LEFT JOIN accounts token ON token.id = operations.token_id
		ORDER BY operations.block_hash, operations.idx`);
	const operationsOf = new Map<string, ProjectedOperation[]>();
	for (const row of operations.rows) {
		const hash = row.block_hash.toString('hex');
		const operation = { index: row.idx, type: row.type, account: row.account, counterparty: row.counterparty, token: row.token, amount: row.amount, stapleTime: row.staple_time, details: row.details };
		operationsOf.set(hash, [...operationsOf.get(hash) ?? [], operation]);
	}
	const projection: Record<string, ProjectedBlock> = {};
	for (const row of blocks.rows) {
		const hash = row.hash.toString('hex');
		projection[hash] = { date: row.date, version: row.version, purpose: row.purpose, signer: row.signer, operations: operationsOf.get(hash) ?? [] };
		operationsOf.delete(hash);
	}
	const [orphan] = operationsOf.keys();
	if (orphan !== undefined) {
		throw(new Error(`block ${orphan} has operations rows but no block_details row`));
	}
	return(projection);
};

/** What the projection should hold: every main block's stored bytes, decoded, at its staple's time. */
const decodedLedgerOf = async function(pool: pg.Pool): Promise<Projection> {
	const rows = await pool.query<{ hash: Buffer; bytes: Buffer; staple_time: Date }>(`
		SELECT blocks.hash, blocks.bytes, staples.staple_time
		FROM blocks JOIN staples ON staples.blocks_hash = blocks.staple
		WHERE blocks.ledger = 'main'`);
	const projection: Record<string, ProjectedBlock> = {};
	for (const row of rows.rows) {
		const decoded = decodeBlock(new lib.Block(row.bytes));
		projection[row.hash.toString('hex')] = {
			date: decoded.date,
			version: decoded.version,
			purpose: decoded.purpose,
			signer: decoded.signer,
			operations: decoded.operations.map(function(operation): ProjectedOperation {
				return({
					index: operation.index,
					type: lib.Block.OperationType[operation.type],
					account: operation.account,
					counterparty: operation.counterparty,
					token: operation.token,
					amount: operation.amount?.toString() ?? null,
					stapleTime: row.staple_time,
					details: operation.details
				});
			})
		};
	}
	return(projection);
};

const typeNamesOf = function(projection: Projection): string[] {
	const types = new Set(Object.values(projection).flatMap(function(block) {
		return(block.operations.map(function(operation) {
			return(lib.Block.OperationType[operation.type] ?? `unknown type ${String(operation.type)}`);
		}));
	}));
	return(Array.from(types).sort());
};

const blockHashOf = function(block: Block): string {
	return(block.hash.toString().toLowerCase());
};

/** Applies a staple of each kind of operation the builders make, past what genesis holds, and names an account first in a multisig's signers. */
const applyEveryOperation = async function(context: ProjectionFixture): Promise<void> {
	const { network, cursor, apply } = context;
	const owner = requireAt(network.users, 0);
	const other = requireAt(network.users, 1);
	const created = await createTokenBlock({ owner, previous: cursor.previous(owner), network: network.network });
	const { token } = created;
	cursor.append(created.block);
	const minted = cursor.append(await tokenSupplyBlock({ owner, token, amount: 10n, previous: cursor.previous(token), network: network.network }));
	const named = cursor.append(await setInfoBlock({ account: token, signer: owner, previous: cursor.previous(token), network: network.network, name: 'T', description: 'token', metadata: '', defaultPermission: new lib.Permissions(['ACCESS']) }));
	await apply([created.block, minted, named]);
	const paid = cursor.append(await sendBlock({ from: owner, to: other, amount: 3n, token: network.baseToken, previous: cursor.previous(owner), network: network.network }));
	const received = cursor.append(await receiveBlock({ account: other, from: owner, amount: 3n, token: network.baseToken, exact: true, previous: cursor.previous(other), network: network.network }));
	await apply([paid, received]);
	await apply([cursor.append(await modifyPermissionsBlock({ account: owner, principal: other, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['SEND_ON_BEHALF']), target: network.baseToken, previous: cursor.previous(owner), network: network.network }))]);
	const certificate = await certificateIssuedBy(other, owner, 3, false);
	const intermediates = new lib.Utils.Certificate.CertificateBundle([await certificateFor(other, 4)]);
	await apply([cursor.append(await manageCertificateBlock({ account: owner, method: lib.Block.AdjustMethod.ADD, certificateOrHash: certificate, intermediateCertificates: intermediates, previous: cursor.previous(owner), network: network.network }))]);
	const newcomer = lib.Account.fromSeed('6b5a4c3d2e1f0a9b8c7d6e5f4a3b2c1d6b5a4c3d2e1f0a9b8c7d6e5f4a3b2c1d', 0);
	const multisig = await createMultisigBlock({ owner, signers: [newcomer, other], quorum: 2n, previous: cursor.previous(owner), network: network.network });
	await apply([cursor.append(multisig.block)]);
};

describe('the projection', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('a confirmed staple writes one operations row per operation and one block_details row per block, as decoded from its blocks', async function() {
		const context = await projectionFixture();

		await applyEveryOperation(context);

		const projection = await projectionOf(context.pool);
		expect(projection).toEqual(await decodedLedgerOf(context.pool));
		expect(typeNamesOf(projection)).toEqual(['CREATE_IDENTIFIER', 'MANAGE_CERTIFICATE', 'MODIFY_PERMISSIONS', 'RECEIVE', 'SEND', 'SET_INFO', 'SET_REP', 'TOKEN_ADMIN_MODIFY_BALANCE', 'TOKEN_ADMIN_SUPPLY']);
	});

	test('a side copy gets its rows only from the staple that promotes it', async function() {
		const context = await projectionFixture();
		const { network, storage, pool } = context;
		const voter = network.createLedger(new MemoryLedgerStorage(), requireAt(network.representatives, 0));
		await voter.add(network.genesis);
		const from = requireAt(network.users, 0);
		const send = await sendBlock({ from, previous: context.cursor.previous(from), to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, network: network.network });
		const transaction = await storage.beginTransaction({ identifier: 'pending', readOnly: false });
		await storage.addPendingVote(transaction, lib.Vote.Staple.fromVotesAndBlocks([await voter.vote([send])], [send]));
		await storage.commitTransaction(transaction);
		const copies = await pool.query<{ ledger: string }>('SELECT ledger FROM blocks WHERE hash = $1', [send.hash.getBuffer()]);
		expect(copies.rows).toEqual([{ ledger: 'side' }]);

		expect(Object.keys(await projectionOf(pool))).not.toContain(blockHashOf(send));

		await context.apply([send]);

		const projection = await projectionOf(pool);
		expect(Object.keys(projection)).toContain(blockHashOf(send));
		expect(projection).toEqual(await decodedLedgerOf(pool));
	});

	test('every account an operation names has an id when its staple lands', async function() {
		const context = await projectionFixture();

		await applyEveryOperation(context);

		const stored = await context.pool.query<{ bytes: Buffer }>('SELECT bytes FROM blocks WHERE ledger = \'main\'');
		const named = new Set(stored.rows.flatMap(function(row) {
			return(Array.from(addressesOf(decodeBlock(new lib.Block(row.bytes)))));
		}));
		const interned = await context.pool.query<{ public_key: string }>('SELECT public_key FROM accounts WHERE public_key = ANY($1::text[])', [Array.from(named)]);
		expect(interned.rows.map(function(row) {
			return(row.public_key);
		}).sort()).toEqual(Array.from(named).sort());
		expect(named).toContain(lib.Account.fromSeed('6b5a4c3d2e1f0a9b8c7d6e5f4a3b2c1d6b5a4c3d2e1f0a9b8c7d6e5f4a3b2c1d', 0).publicKeyString.get());
	});

	test('a staple naming an account the change did not intern is refused as an internal error naming the staple and the account', async function() {
		const context = await projectionFixture();
		const { network, cursor, pool } = context;
		const owner = requireAt(network.users, 0);
		// A multisig's signers are named only in the details of the operation that creates it.
		const newcomer = lib.Account.fromSeed('7c6b5a4d3e2f1a0b9c8d7e6f5a4b3c2d7c6b5a4d3e2f1a0b9c8d7e6f5a4b3c2d', 0);
		const multisig = await createMultisigBlock({ owner, signers: [newcomer, requireAt(network.users, 1)], quorum: 2n, previous: cursor.previous(owner), network: network.network });
		const staple = await confirmedStaple([multisig.block], network.representatives);
		interceptQueries(pool, async function(issued, run) {
			const result = await run();
			if (issued.name === 'ledger_intern_accounts') {
				const rows: unknown = Reflect.get(Object(result), 'rows');
				if (Array.isArray(rows)) {
					Reflect.set(Object(result), 'rows', rows.filter(function(row: { public_key?: unknown }) {
						return(row.public_key !== newcomer.publicKeyString.get());
					}));
				}
			}
			return(result);
		});

		await expect(context.ledger.add(staple)).rejects.toThrow(`internal error: staple ${staple.blocksHash.toString()} names account ${newcomer.publicKeyString.get()}, which was not interned`);

		expect(Object.keys(await projectionOf(pool))).not.toContain(blockHashOf(multisig.block));
	});

	test('a refused staple leaves no projection rows', async function() {
		const context = await projectionFixture();
		const { network, cursor, pool } = context;
		const first = requireAt(network.users, 0);
		const second = requireAt(network.users, 1);
		const sent = cursor.append(await sendBlock({ from: first, to: second, amount: 1n, token: network.baseToken, previous: cursor.previous(first), network: network.network }));
		await context.apply([sent]);
		const before = await projectionOf(pool);
		const fresh = await sendBlock({ from: second, to: first, amount: 1n, token: network.baseToken, previous: cursor.previous(second), network: network.network });

		await expect(context.apply([fresh, sent])).rejects.toMatchObject({ code: 'LEDGER_BLOCK_ALREADY_EXISTS' });

		expect(await projectionOf(pool)).toEqual(before);
	});

	test('a staple that fails after its rows are written leaves none of them', async function() {
		const context = await projectionFixture();
		const { network, cursor, pool } = context;
		const from = requireAt(network.users, 0);
		const send = await sendBlock({ from, to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, previous: cursor.previous(from), network: network.network });
		const before = await projectionOf(pool);
		failing(pool, function(text) {
			return(text === insertMainVotes.text);
		}, function() {
			return(serverError('XX000', 'the server failed'));
		});

		await expect(context.apply([send])).rejects.toThrow('the server failed');

		expect(await projectionOf(pool)).toEqual(before);
	});

	test('a block of several hundred operations is written in one statement per table', async function() {
		const context = await projectionFixture();
		const { network, cursor, pool } = context;
		const from = requireAt(network.users, 0);
		const recipients = network.users.slice(1);
		const block = await operationsBlock({
			account: from,
			previous: cursor.previous(from),
			network: network.network,
			operations: Array.from({ length: 300 }, function(_unused, index) {
				return({ type: lib.Block.OperationType.SEND, to: requireAt(recipients, index % recipients.length), amount: 1n, token: network.baseToken });
			})
		});
		const counted = new Map<string, number>();
		interceptQueries(pool, function(issued, run) {
			if (issued.name === insertBlockDetails.name || issued.name === insertOperations.name) {
				counted.set(issued.name, (counted.get(issued.name) ?? 0) + 1);
			}
			return(run());
		});

		await context.apply([block]);

		expect(Object.fromEntries(counted)).toEqual({ [insertBlockDetails.name]: 1, [insertOperations.name]: 1 });
		const projection = await projectionOf(pool);
		expect(projection[blockHashOf(block)]?.operations).toHaveLength(300);
		expect(projection).toEqual(await decodedLedgerOf(pool));
	});

	test('a block a multisig signs has the multisig as its signer', async function() {
		const context = await projectionFixture();
		const { network, cursor, pool } = context;
		const owner = requireAt(network.users, 0);
		const signers = [lib.Account.fromSeed(NEWCOMER_SEED, 1), lib.Account.fromSeed(NEWCOMER_SEED, 2)];
		const { block: creation, multisig } = await createMultisigBlock({ owner, signers, quorum: 2n, previous: cursor.previous(owner), network: network.network });
		cursor.append(creation);
		const delegated = cursor.append(await modifyPermissionsBlock({ account: owner, previous: cursor.previous(owner), network: network.network, principal: multisig, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['SEND_ON_BEHALF']), target: network.baseToken }));
		await context.apply([creation, delegated]);
		advanceClock(1000);
		const signed = cursor.append(await multisigSendBlock({ from: owner, signer: [multisig, signers], to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, previous: cursor.previous(owner), network: network.network }));

		await context.apply([signed]);

		const projection = await projectionOf(pool);
		expect(projection[blockHashOf(signed)]?.signer).toBe(multisig.publicKeyString.get());
		expect(projection).toEqual(await decodedLedgerOf(pool));
	});

	// No block upstream validates carries a NUL in its details, so the rows are built from a decoded block that does.
	test('a NUL in the details of an operation is written as U+FFFD, which jsonb accepts', async function() {
		const { network, pool } = await projectionFixture();
		const account = requireAt(network.users, 0).publicKeyString.get() as Address;
		const interned = await pool.query<{ id: AccountID; public_key: string }>('SELECT id, public_key FROM accounts WHERE public_key = $1', [account]);
		const ids = new Map(interned.rows.map(function(row): [string, AccountID] {
			return([row.public_key, row.id]);
		}));
		const block: DecodedBlock = {
			account,
			signer: account,
			date: GENESIS_MOMENT,
			version: 1,
			purpose: 0,
			operations: [{ index: 0, type: 'SET_INFO', account, counterparty: null, token: null, amount: null, details: { name: 'A\u0000B', 'note\u0000': ['C\u0000D', 'plain'], exact: true, quorum: null } }]
		};
		const hash = Buffer.alloc(32, 1);
		const { operations } = projectionRowsOf([{ blocksHash: 'FF'.repeat(32), stapleTime: GENESIS_MOMENT, blocks: [{ hash, decoded: block }] }], ids);

		await pool.query({ text: insertOperations.text, values: operations });

		const stored = await pool.query<{ details: unknown }>('SELECT details FROM operations WHERE block_hash = $1', [hash]);
		expect(stored.rows).toEqual([{ details: { name: 'A\uFFFDB', 'note\uFFFD': ['C\uFFFDD', 'plain'], exact: true, quorum: null } }]);
	});

	test('a ledger built from genesis has rows for every staple, and complete_from at its first', async function() {
		const context = await projectionFixture();
		const { network, cursor, pool } = context;
		for (const [index, from] of network.users.entries()) {
			const to = requireAt(network.users, (index + 1) % network.users.length);
			await context.apply([cursor.append(await sendBlock({ from, to, amount: 1n, token: network.baseToken, previous: cursor.previous(from), network: network.network }))]);
		}

		const staples = await pool.query<{ blocks_hash: Buffer; sequence: string; blocks: string; described: string; operations: string; projected: string }>(`
			SELECT staples.blocks_hash, staples.sequence::text AS sequence, count(blocks.hash)::text AS blocks, count(block_details.hash)::text AS described,
				coalesce(sum(blocks.operation_count), 0)::text AS operations,
				(SELECT count(*) FROM operations JOIN blocks main ON main.hash = operations.block_hash WHERE main.staple = staples.blocks_hash)::text AS projected
			FROM staples
			JOIN blocks ON blocks.staple = staples.blocks_hash AND blocks.ledger = 'main'
			LEFT JOIN block_details ON block_details.hash = blocks.hash
			GROUP BY staples.blocks_hash, staples.sequence
			ORDER BY staples.sequence`);
		expect(staples.rows).toHaveLength(network.users.length + 1);
		expect(requireAt(staples.rows, 0).blocks_hash).toEqual(network.genesis.blocksHash.getBuffer());
		for (const staple of staples.rows) {
			expect([staple.described, staple.projected]).toEqual([staple.blocks, staple.operations]);
		}
		expect(await projectionOf(pool)).toEqual(await decodedLedgerOf(pool));
		const backfill = await pool.query<{ complete_from: string }>('SELECT complete_from::text AS complete_from FROM projection_backfill');
		expect(backfill.rows).toEqual([{ complete_from: requireAt(staples.rows, 0).sequence }]);
	});
});

describe('the projection backfill', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('a backfill writes the rows of every staple below complete_from, newest first, and lowers it to the oldest', async function() {
		const context = await projectionFixture();
		const { pool, storage } = context;
		await applyEveryOperation(context);
		await applySends(context, BACKFILL_BATCH_STAPLES);
		const sequences = await sequencesOf(pool);
		const operations = await operationCountOf(pool);
		await asMigrated(pool);
		const newest = sequences.slice(-BACKFILL_BATCH_STAPLES);
		const progress: { readonly done: ProjectionBackfill; readonly filled: readonly bigint[] }[] = [];

		const done = await storage.backfillProjection(async function(reached) {
			progress.push({ done: reached, filled: await filledOf(pool) });
		});

		const oldest = requireAt(sequences, 0);
		expect(progress.map(function({ done: reached }) {
			return([reached.completeFrom, reached.staples]);
		})).toEqual([[requireAt(newest, 0), BACKFILL_BATCH_STAPLES], [oldest, sequences.length]]);
		expect(requireAt(progress, 0).filled).toEqual(newest);
		expect(done).toEqual({ completeFrom: oldest, staples: sequences.length, operations });
		expect(await completeFromOf(pool)).toBe(oldest);
		expect(await projectionOf(pool)).toEqual(await decodedLedgerOf(pool));
	});

	test('a backfill stopped after a batch resumes below the staple it reached', async function() {
		const context = await projectionFixture();
		const { pool, storage } = context;
		await applyEveryOperation(context);
		await applySends(context, BACKFILL_BATCH_STAPLES);
		const sequences = await sequencesOf(pool);
		await asMigrated(pool);
		const newest = sequences.slice(-BACKFILL_BATCH_STAPLES);

		await expect(storage.backfillProjection(function() {
			return(Promise.reject(new Error('stopped')));
		})).rejects.toThrow('stopped');
		expect(await completeFromOf(pool)).toBe(requireAt(newest, 0));
		expect(await filledOf(pool)).toEqual(newest);

		const resumed = await storage.backfillProjection();

		expect(resumed).toMatchObject({ completeFrom: requireAt(sequences, 0), staples: sequences.length - BACKFILL_BATCH_STAPLES });
		expect(await projectionOf(pool)).toEqual(await decodedLedgerOf(pool));
	});

	test('two backfills at once write each row once', async function() {
		const context = await projectionFixture();
		const { pool, storage } = context;
		await applyEveryOperation(context);
		await applySends(context, BACKFILL_BATCH_STAPLES);
		const sequences = await sequencesOf(pool);
		const operations = await operationCountOf(pool);
		await asMigrated(pool);
		const rival = injectedStorageOn(pool);

		const both = await Promise.all([storage.backfillProjection(), rival.backfillProjection()]);

		const oldest = requireAt(sequences, 0);
		expect(both.map(function(done) {
			return(done.completeFrom);
		})).toEqual([oldest, oldest]);
		expect(await completeFromOf(pool)).toBe(oldest);
		expect(await rowCountsOf(pool)).toEqual({ blocks: await mainBlockCountOf(pool), operations });
		expect(await projectionOf(pool)).toEqual(await decodedLedgerOf(pool));
	});

	test('a backfill beside staples being confirmed writes each row once, and leaves the live staples\' rows as they were', async function() {
		const context = await projectionFixture();
		const { pool, storage, network, cursor } = context;
		await applyEveryOperation(context);
		await applySends(context, BACKFILL_BATCH_STAPLES);
		const sequences = await sequencesOf(pool);
		await asMigrated(pool);
		const live: { readonly hash: string; readonly rows: unknown }[] = [];

		const done = await storage.backfillProjection(async function() {
			const from = requireAt(network.users, live.length);
			const block = cursor.append(await sendBlock({ from, to: requireAt(network.users, live.length + 1), amount: 1n, token: network.baseToken, previous: cursor.previous(from), network: network.network }));
			await context.apply([block]);
			live.push({ hash: blockHashOf(block), rows: (await projectionOf(pool))[blockHashOf(block)] });
		});

		expect(live).toHaveLength(2);
		const projection = await projectionOf(pool);
		for (const { hash, rows } of live) {
			expect(projection[hash]).toEqual(rows);
		}
		expect(done).toMatchObject({ completeFrom: requireAt(sequences, 0), staples: sequences.length });
		expect(await rowCountsOf(pool)).toEqual({ blocks: await mainBlockCountOf(pool), operations: await operationCountOf(pool) });
		expect(projection).toEqual(await decodedLedgerOf(pool));
	});

	test('a backfill fills a staple above complete_from whose rows are missing, as one an older build stored after the migration would be', async function() {
		const context = await projectionFixture();
		const { pool, storage, network, cursor } = context;
		await applyEveryOperation(context);
		const migrated = (await sequencesOf(pool)).length;
		const migratedOperations = await operationCountOf(pool);
		const migratedFrom = await asMigrated(pool);
		const from = requireAt(network.users, 0);
		// The first staple stored after the migration, by a build that writes no rows.
		const old = cursor.append(await sendBlock({ from, to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, previous: cursor.previous(from), network: network.network }));
		await context.apply([old]);
		await pool.query('DELETE FROM operations WHERE block_hash = $1', [old.hash.getBuffer()]);
		await pool.query('DELETE FROM block_details WHERE hash = $1', [old.hash.getBuffer()]);
		await applySends(context, 2);
		expect(requireAt(await sequencesOf(pool), migrated)).toBe(migratedFrom);

		const done = await storage.backfillProjection();

		expect(done).toEqual({ completeFrom: requireAt(await sequencesOf(pool), 0), staples: migrated + 1, operations: migratedOperations + old.operations.length });
		expect(await projectionOf(pool)).toEqual(await decodedLedgerOf(pool));
		expect(await storage.backfillProjection()).toEqual({ completeFrom: done.completeFrom, staples: 0, operations: 0 });
	});

	test('a backfill whose batch fails writes none of it, and leaves complete_from where it was', async function() {
		const context = await projectionFixture();
		const { pool, storage } = context;
		await applyEveryOperation(context);
		const migratedFrom = await asMigrated(pool);
		failing(pool, function(text) {
			return(text === backfillOperations.text);
		}, function() {
			return(serverError('XX000', 'the server failed'));
		});

		await expect(storage.backfillProjection()).rejects.toThrow('the server failed');

		expect(await projectionOf(pool)).toEqual({});
		expect(await completeFromOf(pool)).toBe(migratedFrom);
	});

	test('backfilled rows equal the rows the live path wrote for the same staples', async function() {
		const context = await projectionFixture();
		const { pool, storage } = context;
		await applyEveryOperation(context);
		await applySends(context, 2);
		const live = await projectionOf(pool);
		await asMigrated(pool);
		expect(await projectionOf(pool)).toEqual({});

		await storage.backfillProjection();

		expect(await projectionOf(pool)).toEqual(live);
	});

	test('a backfill that meets an address with no id stops, names the staple and the address, and writes nothing for that batch', async function() {
		const context = await projectionFixture();
		const { pool, storage } = context;
		await applyEveryOperation(context);
		const migratedFrom = await asMigrated(pool);
		// The last staple creates a multisig whose first signer only its details name.
		const newcomer = lib.Account.fromSeed('6b5a4c3d2e1f0a9b8c7d6e5f4a3b2c1d6b5a4c3d2e1f0a9b8c7d6e5f4a3b2c1d', 0).publicKeyString.get();
		const naming = await pool.query<{ blocks_hash: Buffer }>('SELECT blocks_hash FROM staples ORDER BY sequence DESC LIMIT 1');
		interceptQueries(pool, async function(issued, run) {
			const result = await run();
			if (issued.name === 'ledger_account_ids_of') {
				const rows: unknown = Reflect.get(Object(result), 'rows');
				if (Array.isArray(rows)) {
					Reflect.set(Object(result), 'rows', rows.filter(function(row: { public_key?: unknown }) {
						return(row.public_key !== newcomer);
					}));
				}
			}
			return(result);
		});

		await expect(storage.backfillProjection()).rejects.toThrow(`internal error: staple ${requireAt(naming.rows, 0).blocks_hash.toString('hex').toUpperCase()} names account ${newcomer}, which was not interned`);

		expect(await projectionOf(pool)).toEqual({});
		expect(await completeFromOf(pool)).toBe(migratedFrom);
	});
});

/** A staple of one send for each, among the users in turn. */
const applySends = async function(context: ProjectionFixture, count: number): Promise<void> {
	const { network, cursor } = context;
	for (let index = 0; index < count; index++) {
		const from = requireAt(network.users, index % network.users.length);
		const to = requireAt(network.users, (index + 1) % network.users.length);
		await context.apply([cursor.append(await sendBlock({ from, to, amount: 1n, token: network.baseToken, previous: cursor.previous(from), network: network.network }))]);
	}
};

/** The ledger as the projection's migration leaves one that held these staples: no rows, and complete from after the newest. */
const asMigrated = async function(pool: pg.Pool): Promise<bigint> {
	await pool.query('DELETE FROM operations');
	await pool.query('DELETE FROM block_details');
	await pool.query('UPDATE projection_backfill SET complete_from = (SELECT max(sequence) + 1 FROM staples)');
	return(await completeFromOf(pool));
};

const completeFromOf = async function(pool: pg.Pool): Promise<bigint> {
	const rows = await pool.query<{ complete_from: string }>('SELECT complete_from::text AS complete_from FROM projection_backfill');
	return(BigInt(requireAt(rows.rows, 0).complete_from));
};

const sequencesOf = async function(pool: pg.Pool): Promise<bigint[]> {
	const rows = await pool.query<{ sequence: string }>('SELECT sequence::text AS sequence FROM staples ORDER BY staples.sequence');
	return(rows.rows.map(function(row) {
		return(BigInt(row.sequence));
	}));
};

/** The staples that have rows of their blocks, oldest first. */
const filledOf = async function(pool: pg.Pool): Promise<bigint[]> {
	const rows = await pool.query<{ sequence: string }>(`
		SELECT DISTINCT staples.sequence::text AS sequence, staples.sequence AS position
		FROM block_details JOIN blocks ON blocks.hash = block_details.hash JOIN staples ON staples.blocks_hash = blocks.staple
		ORDER BY position`);
	return(rows.rows.map(function(row) {
		return(BigInt(row.sequence));
	}));
};

const operationCountOf = async function(pool: pg.Pool): Promise<number> {
	const rows = await pool.query<{ count: string }>('SELECT coalesce(sum(operation_count), 0)::text AS count FROM blocks WHERE ledger = \'main\'');
	return(Number(requireAt(rows.rows, 0).count));
};

const mainBlockCountOf = async function(pool: pg.Pool): Promise<number> {
	const rows = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM blocks WHERE ledger = \'main\'');
	return(Number(requireAt(rows.rows, 0).count));
};

const rowCountsOf = async function(pool: pg.Pool): Promise<{ readonly blocks: number; readonly operations: number }> {
	const rows = await pool.query<{ blocks: string; operations: string }>('SELECT (SELECT count(*) FROM block_details)::text AS blocks, (SELECT count(*) FROM operations)::text AS operations');
	const row = requireAt(rows.rows, 0);
	return({ blocks: Number(row.blocks), operations: Number(row.operations) });
};
