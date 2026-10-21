import { writeFileSync } from 'node:fs';
import type { RunnerTask, RunnerTaskResult, RunnerTestFile } from 'vitest';
import type { Reporter } from 'vitest/node';

/** The variable naming the file the report is written to. */
export const REPORT_VARIABLE = 'SLOP_NODE_CANARY_REPORT';

export type ReportedError = {
	readonly name: string;
	readonly message: string;
};

export type ReportedTest = {
	/** The titles of the blocks around the test, outermost first, and its own. */
	readonly name: readonly string[];
	/** As vitest's runner records it: pass, fail, skip, todo, or run when it never ended. */
	readonly state: string;
	readonly errors: readonly ReportedError[];
	/** The hooks of the test that began and did not pass: a hook that throws or hangs leaves its state at run. */
	readonly failedHooks: readonly string[];
};

export type ReportedFile = {
	readonly file: string;
	/** What failed the file or a block of it outside its tests: collecting it, or a beforeAll or afterAll. */
	readonly errors: readonly ReportedError[];
	readonly tests: readonly ReportedTest[];
};

export type CanaryReport = {
	readonly files: readonly ReportedFile[];
};

/*
 * The error's own name and message, not its stack: vitest gives a timeout's
 * error the stack of another error [vitest 3.2.7] @vitest/runner
 * dist/chunk-hooks.js:2005-2011, so its JSON report, which writes the stack,
 * shows a timeout as "Error: STACK_TRACE_ERROR".
 */
function errorsOf(result: RunnerTaskResult | undefined): ReportedError[] {
	return((result?.errors ?? []).map(function(error): ReportedError {
		return({ name: error.name ?? '', message: error.message });
	}));
}

function failedHooksOf(result: RunnerTaskResult | undefined): string[] {
	return(Object.entries(result?.hooks ?? {}).filter(function([, state]): boolean {
		return(state !== 'pass');
	}).map(function([hook]): string {
		return(hook);
	}));
}

function collect(task: RunnerTask, blocks: readonly string[], file: { errors: ReportedError[]; tests: ReportedTest[] }): void {
	if (task.type === 'suite') {
		file.errors.push(...errorsOf(task.result));
		for (const child of task.tasks) {
			collect(child, [...blocks, task.name], file);
		}
		return;
	}
	file.tests.push({ name: [...blocks, task.name], state: task.result?.state ?? task.mode, errors: errorsOf(task.result), failedHooks: failedHooksOf(task.result) });
}

/**
 * Writes what each test of the run did to the file REPORT_VARIABLE names,
 * for utils/canaries/main.ts to judge. It reads the runner's tasks, which
 * keep the state of each hook, through the reporter interface vitest 3.2.7
 * still calls once the run ends.
 */
export default class CanaryReporter implements Reporter {
	onFinished(files: RunnerTestFile[] = []): void {
		const path = process.env[REPORT_VARIABLE];
		if (path === undefined) {
			throw(new Error(`${REPORT_VARIABLE} names no file to write the canary report to`));
		}
		const report: CanaryReport = {
			files: files.map(function(testFile): ReportedFile {
				const file: { errors: ReportedError[]; tests: ReportedTest[] } = { errors: errorsOf(testFile.result), tests: [] };
				for (const task of testFile.tasks) {
					collect(task, [], file);
				}
				return({ file: testFile.filepath, ...file });
			})
		};
		writeFileSync(path, JSON.stringify(report));
	}
}
