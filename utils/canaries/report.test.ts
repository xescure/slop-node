import { describe, expect, test } from 'vitest';
import { escapeOf, failureKindOf, parseRunReport } from './report.js';
import type { NamedTest } from './report.js';

const ROOT = '/scratch/canary';

type Assertion = {
	readonly name: readonly string[];
	readonly status: string;
	readonly failure?: string;
};

/** vitest's JSON report of a run in ROOT, as its json reporter writes one. */
function vitestReport(files: Readonly<Record<string, readonly Assertion[]>>, failedFiles: Readonly<Record<string, string>> = {}): unknown {
	const results = Object.entries(files).map(function([file, assertions]): unknown {
		return({
			name: `${ROOT}/${file}`,
			status: 'failed',
			message: '',
			startTime: 0,
			endTime: 1,
			assertionResults: assertions.map(function({ name, status, failure }): unknown {
				const failureMessages: string[] = [];
				if (failure !== undefined) {
					failureMessages.push(failure);
				}
				return({ ancestorTitles: name.slice(0, -1), fullName: name.join(' '), title: name.at(-1), status, duration: 1, failureMessages, meta: {} });
			})
		});
	});
	const failed = Object.entries(failedFiles).map(function([file, message]): unknown {
		return({ name: `${ROOT}/${file}`, status: 'failed', message, startTime: 0, endTime: 1, assertionResults: [] });
	});
	return({ numTotalTests: 0, success: false, testResults: [...results, ...failed] });
}

const NAMED: NamedTest = { file: 'src/a.test.ts', name: ['a block', 'a test'] };

function escapeIn(files: Readonly<Record<string, readonly Assertion[]>>, failedFiles?: Readonly<Record<string, string>>): string | undefined {
	return(escapeOf(parseRunReport(vitestReport(files, failedFiles), ROOT), NAMED));
}

describe('a canary\'s run', function() {
	test('catches it when the named test fails by an assertion, or by a check of the test\'s own', function() {
		expect(escapeIn({ 'src/a.test.ts': [{ name: ['a block', 'a test'], status: 'failed', failure: 'AssertionError: expected 1 to be 2 // Object.is equality\n    at a.test.ts:3:4' }] })).toBeUndefined();
		expect(escapeIn({ 'src/a.test.ts': [{ name: ['a block', 'a test'], status: 'failed', failure: 'Error: promise resolved "undefined" instead of rejecting' }] })).toBeUndefined();
	});

	test('does not catch it when the named test passes, is skipped, or ran in another file or under another name', function() {
		expect(escapeIn({ 'src/a.test.ts': [{ name: ['a block', 'a test'], status: 'passed' }] })).toBe('a block > a test passed');
		expect(escapeIn({ 'src/a.test.ts': [{ name: ['a block', 'a test'], status: 'skipped' }] })).toBe('a block > a test skipped');
		expect(escapeIn({ 'src/b.test.ts': [{ name: ['a block', 'a test'], status: 'failed', failure: 'AssertionError: no' }] })).toBe('no test a block > a test ran in src/a.test.ts');
		expect(escapeIn({ 'src/a.test.ts': [{ name: ['a block', 'another test'], status: 'failed', failure: 'AssertionError: no' }] })).toBe('no test a block > a test ran in src/a.test.ts');
	});

	test('does not catch it when the named test fails by a timeout or by an error that shows the code no longer runs', function() {
		expect(escapeIn({ 'src/a.test.ts': [{ name: ['a block', 'a test'], status: 'failed', failure: 'Error: Test timed out in 30000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".' }] })).toBe('a block > a test failed by a timeout: Error: Test timed out in 30000ms.');
		expect(escapeIn({ 'src/a.test.ts': [{ name: ['a block', 'a test'], status: 'failed', failure: 'ReferenceError: reverted is not defined' }] })).toBe('a block > a test failed by an error that shows the code no longer runs: ReferenceError: reverted is not defined');
	});

	test('does not catch it when the named test\'s file fails to run, saying why', function() {
		expect(escapeIn({}, { 'src/a.test.ts': 'Transform failed with 1 error: Unexpected "}"' })).toBe('src/a.test.ts failed to run: Transform failed with 1 error: Unexpected "}"');
	});
});

describe('a test\'s failure', function() {
	test.each([
		['Error: Test timed out in 5000ms.', 'timeout'],
		['Error: Hook timed out in 10000ms.', 'timeout'],
		['SyntaxError: Unexpected token', 'broken'],
		['ReferenceError: x is not defined', 'broken'],
		['TypeError: x is not a function', 'broken'],
		['AssertionError: expected [] to deeply equal [ 1 ]', 'assertion'],
		['Error: the configuration was accepted', 'assertion'],
		['Error: connect ENOENT /tmp/postgres/socket', 'assertion']
	] as const)('%s is by %s', function(message, kind) {
		expect(failureKindOf(message)).toBe(kind);
	});
});

describe('vitest\'s JSON report', function() {
	test('names each test by the file it ran in, relative to the tree, and the titles of its blocks and its own', function() {
		const report = parseRunReport(vitestReport({ 'src/a.test.ts': [{ name: ['a block', 'an inner block', 'a test'], status: 'passed' }, { name: ['a lone test'], status: 'failed', failure: 'AssertionError: no' }] }), ROOT);

		expect(report.tests).toEqual([
			{ file: 'src/a.test.ts', name: ['a block', 'an inner block', 'a test'], status: 'passed', failure: undefined },
			{ file: 'src/a.test.ts', name: ['a lone test'], status: 'failed', failure: { kind: 'assertion', message: 'AssertionError: no' } }
		]);
		expect(report.fileFailures).toEqual([]);
	});

	test('is refused when it is not one', function() {
		expect(function() {
			parseRunReport({ testResults: [{ name: `${ROOT}/a.test.ts`, assertionResults: [{ ancestorTitles: [], title: 'a test', status: 'unknown', failureMessages: [] }] }] }, ROOT);
		}).toThrow('report.testResults[0].assertionResults[0].status is not a test status: unknown');
		expect(function() {
			parseRunReport([], ROOT);
		}).toThrow('the report is not an object');
	});
});
