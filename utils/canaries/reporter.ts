import { writeFileSync } from 'node:fs';
import type { Reporter, ReportedHookContext, TestCase, TestModule, TestSuite } from 'vitest/node';

/** The variable naming the file the report is written to. */
export const REPORT_VARIABLE = 'SLOP_NODE_CANARY_REPORT';

export type ReportedError = {
	readonly name: string;
	readonly message: string;
};

export type ReportedTest = {
	/** The titles of the blocks around the test, outermost first, and its own. */
	readonly name: readonly string[];
	/** As vitest reports it: passed, failed, skipped, or pending when it never ended. */
	readonly state: string;
	readonly errors: readonly ReportedError[];
	/** The hooks of the test that began and did not end, as one that throws or hangs does not. */
	readonly failedHooks: readonly string[];
};

export type ReportedFile = {
	readonly file: string;
	/** What failed the file or a block of it outside its tests, as collecting it does. */
	readonly errors: readonly ReportedError[];
	readonly tests: readonly ReportedTest[];
};

export type CanaryReport = {
	readonly files: readonly ReportedFile[];
};

type VitestError = {
	readonly name?: string | undefined;
	readonly message: string;
};

/*
 * The error's own name and message, not its stack: vitest gives a timeout's
 * error the stack of another error [vitest 4.1.11] @vitest/runner
 * dist/chunk-artifact.js:2404-2411, so a report of the stack shows a timeout
 * as "Error: STACK_TRACE_ERROR".
 */
function reportedErrorsOf(errors: readonly VitestError[] | undefined): ReportedError[] {
	return((errors ?? []).map(function(error): ReportedError {
		return({ name: error.name ?? '', message: error.message });
	}));
}

function namesOf(testCase: TestCase): string[] {
	const names = [testCase.name];
	for (let parent: TestSuite | TestModule = testCase.parent; parent.type === 'suite'; parent = parent.parent) {
		names.unshift(parent.name);
	}
	return(names);
}

function suiteErrorsOf(testModule: TestModule): ReportedError[] {
	const errors = reportedErrorsOf(testModule.errors());
	for (const suite of testModule.children.allSuites()) {
		errors.push(...reportedErrorsOf(suite.errors()));
	}
	return(errors);
}

/**
 * Writes what each test of the run did to the file REPORT_VARIABLE names,
 * for utils/canaries/run.ts to judge. A hook's end is reported only once it
 * passes [vitest 4.1.11] @vitest/runner dist/chunk-artifact.js:2550-2566,
 * 2618, 2633, so a test's hook that began and never ended failed.
 */
export default class CanaryReporter implements Reporter {
	readonly #unendedHooks = new Map<string, string[]>();

	onHookStart(hook: ReportedHookContext): void {
		if (hook.name === 'beforeEach' || hook.name === 'afterEach') {
			const unended = this.#unendedHooks.get(hook.entity.id) ?? [];
			unended.push(hook.name);
			this.#unendedHooks.set(hook.entity.id, unended);
		}
	}

	onHookEnd(hook: ReportedHookContext): void {
		if (hook.name === 'beforeEach' || hook.name === 'afterEach') {
			const unended = this.#unendedHooks.get(hook.entity.id) ?? [];
			const at = unended.lastIndexOf(hook.name);
			if (at >= 0) {
				unended.splice(at, 1);
			}
		}
	}

	onTestRunEnd(testModules: readonly TestModule[]): void {
		const path = process.env[REPORT_VARIABLE];
		if (path === undefined) {
			throw(new Error(`${REPORT_VARIABLE} names no file to write the canary report to`));
		}
		const unendedHooks = this.#unendedHooks;
		const report: CanaryReport = {
			files: testModules.map(function(testModule): ReportedFile {
				return({
					file: testModule.moduleId,
					errors: suiteErrorsOf(testModule),
					tests: [...testModule.children.allTests()].map(function(testCase): ReportedTest {
						const result = testCase.result();
						let errors: ReportedError[] = [];
						if (result.state === 'failed') {
							errors = reportedErrorsOf(result.errors);
						}
						return({ name: namesOf(testCase), state: result.state, errors, failedHooks: unendedHooks.get(testCase.id) ?? [] });
					})
				});
			})
		};
		writeFileSync(path, JSON.stringify(report));
	}
}
