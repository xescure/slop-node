import { readFile } from 'node:fs/promises';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import pg from 'pg';
import { inject, onTestFinished } from 'vitest';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import { ChainCursor, DEFAULT_WEIGHTS, GENESIS_MOMENT, requireAt } from '../ledger/storage/suite/support.js';
import { confirmedStaple, createTokenBlock, sendBlock, setInfoBlock, tokenSupplyBlock } from '../testing/blocks.js';
import { createTestNetwork, freezeClock, type TestNetwork } from '../testing/network.js';
import { createDatabase } from '../testing/postgres.js';
import type { ClusterConnection, TestDatabase } from '../testing/postgres.js';
import { DEFAULT_INDEXER_SETTINGS, indexBatch, startingState } from './indexer.js';
import { applyExplorerMigrations } from './migrations.js';

const lib = KeetaNet.lib;

const EXPLORER_SETUP = new URL('../../schema/explorer/setup.sql', import.meta.url);

/*
 * Roles and their settings belong to the whole cluster, which every test file
 * shares while they run in parallel, and two sessions that create or alter
 * one role at once fail. An advisory lock is scoped to its database, so the
 * setups of the test databases serialize on one held in the cluster's
 * maintenance database.
 */
const SETUP_LOCK_KEY = 0x6b65657461736574n;

const MAINTENANCE_DATABASE = 'postgres';

const ROLES = ['explorer_writer', 'explorer_reader'] as const;

type Role = typeof ROLES[number];

/*
 * The test cluster trusts every local connection, so the roles log in without
 * a password. Their connection limits are lifted because every test file in
 * the run logs in as the same two roles at once.
 */
const TEST_LOGIN = ROLES.map(function(role) {
	return(`ALTER ROLE ${role} LOGIN CONNECTION LIMIT -1;`);
}).join('\n');

const runSetup = async function(cluster: ClusterConnection, admin: pg.Pool): Promise<void> {
	const setup = await readFile(EXPLORER_SETUP, 'utf-8');
	const maintenance = new pg.Client({ host: cluster.socketDirectory, port: cluster.port, user: cluster.user, database: MAINTENANCE_DATABASE });
	await maintenance.connect();
	try {
		await maintenance.query('BEGIN');
		await maintenance.query('SELECT pg_advisory_xact_lock($1::bigint)', [SETUP_LOCK_KEY.toString()]);
		// One simple query runs as one transaction, so the setup lands whole
		// before the lock is released.
		await admin.query(`${setup}\n${TEST_LOGIN}`);
		await maintenance.query('COMMIT');
	} finally {
		await maintenance.end();
	}
};

const rolePool = function(cluster: ClusterConnection, database: TestDatabase, role: Role): pg.Pool {
	const pool = new pg.Pool({ host: cluster.socketDirectory, port: cluster.port, user: role, database: database.name });
	pool.on('error', function() {
		// Dropping the database terminates idle connections; the pool discards them.
	});
	return(pool);
};

/**
 * A copy of the node's ledger template with the explorer set up as the owner
 * of the node tables would set it up, and migrated as the writer. The cluster
 * user, which ran the node migrations into the template, owns the node tables
 * here as the node's role does in a deployment.
 */
export const explorerDatabase = async function(): Promise<{ database: TestDatabase; writer: pg.Pool; reader: pg.Pool; admin: pg.Pool }> {
	const cluster = inject('postgresCluster');
	const database = await createDatabase(cluster, inject('postgresLedgerTemplate'));
	const writer = rolePool(cluster, database, 'explorer_writer');
	const reader = rolePool(cluster, database, 'explorer_reader');
	onTestFinished(async function() {
		await Promise.all([writer.end(), reader.end()]);
		await database.drop();
	});
	const admin = database.pool();
	await runSetup(cluster, admin);
	await applyExplorerMigrations(writer);
	return({ database, writer, reader, admin });
};

export type LedgerFixture = {
	readonly writer: pg.Pool;
	readonly reader: pg.Pool;
	readonly admin: pg.Pool;
	readonly network: TestNetwork;
	readonly cursor: ChainCursor;
	readonly apply: (blocks: readonly Block[]) => Promise<void>;
};

/** An explorer database whose node tables a real ledger fills, from a test network's genesis. */
export const ledgerFixture = async function(): Promise<LedgerFixture> {
	const { database, writer, reader, admin } = await explorerDatabase();
	const storage = new PostgresLedgerStorage({ kind: 'connection-string', connectionString: database.connectionString });
	onTestFinished(function() {
		return(storage.destroy());
	});
	freezeClock(GENESIS_MOMENT);
	const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
	const ledger = network.createLedger(storage, requireAt(network.representatives, 0));
	await ledger.add(network.genesis);
	const cursor = new ChainCursor(network.genesis);
	const apply = async function(blocks: readonly Block[]): Promise<void> {
		await ledger.add(await confirmedStaple(blocks, network.representatives));
	};
	return({ writer, reader, admin, network, cursor, apply });
};

/** Indexes every staple the node has stored. */
export const indexAll = async function(writer: pg.Pool): Promise<void> {
	let state = await startingState(writer);
	for (;;) {
		const result = await indexBatch(writer, state, DEFAULT_INDEXER_SETTINGS, function() {
			return(GENESIS_MOMENT.getTime());
		});
		state = result.state;
		if (result.indexed === 0) {
			return;
		}
	}
};

export const addressOf = function(account: GenericAccount): string {
	return(account.publicKeyString.get());
};

export const base64Of = function(text: string): string {
	return(Buffer.from(text, 'utf-8').toString('base64'));
};

export type Minting = { readonly decimals: number; readonly first: bigint; readonly second: bigint };

/** A token whose metadata gives it its decimals, minted and sent out whole to two holders. */
export const mintedToken = async function(context: LedgerFixture, minting: Minting = { decimals: 2, first: 100n, second: 50n }): Promise<{ token: GenericAccount; first: Account; second: Account }> {
	const { network, cursor } = context;
	const owner = requireAt(network.users, 0);
	const [first, second] = [requireAt(network.users, 1), requireAt(network.users, 2)];
	const created = await createTokenBlock({ owner, previous: cursor.previous(owner), network: network.network });
	const { token } = created;
	cursor.append(created.block);
	const named = cursor.append(await setInfoBlock({ account: token, signer: owner, previous: cursor.previous(token), network: network.network, name: 'CENT', description: 'a token of two decimals', metadata: base64Of(JSON.stringify({ decimalPlaces: minting.decimals })), defaultPermission: new lib.Permissions(['ACCESS']) }));
	const minted = cursor.append(await tokenSupplyBlock({ owner, token, amount: minting.first + minting.second, previous: cursor.previous(token), network: network.network }));
	const toSecond = cursor.append(await sendBlock({ from: token, signer: owner, to: second, amount: minting.second, token, previous: cursor.previous(token), network: network.network }));
	const toFirst = cursor.append(await sendBlock({ from: token, signer: owner, to: first, amount: minting.first, token, previous: cursor.previous(token), network: network.network }));
	await context.apply([created.block, named, minted, toSecond, toFirst]);
	return({ token, first, second });
};
