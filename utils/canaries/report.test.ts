import { describe, expect, test } from 'vitest';
import { baselineProblemOf, escapeOf, failureKindOf, parseRunReport } from './report.js';
import type { NamedTest } from './report.js';
import type { CanaryReport, ReportedError, ReportedTest } from './reporter.js';

const ROOT = '/scratch/canary';

/** The canary reporter's report of a run in ROOT. */
function canaryReport(files: Readonly<Record<string, readonly ReportedTest[]>>, fileErrors: Readonly<Record<string, readonly ReportedError[]>> = {}): CanaryReport {
	const names = new Set([...Object.keys(files), ...Object.keys(fileErrors)]);
	return({
		files: [...names].map(function(file) {
			return({ file: `${ROOT}/${file}`, errors: fileErrors[file] ?? [], tests: files[file] ?? [] });
		})
	});
}

function failed(name: readonly string[], errors: readonly ReportedError[], failedHooks: readonly string[] = []): ReportedTest {
	return({ name, state: 'fail', errors, failedHooks });
}

function ran(name: readonly string[], state: string): ReportedTest {
	return({ name, state, errors: [], failedHooks: [] });
}

const NAMED: NamedTest = { file: 'src/a.test.ts', name: ['a block', 'a test'] };

function escapeIn(files: Readonly<Record<string, readonly ReportedTest[]>>, fileErrors?: Readonly<Record<string, readonly ReportedError[]>>): string | undefined {
	return(escapeOf(parseRunReport(canaryReport(files, fileErrors), ROOT), NAMED));
}

describe('a canary\'s run', function() {
	test('catches it when the named test fails by an expectation, or by a check of the test\'s own', function() {
		expect(escapeIn({ 'src/a.test.ts': [failed(NAMED.name, [{ name: 'AssertionError', message: 'expected 1 to be 2 // Object.is equality' }])] })).toBeUndefined();
		expect(escapeIn({ 'src/a.test.ts': [failed(NAMED.name, [{ name: 'Error', message: 'promise resolved "undefined" instead of rejecting' }])] })).toBeUndefined();
	});

	test('does not catch it when the named test passes, is skipped, never ended, or ran in another file or under another name', function() {
		expect(escapeIn({ 'src/a.test.ts': [ran(NAMED.name, 'pass')] })).toBe('a block > a test passed');
		expect(escapeIn({ 'src/a.test.ts': [ran(NAMED.name, 'skip')] })).toBe('a block > a test skipped');
		expect(escapeIn({ 'src/a.test.ts': [ran(NAMED.name, 'run')] })).toBe('a block > a test unfinished');
		expect(escapeIn({ 'src/b.test.ts': [failed(NAMED.name, [{ name: 'AssertionError', message: 'no' }])] })).toBe('no test a block > a test ran in src/a.test.ts');
		expect(escapeIn({ 'src/a.test.ts': [failed(['a block', 'another test'], [{ name: 'AssertionError', message: 'no' }])] })).toBe('no test a block > a test ran in src/a.test.ts');
	});

	test('does not catch it when the named test fails by a timeout, in a hook, by an error that shows the code no longer runs, or by no assertion', function() {
		expect(escapeIn({ 'src/a.test.ts': [failed(NAMED.name, [{ name: 'Error', message: 'Test timed out in 30000ms.\nIf this is a long-running test, pass a timeout value.' }])] })).toBe('a block > a test failed by a timeout: Error: Test timed out in 30000ms.');
		expect(escapeIn({ 'src/a.test.ts': [failed(NAMED.name, [{ name: 'Error', message: 'connect ENOENT /tmp/postgres/socket' }], ['beforeEach'])] })).toBe('a block > a test failed by a hook: Error: connect ENOENT /tmp/postgres/socket (in beforeEach)');
		expect(escapeIn({ 'src/a.test.ts': [failed(NAMED.name, [{ name: 'ReferenceError', message: 'reverted is not defined' }])] })).toBe('a block > a test failed by an error that shows the code no longer runs: ReferenceError: reverted is not defined');
		expect(escapeIn({ 'src/a.test.ts': [failed(NAMED.name, [{ name: 'RangeError', message: 'out of range' }])] })).toBe('a block > a test failed by no assertion: RangeError: out of range');
		expect(escapeIn({ 'src/a.test.ts': [failed(NAMED.name, [])] })).toBe('a block > a test failed by no assertion: no error');
	});

	test('does not catch it when the named test\'s file fails to run, saying why', function() {
		expect(escapeIn({}, { 'src/a.test.ts': [{ name: 'SyntaxError', message: 'Transform failed with 1 error: Unexpected "}"' }] })).toBe('src/a.test.ts failed to run: SyntaxError: Transform failed with 1 error: Unexpected "}"');
	});

	test('holds only a test that passed before the patch, saying why another did not', function() {
		function baselineOf(files: Readonly<Record<string, readonly ReportedTest[]>>): string | undefined {
			return(baselineProblemOf(parseRunReport(canaryReport(files), ROOT), NAMED));
		}

		expect(baselineOf({ 'src/a.test.ts': [ran(NAMED.name, 'pass')] })).toBeUndefined();
		expect(baselineOf({ 'src/a.test.ts': [failed(NAMED.name, [{ name: 'Error', message: 'connect ENOENT /tmp/postgres/socket' }], ['beforeEach'])] })).toBe('before the patch, a block > a test failed: Error: connect ENOENT /tmp/postgres/socket (in beforeEach)');
		expect(baselineOf({ 'src/a.test.ts': [ran(NAMED.name, 'skip')] })).toBe('before the patch, a block > a test skipped');
		expect(baselineOf({})).toBe('before the patch, no test a block > a test ran in src/a.test.ts');
	});
});

describe('a test\'s failure', function() {
	test.each<[string, ReportedError | undefined, readonly string[], string]>([
		['a test timeout', { name: 'Error', message: 'Test timed out in 5000ms.' }, [], 'timeout'],
		['a hook timeout', { name: 'Error', message: 'Hook timed out in 10000ms.' }, ['beforeEach'], 'timeout'],
		['an error in a hook', { name: 'AssertionError', message: 'expected 1 to be 2' }, ['afterEach'], 'hook'],
		['a syntax error', { name: 'SyntaxError', message: 'Unexpected token' }, [], 'broken'],
		['a reference error', { name: 'ReferenceError', message: 'x is not defined' }, [], 'broken'],
		['a type error', { name: 'TypeError', message: 'x is not a function' }, [], 'broken'],
		['an expectation', { name: 'AssertionError', message: 'expected [] to deeply equal [ 1 ]' }, [], 'assertion'],
		['a check of the test\'s own', { name: 'Error', message: 'the configuration was accepted' }, [], 'assertion'],
		['an error of another kind', { name: 'RangeError', message: 'Invalid array length' }, [], 'unknown'],
		['no error at all', undefined, [], 'unknown']
	])('by %s is %#', function(_ignored, error, failedHooks, kind) {
		const errors: ReportedError[] = [];
		if (error !== undefined) {
			errors.push(error);
		}
		expect(failureKindOf(errors, failedHooks)).toBe(kind);
	});
});

describe('the canary reporter\'s report', function() {
	test('names each test by the file it ran in, relative to the tree, and the titles of its blocks and its own', function() {
		const report = parseRunReport(canaryReport({ 'src/a.test.ts': [ran(['a block', 'an inner block', 'a test'], 'pass'), failed(['a lone test'], [{ name: 'AssertionError', message: 'no' }])] }), ROOT);

		expect(report.tests).toEqual([
			{ file: 'src/a.test.ts', name: ['a block', 'an inner block', 'a test'], status: 'passed', failure: undefined },
			{ file: 'src/a.test.ts', name: ['a lone test'], status: 'failed', failure: { kind: 'assertion', message: 'AssertionError: no' } }
		]);
		expect(report.fileFailures).toEqual([]);
	});

	test('is refused when it is not one', function() {
		expect(function() {
			parseRunReport({ files: [{ file: `${ROOT}/a.test.ts`, errors: [], tests: [{ name: ['a test'], state: 'unknown', errors: [], failedHooks: [] }] }] }, ROOT);
		}).toThrow('report.files[0].tests[0].state is not a test state: unknown');
		expect(function() {
			parseRunReport([], ROOT);
		}).toThrow('the report is not an object');
	});
});
