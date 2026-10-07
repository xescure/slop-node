import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { SCHEMA_MIGRATIONS, applyMigrations } from '../ledger/storage/postgres/migrations.js';
import { assertNever } from '../util/assert-never.js';

/**
 * What a test needs to reach the cluster. It is plain data so that vitest can
 * hand it from the global setup to every worker.
 */
export type ClusterConnection = {
	readonly socketDirectory: string;
	readonly port: number;
	readonly user: string;
};

export type Cluster = ClusterConnection & {
	readonly stop: () => Promise<void>;
};

declare module 'vitest' {
	export interface ProvidedContext {
		postgresCluster: ClusterConnection;
		/** A database holding the shipped migrations and nothing else, to copy. */
		postgresLedgerTemplate: DatabaseName;
	}
}

/** A database name made only of characters that need no quoting anywhere. */
export type DatabaseName = string & { readonly __databaseName: never };

const CLUSTER_USER = 'slop';
const MAINTENANCE_DATABASE = 'postgres';

const CLUSTER_DIRECTORY_PREFIX = 'slop-pg-';
const DATA_DIRECTORY = 'data';
const OWNER_FILE = 'owner.pid';
const OWNER_BOOT_FILE = 'owner.boot';
const BOOT_ID = '/proc/sys/kernel/random/boot_id';

const runFile = promisify(execFile);

// The cluster is thrown away after the run, so durability is traded for speed,
// and the vitest workers together hold many pools at once. Timestamps print
// the same on every host.
const SERVER_SETTINGS = [
	'listen_addresses=',
	'timezone=UTC',
	'max_connections=300',
	'fsync=off',
	'synchronous_commit=off',
	'full_page_writes=off'
] as const;

/**
 * devenv's interactive service exports PGHOST, PGPORT and PGDATA, and the
 * server tools would otherwise act on that cluster instead of this one.
 */
const hermeticEnvironment = function(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith('PG')) {
			environment[name] = value;
		}
	}
	return(environment);
};

const hasCode = function(error: unknown, code: string): boolean {
	return(error instanceof Error && 'code' in error && error.code === code);
};

const standardErrorOf = function(error: unknown): string {
	if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') {
		return(error.stderr.trim());
	}
	return(String(error));
};

const runTool = async function(tool: string, args: readonly string[]): Promise<void> {
	try {
		await runFile(tool, args, { env: hermeticEnvironment() });
	} catch (error: unknown) {
		if (hasCode(error, 'ENOENT')) {
			throw(new Error(`${tool} is not on PATH; the tests need the PostgreSQL server binaries that "devenv shell" provides`, { cause: error }));
		}
		throw(new Error(`${tool} ${args.join(' ')} failed: ${standardErrorOf(error)}`, { cause: error }));
	}
};

/**
 * The server listens on no TCP address, but its port still names its socket
 * and seeds its shared memory key, so a port nothing else holds keeps two
 * clusters on one machine from probing each other.
 */
const findFreePort = function(): Promise<number> {
	return(new Promise(function(resolve, reject) {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', function() {
			const address = server.address();
			server.close(function() {
				if (address === null || typeof address === 'string') {
					reject(new Error(`expected a TCP address, got ${String(address)}`));
					return;
				}
				resolve(address.port);
			});
		});
	}));
};

// pg_ctl hands its server options to a shell, so the socket directory must
// survive that unquoted.
const assertShellSafePath = function(path: string): void {
	if (!/^[A-Za-z0-9/._-]+$/.test(path)) {
		throw(new Error(`the temporary directory ${JSON.stringify(path)} has characters pg_ctl cannot pass on; set TMPDIR to a plain path`));
	}
};

const serverOptions = function(socketDirectory: string, port: number): string {
	const settings = SERVER_SETTINGS.map(function(setting) {
		return(`-c ${setting}`);
	});
	return([`-k ${socketDirectory}`, `-p ${String(port)}`, ...settings].join(' '));
};

const describeError = function(error: unknown): string {
	if (error instanceof Error) {
		return(error.message);
	}
	return(String(error));
};

const readLog = async function(logFile: string): Promise<string> {
	try {
		return(await readFile(logFile, 'utf-8'));
	} catch (error: unknown) {
		return(`(no server log: ${String(error)})`);
	}
};

/** This boot's ID, where the host reports one; a process ID means nothing across boots. */
export const currentBootID = async function(): Promise<string | undefined> {
	try {
		return((await readFile(BOOT_ID, 'utf-8')).trim());
	} catch {
		return(undefined);
	}
};

const stopClusterServer = function(directory: string): Promise<void> {
	// The data is thrown away, so nothing needs a clean shutdown.
	return(runTool('pg_ctl', ['stop', '--pgdata', join(directory, DATA_DIRECTORY), '--mode', 'immediate', '--wait']));
};

type ClusterOwner = {
	readonly processID: number;
	/** Absent where the host reports no boot ID. */
	readonly boot: string | undefined;
};

const readTrimmed = async function(path: string): Promise<string | undefined> {
	try {
		return((await readFile(path, 'utf-8')).trim());
	} catch {
		return(undefined);
	}
};

const asProcessID = function(text: string | undefined): number | undefined {
	const processID = Number(text);
	if (text === undefined || !Number.isSafeInteger(processID) || processID < 1) {
		return(undefined);
	}
	return(processID);
};

/** The process that started the cluster in this directory, and in which boot, if it says. */
const ownerOf = async function(directory: string): Promise<ClusterOwner | undefined> {
	const processID = asProcessID(await readTrimmed(join(directory, OWNER_FILE)));
	if (processID === undefined) {
		return(undefined);
	}
	return({ processID, boot: await readTrimmed(join(directory, OWNER_BOOT_FILE)) });
};

// Signal 0 only checks that the process exists; EPERM means it exists under another user.
const isRunning = function(processID: number): boolean {
	try {
		process.kill(processID, 0);
	} catch (error: unknown) {
		return(!hasCode(error, 'ESRCH'));
	}
	return(true);
};

/*
 * pg_ctl signals whatever process the server's PID file names. Once the
 * server has died that PID may belong to anything, so it is signalled only
 * while its command line is still a postgres serving this data directory.
 */
const isClusterServer = async function(directory: string): Promise<boolean> {
	const dataDirectory = join(directory, DATA_DIRECTORY);
	const serverFile = await readTrimmed(join(dataDirectory, 'postmaster.pid'));
	const processID = asProcessID(serverFile?.split('\n')[0]);
	if (processID === undefined) {
		return(false);
	}
	const commandLine = await readTrimmed(`/proc/${String(processID)}/cmdline`);
	if (commandLine === undefined) {
		return(false);
	}
	const [program, ...args] = commandLine.split('\0');
	return(program !== undefined && basename(program) === 'postgres' && args.includes(dataDirectory));
};

const ownershipOf = async function(owner: ClusterOwner): Promise<'earlier-boot' | 'owner-died' | 'owned'> {
	const boot = await currentBootID();
	if (owner.boot !== undefined && boot !== undefined && owner.boot !== boot) {
		return('earlier-boot');
	}
	if (isRunning(owner.processID)) {
		return('owned');
	}
	return('owner-died');
};

/**
 * A run killed outright never reaches its teardown, and leaves its server
 * running. Each cluster names the process that started it and the boot it ran
 * in, so a later run stops and removes those whose owner has died. Nothing of
 * an earlier boot is still running, so its directory is only removed. A
 * directory that names no owner may belong to a run that is still starting
 * its cluster, and is left.
 */
export const sweepAbandonedClusters = async function(parent: string = tmpdir()): Promise<void> {
	const entries = await readdir(parent, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(CLUSTER_DIRECTORY_PREFIX)) {
			continue;
		}
		const directory = join(parent, entry.name);
		const owner = await ownerOf(directory);
		if (owner === undefined) {
			continue;
		}
		const state = await ownershipOf(owner);
		switch (state) {
			case 'owned':
				continue;
			case 'owner-died':
				if (await isClusterServer(directory)) {
					await stopClusterServer(directory).catch(function() {
						// A server that died meanwhile has nothing to stop.
					});
				}
				break;
			case 'earlier-boot':
				break;
			default:
				assertNever(state);
		}
		await rm(directory, { recursive: true, force: true });
	}
};

/**
 * Starts a private cluster in a fresh temporary directory, reachable only
 * through a Unix socket in that directory. Fails with the reason, never
 * silently, when the server binaries are missing or the server cannot start.
 */
export const startCluster = async function(parent: string = tmpdir()): Promise<Cluster> {
	const directory = await mkdtemp(join(parent, CLUSTER_DIRECTORY_PREFIX));
	const dataDirectory = join(directory, DATA_DIRECTORY);
	const logFile = join(directory, 'server.log');
	const removeDirectory = function(): Promise<void> {
		return(rm(directory, { recursive: true, force: true }));
	};
	const stopServer = function(): Promise<void> {
		return(stopClusterServer(directory));
	};

	let port: number;
	try {
		await writeFile(join(directory, OWNER_FILE), `${String(process.pid)}\n`);
		const boot = await currentBootID();
		if (boot !== undefined) {
			await writeFile(join(directory, OWNER_BOOT_FILE), `${boot}\n`);
		}
		assertShellSafePath(directory);
		port = await findFreePort();
		await runTool('initdb', [
			'--pgdata', dataDirectory,
			'--username', CLUSTER_USER,
			'--auth', 'trust',
			'--encoding', 'UTF8',
			// Collation then sorts by bytes, the same on every machine.
			'--locale', 'C',
			'--no-sync',
			'--no-instructions'
		]);
	} catch (error: unknown) {
		await removeDirectory();
		throw(error);
	}

	try {
		await runTool('pg_ctl', ['start', '--pgdata', dataDirectory, '--log', logFile, '--wait', '--options', serverOptions(directory, port)]);
	} catch (error: unknown) {
		const log = await readLog(logFile);
		await stopServer().catch(function() {
			// A server that never started has nothing to stop.
		});
		await removeDirectory();
		throw(new Error(`PostgreSQL did not start: ${describeError(error)}\n${log}`, { cause: error }));
	}

	let stopping: Promise<void> | undefined;
	const stop = function(): Promise<void> {
		stopping ??= stopServer().finally(removeDirectory);
		return(stopping);
	};
	return({ socketDirectory: directory, port, user: CLUSTER_USER, stop });
};

/** Only the connection fields, so that a whole Cluster can be passed as well. */
export const connectionOf = function(cluster: ClusterConnection): ClusterConnection {
	return({ socketDirectory: cluster.socketDirectory, port: cluster.port, user: cluster.user });
};

const clientConfig = function(cluster: ClusterConnection, database: string): pg.ClientConfig {
	return({ host: cluster.socketDirectory, port: cluster.port, user: cluster.user, database });
};

const withMaintenanceClient = async function<Result>(cluster: ClusterConnection, action: (client: pg.Client) => Promise<Result>): Promise<Result> {
	const client = new pg.Client(clientConfig(cluster, MAINTENANCE_DATABASE));
	await client.connect();
	try {
		return(await action(client));
	} finally {
		await client.end();
	}
};

const newDatabaseName = function(): DatabaseName {
	// The brand marks a name of lowercase hex and underscores only.
	return(`test_${randomUUID().replaceAll('-', '')}` as DatabaseName);
};

/** A database of its own for one test, with the pools opened on it. */
export class TestDatabase {
	readonly name: DatabaseName;
	readonly #cluster: ClusterConnection;
	readonly #pools: pg.Pool[] = [];

	constructor(cluster: ClusterConnection, name: DatabaseName) {
		this.#cluster = connectionOf(cluster);
		this.name = name;
	}

	/** The same database as a URL, for code that takes a connection string. */
	get connectionString(): string {
		const host = encodeURIComponent(this.#cluster.socketDirectory);
		return(`postgresql://${this.#cluster.user}@${host}:${String(this.#cluster.port)}/${this.name}`);
	}

	/** A new pool on this database, ended by drop. */
	pool(): pg.Pool {
		const pool = new pg.Pool(clientConfig(this.#cluster, this.name));
		pool.on('error', function() {
			// drop terminates idle connections; the pool discards them.
		});
		this.#pools.push(pool);
		return(pool);
	}

	/** Ends every pool opened through this object. */
	async endPools(): Promise<void> {
		const pools = this.#pools.splice(0);
		await Promise.all(pools.map(function(pool) {
			if (pool.ended) {
				return(Promise.resolve());
			}
			return(pool.end());
		}));
	}

	/** Ends every pool opened through this object, then drops the database. */
	async drop(): Promise<void> {
		await this.endPools();
		const name = this.name;
		await withMaintenanceClient(this.#cluster, function(client) {
			return(client.query(`DROP DATABASE ${pg.escapeIdentifier(name)} WITH (FORCE)`));
		});
	}
}

/**
 * Creates an empty database, or a copy of the template. The template must have
 * no open connections while it is copied.
 */
export const createDatabase = async function(cluster: ClusterConnection, template?: DatabaseName): Promise<TestDatabase> {
	const name = newDatabaseName();
	let statement = `CREATE DATABASE ${pg.escapeIdentifier(name)}`;
	if (template !== undefined) {
		statement = `${statement} TEMPLATE ${pg.escapeIdentifier(template)}`;
	}
	await withMaintenanceClient(cluster, function(client) {
		return(client.query(statement));
	});
	return(new TestDatabase(cluster, name));
};

/**
 * Migrates a new database with the shipped migrations and makes it a template
 * that accepts no connections, so that every copy starts from the same schema
 * and nothing can change the template between copies.
 */
export const createLedgerTemplate = async function(cluster: ClusterConnection): Promise<DatabaseName> {
	const database = await createDatabase(cluster);
	await applyMigrations(database.pool(), SCHEMA_MIGRATIONS);
	await database.endPools();
	await withMaintenanceClient(cluster, function(client) {
		return(client.query(`ALTER DATABASE ${pg.escapeIdentifier(database.name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`));
	});
	return(database.name);
};
