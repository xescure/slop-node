#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, appendFile, chmod, lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import pg from 'pg';
import { BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RETRY_ARENA } from '../node/bootstrap-cursors.js';
import { assertNever } from '../util/assert-never.js';
import { checkFollowerEnvironment, FOLLOWER_LISTEN_IP, followerDirectory, followerEnvironment, parseFollowerCommand, POSTGRES_PORT, POSTGRES_SOCKET_DIRECTORY, readOrCreateSeed } from './follower-config.js';
import type { FollowerLog, FollowerSettings } from './follower-config.js';

/** The built node, which utils/follower builds before it runs this. */
const BUILT_CLI = new URL('../../../dist/main.js', import.meta.url);

const SEED_FILE = 'seed';
const SETTINGS_FILE = 'follower.json';
const NODE_PID_FILE = 'node.pid';
const POSTGRES_DATA = 'postgres';
const POSTMASTER_PID_FILE = 'postmaster.pid';
const SETTINGS_INCLUDE = 'follower.conf';
const LOG_FILES: Readonly<Record<FollowerLog, string>> = { node: 'node.log', postgres: 'postgres.log' };

const POSTGRES_USER = 'slop';
const DATABASE = 'follower';

/** Only the follower's user may enter its directory, which holds its seed and its database's socket. */
const PRIVATE_DIRECTORY = 0o700;

/**
 * The cluster serves one node of modest load beside other work on the
 * machine, so its memory is kept small; the operating system's cache holds
 * the rest. A commit that is lost when the machine fails is fetched again
 * from the representatives, so commits do not wait for the disk, which
 * never corrupts the database.
 */
const POSTGRES_SETTINGS: Readonly<Record<string, string>> = {
	listen_addresses: '\'\'',
	port: String(POSTGRES_PORT),
	max_connections: '40',
	shared_buffers: '\'64MB\'',
	work_mem: '\'4MB\'',
	maintenance_work_mem: '\'64MB\'',
	effective_cache_size: '\'512MB\'',
	huge_pages: 'off',
	synchronous_commit: 'off',
	wal_level: 'minimal',
	max_wal_senders: '0',
	max_wal_size: '\'1GB\'',
	timezone: '\'UTC\''
};

/** The node loads the client and migrates its database before it serves. */
const START_MILLISECONDS = 120_000;
/** conformance/DEPLOY.md gives a node 20 s to stop; the margin covers a slow database. */
const NODE_STOP_MILLISECONDS = 30_000;
const POSTGRES_STOP_MILLISECONDS = 60_000;
const POLL_MILLISECONDS = 250;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;

const PROBLEM_LINES_KEPT = 5;

type ExitCode = 0 | 1 | 2;

const USAGE = [
	'Usage: utils/follower <command> [--directory <directory>] [options]',
	'',
	'  up      start a node that follows the main network read-only, in bootstrap-only mode, from its',
	'          four representatives, with its own Postgres; both keep running in the background',
	'          --port <port>             the node\'s API port on 127.0.0.1 (47380)',
	'          --min-interval-ms <ms>    the rest each representative gets between two requests (1000)',
	'          --max-heap-mb <MiB>       the node\'s V8 heap limit (1536)',
	'  status  print the follower\'s progress, its processes\' memory and its database\'s size, as JSON',
	'  logs    print the end of the node\'s log, or with --postgres the database\'s',
	'          --lines <count> (50), --follow',
	'  down    stop the node, then its Postgres',
	'',
	'The directory holds the seed, the database, the logs and the settings (~/.local/share/slop-node-follower).',
	'"up" needs the PostgreSQL server binaries, which "devenv shell" provides.',
	''
].join('\n');

const runFile = promisify(execFile);

function hasCode(error: unknown, code: string): boolean {
	return(error instanceof Error && 'code' in error && error.code === code);
}

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return(error.message);
	}
	return(String(error));
}

function standardErrorOf(error: unknown): string {
	if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') {
		return(error.stderr.trim());
	}
	return(messageOf(error));
}

/** devenv's interactive service exports PGHOST, PGPORT and PGDATA, which the server tools would otherwise act on. */
function hermeticEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith('PG')) {
			environment[name] = value;
		}
	}
	return(environment);
}

async function runTool(tool: string, args: readonly string[]): Promise<void> {
	try {
		await runFile(tool, args, { env: hermeticEnvironment() });
	} catch (error: unknown) {
		if (hasCode(error, 'ENOENT')) {
			throw(new Error(`${tool} is not on PATH; run the follower in "devenv shell", which provides the PostgreSQL server binaries`, { cause: error }));
		}
		throw(new Error(`${tool} ${args.join(' ')} failed: ${standardErrorOf(error)}`, { cause: error }));
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return(true);
	} catch {
		return(false);
	}
}

async function readTrimmed(path: string): Promise<string | undefined> {
	try {
		return((await readFile(path, 'utf8')).trim());
	} catch {
		return(undefined);
	}
}

/** The command line of a running process, or undefined when there is none with the ID. */
async function commandLineOf(processID: number): Promise<string[] | undefined> {
	try {
		return((await readFile(`/proc/${String(processID)}/cmdline`, 'utf8')).split('\0').filter(function(part): boolean {
			return(part !== '');
		}));
	} catch {
		return(undefined);
	}
}

function processIDOf(text: string | undefined): number | undefined {
	const processID = Number(text);
	if (text === undefined || !Number.isSafeInteger(processID) || processID < 1) {
		return(undefined);
	}
	return(processID);
}

/** The node's process, when the one its PID file names still runs the built node; an ID reused after a reboot is not it. */
async function runningNode(directory: string): Promise<number | undefined> {
	const processID = processIDOf(await readTrimmed(join(directory, NODE_PID_FILE)));
	if (processID === undefined) {
		return(undefined);
	}
	const commandLine = await commandLineOf(processID);
	if (commandLine === undefined || !commandLine.includes(BUILT_CLI.pathname) || !commandLine.includes('run')) {
		return(undefined);
	}
	return(processID);
}

/** The cluster's postmaster, when the one its PID file names still runs. */
async function runningPostmaster(directory: string): Promise<number | undefined> {
	const processID = processIDOf((await readTrimmed(join(directory, POSTGRES_DATA, POSTMASTER_PID_FILE)))?.split('\n')[0]);
	if (processID === undefined) {
		return(undefined);
	}
	const commandLine = await commandLineOf(processID);
	if (commandLine === undefined || !commandLine.some(function(part): boolean {
		return(part.endsWith('postgres'));
	})) {
		return(undefined);
	}
	return(processID);
}

function databaseURL(directory: string): string {
	return(`postgresql://${POSTGRES_USER}@${encodeURIComponent(join(directory, POSTGRES_SOCKET_DIRECTORY))}:${String(POSTGRES_PORT)}/${DATABASE}`);
}

function serverSettings(directory: string): string {
	const settings: Record<string, string> = { ...POSTGRES_SETTINGS, unix_socket_directories: `'${join(directory, POSTGRES_SOCKET_DIRECTORY)}'` };
	return(Object.entries(settings).map(function([name, value]): string {
		return(`${name} = ${value}\n`);
	}).join(''));
}

/** Makes the cluster once, and writes its settings on every start, so that a change of them applies. */
async function prepareCluster(directory: string): Promise<void> {
	const data = join(directory, POSTGRES_DATA);
	if (!await exists(join(data, 'PG_VERSION'))) {
		await rm(data, { recursive: true, force: true });
		await runTool('initdb', [
			'--pgdata', data,
			'--username', POSTGRES_USER,
			// Only the follower's user can reach the socket, in its private directory.
			'--auth', 'trust',
			'--encoding', 'UTF8',
			'--locale', 'C',
			'--no-instructions'
		]);
		await appendFile(join(data, 'postgresql.conf'), `\ninclude '${SETTINGS_INCLUDE}'\n`);
	}
	await writeFile(join(data, SETTINGS_INCLUDE), serverSettings(directory));
}

async function startPostgres(directory: string): Promise<void> {
	if (await runningPostmaster(directory) !== undefined) {
		return;
	}
	await runTool('pg_ctl', ['start', '--pgdata', join(directory, POSTGRES_DATA), '--log', join(directory, LOG_FILES.postgres), '--wait', '--timeout', '60']);
}

async function withDatabase<Result>(database: string, directory: string, work: (client: pg.Client) => Promise<Result>): Promise<Result> {
	const client = new pg.Client({ host: join(directory, POSTGRES_SOCKET_DIRECTORY), port: POSTGRES_PORT, user: POSTGRES_USER, database });
	await client.connect();
	try {
		return(await work(client));
	} finally {
		await client.end();
	}
}

async function createDatabase(directory: string): Promise<void> {
	await withDatabase('postgres', directory, async function(client) {
		const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
		if (found.rowCount === 0) {
			await client.query(`CREATE DATABASE ${DATABASE}`);
		}
	});
}

type Answer = { readonly status: number; readonly body: unknown };

/** A GET of the follower's own API, on the loopback interface. */
function getOwnAPI(port: number, path: string): Promise<Answer> {
	return(new Promise<Answer>(function(resolve, reject) {
		const request = http.get({ host: FOLLOWER_LISTEN_IP, port, path: `/api${path}`, timeout: REQUEST_TIMEOUT_MILLISECONDS }, function(response) {
			const chunks: Buffer[] = [];
			response.on('data', function(chunk: Buffer) {
				chunks.push(chunk);
			});
			response.on('error', reject);
			response.on('end', function() {
				const text = Buffer.concat(chunks).toString('utf8');
				let body: unknown = text;
				try {
					body = JSON.parse(text);
				} catch {
					// Kept as text.
				}
				resolve({ status: response.statusCode ?? 0, body });
			});
		});
		request.on('timeout', function() {
			request.destroy(new Error(`the follower did not answer ${path} within ${String(REQUEST_TIMEOUT_MILLISECONDS)} ms`));
		});
		request.on('error', reject);
	}));
}

async function logTail(path: string, lines: number): Promise<string> {
	const text = await readTrimmed(path);
	if (text === undefined) {
		return(`(no log at ${path})`);
	}
	return(text.split('\n').slice(-lines).join('\n'));
}

function isAlive(processID: number): boolean {
	try {
		process.kill(processID, 0);
		return(true);
	} catch {
		return(false);
	}
}

/** Waits for the node to serve, failing once it has exited or the deadline has passed. */
async function waitUntilServing(processID: number, port: number, logPath: string): Promise<void> {
	const deadline = Date.now() + START_MILLISECONDS;
	for (;;) {
		if (!isAlive(processID)) {
			throw(new Error(`the node exited before it served:\n${await logTail(logPath, 30)}`));
		}
		try {
			const answer = await getOwnAPI(port, '/node/version');
			if (answer.status === 200) {
				return;
			}
		} catch {
			// Not serving yet.
		}
		if (Date.now() > deadline) {
			throw(new Error(`the node did not serve within ${String(START_MILLISECONDS)} ms:\n${await logTail(logPath, 30)}`));
		}
		await delay(POLL_MILLISECONDS);
	}
}

/**
 * Starts the node in a session of its own, so that it outlives this command
 * and the terminal, with nothing of this process's environment but the
 * search path.
 */
async function startNode(directory: string, settings: FollowerSettings, environment: NodeJS.ProcessEnv): Promise<number> {
	const logPath = join(directory, LOG_FILES.node);
	const log = await open(logPath, 'a');
	try {
		await log.write(`--- ${new Date().toISOString()} utils/follower up\n`);
		const child = spawn(process.execPath, [`--max-old-space-size=${String(settings.maxHeapMegabytes)}`, BUILT_CLI.pathname, 'run'], {
			detached: true,
			stdio: ['ignore', log.fd, log.fd],
			env: { PATH: process.env['PATH'], ...environment }
		});
		const processID = child.pid;
		if (processID === undefined) {
			child.once('error', function() {
				// The failure is thrown here instead.
			});
			throw(new Error(`${process.execPath} could not be started`));
		}
		child.unref();
		await writeFile(join(directory, NODE_PID_FILE), `${String(processID)}\n`);
		return(processID);
	} finally {
		await log.close();
	}
}

async function up(settings: FollowerSettings): Promise<ExitCode> {
	const { directory } = settings;
	const running = await runningNode(directory);
	if (running !== undefined) {
		process.stderr.write(`a follower is already up in ${directory} (process ${String(running)})\n`);
		return(1);
	}
	await mkdir(join(directory, POSTGRES_SOCKET_DIRECTORY), { recursive: true, mode: PRIVATE_DIRECTORY });
	await chmod(directory, PRIVATE_DIRECTORY);
	await chmod(join(directory, POSTGRES_SOCKET_DIRECTORY), PRIVATE_DIRECTORY);
	const seed = await readOrCreateSeed(join(directory, SEED_FILE));
	const environment = followerEnvironment({ settings, seed, databaseURL: databaseURL(directory) });
	const config = checkFollowerEnvironment(environment);
	await prepareCluster(directory);
	await startPostgres(directory);
	await createDatabase(directory);
	await writeFile(join(directory, SETTINGS_FILE), `${JSON.stringify(settings, null, '\t')}\n`);
	const processID = await startNode(directory, settings, environment);
	await waitUntilServing(processID, settings.port, join(directory, LOG_FILES.node));
	process.stdout.write([
		`follower up in ${directory}: node process ${String(processID)}, API http://${FOLLOWER_LISTEN_IP}:${String(settings.port)}/api\n`,
		`network: main, ledger write mode: ${config.ledgerWriteMode}, representative (signs nothing): ${config.representative.publicKeyString.get()}\n`,
		`bootstrapping from: ${config.bootstrapPeers.join(', ')}, each left ${String(config.bootstrapMinIntervalMilliseconds)} ms between requests\n`,
		`progress: utils/follower status; logs: utils/follower logs; stop: utils/follower down\n`
	].join(''));
	return(0);
}

/** Signals the process and waits for it to exit, killing it once the deadline has passed; answers whether it had to be killed. */
async function stopProcess(processID: number, signal: NodeJS.Signals, milliseconds: number): Promise<boolean> {
	try {
		process.kill(processID, signal);
	} catch (error: unknown) {
		// It exited after it was found.
		if (hasCode(error, 'ESRCH')) {
			return(false);
		}
		throw(error);
	}
	const deadline = Date.now() + milliseconds;
	while (isAlive(processID)) {
		if (Date.now() > deadline) {
			process.kill(processID, 'SIGKILL');
			return(true);
		}
		await delay(POLL_MILLISECONDS);
	}
	return(false);
}

async function down(directory: string): Promise<ExitCode> {
	const node = await runningNode(directory);
	const postmaster = await runningPostmaster(directory);
	if (node === undefined && postmaster === undefined) {
		process.stderr.write(`no follower is up in ${directory}\n`);
		return(1);
	}
	let code: ExitCode = 0;
	if (node !== undefined) {
		if (await stopProcess(node, 'SIGTERM', NODE_STOP_MILLISECONDS)) {
			process.stderr.write(`the node did not stop within ${String(NODE_STOP_MILLISECONDS)} ms and was killed\n`);
			code = 1;
		}
		await rm(join(directory, NODE_PID_FILE), { force: true });
	}
	if (postmaster !== undefined) {
		// SIGINT is Postgres' fast shutdown: it ends the sessions and checkpoints.
		if (await stopProcess(postmaster, 'SIGINT', POSTGRES_STOP_MILLISECONDS)) {
			process.stderr.write(`Postgres did not stop within ${String(POSTGRES_STOP_MILLISECONDS)} ms and was killed\n`);
			code = 1;
		}
	}
	process.stdout.write(`follower in ${directory} stopped\n`);
	return(code);
}

type Memory = { readonly rssMiB: number; readonly pssMiB: number };

const KIB_PER_MIB = 1024;

/** A field of /proc, which counts in KiB, as MiB. */
function fieldMiB(text: string, field: string): number {
	const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(text);
	return(Math.round(Number(match?.[1] ?? 0) / KIB_PER_MIB));
}

async function memoryOf(processID: number): Promise<Memory> {
	const rollup = await readTrimmed(`/proc/${String(processID)}/smaps_rollup`) ?? '';
	return({ rssMiB: fieldMiB(rollup, 'Rss'), pssMiB: fieldMiB(rollup, 'Pss') });
}

/** The postmaster and every process it started; their shared buffers count once in the sum of their proportional sizes. */
async function postgresMemory(postmaster: number): Promise<Memory & { readonly processes: number }> {
	const processes = [postmaster];
	for (const entry of await readdir('/proc')) {
		const processID = processIDOf(entry);
		if (processID === undefined) {
			continue;
		}
		const status = await readTrimmed(`/proc/${entry}/status`);
		if (status !== undefined && new RegExp(`^PPid:\\s+${String(postmaster)}$`, 'm').test(status)) {
			processes.push(processID);
		}
	}
	let rssMiB = 0;
	let pssMiB = 0;
	for (const processID of processes) {
		const memory = await memoryOf(processID);
		rssMiB += memory.rssMiB;
		pssMiB += memory.pssMiB;
	}
	return({ rssMiB, pssMiB, processes: processes.length });
}

async function directoryBytes(path: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(path, { recursive: true })) {
		try {
			const info = await lstat(join(path, entry));
			total += info.blocks * 512;
		} catch {
			// Removed while it was walked, as WAL segments are.
		}
	}
	return(total);
}

const PASS_LINE = /Bootstrap pass over (\S+): (.*) after (\d+) requests, (\d+) staples added, (\d+) held already(?:, (\d+) queued for retry)?/;

type PassTotals = { passes: number; bounded: number; requests: number; added: number; held: number; queued: number; lastOutcome: string };

/** What the node's log says of its bootstrap passes, which it logs at INFO when they add staples or reach their bound. */
function bootstrapLogOf(log: string): { readonly perPeer: Record<string, PassTotals>; readonly problems: number; readonly lastProblems: readonly string[] } {
	const perPeer: Record<string, PassTotals> = {};
	const problems: string[] = [];
	for (const line of log.split('\n')) {
		const pass = PASS_LINE.exec(line);
		if (pass !== null) {
			const [, endpoint = '', outcome = '', requests = '0', added = '0', held = '0', queued = '0'] = pass;
			const totals = perPeer[endpoint] ??= { passes: 0, bounded: 0, requests: 0, added: 0, held: 0, queued: 0, lastOutcome: '' };
			totals.passes++;
			if (outcome.startsWith('reached')) {
				totals.bounded++;
			}
			totals.requests += Number(requests);
			totals.added += Number(added);
			totals.held += Number(held);
			totals.queued += Number(queued);
			totals.lastOutcome = outcome;
			continue;
		}
		if (/\b(WARN|ERROR)\b/.test(line)) {
			problems.push(line);
		}
	}
	return({ perPeer, problems: problems.length, lastProblems: problems.slice(-PROBLEM_LINES_KEPT) });
}

async function ledgerProgress(directory: string): Promise<unknown> {
	return(await withDatabase(DATABASE, directory, async function(client) {
		const staples = await client.query<{ count: string; newest_staple_time: Date | null; newest_moment: Date | null }>('SELECT count(*) AS count, max(staple_time) AS newest_staple_time, max(moment) AS newest_moment FROM staples');
		const cursors = await client.query<{ key: string; value: unknown }>('SELECT key, value FROM kv_entries WHERE arena = $1 ORDER BY key', [BOOTSTRAP_CURSOR_ARENA]);
		const size = await client.query<{ bytes: string }>('SELECT pg_database_size(current_database()) AS bytes');
		const queued = await client.query<{ code: string | null; count: string; oldest: string | null; reported: string }>(`
			SELECT value->>'code' AS code, count(*) AS count, min((value->>'queuedAt')::bigint) AS oldest, count(*) FILTER (WHERE (value->>'reported')::boolean) AS reported
			FROM kv_entries WHERE arena = $1 GROUP BY 1 ORDER BY 1`, [BOOTSTRAP_RETRY_ARENA]);
		const row = staples.rows[0];
		return({
			staples: Number(row?.count ?? 0),
			newestStapleTime: row?.newest_staple_time ?? null,
			newestMoment: row?.newest_moment ?? null,
			databaseMiB: Math.round(Number(size.rows[0]?.bytes ?? 0) / KIB_PER_MIB / KIB_PER_MIB),
			cursors: Object.fromEntries(cursors.rows.map(function(cursor): [string, unknown] {
				return([cursor.key, cursor.value]);
			})),
			retryQueue: queued.rows.map(function(group) {
				let oldestQueuedAt: string | null = null;
				if (group.oldest !== null) {
					oldestQueuedAt = new Date(Number(group.oldest)).toISOString();
				}
				return({ code: group.code, staples: Number(group.count), reported: Number(group.reported), oldestQueuedAt });
			})
		});
	}));
}

async function settled<Value>(work: () => Promise<Value>): Promise<Value | { readonly error: string }> {
	try {
		return(await work());
	} catch (error: unknown) {
		return({ error: String(error) });
	}
}

/** The settings "up" last started the follower with. */
async function readSettings(directory: string): Promise<FollowerSettings | undefined> {
	const path = join(directory, SETTINGS_FILE);
	const text = await readTrimmed(path);
	if (text === undefined) {
		return(undefined);
	}
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== 'object' || parsed === null) {
		throw(new Error(`${path} holds no follower settings`));
	}
	const { port, minIntervalMilliseconds, maxHeapMegabytes } = { port: undefined, minIntervalMilliseconds: undefined, maxHeapMegabytes: undefined, ...parsed };
	if (typeof port !== 'number' || typeof minIntervalMilliseconds !== 'number' || typeof maxHeapMegabytes !== 'number') {
		throw(new Error(`${path} holds no follower settings`));
	}
	return({ directory, port, minIntervalMilliseconds, maxHeapMegabytes });
}

async function status(directory: string): Promise<ExitCode> {
	const settings = await readSettings(directory);
	if (settings === undefined) {
		process.stderr.write(`no follower was started in ${directory}\n`);
		return(1);
	}
	const node = await runningNode(directory);
	const postmaster = await runningPostmaster(directory);
	const log = await readTrimmed(join(directory, LOG_FILES.node)) ?? '';
	let nodeStatus: unknown = { running: false };
	if (node !== undefined) {
		nodeStatus = { running: true, processID: node, ...await memoryOf(node) };
	}
	let postgresStatus: unknown = { running: false };
	if (postmaster !== undefined) {
		postgresStatus = { running: true, processID: postmaster, ...await postgresMemory(postmaster), dataDirectoryMiB: Math.round(await directoryBytes(join(directory, POSTGRES_DATA)) / KIB_PER_MIB / KIB_PER_MIB) };
	}
	let ledger: unknown = { error: 'Postgres is not running' };
	if (postmaster !== undefined) {
		ledger = await settled(function() {
			return(ledgerProgress(directory));
		});
	}
	let api: unknown = { error: 'the node is not running' };
	if (node !== undefined) {
		api = await settled(async function() {
			const [stats, checksum] = await Promise.all([getOwnAPI(settings.port, '/node/stats'), getOwnAPI(settings.port, '/node/ledger/checksum')]);
			return({ stats: stats.body, checksum: checksum.body });
		});
	}
	const report = {
		at: new Date().toISOString(),
		directory,
		settings,
		node: nodeStatus,
		postgres: postgresStatus,
		ledger,
		api,
		bootstrapLog: bootstrapLogOf(log),
		logMiB: Math.round(Buffer.byteLength(log) / KIB_PER_MIB / KIB_PER_MIB)
	};
	process.stdout.write(`${JSON.stringify(report, null, '\t')}\n`);
	return(0);
}

async function logs(directory: string, log: FollowerLog, lines: number, follow: boolean): Promise<ExitCode> {
	const args = ['-n', String(lines)];
	if (follow) {
		args.push('-F');
	}
	args.push(join(directory, LOG_FILES[log]));
	const child = spawn('tail', args, { stdio: 'inherit' });
	return(await new Promise<ExitCode>(function(resolve) {
		child.once('close', function(code) {
			if (code === 0) {
				resolve(0);
				return;
			}
			resolve(1);
		});
	}));
}

async function main(argv: readonly string[]): Promise<ExitCode> {
	const command = parseFollowerCommand(argv, homedir());
	if (command === undefined) {
		process.stderr.write(USAGE);
		return(2);
	}
	try {
		switch (command.kind) {
			case 'up':
				return(await up({ ...command.settings, directory: followerDirectory(command.settings.directory, tmpdir()) }));
			case 'down':
				return(await down(followerDirectory(command.directory, tmpdir())));
			case 'status':
				return(await status(followerDirectory(command.directory, tmpdir())));
			case 'logs':
				return(await logs(followerDirectory(command.directory, tmpdir()), command.log, command.lines, command.follow));
			default:
				return(assertNever(command));
		}
	} catch (error: unknown) {
		process.stderr.write(`utils/follower: ${messageOf(error)}\n`);
		return(1);
	}
}

process.exitCode = await main(process.argv.slice(2));
