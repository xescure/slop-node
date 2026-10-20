import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { inject, onTestFinished } from 'vitest';
import { createDatabase } from '../testing/postgres.js';
import type { ClusterConnection, TestDatabase } from '../testing/postgres.js';
import { applyExplorerMigrations } from './migrations.js';

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
