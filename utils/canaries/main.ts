import { execFile, spawn } from 'node:child_process';
import { open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { driftOf } from './drift.js';
import { CANARIES, patchOf, testFilesOf } from './list.js';
import type { Canary, Fix } from './list.js';
import { describeName, escapeOf, firstLine, parseRunReport } from './report.js';
import type { RunReport, TestResult } from './report.js';

const usage = 'usage: main.js [--canary <name>]... [--keep]';

/** Where each canary's clone is made, under the build directory "make clean" removes. */
const SCRATCH_DIRECTORY = 'build/canaries';

/** The vitest workers a canary's run may use: the workspace's memory cap allows three at most. */
const MAX_WORKERS = '3';

const run = promisify(execFile);

class UsageError extends Error {}

function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		return(error.stack ?? error.message);
	}
	return(String(error));
}

type Options = {
	readonly canaries: readonly Canary[];
	readonly keep: boolean;
};

function parseOptions(): Options {
	let values: { readonly canary?: string[] | undefined; readonly keep?: boolean | undefined };
	try {
		({ values } = parseArgs({
			options: { canary: { type: 'string', multiple: true }, keep: { type: 'boolean', default: false } },
			strict: true,
			allowPositionals: false
		}));
	} catch (error: unknown) {
		throw(new UsageError(`${String(error)}; ${usage}`, { cause: error }));
	}
	const names = values.canary;
	if (names === undefined) {
		return({ canaries: CANARIES, keep: values.keep === true });
	}
	const canaries = names.map(function(name): Canary {
		const canary = CANARIES.find(function(candidate): boolean {
			return(candidate.name === name);
		});
		if (canary === undefined) {
			throw(new UsageError(`no canary is named ${name}; ${usage}`));
		}
		return(canary);
	});
	return({ canaries, keep: values.keep === true });
}

function describeFix(fix: Fix): string {
	switch (fix.kind) {
		case 'commit':
			return(`commit ${fix.commit}`);
		case 'release':
			return(`keetanet-client ${fix.version}`);
		default:
			return(fix satisfies never);
	}
}

/**
 * A clone of the commit, never a worktree, so that nothing the canary does
 * reaches the repository, with a copy of the dependencies as patched, which
 * a canary of upstream's fix patches further.
 */
async function cloneAt(root: string, commit: string, scratch: string): Promise<void> {
	await rm(scratch, { recursive: true, force: true });
	await run('git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', root, scratch]);
	await run('git', ['checkout', '--quiet', '--detach', commit], { cwd: scratch });
	await run('cp', ['-a', '--reflink=auto', join(root, 'node_modules'), join(scratch, 'node_modules')]);
}

/** Runs only the canary's test files, with vitest's JSON report; its output goes to a log in the clone. */
async function runTests(canary: Canary, scratch: string): Promise<RunReport> {
	const reportPath = join(scratch, 'canary-report.json');
	const log = await open(join(scratch, 'canary-vitest.log'), 'w');
	try {
		await new Promise<void>(function(settle, fail) {
			const child = spawn(join(scratch, 'node_modules', '.bin', 'vitest'), [
				'run',
				'--config', '.vitest.config.js',
				'--project', 'unit',
				'--maxWorkers', MAX_WORKERS,
				'--reporter', 'json',
				'--outputFile', reportPath,
				...testFilesOf(canary)
			], { cwd: scratch, stdio: ['ignore', log.fd, log.fd] });
			child.on('error', fail);
			// A canary is meant to fail tests, so vitest's exit status says nothing; the report does.
			child.on('exit', function(): void {
				settle();
			});
		});
	} finally {
		await log.close();
	}
	let report: unknown;
	try {
		report = JSON.parse(await readFile(reportPath, 'utf8'));
	} catch (error: unknown) {
		throw(new Error(`vitest wrote no report; see ${join(scratch, 'canary-vitest.log')}`, { cause: error }));
	}
	return(parseRunReport(report, scratch));
}

type Verdict = {
	readonly escapes: readonly string[];
	readonly failed: readonly TestResult[];
};

async function runCanary(canary: Canary, root: string, commit: string): Promise<Verdict> {
	const scratch = join(root, SCRATCH_DIRECTORY, canary.name);
	await cloneAt(root, commit, scratch);
	const drift = await driftOf(canary, scratch, resolve(root, patchOf(canary)));
	if (drift.length > 0) {
		return({ escapes: drift, failed: [] });
	}
	await run('git', ['apply', resolve(root, patchOf(canary))], { cwd: scratch });
	const report = await runTests(canary, scratch);
	const escapes = canary.catchers.flatMap(function(test): string[] {
		const escape = escapeOf(report, test);
		if (escape === undefined) {
			return([]);
		}
		return([escape]);
	});
	const failed = report.tests.filter(function(test): boolean {
		return(test.status === 'failed');
	});
	return({ escapes, failed });
}

function describeVerdict(canary: Canary, verdict: Verdict, scratch: string): string[] {
	const lines: string[] = [];
	if (verdict.escapes.length === 0) {
		lines.push(`${canary.name} (reverts ${describeFix(canary.fix)}): caught`);
	} else {
		lines.push(`${canary.name} (reverts ${describeFix(canary.fix)}): NOT CAUGHT, its clone kept at ${scratch}`);
		for (const escape of verdict.escapes) {
			lines.push(`  ${escape}`);
		}
	}
	for (const test of verdict.failed) {
		lines.push(`  failed: ${test.file}: ${describeName(test.name)} (${test.failure?.kind ?? 'unknown'}: ${firstLine(test.failure?.message ?? '')})`);
	}
	return(lines);
}

async function runAll(): Promise<boolean> {
	const options = parseOptions();
	const root = process.cwd();
	const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
	console.log(`canaries of ${commit}, each in a clone under ${SCRATCH_DIRECTORY}, one at a time`);
	let caught = 0;
	for (const canary of options.canaries) {
		const scratch = join(root, SCRATCH_DIRECTORY, canary.name);
		let verdict: Verdict;
		try {
			verdict = await runCanary(canary, root, commit);
		} catch (error: unknown) {
			verdict = { escapes: [`the canary failed to run: ${describeFailure(error)}`], failed: [] };
		}
		for (const line of describeVerdict(canary, verdict, scratch)) {
			console.log(line);
		}
		if (verdict.escapes.length === 0) {
			caught++;
			if (!options.keep) {
				await rm(scratch, { recursive: true, force: true });
			}
		}
	}
	console.log(`${String(caught)} of ${String(options.canaries.length)} canaries caught`);
	return(caught === options.canaries.length);
}

try {
	if (!await runAll()) {
		process.exitCode = 1;
	}
} catch (error: unknown) {
	if (error instanceof UsageError) {
		console.error(error.message);
		process.exitCode = 2;
	} else {
		console.error(describeFailure(error));
		process.exitCode = 1;
	}
}
