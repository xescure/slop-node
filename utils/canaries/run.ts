import { execFile, spawn } from 'node:child_process';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { driftOf } from './drift.js';
import { patchOf, testFilesOf } from './list.js';
import type { Canary, Fix } from './list.js';
import { baselineProblemOf, describeName, escapeOf, firstLine, parseRunReport } from './report.js';
import type { NamedTest, RunReport, TestResult } from './report.js';
import { REPORT_VARIABLE } from './reporter.js';

/** Where each canary's clone is made, under the build directory "make clean" removes. */
export const SCRATCH_DIRECTORY = 'build/canaries';

/** The reporter each run in a clone writes its report with, from the clone's own tree. */
const REPORTER = 'utils/canaries/reporter.ts';

/** The vitest workers a canary's run may use: the workspace's memory cap allows three at most. */
const MAX_WORKERS = '3';

const run = promisify(execFile);

/** The canaries cannot run as asked, before any is run. */
export class CanariesRefused extends Error {}

function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		return(error.stack ?? error.message);
	}
	return(String(error));
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

function escapedPattern(text: string): string {
	return(text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&'));
}

/** vitest's test name pattern for exactly the named tests, which it matches against the titles joined by spaces, after those of the file. */
function namePatternOf(tests: readonly NamedTest[]): string {
	return(`(?:^| )(?:${tests.map(function(test): string {
		return(escapedPattern(test.name.join(' ')));
	}).join('|')})$`);
}

/**
 * Runs the test files in the clone, only the tests the pattern names when it
 * is given, with the clone's canary reporter; vitest's output goes to a log
 * in the clone, named by the run.
 */
export async function runTests(scratch: string, files: readonly string[], label: string, namePattern?: string): Promise<RunReport> {
	const reportPath = join(scratch, `canary-${label}.json`);
	const logPath = join(scratch, `canary-${label}.log`);
	const filter: string[] = [];
	if (namePattern !== undefined) {
		filter.push('--testNamePattern', namePattern);
	}
	const log = await open(logPath, 'w');
	try {
		await new Promise<void>(function(settle, fail) {
			const child = spawn(join(scratch, 'node_modules', '.bin', 'vitest'), [
				'run',
				'--config', '.vitest.config.js',
				'--project', 'unit',
				'--maxWorkers', MAX_WORKERS,
				'--reporter', 'default',
				'--reporter', join(scratch, REPORTER),
				...filter,
				...files
			], { cwd: scratch, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, [REPORT_VARIABLE]: reportPath } });
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
		throw(new Error(`vitest wrote no report; see ${logPath}`, { cause: error }));
	}
	return(parseRunReport(report, scratch));
}

type Verdict = {
	readonly escapes: readonly string[];
	readonly failed: readonly TestResult[];
};

function problemsOf(tests: readonly NamedTest[], problemOf: (test: NamedTest) => string | undefined): string[] {
	return(tests.flatMap(function(test): string[] {
		const problem = problemOf(test);
		if (problem === undefined) {
			return([]);
		}
		return([problem]);
	}));
}

/**
 * Clones HEAD, checks the canary still fits it, runs its named tests, which
 * must pass, then applies its patch, from the clone, and runs their files,
 * whose named tests must each fail by assertion.
 */
async function runCanary(canary: Canary, scratch: string, root: string, commit: string): Promise<Verdict> {
	await cloneAt(root, commit, scratch);
	const drift = await driftOf(canary, scratch);
	if (drift.length > 0) {
		return({ escapes: drift, failed: [] });
	}
	const files = testFilesOf(canary);
	const baseline = await runTests(scratch, files, 'baseline', namePatternOf(canary.catchers));
	const red = problemsOf(canary.catchers, function(test): string | undefined {
		return(baselineProblemOf(baseline, test));
	});
	if (red.length > 0) {
		return({ escapes: red, failed: [] });
	}
	await run('git', ['apply', patchOf(canary)], { cwd: scratch });
	const report = await runTests(scratch, files, 'reverted');
	return({
		escapes: problemsOf(canary.catchers, function(test): string | undefined {
			return(escapeOf(report, test));
		}),
		failed: report.tests.filter(function(test): boolean {
			return(test.status === 'failed');
		})
	});
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

export type CanaryRun = {
	/** The repository, whose HEAD the canaries revert their fixes in. */
	readonly root: string;
	readonly canaries: readonly Canary[];
	/** Keep the clone of a canary that was caught as well. */
	readonly keep: boolean;
	readonly write: (line: string) => void;
};

/**
 * Runs each canary against HEAD, one at a time, and answers whether every
 * one was caught. A clone takes HEAD's code, list and patches, and the
 * dependencies of the working tree, so the tree must hold nothing HEAD does
 * not: a run then judges exactly the commit it names.
 */
export async function runCanaries(options: CanaryRun): Promise<boolean> {
	const { root } = options;
	const changes = (await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root })).stdout;
	if (changes !== '') {
		throw(new CanariesRefused(`the working tree differs from HEAD, whose code, canary list and patches the canaries run; commit or stash first:\n${changes.trimEnd()}`));
	}
	const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
	options.write(`canaries of ${commit}, each in a clone under ${SCRATCH_DIRECTORY}, one at a time`);
	let caught = 0;
	for (const canary of options.canaries) {
		const scratch = join(root, SCRATCH_DIRECTORY, canary.name);
		let verdict: Verdict;
		try {
			verdict = await runCanary(canary, scratch, root, commit);
		} catch (error: unknown) {
			verdict = { escapes: [`the canary failed to run: ${describeFailure(error)}`], failed: [] };
		}
		for (const line of describeVerdict(canary, verdict, scratch)) {
			options.write(line);
		}
		if (verdict.escapes.length === 0) {
			caught++;
			if (!options.keep) {
				await rm(scratch, { recursive: true, force: true });
			}
		}
	}
	options.write(`${String(caught)} of ${String(options.canaries.length)} canaries caught`);
	return(caught === options.canaries.length);
}
