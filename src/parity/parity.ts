#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { PeerPacer } from '../node/bootstrap-pacing.js';
import { assertNever } from '../util/assert-never.js';
import { capturedBehaviours, sampleAPI } from './api-diff.js';
import { httpSource, pacedSource } from './api-source.js';
import type { APISource } from './api-source.js';
import { compareChecksums, crossCheckChecksum } from './checksum.js';
import { FOLLOWER_LISTEN_IP, followerDatabaseURL, followerDirectory, MAINNET_REPRESENTATIVE_APIS, readFollowerSettings } from './follower-config.js';
import { openFollowerStore } from './follower-store.js';
import type { FollowerStore } from './follower-store.js';
import { ParityLog, parityLogPath } from './log.js';
import { lockParity, parseParityCommand } from './parity-command.js';
import type { ParityCommand } from './parity-command.js';
import { runParity, sweepPointerOf } from './report.js';
import type { ParityReport } from './report.js';
import { shadowVoteLive } from './shadow-live.js';
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
	'  shadow    replay the follower\'s history into an offline ledger and shadow-vote on the newest staples',
	'            within its reach, as a representative asked about them then would; it reads only the',
	'            follower\'s database',
	'            --window <n>       how many staples to vote on (1000)',
	'  report    check the checksum and compare a sweep sample and an API diff sample, then print the',
	'            parity report as JSON, with the latest shadow votes from the log; exits 1 when a signal fails',
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

type Tools = {
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
			const crossCheck = await crossCheckChecksum({ follower: tools.follower, store: tools.store });
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
				knownBehaviours: await capturedBehaviours(fileURLToPath(CAPTURE_DIRECTORY))
			});
			process.stdout.write(`${JSON.stringify(summary, null, '\t')}\n`);
			return(0);
		}
		case 'shadow': {
			const record = await shadowVoteLive({ store: tools.store, windowStaples: command.windowStaples, storage: () => new MemoryLedgerStorage() });
			await tools.log.append([record]);
			process.stdout.write(`${JSON.stringify(record, null, '\t')}\n`);
			return(0);
		}
		case 'report': {
			const apiDiff = {
				samplesPerStratum: command.apiSamples,
				seed: new Date().toISOString(),
				edgeCaseStaples: await edgeCaseStaples(),
				knownBehaviours: await capturedBehaviours(fileURLToPath(CAPTURE_DIRECTORY))
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
		const release = await lockParity(directory);
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
		return(1);
	}
}

process.exitCode = await main(process.argv.slice(2));
