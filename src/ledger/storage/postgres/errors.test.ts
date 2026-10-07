import { describe, expect, inject, onTestFinished, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import pg from 'pg';
import { createDatabase } from '../../../testing/postgres.js';
import { mapDatabaseError } from './errors.js';

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

/** One row in every table whose rows two processes can race to insert, and a balance. */
const insertOneOfEach = async function(pool: pg.Pool): Promise<Readonly<Record<string, () => Promise<unknown>>>> {
	const statements = {
		accounts: ['INSERT INTO accounts (public_key, key_type) VALUES (\'keeta_probe\', 0)', []],
		staples: ['INSERT INTO staples (blocks_hash, staple_time, moment) VALUES ($1, $2, $2)', [HASH, MOMENT]],
		blocks: ['INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position) VALUES ($1, \'main\', 1, $2, 1, \'\\x00\', $1, 0)', [HASH, PREVIOUS]],
		votes: ['INSERT INTO votes (ledger, uid, blocks_hash, issuer_id, validity_from, validity_to, permanent, bytes) VALUES (\'main\', \'probe\', $1, 1, $2, $2, true, \'\\x00\')', [HASH, MOMENT]],
		idempotent_keys: ['INSERT INTO idempotent_keys (key, ledger, block_hash) VALUES ($1, \'main\', $1)', [HASH]],
		balances: ['INSERT INTO balances (account_id, token_id, balance) VALUES (1, 1, 0)', []]
	} as const;
	const again: Record<string, () => Promise<unknown>> = {};
	for (const [table, [text, values]] of Object.entries(statements)) {
		await pool.query(text, [...values]);
		again[table] = function() {
			return(pool.query(text, [...values]));
		};
	}
	return(again);
};

const expectRetryable = function(error: unknown): void {
	const mapped = mapDatabaseError(error);
	expect(mapped.kind).toBe('conflict');
	expect(lib.Error.isInstance(mapped.error)).toBe(true);
	expect(mapped.error).toMatchObject({ type: 'LEDGER', code: 'LEDGER_TRANSACTION_ABORTED', shouldRetry: true });
	expect(mapped.error).toHaveProperty('cause', error);
};

const expectUnchanged = function(error: unknown): void {
	expect(mapDatabaseError(error)).toEqual({ kind: 'other', error });
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

	test('a unique violation (23505) is a retryable conflict only where a concurrent insert of the same row is expected', async function() {
		const pool = await ledgerPool();
		const again = await insertOneOfEach(pool);
		const failures: Record<string, unknown> = {};
		for (const [table, insert] of Object.entries(again)) {
			failures[table] = await failureOf(insert());
		}

		for (const table of ['accounts', 'staples', 'blocks', 'votes', 'idempotent_keys']) {
			expect(failures[table], table).toMatchObject({ code: '23505', table });
			expectRetryable(failures[table]);
		}
		expect(failures['balances']).toMatchObject({ code: '23505', table: 'balances' });
		expectUnchanged(failures['balances']);
	});

	test('a terminated connection and other errors are returned unchanged', async function() {
		const pool = await ledgerPool();
		const victim = await pool.connect();
		victim.on('error', function() {
			// The server ends the session; the query below reports it.
		});
		const { rows } = await victim.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
		await pool.query('SELECT pg_terminate_backend($1, 5000)', [rows[0]?.pid]);

		const terminated = await failureOf(victim.query('SELECT 1'));
		victim.release(true);

		expectUnchanged(terminated);
		expectUnchanged(new Error('disk on fire'));
		expectUnchanged('not even an error');
	});
});
