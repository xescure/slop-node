#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir, setPriority, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import { PeerPacer } from '../node/bootstrap-pacing.js';
import { assertNever } from '../util/assert-never.js';
import { capturedBehaviors, sampleAPI } from './api-diff.js';
import { httpSource, pacedSource } from './api-source.js';
import type { APISource } from './api-source.js';
import { compareChecksums, crossCheckChecksum } from './checksum.js';
import { FOLLOWER_DATABASE, FOLLOWER_LISTEN_IP, followerDatabaseURL, followerDatabaseURLOf, followerDirectory, MAINNET_REPRESENTATIVE_APIS, readFollowerSettings } from './follower-config.js';
import { caughtUp, openFollowerStore } from './follower-store.js';
import type { FollowerStore } from './follower-store.js';
import { ParityLog, parityLogPath } from './log.js';
import type { ShadowBase, ShadowRunRecord, ShadowRunState, ShadowTarget } from './log.js';
import { lockParity, PARITY_LOCK_FILE, parseParityCommand, SHADOW_LOCK_FILE } from './parity-command.js';
import type { ParityCommand } from './parity-command.js';
import { runParity, sweepPointerOf } from './report.js';
import type { ParityReport } from './report.js';
import { freshShadowRun, runShadowVotes, SHADOW_SCOPE, shadowRunComplete } from './shadow-live.js';
import { fileShadowState, shadowDirectory } from './shadow-state.js';
import { sweepAccounts, sweepCursorPath } from './sweep.js';

/**
 * Every parity tool leaves each representative at least this long without a
 * request between two of its own, so that together they send at most one a
 * second to each; the follower's bootstrap paces its own.
 */
const REPRESENTATIVE_INTERVAL_MILLISECONDS = 1000;

type ExitCode = 0 | 1 | 2;

const USAGE = [
	'Usage: utils/parity <command> [--directory <directory>] [options]',
	'',
	'Compares the follower with the main network\'s representatives, reading from them with paced GETs only,',
	'and records every comparison in the parity log (parity.jsonl in the follower\'s directory).',
	'',
	'  checksum  check the follower\'s stored ledger checksum against the XOR of its main blocks, compare its',
	'            block count with each representative\'s, and record each representative\'s checksum',
	'            --gap-ms <ms>      how long both are read apart (10000)',
	'  sweep     compare the state of the accounts the follower knows, from where the last sweep stopped',
	'            --accounts <n>     how many accounts (100)',
	'  api-diff  send the same GET requests, drawn from what the follower holds within its reach, to the',
	'            follower and to a representative, and compare the answers, stratum by stratum',
	'            --samples <n>      how many requests of each stratum to compare (50)',
	'            --seed <text>      fixes which requests are drawn (the time of the run)',
	'  shadow    replay the follower\'s main staples, in the order its ledger added them, into an offline',
	'            ledger in a database of the follower\'s cluster (follower_shadow), and before each is added,',
	'            ask that ledger to vote on it as a representative asked then would; every staple first',
	'            voted for after 0.18.4 was published decides, one in so many earlier ones informs; the',
	'            run resumes where it stopped (shadow-live/ in the follower\'s directory), up to the',
	'            follower\'s newest staple, and reads only the follower\'s database',
	'            --base <database>          start from this snapshot of the follower\'s database',
	'                                       ("utils/follower snapshot") instead of an empty ledger',
	'            --informational-every <n>  vote on one in n staples voted for before the scope (10)',
	'            --batch <n>                staples replayed between two saves of the standing (500)',
	'            --restart                  drop the offline ledger and the standing, and start again',
	'  report    check the checksum and compare a sweep sample and an API diff sample, then print the',
	'            parity report as JSON, with the latest shadow-vote run from the log; exits 1 when a signal fails',
	'            --sample <n>       how many accounts the sweep sample compares (16)',
	'            --api-samples <n>  how many requests of each stratum the API diff sample compares (2)',
	'            --gap-ms <ms>      as for checksum',
	'',
	'The directory is the follower\'s (~/.local/share/slop-node-follower); the follower must be up.',
	''
].join('\n');

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return(error.message);
	}
	return(String(error));
}

/** The repository the tool was built in, three levels above its build/parity/parity directory. */
const REPOSITORY = new URL('../../../', import.meta.url);

const CAPTURE_DIRECTORY = new URL('conformance/api/mainnet/', REPOSITORY);

const EDGE_CASE_FIXTURE = new URL('conformance/mainnet/edge-cases.jsonl.gz', REPOSITORY);

/** The edge-case staples, by the hash of their blocks; each line is the base64 of one staple as a bootstrap serves it. */
async function edgeCaseStaples(): Promise<readonly string[]> {
	const text = gunzipSync(await readFile(EDGE_CASE_FIXTURE)).toString('ascii');
	return(text.split('\n').filter(function(line): boolean {
		return(line !== '');
	}).map(function(line): string {
		return(new KeetaNet.lib.Vote.Staple(Buffer.from(line, 'base64')).blocksHash.toString());
	}));
}

/** The offline ledger of shadow votes, a database of the follower's cluster. */
const SHADOW_DATABASE = `${FOLLOWER_DATABASE}_shadow`;

const OFFLINE_TIMEOUT_MILLISECONDS = 600_000;

async function withMaintenance<Result>(directory: string, work: (client: pg.Client) => Promise<Result>): Promise<Result> {
	const client = new pg.Client({ connectionString: followerDatabaseURLOf(directory, 'postgres') });
	await client.connect();
	try {
		return(await work(client));
	} finally {
		await client.end();
	}
}

async function databaseExists(client: pg.Client, name: string): Promise<boolean> {
	return(((await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount ?? 0) > 0);
}

const BASE_LAST_STAPLE = 'SELECT sequence::text AS place, blocks_hash FROM staples ORDER BY sequence DESC LIMIT 1';

/** Staples whose every vote is from the moment on: those of the scoped window. */
/** Forgets every deferred staple; the rows of what each waits on go with it (schema/migrations/0001_ledger.sql, 0006_deferred_checks.sql). */
const FORGET_DEFERRED_STAPLES = 'DELETE FROM deferred_staples';

const BASE_SCOPED_STAPLES = `
	SELECT count(*) AS count FROM (
		SELECT blocks_hash FROM votes
		WHERE ledger = 'main' AND blocks_hash IN (SELECT blocks_hash FROM votes WHERE ledger = 'main' AND validity_from >= $1)
		GROUP BY blocks_hash HAVING min(validity_from) >= $1
	) AS scoped`;

/**
 * Makes the offline ledger's database: a copy of the snapshot, made file by
 * file, or an empty one the driver migrates. A snapshot's staples hold the
 * follower's places, so the run goes on from its newest, which the
 * follower's ledger must hold at the same place.
 */
async function prepareShadowLedger(directory: string, base: string | undefined, store: FollowerStore): Promise<ShadowBase> {
	await withMaintenance(directory, async function(client) {
		if (await databaseExists(client, SHADOW_DATABASE)) {
			throw(new Error(`${SHADOW_DATABASE} holds an offline ledger that no shadow-vote standing counts; start again with --restart`));
		}
		if (base === undefined) {
			await client.query(`CREATE DATABASE ${SHADOW_DATABASE}`);
			return;
		}
		if (base === FOLLOWER_DATABASE || base === SHADOW_DATABASE || !await databaseExists(client, base)) {
			throw(new Error(`${base} is no snapshot of the follower's database`));
		}
		await client.query(`CREATE DATABASE ${SHADOW_DATABASE} TEMPLATE ${base} STRATEGY FILE_COPY`);
	});
	if (base === undefined) {
		return({ database: null, sequence: '0', blocksHash: null, scopedStaples: 0 });
	}
	const copy = new pg.Client({ connectionString: followerDatabaseURLOf(directory, SHADOW_DATABASE) });
	await copy.connect();
	try {
		/*
		 * The follower lists every staple it applied at the place it applied
		 * it, those a replay of a deferred one applied included, so the run
		 * adds each itself and needs no deferred copy. A copy the snapshot
		 * kept would be applied by the replay of the staple before it on its
		 * chain, ahead of its own place, where its vote would see a ledger
		 * that holds it (src/parity/shadow-live.ts).
		 */
		await copy.query(FORGET_DEFERRED_STAPLES);
		const last = (await copy.query<{ place: string; blocks_hash: Buffer }>(BASE_LAST_STAPLE)).rows[0];
		const scoped = await copy.query<{ count: string }>(BASE_SCOPED_STAPLES, [SHADOW_SCOPE.from]);
		const sequence = last?.place ?? '0';
		const blocksHash = last?.blocks_hash.toString('hex').toUpperCase() ?? null;
		if (blocksHash !== null && await store.stapleAt(BigInt(sequence)) !== blocksHash) {
			throw(new Error(`the follower's ledger holds no staple ${blocksHash} at ${sequence}, where ${base} holds it; ${base} is no snapshot of this ledger`));
		}
		return({ database: base, sequence, blocksHash, scopedStaples: Number(scoped.rows[0]?.count ?? 0) });
	} finally {
		await copy.end();
	}
}

/** Where the run stands, with the follower's newest staple as its target; a run that does not stand yet starts from its base. */
async function shadowStart(command: Extract<ParityCommand, { kind: 'shadow' }>, directory: string, store: FollowerStore, loaded: ShadowRunState | undefined): Promise<ShadowRunState> {
	const progress = await store.progress();
	const target: ShadowTarget = {
		sequence: (await store.lastSequence()).toString(),
		fixedAt: new Date().toISOString(),
		followerCaughtUp: caughtUp(progress),
		heldBefore: progress.heldBefore?.toISOString() ?? null
	};
	if (loaded === undefined) {
		const base = await prepareShadowLedger(directory, command.base, store);
		return(freshShadowRun(SHADOW_SCOPE, command.informationalEvery, base, target));
	}
	if (command.base !== undefined && command.base !== loaded.base.database) {
		throw(new Error(`the run started from ${loaded.base.database ?? 'an empty ledger'}, not ${command.base}; start again with --restart to change it`));
	}
	const { reached } = loaded;
	if (reached.blocksHash !== null && await store.stapleAt(BigInt(reached.sequence)) !== reached.blocksHash) {
		throw(new Error(`the follower's ledger no longer holds the staple ${reached.blocksHash} at ${reached.sequence}, where the run stopped; it was rebuilt since, so start again with --restart`));
	}
	return({ ...loaded, target });
}

function replayedOf(state: ShadowRunState): number {
	return(state.scoped.replayed + state.informational.replayed);
}

function shadowVotesOf(state: ShadowRunState): number {
	return(state.scoped.shadowVoted + state.informational.shadowVoted);
}

const KIB_PER_MIB = 1024;

/**
 * Runs or resumes the shadow votes, and records where they stand. The run
 * takes the lowest CPU priority, so that the follower's node keeps its pace
 * beside it, and a stop asked for ends it after the batch it is in.
 */
async function shadow(command: Extract<ParityCommand, { kind: 'shadow' }>, directory: string, tools: Tools): Promise<ExitCode> {
	setPriority(19);
	const state = fileShadowState(shadowDirectory(directory));
	if (command.restart) {
		await withMaintenance(directory, async function(client) {
			await client.query(`DROP DATABASE IF EXISTS ${SHADOW_DATABASE}`);
		});
		await state.clear();
	}
	const loaded = await state.load();
	const start = await shadowStart(command, directory, tools.store, loaded);
	/*
	 * A run that stands somewhere already is saved only by its batches: a
	 * save now would count the votes of a batch a stop cut short as covered,
	 * and the run would then find their staples in the ledger unrecorded.
	 */
	if (loaded === undefined) {
		await state.save(start);
	}
	const storage = new PostgresLedgerStorage({
		kind: 'connection-string',
		connectionString: followerDatabaseURLOf(directory, SHADOW_DATABASE),
		/*
		 * The offline ledger is the database's only client, and a vote on a
		 * staple of hundreds of operations computes its effects for many
		 * seconds inside one transaction, so its sessions are not ended for
		 * idling there, as a node's are to free locks for other writers.
		 */
		options: { statementTimeoutMillis: OFFLINE_TIMEOUT_MILLISECONDS, idleInTransactionTimeoutMillis: OFFLINE_TIMEOUT_MILLISECONDS }
	});
	const at = new Date().toISOString();
	const started = performance.now();
	let lastReport = started;
	let lastReplayed = replayedOf(start);
	let reached: ShadowRunState;
	try {
		reached = await runShadowVotes({
			source: tools.store,
			state,
			storage,
			start,
			batchStaples: command.batchStaples,
			stopped: tools.stopped,
			progress(standing) {
				const now = performance.now();
				const rate = (replayedOf(standing) - lastReplayed) * 1000 / Math.max(1, now - lastReport);
				lastReport = now;
				lastReplayed = replayedOf(standing);
				const heapMiB = Math.round(process.memoryUsage().heapUsed / KIB_PER_MIB / KIB_PER_MIB);
				process.stderr.write(`replayed to ${standing.reached.sequence} of ${standing.target.sequence} (${rate.toFixed(1)} staples/s, voted up to ${standing.scoped.votedTo ?? standing.informational.votedTo ?? '-'}); scoped: ${String(standing.scoped.shadowVoted)} voted on, ${String(standing.scoped.unexplained)} unexplained; informational: ${String(standing.informational.shadowVoted)} voted on, ${String(standing.informational.unexplained)} unexplained; ${String(standing.unapplied.length)} not applied; heap ${String(heapMiB)} MiB\n`);
			}
		});
	} finally {
		await storage.destroy();
	}
	const record: ShadowRunRecord = {
		kind: 'shadow-run',
		at,
		...reached,
		complete: shadowRunComplete(reached),
		cost: {
			seconds: Math.round((performance.now() - started) / 1000),
			staples: replayedOf(reached) - replayedOf(start),
			shadowVotes: shadowVotesOf(reached) - shadowVotesOf(start),
			maxResidentMiB: Math.round(process.resourceUsage().maxRSS / KIB_PER_MIB)
		}
	};
	await tools.log.append([record]);
	process.stdout.write(`${JSON.stringify(record, null, '\t')}\n`);
	return(0);
}

type Tools = {
	readonly directory: string;
	readonly follower: APISource;
	readonly representatives: readonly APISource[];
	readonly store: FollowerStore;
	readonly log: ParityLog;
	readonly cursorPath: string;
	readonly stopped: AbortSignal;
};

function anyFails(report: ParityReport): boolean {
	return(Object.values(report.signals).some(function(signal): boolean {
		return(signal.verdict === 'fail');
	}));
}

async function wait(milliseconds: number): Promise<void> {
	await delay(milliseconds);
}

async function run(command: ParityCommand, tools: Tools): Promise<ExitCode> {
	switch (command.kind) {
		case 'checksum': {
			const crossCheck = await crossCheckChecksum({ store: tools.store });
			const comparison = await compareChecksums({
				follower: tools.follower,
				representatives: tools.representatives,
				progress: await tools.store.progress(),
				gapMilliseconds: command.gapMilliseconds,
				wait,
				sweep() {
					return(sweepPointerOf(tools.log, tools.cursorPath));
				}
			});
			const records = [crossCheck, ...comparison.checksums, ...comparison.blockCounts];
			await tools.log.append(records);
			process.stdout.write(`${JSON.stringify(records, null, '\t')}\n`);
			return(0);
		}
		case 'sweep': {
			const summary = await sweepAccounts({ ...tools, accounts: command.accounts });
			process.stdout.write(`${JSON.stringify(summary, null, '\t')}\n`);
			return(0);
		}
		case 'api-diff': {
			const summary = await sampleAPI({
				...tools,
				samplesPerStratum: command.samplesPerStratum,
				seed: command.seed ?? new Date().toISOString(),
				edgeCaseStaples: await edgeCaseStaples(),
				knownBehaviors: await capturedBehaviors(fileURLToPath(CAPTURE_DIRECTORY))
			});
			process.stdout.write(`${JSON.stringify(summary, null, '\t')}\n`);
			return(0);
		}
		case 'shadow':
			return(await shadow(command, tools.directory, tools));
		case 'report': {
			const apiDiff = {
				samplesPerStratum: command.apiSamples,
				seed: new Date().toISOString(),
				edgeCaseStaples: await edgeCaseStaples(),
				knownBehaviors: await capturedBehaviors(fileURLToPath(CAPTURE_DIRECTORY))
			};
			const report = await runParity({ ...tools, sampleAccounts: command.sampleAccounts, apiDiff, gapMilliseconds: command.gapMilliseconds, wait });
			process.stdout.write(`${JSON.stringify(report, null, '\t')}\n`);
			if (anyFails(report)) {
				return(1);
			}
			return(0);
		}
		default:
			return(assertNever(command));
	}
}

async function main(argv: readonly string[]): Promise<ExitCode> {
	const command = parseParityCommand(argv, homedir());
	if (command === undefined) {
		process.stderr.write(USAGE);
		return(2);
	}
	try {
		const directory = followerDirectory(command.directory, tmpdir());
		const settings = await readFollowerSettings(directory);
		if (settings === undefined) {
			process.stderr.write(`no follower was started in ${directory}\n`);
			return(1);
		}
		let lock = PARITY_LOCK_FILE;
		if (command.kind === 'shadow') {
			lock = SHADOW_LOCK_FILE;
		}
		const release = await lockParity(directory, process.pid, lock);
		const stopping = new AbortController();
		const stop = function(): void {
			stopping.abort(new Error('stopped'));
		};
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
		const store = openFollowerStore(followerDatabaseURL(directory));
		try {
			const pacer = new PeerPacer(REPRESENTATIVE_INTERVAL_MILLISECONDS);
			return(await run(command, {
				directory,
				follower: httpSource(`http://${FOLLOWER_LISTEN_IP}:${String(settings.port)}/api`),
				representatives: MAINNET_REPRESENTATIVE_APIS.map(function(endpoint): APISource {
					return(pacedSource(httpSource(endpoint), pacer, stopping.signal));
				}),
				store,
				log: new ParityLog(parityLogPath(directory)),
				cursorPath: sweepCursorPath(directory),
				stopped: stopping.signal
			}));
		} finally {
			await store.close();
			await release();
		}
	} catch (error: unknown) {
		process.stderr.write(`utils/parity: ${messageOf(error)}\n`);
		if (error instanceof Error && error.stack !== undefined) {
			process.stderr.write(`${error.stack}\n`);
		}
		return(1);
	}
}

process.exitCode = await main(process.argv.slice(2));
