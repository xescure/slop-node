#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir, setPriority, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import { assertNever } from '../util/assert-never.js';
import { capturedBehaviors, explainDivergence, recheckAPIDivergences, sampleAPI } from './api-diff.js';
import { httpSource, pacedSource } from './api-source.js';
import type { APISource } from './api-source.js';
import { compareChecksums, crossCheckChecksum } from './checksum.js';
import { FOLLOWER_DATABASE, FOLLOWER_LISTEN_IP, followerDatabaseURL, followerDatabaseURLOf, followerDirectory, MAINNET_REPRESENTATIVE_APIS, readFollowerSettings } from './follower-config.js';
import { caughtUp, openFollowerStore } from './follower-store.js';
import type { FollowerStore } from './follower-store.js';
import { ParityLog, parityLogPath } from './log.js';
import type { ShadowBase, ShadowRunRecord, ShadowRunState, ShadowTarget, SweepCursor, SweepWalk } from './log.js';
import { lockParity, PARITY_LOCK_FILE, parseParityCommand, SHADOW_LOCK_FILE } from './parity-command.js';
import type { ParityCommand } from './parity-command.js';
import { neverComparedAccountsOf, reportOnLog, runParity, sweepPointerOf, sweepPositionOf } from './report.js';
import { DEFAULT_REPRESENTATIVE_PACING, RepresentativePacer } from './representative-pacer.js';
import type { PacerClock, RepresentativePacing } from './representative-pacer.js';
import type { ParityReport } from './report.js';
import { freshShadowRun, runShadowVotes, SHADOW_SCOPE, shadowRunComplete } from './shadow-live.js';
import { fileShadowState, shadowDirectory } from './shadow-state.js';
import { compareNeverCompared, recheckDivergences, sweepAccounts, sweepCursorPaths } from './sweep.js';
import { retryingStore } from './transient-store.js';
import type { TransientFailure } from './transient-store.js';
import type { SweepCursorPaths } from './sweep.js';

/** The pacer reads the wall clock, which a Retry-After date is in. */
const WALL_CLOCK: PacerClock = {
	now(): number {
		return(Date.now());
	},
	async pause(milliseconds: number, stopped: AbortSignal): Promise<void> {
		await delay(milliseconds, undefined, { signal: stopped });
	}
};

/** The shadow votes send no request, so they take the pacing they never use. */
function pacingOf(command: ParityCommand): RepresentativePacing {
	if (command.kind === 'shadow' || command.kind === 'explain') {
		return(DEFAULT_REPRESENTATIVE_PACING);
	}
	return(command.pacing);
}

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
	'  sweep     compare the state of the accounts the follower knows, in two walks side by side, each from',
	'            where it stopped last: the accounts with a chain one at a time, compared at the same head,',
	'            and the rest a hundred at a time, each answered apart compared again by itself',
	'            --accounts <n>     how many accounts each walk goes past (100)',
	'            --lap              go on to the end of the lap each walk is on (as many as there are)',
	'            an account that diverges from its representative is read again from every other one: the',
	'            follower\'s divergence when it disagrees with most, the own of those apart when two answer',
	'            as the follower, every other value fewer, and the follower holds what each apart holds newest,',
	'            its balances checked against its history; unresolved otherwise',
	'  recheck   compare again each account whose latest comparison diverged or was unresolved, or left the',
	'            difference to those apart without a consistent check of the follower\'s balances, or that both',
	'            sides answered with the same error, with the',
	'            representative it was compared with, and read it again from every other representative;',
	'            then compare by itself each account the latest complete lap never compared, recorded in that lap;',
	'            and send again each API diff request whose latest comparison diverged or was unresolved,',
	'            and each request of the latest API diff census not compared yet',
	'  api-diff  send the same GET requests, drawn from what the follower holds within its reach, to the',
	'            follower and to a representative, and compare the answers, stratum by stratum; a stratum',
	'            with fewer requests than --samples in all is a census, each of its requests sent; answers',
	'            that differ are sent again to every other representative and judged as the sweep judges',
	'            --samples <n>      how many requests of each stratum to compare (300, the done criterion; fewer',
	'                               reads a bounded part of the blocks and records no plan)',
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
	'  explain   record the triage of an open API divergence of a state that has moved on, which closes it:',
	'            --stratum <stratum> --path <path> --at <moment the divergence was recorded>',
	'            --class our-bug|upstream-version|operational-artifact --reference <fixing change or document section>',
	'            refused unless a later comparison of the request retested the divergence, or found it moving:',
	'            --force <why>      record it all the same, with why no retest is needed',
	'  report    check the checksum and compare a sweep sample and an API diff sample, then print the',
	'            parity report as JSON, with the latest shadow-vote run from the log; exits 1 when a signal fails',
	'            --sample <n>       how many chain accounts the sweep sample compares (16)',
	'            --passive-sample <n>  how many passive accounts the sweep sample goes past (400)',
	'            --log-only         compare nothing afresh: report on the log as it stands, beside a running sweep',
	'            --api-samples <n>  how many requests of each stratum the API diff sample compares (2)',
	'            --gap-ms <ms>      as for checksum',
	'',
	'Every command but shadow takes --rep-concurrency <n>, the most requests in flight to each representative (4),',
	'and --rep-gap-ms <ms>, how long after one request to a representative starts the next may start (0); a',
	'representative answering 429, or a server error other than the API\'s own internal failure, has that halved',
	'(down to 1) and is left alone for 1 s, doubling to 30 s with each such answer in a row, or for its Retry-After;',
	'each run of 10 other answers allows one more in flight again.',
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

/** Forgets every deferred staple; the rows of what each waits on go with it (schema/migrations/0001_ledger.sql, 0006_deferred_checks.sql). */
const FORGET_DEFERRED_STAPLES = 'DELETE FROM deferred_staples';

/** Staples whose every vote is from the moment on: those of the scoped window. */
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
		 * applies each itself, as the follower's ledger accepted it, and
		 * needs no deferred copy. A copy would be applied by the collection
		 * after the staple before it on its chain, ahead of its own place,
		 * where its vote would see a ledger that holds it
		 * (src/parity/shadow-live.ts).
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
	readonly cursorPaths: SweepCursorPaths;
	readonly stopped: AbortSignal;
};

function anyFails(report: ParityReport): boolean {
	return(Object.values(report.signals).some(function(signal): boolean {
		return(signal.verdict === 'fail');
	}));
}

/** The latest lap of a walk it has completed, or undefined, with why on the standard error, when it has completed none. */
function latestCompleteLap(walk: SweepWalk, cursor: SweepCursor): number | undefined {
	if (cursor.lap === 0) {
		process.stderr.write(`the ${walk} walk has completed no lap, so no account of it is compared as never compared\n`);
		return(undefined);
	}
	return(cursor.lap - 1);
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
					return(sweepPointerOf(tools.log, tools.cursorPaths));
				}
			});
			const records = [crossCheck, ...comparison.checksums, ...comparison.blockCounts];
			await tools.log.append(records);
			process.stdout.write(`${JSON.stringify(records, null, '\t')}\n`);
			return(0);
		}
		case 'sweep': {
			const summary = await sweepAccounts({ ...tools, accounts: { chain: command.accounts, passive: command.accounts }, toLapEnd: command.toLapEnd, passiveRequestsInFlight: command.pacing.concurrency });
			process.stdout.write(`${JSON.stringify(summary, null, '\t')}\n`);
			return(0);
		}
		case 'recheck': {
			const sweep = await recheckDivergences(tools);
			const apiDiff = await recheckAPIDivergences(tools);
			const { records } = await tools.log.read();
			const position = await sweepPositionOf(tools, records);
			const neverCompared = await compareNeverCompared(tools, neverComparedAccountsOf(records, position), {
				chain: latestCompleteLap('chain', position.cursors.chain),
				passive: latestCompleteLap('passive', position.cursors.passive)
			}, wait);
			const summary = { sweep, apiDiff, neverCompared };
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
		case 'explain': {
			const { stratum, path, divergenceAt, divergence, reference, untestedBecause } = command;
			const explained = await explainDivergence(tools.log, { stratum, path, divergenceAt, divergence, reference, untestedBecause });
			process.stdout.write(`${JSON.stringify(explained, null, '\t')}\n`);
			return(0);
		}
		case 'report': {
			if (command.logOnly) {
				const report = await reportOnLog({ ...tools, knownBehaviors: await capturedBehaviors(fileURLToPath(CAPTURE_DIRECTORY)) });
				process.stdout.write(`${JSON.stringify(report, null, '\t')}\n`);
				if (anyFails(report)) {
					return(1);
				}
				return(0);
			}
			const apiDiff = {
				samplesPerStratum: command.apiSamples,
				seed: new Date().toISOString(),
				edgeCaseStaples: await edgeCaseStaples(),
				knownBehaviors: await capturedBehaviors(fileURLToPath(CAPTURE_DIRECTORY))
			};
			const report = await runParity({ ...tools, sampleAccounts: command.sampleAccounts, passiveSampleAccounts: command.passiveSampleAccounts, apiDiff, gapMilliseconds: command.gapMilliseconds, wait });
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

/**
 * The shadow run sends no request, a report on the log alone only reads,
 * and a triage appends one line to it, so none takes the lock that keeps
 * the representatives' pace across the tools that do.
 */
async function lockFor(command: ParityCommand, directory: string): Promise<() => Promise<void>> {
	if (command.kind === 'shadow') {
		return(await lockParity(directory, process.pid, SHADOW_LOCK_FILE));
	}
	if ((command.kind === 'report' && command.logOnly) || command.kind === 'explain') {
		return(function(): Promise<void> {
			return(Promise.resolve());
		});
	}
	return(await lockParity(directory, process.pid, PARITY_LOCK_FILE));
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
		const release = await lockFor(command, directory);
		const stopping = new AbortController();
		const stop = function(): void {
			stopping.abort(new Error('stopped'));
		};
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
		const store = retryingStore(openFollowerStore(followerDatabaseURL(directory)), {
			clock: WALL_CLOCK,
			stopped: stopping.signal,
			retrying(error: unknown, { attempt, elapsedMilliseconds, waitMilliseconds }: TransientFailure): void {
				process.stderr.write(`${new Date().toISOString()} the follower's database failed read attempt ${String(attempt)}, ${String(Math.round(elapsedMilliseconds / 1000))} s into the read (${messageOf(error)}); reading again in ${String(waitMilliseconds)} ms\n`);
			}
		});
		try {
			const pacer = new RepresentativePacer(pacingOf(command), WALL_CLOCK, function(endpoint, standing, waitMilliseconds, why) {
				process.stderr.write(`${new Date().toISOString()} ${endpoint} ${why}: ${String(standing.concurrency)} in flight at most, next in ${String(waitMilliseconds)} ms, backed off ${String(standing.backedOff)} times\n`);
			});
			try {
				return(await run(command, {
					directory,
					follower: httpSource(`http://${FOLLOWER_LISTEN_IP}:${String(settings.port)}/api`),
					representatives: MAINNET_REPRESENTATIVE_APIS.map(function(endpoint): APISource {
						return(pacedSource(endpoint, pacer, stopping.signal));
					}),
					store,
					log: new ParityLog(parityLogPath(directory)),
					cursorPaths: sweepCursorPaths(directory),
					stopped: stopping.signal
				}));
			} finally {
				process.stderr.write(`representatives: ${JSON.stringify(pacer.standing())}\n`);
			}
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
