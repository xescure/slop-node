import { relative } from 'node:path';

/**
 * How a test failed, by its first failure:
 * - by a timeout, which says only that it did not finish in time;
 * - by an error that shows the code no longer runs, a syntax, reference or
 *   type error, as a revert that broke the code rather than its behavior
 *   would throw;
 * - otherwise by an assertion: an expectation, or a check of the test's own,
 *   that the behavior failed.
 */
export type FailureKind = 'assertion' | 'timeout' | 'broken';

export type TestResult = {
	/** Relative to the tree the tests ran in. */
	readonly file: string;
	/** The titles of the blocks around the test, and its own. */
	readonly name: readonly string[];
	readonly status: 'passed' | 'failed' | 'skipped';
	/** For a failed test. */
	readonly failure: { readonly kind: FailureKind; readonly message: string } | undefined;
};

/** A test file that failed outside its tests, as one that does not load. */
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

const TIMEOUT = /^Error: (Test|Hook) timed out in \d+ms/u;

const BROKEN = /^(SyntaxError|ReferenceError|TypeError)\b/u;

export function failureKindOf(message: string): FailureKind {
	if (TIMEOUT.test(message)) {
		return('timeout');
	}
	if (BROKEN.test(message)) {
		return('broken');
	}
	return('assertion');
}

function statusOf(text: string, where: string): TestResult['status'] {
	switch (text) {
		case 'passed':
		case 'failed':
			return(text);
		case 'skipped':
		case 'pending':
		case 'todo':
		case 'disabled':
			return('skipped');
		default:
			throw(new Error(`${where}.status is not a test status: ${text}`));
	}
}

function testResultOf(value: unknown, file: string, where: string): TestResult {
	if (!isObject(value)) {
		throw(new Error(`${where} is not an object`));
	}
	const status = statusOf(stringAt(value, 'status', where), where);
	const name = [...stringsAt(value, 'ancestorTitles', where), stringAt(value, 'title', where)];
	if (status !== 'failed') {
		return({ file, name, status, failure: undefined });
	}
	const [message = ''] = stringsAt(value, 'failureMessages', where);
	return({ file, name, status, failure: { kind: failureKindOf(message), message } });
}

/** The results of vitest's JSON report of a run in the tree at the root. */
export function parseRunReport(report: unknown, root: string): RunReport {
	if (!isObject(report)) {
		throw(new Error('the report is not an object'));
	}
	const tests: TestResult[] = [];
	const fileFailures: FileFailure[] = [];
	arrayAt(report, 'testResults', 'report').forEach(function(fileResult, index): void {
		const where = `report.testResults[${String(index)}]`;
		if (!isObject(fileResult)) {
			throw(new Error(`${where} is not an object`));
		}
		const file = relative(root, stringAt(fileResult, 'name', where));
		const results = arrayAt(fileResult, 'assertionResults', where);
		const message = fileResult['message'];
		if (results.length === 0 && typeof message === 'string' && message !== '') {
			fileFailures.push({ file, message });
		}
		results.forEach(function(result, resultIndex): void {
			tests.push(testResultOf(result, file, `${where}.assertionResults[${String(resultIndex)}]`));
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

const FAILED_BY: Readonly<Record<Exclude<FailureKind, 'assertion'>, string>> = {
	timeout: 'a timeout',
	broken: 'an error that shows the code no longer runs'
};

/** Why the run does not show the named test failing by assertion, if it does not. */
export function escapeOf(report: RunReport, named: NamedTest): string | undefined {
	const result = report.tests.find(function(test): boolean {
		return(test.file === named.file && sameName(test.name, named.name));
	});
	if (result === undefined) {
		const fileFailure = report.fileFailures.find(function(failure): boolean {
			return(failure.file === named.file);
		});
		if (fileFailure !== undefined) {
			return(`${named.file} failed to run: ${fileFailure.message}`);
		}
		return(`no test ${describeName(named.name)} ran in ${named.file}`);
	}
	if (result.failure === undefined) {
		return(`${describeName(named.name)} ${result.status}`);
	}
	if (result.failure.kind === 'assertion') {
		return(undefined);
	}
	return(`${describeName(named.name)} failed by ${FAILED_BY[result.failure.kind]}: ${firstLine(result.failure.message)}`);
}

export function firstLine(text: string): string {
	return(text.split('\n', 1)[0] ?? '');
}
