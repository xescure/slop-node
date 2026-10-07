import { describe, expect, inject, onTestFinished, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import pg from 'pg';
import { createDatabase } from '../../../testing/postgres.js';
import { PostgresLedgerStorage } from './driver.js';
import { CONFLICT_MESSAGE, mapDatabaseError } from './errors.js';
import type { FailedStatement } from './errors.js';

const lib = KeetaNet.lib;

const MOMENT = new Date('2026-10-07T12:00:00.000Z');
const HASH = Buffer.alloc(32, 0xab);
const PREVIOUS = Buffer.alloc(32, 0xcd);

const ledgerPool = async function(): Promise<pg.Pool> {
	const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	onTestFinished(function() {
		return(database.drop());
	});
	return(database.pool());
};

/** The error a query raises; a query that succeeds fails the test. */
const failureOf = async function(attempt: Promise<unknown>): Promise<unknown> {
	return(await attempt.then(function(): never {
		throw(new Error('expected the query to fail'));
	}, function(error: unknown) {
		return(error);
	}));
};

const OTHER = Buffer.alloc(32, 0xef);
const THIRD = Buffer.alloc(32, 0x12);

type Statement = readonly [text: string, values: readonly unknown[]];

/** A ledger with one row of each kind that two processes can race to insert. */
const SETUP: readonly Statement[] = [
	['INSERT INTO accounts (public_key, key_type) VALUES (\'keeta_probe\', 0)', []],
	['INSERT INTO staples (blocks_hash, staple_time, moment) VALUES ($1, $2, $2)', [HASH, MOMENT]],
	['INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position) VALUES ($1, \'main\', 1, $2, 1, \'\\x00\', $1, 0)', [HASH, PREVIOUS]],
	['INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes) VALUES ($1, \'side\', 1, $1, 1, \'\\x00\')', [OTHER]],
	['INSERT INTO votes (ledger, uid, blocks_hash, issuer_id, validity_from, validity_to, permanent, bytes) VALUES (\'main\', \'probe\', $1, 1, $2, $2, true, \'\\x00\')', [HASH, MOMENT]],
	['INSERT INTO votes (ledger, uid, blocks_hash, issuer_id, validity_from, validity_to, permanent, bytes) VALUES (\'side\', \'probe\', $1, 1, $2, $2, false, \'\\x00\')', [OTHER, MOMENT]],
	['INSERT INTO idempotent_keys (key, ledger, block_hash) VALUES ($1, \'main\', $1)', [HASH]],
	['INSERT INTO balances (account_id, token_id, balance) VALUES (1, 1, 0)', []]
];

/** For each unique constraint, an insert that violates it. */
const VIOLATIONS: Readonly<Record<string, Statement>> = {
	staples_pkey: ['INSERT INTO staples (blocks_hash, staple_time, moment) VALUES ($1, $2, $2)', [HASH, MOMENT]],
	blocks_pkey: ['INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes) VALUES ($1, \'side\', 1, $2, 1, \'\\x00\')', [HASH, THIRD]],
	blocks_main_successor: ['INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position) VALUES ($1, \'main\', 1, $2, 1, \'\\x00\', $3, 1)', [THIRD, PREVIOUS, HASH]],
	votes_main: ['INSERT INTO votes (ledger, uid, blocks_hash, issuer_id, validity_from, validity_to, permanent, bytes) VALUES (\'main\', \'probe\', $1, 1, $2, $2, true, \'\\x00\')', [HASH, MOMENT]],
	votes_side: ['INSERT INTO votes (ledger, uid, blocks_hash, issuer_id, validity_from, validity_to, permanent, bytes) VALUES (\'side\', \'probe\', $1, 1, $2, $2, false, \'\\x00\')', [HASH, MOMENT]],
	idempotent_keys_main: ['INSERT INTO idempotent_keys (key, ledger, block_hash) VALUES ($1, \'main\', $2)', [HASH, OTHER]],
	accounts_public_key_key: ['INSERT INTO accounts (public_key, key_type) VALUES (\'keeta_probe\', 0)', []],
	balances_pkey: ['INSERT INTO balances (account_id, token_id, balance) VALUES (1, 1, 0)', []]
};

const BEFORE_COMMIT: FailedStatement = { kind: 'before-commit', connectionLost: false };
const COMMIT: FailedStatement = { kind: 'commit' };

const expectRetryable = function(error: unknown, statement: FailedStatement = BEFORE_COMMIT): void {
	const mapped = mapDatabaseError(error, statement);
	expect(mapped.kind).toBe('conflict');
	expect(lib.Error.isInstance(mapped.error)).toBe(true);
	expect(mapped.error).toMatchObject({ type: 'LEDGER', code: 'LEDGER_TRANSACTION_ABORTED', shouldRetry: true });
	expect(mapped.error).toHaveProperty('cause', error);
	// Ledger.run rethrows the last conflict once its retries run out, and the API answers it as a refusal.
	expect(mapped.error).toHaveProperty('message', CONFLICT_MESSAGE);
	if (error instanceof Error) {
		expect(CONFLICT_MESSAGE).not.toContain(error.message);
	}
};

const expectUnchanged = function(error: unknown, statement: FailedStatement = BEFORE_COMMIT): void {
	expect(mapDatabaseError(error, statement)).toEqual({ kind: 'other', error });
};

/** A pooled connection whose session another connection ends, and whose errors the test reads from its statements. */
const sessionToEnd = async function(pool: pg.Pool): Promise<{ readonly victim: pg.PoolClient; readonly end: () => Promise<unknown> }> {
	const victim = await pool.connect();
	onTestFinished(function() {
		victim.release(true);
	});
	victim.on('error', function() {
		// The server ends the session; the statements report it.
	});
	const { rows } = await victim.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
	return({
		victim,
		end: function() {
			return(pool.query('SELECT pg_terminate_backend($1, 5000)', [rows[0]?.pid]));
		}
	});
};

describe('mapDatabaseError', function() {
	test('a serialization failure (40001) is a retryable conflict', async function() {
		const pool = await ledgerPool();
		await pool.query('INSERT INTO accounts (public_key, key_type) VALUES (\'keeta_probe\', 0)');
		const reader = await pool.connect();
		try {
			await reader.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
			await reader.query('SELECT key_type FROM accounts');
			await pool.query('UPDATE accounts SET key_type = 1');

			const error = await failureOf(reader.query('UPDATE accounts SET key_type = 2'));

			expect(error).toMatchObject({ code: '40001' });
			expectRetryable(error);
		} finally {
			await reader.query('ROLLBACK');
			reader.release();
		}
	});

	test('a deadlock (40P01) is a retryable conflict', async function() {
		const pool = await ledgerPool();
		await pool.query('INSERT INTO accounts (public_key, key_type) VALUES (\'keeta_first\', 0), (\'keeta_second\', 0)');
		const first = await pool.connect();
		const second = await pool.connect();
		try {
			for (const client of [first, second]) {
				// Detection then runs as soon as the second lock wait begins.
				await client.query('SET deadlock_timeout = 1');
				await client.query('BEGIN');
			}
			await first.query('UPDATE accounts SET key_type = 1 WHERE public_key = \'keeta_first\'');
			await second.query('UPDATE accounts SET key_type = 1 WHERE public_key = \'keeta_second\'');
			const waiting = first.query('UPDATE accounts SET key_type = 2 WHERE public_key = \'keeta_second\'').then(function() {
				return(undefined);
			}, function(error: unknown) {
				return(error);
			});
			const crossing = second.query('UPDATE accounts SET key_type = 2 WHERE public_key = \'keeta_first\'').then(function() {
				return(undefined);
			}, function(error: unknown) {
				return(error);
			});

			const errors = (await Promise.all([waiting, crossing])).filter(function(error) {
				return(error !== undefined);
			});

			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({ code: '40P01' });
			expectRetryable(errors[0]);
		} finally {
			for (const client of [first, second]) {
				await client.query('ROLLBACK');
				client.release();
			}
		}
	});

	test('a unique violation (23505) is a retryable conflict only on a constraint two processes can race to', async function() {
		const pool = await ledgerPool();
		for (const [text, values] of SETUP) {
			await pool.query(text, [...values]);
		}
		const failures: Record<string, unknown> = {};
		for (const [constraint, [text, values]] of Object.entries(VIOLATIONS)) {
			failures[constraint] = await failureOf(pool.query(text, [...values]));
			expect(failures[constraint], constraint).toMatchObject({ code: '23505', constraint });
		}

		for (const constraint of ['staples_pkey', 'blocks_pkey', 'blocks_main_successor', 'votes_main', 'votes_side', 'idempotent_keys_main']) {
			expectRetryable(failures[constraint]);
		}
		// Interning skips existing rows, and under SERIALIZABLE a row it cannot see yet fails with 40001 instead.
		expectUnchanged(failures['accounts_public_key_key']);
		expectUnchanged(failures['balances_pkey']);
		const unused = new PostgresLedgerStorage({ kind: 'connection-string', connectionString: 'postgresql://unused' });
		expect(await unused.evaluateError(failures['balances_pkey'])).toMatchObject({ code: 'LEDGER_OTHER', shouldRetry: false });
	});

	test('a session the server ends during a statement is a retryable conflict before COMMIT and unchanged at COMMIT', async function() {
		const pool = await ledgerPool();
		const { victim } = await sessionToEnd(pool);

		// The session ends itself, so its own statement is running when the server ends it.
		const terminated = await failureOf(victim.query('SELECT pg_terminate_backend(pg_backend_pid())'));

		expect(terminated).toMatchObject({ code: '57P01' });
		expectRetryable(terminated);
		expectUnchanged(terminated, COMMIT);
	});

	test('a statement on a connection already reported lost is a retryable conflict before COMMIT and unchanged at COMMIT', async function() {
		const pool = await ledgerPool();
		const { victim, end } = await sessionToEnd(pool);
		await end();

		const failed = await failureOf(victim.query('SELECT 1'));

		expectRetryable(failed, { kind: 'before-commit', connectionLost: true });
		expectUnchanged(failed, COMMIT);
	});

	test('a connection exception (class 08) is a retryable conflict only before COMMIT', function() {
		const failure = new pg.DatabaseError('connection failure', 0, 'error');
		failure.code = '08006';

		expectRetryable(failure);
		expectUnchanged(failure, COMMIT);
	});

	test('a session ended for idling in its transaction is a retryable conflict only before COMMIT', function() {
		const failure = new pg.DatabaseError('terminating connection due to idle-in-transaction timeout', 0, 'error');
		failure.code = '25P03';

		expectRetryable(failure);
		expectUnchanged(failure, COMMIT);
	});

	test('other errors are returned unchanged', function() {
		expectUnchanged(new Error('disk on fire'));
		expectUnchanged('not even an error');
	});
});
