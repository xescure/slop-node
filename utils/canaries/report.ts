import { relative } from 'node:path';
import type { ReportedError } from './reporter.js';

/**
 * How a test failed:
 * - by an assertion: an expectation failed, or a check of the test's own
 *   threw an Error;
 * - by a timeout, which says only that it did not finish in time;
 * - in a hook, whose failure is setup's or the environment's, not the
 *   behavior's under test;
 * - by an error that shows the code no longer runs, a syntax, reference or
 *   type error, as a revert that broke the code rather than its behavior
 *   would throw;
 * - by anything else, or no error at all, which says nothing a canary can
 *   rely on.
 */
export type FailureKind = 'assertion' | 'timeout' | 'hook' | 'broken' | 'unknown';

export type TestResult = {
	/** Relative to the tree the tests ran in. */
	readonly file: string;
	/** The titles of the blocks around the test, and its own. */
	readonly name: readonly string[];
	readonly status: 'passed' | 'failed' | 'skipped' | 'unfinished';
	/** For a failed test. */
	readonly failure: { readonly kind: FailureKind; readonly message: string } | undefined;
};

/** A test file, or a block of it, that failed outside its tests, as one that does not load. */
export type FileFailure = {
	readonly file: string;
	readonly message: string;
};

export type RunReport = {
	readonly tests: readonly TestResult[];
	readonly fileFailures: readonly FileFailure[];
};

/** A test vitest must fail by assertion: the file that holds it, and its name as vitest reports it. */
export type NamedTest = {
	readonly file: string;
	readonly name: readonly string[];
};

type JSONObject = { readonly [key: string]: unknown };

function isObject(value: unknown): value is JSONObject {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

function arrayAt(object: JSONObject, name: string, where: string): readonly unknown[] {
	const value = object[name];
	if (!Array.isArray(value)) {
		throw(new Error(`${where}.${name} is not an array`));
	}
	return(value);
}

function stringAt(object: JSONObject, name: string, where: string): string {
	const value = object[name];
	if (typeof value !== 'string') {
		throw(new Error(`${where}.${name} is not a string`));
	}
	return(value);
}

function stringsAt(object: JSONObject, name: string, where: string): string[] {
	return(arrayAt(object, name, where).map(function(value, index): string {
		if (typeof value !== 'string') {
			throw(new Error(`${where}.${name}[${String(index)}] is not a string`));
		}
		return(value);
	}));
}

function errorsAt(object: JSONObject, name: string, where: string): ReportedError[] {
	return(arrayAt(object, name, where).map(function(value, index): ReportedError {
		const at = `${where}.${name}[${String(index)}]`;
		if (!isObject(value)) {
			throw(new Error(`${at} is not an object`));
		}
		return({ name: stringAt(value, 'name', at), message: stringAt(value, 'message', at) });
	}));
}

/** A test's or hook's own timeout, or vi.waitFor's and vi.waitUntil's when the code they wait on never answers [vitest 4.1.11] dist/chunks/test.DNmyFkvJ.js:3376, 3417. */
const TIMEOUT = /^(?:(?:Test|Hook) timed out in \d+ms|Timed out in wait(?:For|Until)!)/u;

const BROKEN = new Set(['SyntaxError', 'ReferenceError', 'TypeError']);

/** AssertionError is what expect throws; Error what a test's own check, or expect's rejects and resolves, throw. */
const ASSERTION = new Set(['AssertionError', 'Error']);

/** How the test failed, by its first error and the hooks of it that failed. */
export function failureKindOf(errors: readonly ReportedError[], failedHooks: readonly string[]): FailureKind {
	const [error] = errors;
	if (error === undefined) {
		return('unknown');
	}
	if (TIMEOUT.test(error.message)) {
		return('timeout');
	}
	if (failedHooks.length > 0) {
		return('hook');
	}
	if (BROKEN.has(error.name)) {
		return('broken');
	}
	if (ASSERTION.has(error.name)) {
		return('assertion');
	}
	return('unknown');
}

function describeError(error: ReportedError | undefined): string {
	if (error === undefined) {
		return('no error');
	}
	return(`${error.name}: ${error.message}`);
}

function statusOf(state: string, where: string): TestResult['status'] {
	switch (state) {
		case 'passed':
		case 'failed':
		case 'skipped':
			return(state);
		case 'pending':
			return('unfinished');
		default:
			throw(new Error(`${where}.state is not a test state: ${state}`));
	}
}

function testResultOf(value: unknown, file: string, where: string): TestResult {
	if (!isObject(value)) {
		throw(new Error(`${where} is not an object`));
	}
	const status = statusOf(stringAt(value, 'state', where), where);
	const name = stringsAt(value, 'name', where);
	if (status !== 'failed') {
		return({ file, name, status, failure: undefined });
	}
	const errors = errorsAt(value, 'errors', where);
	const failedHooks = stringsAt(value, 'failedHooks', where);
	let message = describeError(errors[0]);
	if (failedHooks.length > 0) {
		message = `${message} (in ${failedHooks.join(', ')})`;
	}
	return({ file, name, status, failure: { kind: failureKindOf(errors, failedHooks), message } });
}

/** The results of the canary reporter's report (utils/canaries/reporter.ts) of a run in the tree at the root. */
export function parseRunReport(report: unknown, root: string): RunReport {
	if (!isObject(report)) {
		throw(new Error('the report is not an object'));
	}
	const tests: TestResult[] = [];
	const fileFailures: FileFailure[] = [];
	arrayAt(report, 'files', 'report').forEach(function(fileReport, index): void {
		const where = `report.files[${String(index)}]`;
		if (!isObject(fileReport)) {
			throw(new Error(`${where} is not an object`));
		}
		const file = relative(root, stringAt(fileReport, 'file', where));
		for (const error of errorsAt(fileReport, 'errors', where)) {
			fileFailures.push({ file, message: describeError(error) });
		}
		arrayAt(fileReport, 'tests', where).forEach(function(result, testIndex): void {
			tests.push(testResultOf(result, file, `${where}.tests[${String(testIndex)}]`));
		});
	});
	return({ tests, fileFailures });
}

export function sameName(left: readonly string[], right: readonly string[]): boolean {
	return(left.length === right.length && left.every(function(title, index): boolean {
		return(title === right[index]);
	}));
}

export function describeName(name: readonly string[]): string {
	return(name.join(' > '));
}

export function firstLine(text: string): string {
	return(text.split('\n', 1)[0] ?? '');
}

const FAILED_BY: Readonly<Record<Exclude<FailureKind, 'assertion'>, string>> = {
	timeout: 'a timeout',
	hook: 'a hook',
	broken: 'an error that shows the code no longer runs',
	unknown: 'no assertion'
};

function resultOf(report: RunReport, named: NamedTest): TestResult | string {
	const result = report.tests.find(function(test): boolean {
		return(test.file === named.file && sameName(test.name, named.name));
	});
	if (result !== undefined) {
		return(result);
	}
	const fileFailure = report.fileFailures.find(function(failure): boolean {
		return(failure.file === named.file);
	});
	if (fileFailure !== undefined) {
		return(`${named.file} failed to run: ${firstLine(fileFailure.message)}`);
	}
	return(`no test ${describeName(named.name)} ran in ${named.file}`);
}

/** Why the run does not show the named test failing by assertion, if it does not. */
export function escapeOf(report: RunReport, named: NamedTest): string | undefined {
	const result = resultOf(report, named);
	if (typeof result === 'string') {
		return(result);
	}
	if (result.failure === undefined) {
		return(`${describeName(named.name)} ${result.status}`);
	}
	if (result.failure.kind === 'assertion') {
		return(undefined);
	}
	return(`${describeName(named.name)} failed by ${FAILED_BY[result.failure.kind]}: ${firstLine(result.failure.message)}`);
}

/** Why the run, made before the canary's patch, does not show the named test passing, if it does not: a canary is caught only by a test that held before it. */
export function baselineProblemOf(report: RunReport, named: NamedTest): string | undefined {
	const result = resultOf(report, named);
	if (typeof result === 'string') {
		return(`before the patch, ${result}`);
	}
	if (result.status === 'passed') {
		return(undefined);
	}
	let failure = '';
	if (result.failure !== undefined) {
		failure = `: ${firstLine(result.failure.message)}`;
	}
	return(`before the patch, ${describeName(named.name)} ${result.status}${failure}`);
}
