import { afterEach, describe, expect, inject, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type pg from 'pg';
import { createTestNetwork, freezeClock } from '../../../testing/network.js';
import { createDatabase } from '../../../testing/postgres.js';
import { DEFAULT_WEIGHTS, GENESIS_MOMENT, requireAt } from '../suite/support.js';
import { PostgresLedgerStorage } from './driver.js';

const lib = KeetaNet.lib;

// The tables of schema/CONTRACT.md, section 6.5.
const KEY_TYPES = { ECDSA_SECP256K1: 0, ED25519: 1, NETWORK: 2, TOKEN: 3, STORAGE: 4, ECDSA_SECP256R1: 6, MULTISIG: 7 } as const;
const BASE_FLAG_BITS = {
	ACCESS: 0, OWNER: 1, ADMIN: 2, UPDATE_INFO: 3, SEND_ON_BEHALF: 4, TOKEN_ADMIN_CREATE: 5, TOKEN_ADMIN_SUPPLY: 6, TOKEN_ADMIN_MODIFY_BALANCE: 7,
	STORAGE_CREATE: 8, STORAGE_CAN_HOLD: 9, STORAGE_DEPOSIT: 10, PERMISSION_DELEGATE_ADD: 11, PERMISSION_DELEGATE_REMOVE: 12, MANAGE_CERTIFICATE: 13, MULTISIG_SIGNER: 14
} as const;
const ZLIB_DEFLATE_METHOD = 8;

const HASH = Buffer.alloc(32, 0xab);

const ledgerPool = async function(): Promise<pg.Pool> {
	const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	onTestFinished(function() {
		return(database.drop());
	});
	return(database.pool());
};

const failureOf = async function(attempt: Promise<unknown>): Promise<unknown> {
	return(await attempt.then(function(): never {
		throw(new Error('expected the statement to fail'));
	}, function(error: unknown) {
		return(error);
	}));
};

describe('the Postgres schema', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('every moment the migrations store is a whole number of milliseconds', async function() {
		const pool = await ledgerPool();

		const columns = await pool.query<{ table_name: string; column_name: string; domain_name: string | null }>(`
			SELECT table_name, column_name, domain_name FROM information_schema.columns
			WHERE table_schema = 'public' AND data_type = 'timestamp with time zone' AND table_name <> 'schema_version'
			ORDER BY table_name, column_name`);

		expect(columns.rows.length).toBeGreaterThan(0);
		for (const column of columns.rows) {
			expect(column.domain_name, `${column.table_name}.${column.column_name}`).toBe('timestamptz_ms');
		}
	});

	test('a moment with a fraction of a millisecond is refused, and a whole millisecond is stored', async function() {
		const pool = await ledgerPool();

		const refused = await failureOf(pool.query('INSERT INTO staples (blocks_hash, staple_time, moment) VALUES ($1, $2, $2)', [HASH, '2026-10-07 12:00:00.0005+00']));
		await pool.query('INSERT INTO staples (blocks_hash, staple_time, moment) VALUES ($1, $2, $2)', [HASH, '2026-10-07 12:00:00.123+00']);

		expect(refused).toMatchObject({ code: '23514' });
		const stored = await pool.query<{ moment: Date }>('SELECT moment FROM staples');
		expect(stored.rows).toEqual([{ moment: new Date('2026-10-07T12:00:00.123Z') }]);
	});

	test('upstream numbers key types and base flags as the column formats state', function() {
		for (const [name, value] of Object.entries(KEY_TYPES)) {
			expect(lib.Account.AccountKeyAlgorithm[name as keyof typeof KEY_TYPES], name).toBe(value);
		}
		for (const [flag, bit] of Object.entries(BASE_FLAG_BITS)) {
			// A set holding any flag also holds ACCESS.
			expect(new lib.Permissions([flag as keyof typeof BASE_FLAG_BITS]).base.bigint, flag).toBe((1n << BigInt(bit)) | 1n);
		}
	});

	test('a confirmed staple is stored in the column formats the contract states', async function() {
		const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
		onTestFinished(function() {
			return(database.drop());
		});
		const storage = new PostgresLedgerStorage({ kind: 'connection-string', connectionString: database.connectionString });
		onTestFinished(function() {
			return(storage.destroy());
		});
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		await network.createLedger(storage, requireAt(network.representatives, 0)).add(network.genesis);
		const pool = database.pool();

		const blocks = await pool.query<{ hash: Buffer; bytes: Buffer; operation_count: number }>('SELECT hash, bytes, operation_count FROM blocks');
		const votes = await pool.query<{ uid: string; bytes: Buffer }>('SELECT uid, bytes FROM votes');
		const accounts = await pool.query<{ public_key: string; key_type: number }>('SELECT public_key, key_type FROM accounts');

		expect(blocks.rows).toHaveLength(network.genesis.blocks.length);
		for (const block of network.genesis.blocks) {
			expect(blocks.rows).toContainEqual({ hash: block.hash.getBuffer(), bytes: Buffer.from(block.toBytes()), operation_count: block.operations.length });
		}
		expect(votes.rows).toHaveLength(network.genesis.votes.length);
		for (const vote of network.genesis.votes) {
			const uid = `ID=${vote.issuer.publicKeyString.get()}/Serial=${vote.serial.toString(10)}`;
			expect(vote.$uid).toBe(uid);
			expect(votes.rows).toContainEqual({ uid, bytes: Buffer.from(vote.toBytes()) });
		}
		for (const row of accounts.rows) {
			expect(row.key_type, row.public_key).toBe(lib.Account.fromPublicKeyString(row.public_key).keyType);
		}
		const staples = await pool.query<{ bytes: Buffer }>('SELECT bytes FROM staples');
		expect(staples.rows).toEqual([{ bytes: Buffer.from(network.genesis.toBytes()) }]);
		const stapleBytes = Buffer.from(network.genesis.toBytes());
		expect(stapleBytes.readUInt8(0) & 0x0f).toBe(ZLIB_DEFLATE_METHOD);
		expect(stapleBytes.readUInt16BE(0) % 31).toBe(0);
	});
});
