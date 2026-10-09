#!/usr/bin/env node
import { homedir, tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PeerPacer } from '../node/bootstrap-pacing.js';
import { assertNever } from '../util/assert-never.js';
import { httpSource, pacedSource } from './api-source.js';
import type { APISource } from './api-source.js';
import { compareChecksums } from './checksum.js';
import { FOLLOWER_LISTEN_IP, followerDatabaseURL, followerDirectory, MAINNET_REPRESENTATIVE_APIS, readFollowerSettings } from './follower-config.js';
import { openFollowerStore } from './follower-store.js';
import type { FollowerStore } from './follower-store.js';
import { ParityLog, parityLogPath } from './log.js';
import { lockParity, parseParityCommand } from './parity-command.js';
import type { ParityCommand } from './parity-command.js';
import { runParity, sweepPointerOf } from './report.js';
import type { ParityReport } from './report.js';
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
	'  checksum  compare the follower\'s ledger checksum with each representative\'s',
	'            --gap-ms <ms>      how long both must hold still to count (10000)',
	'  sweep     compare the state of the accounts the follower knows, from where the last sweep stopped',
	'            --accounts <n>     how many accounts (100)',
	'  report    run a checksum comparison and a sweep sample, then print the parity report as JSON;',
	'            exits 1 when a signal fails',
	'            --sample <n>       how many accounts the sweep sample compares (16)',
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
			const records = await compareChecksums({
				follower: tools.follower,
				representatives: tools.representatives,
				progress: await tools.store.progress(),
				gapMilliseconds: command.gapMilliseconds,
				wait,
				sweep() {
					return(sweepPointerOf(tools.log, tools.cursorPath));
				}
			});
			await tools.log.append(records);
			process.stdout.write(`${JSON.stringify(records, null, '\t')}\n`);
			return(0);
		}
		case 'sweep': {
			const summary = await sweepAccounts({ ...tools, accounts: command.accounts });
			process.stdout.write(`${JSON.stringify(summary, null, '\t')}\n`);
			return(0);
		}
		case 'report': {
			const report = await runParity({ ...tools, sampleAccounts: command.sampleAccounts, gapMilliseconds: command.gapMilliseconds, wait });
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
