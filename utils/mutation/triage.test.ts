import { describe, expect, test } from 'vitest';
import { assess, parseReport, parseTriage, passes, placeOf } from './triage.js';
import type { MutantStatus } from './triage.js';

type Mutant = { readonly line: number; readonly column: number; readonly mutatorName: string; readonly status: MutantStatus };

function report(files: Readonly<Record<string, readonly Mutant[]>>): unknown {
	return({
		schemaVersion: '2',
		files: Object.fromEntries(Object.entries(files).map(function([file, mutants]): [string, unknown] {
			return([file, {
				language: 'typescript',
				source: '',
				mutants: mutants.map(function({ line, column, mutatorName, status }, index): unknown {
					return({ id: String(index), mutatorName, replacement: 'x', status, location: { start: { line, column }, end: { line, column: column + 1 } } });
				})
			}]);
		}))
	});
}

function killed(line: number): Mutant {
	return({ line, column: 1, mutatorName: 'BooleanLiteral', status: 'Killed' });
}

describe('mutation triage', function() {
	test('scores each module before triage over every mutant that ran, and after it without the equivalent ones', function() {
		const mutants = parseReport(report({
			'src/a.ts': [
				...Array.from({ length: 16 }, function(_, index): Mutant {
					return(killed(index + 1));
				}),
				{ line: 40, column: 3, mutatorName: 'BlockStatement', status: 'Timeout' },
				{ line: 50, column: 7, mutatorName: 'ConditionalExpression', status: 'Survived' },
				{ line: 51, column: 2, mutatorName: 'StringLiteral', status: 'NoCoverage' },
				{ line: 52, column: 2, mutatorName: 'StringLiteral', status: 'Survived' },
				{ line: 60, column: 1, mutatorName: 'BlockStatement', status: 'CompileError' },
				{ line: 61, column: 1, mutatorName: 'BlockStatement', status: 'Ignored' }
			]
		}));
		const entries = parseTriage([
			'# Surviving mutants',
			'',
			'- src/a.ts:50:7 ConditionalExpression equivalent: the guard repeats the loop condition',
			'- src/a.ts:51:2 StringLiteral harmless: only a log message changes',
			'- src/a.ts:52:2 StringLiteral equivalent: the key is never read'
		].join('\n'));

		const assessment = assess(mutants, entries);

		expect(assessment.modules).toEqual([{
			file: 'src/a.ts',
			killed: 16,
			timedOut: 1,
			survived: 2,
			noCoverage: 1,
			equivalent: 2,
			harmless: 1,
			scoreBefore: 85,
			scoreAfter: 17 / 18 * 100
		}]);
		expect(assessment.unaccounted).toEqual([]);
		expect(assessment.stale).toEqual([]);
		expect(passes(assessment)).toBe(true);
	});

	test('fails a survivor no entry names, an entry for a module that names no survivor, and a module below the minimum', function() {
		const mutants = parseReport(report({
			'src/a.ts': [killed(1), { line: 2, column: 4, mutatorName: 'EqualityOperator', status: 'Survived' }],
			'src/b.ts': [killed(1), killed(2), killed(3), killed(4), killed(5), killed(6), killed(7), killed(8), killed(9), { line: 3, column: 1, mutatorName: 'StringLiteral', status: 'Killed' }]
		}));
		const entries = parseTriage([
			'- src/a.ts:2:4 EqualityOperator harmless: the bound is never reached',
			'- src/b.ts:3:1 StringLiteral equivalent: killed since',
			'- src/c.ts:9:9 StringLiteral equivalent: a module this run did not mutate'
		].join('\n'));

		const harmlessOnly = assess(mutants, entries);
		expect(harmlessOnly.unaccounted).toEqual([]);
		expect(harmlessOnly.stale.map(function(entry): string {
			return(entry.place);
		})).toEqual([placeOf('src/b.ts', 3, 1, 'StringLiteral')]);
		expect(harmlessOnly.modules[0]?.scoreAfter).toBe(50);
		expect(passes(harmlessOnly)).toBe(false);

		const unaccounted = assess(mutants, []);
		expect(unaccounted.unaccounted.map(function(mutant): string {
			return(mutant.place);
		})).toEqual([placeOf('src/a.ts', 2, 4, 'EqualityOperator')]);
		expect(passes(unaccounted)).toBe(false);
	});

	test('refuses an entry it cannot read, and one that names a mutant twice', function() {
		expect(function() {
			return(parseTriage('- src/a.ts:2 EqualityOperator equivalent: no column'));
		}).toThrow(/line 1 of the triage list/);
		expect(function() {
			return(parseTriage('- src/a.ts:2:1 EqualityOperator unknown: no class'));
		}).toThrow(/line 1 of the triage list/);
		expect(function() {
			return(parseTriage('- src/a.ts:2:1 EqualityOperator equivalent: once\n- src/a.ts:2:1 EqualityOperator harmless: twice'));
		}).toThrow(/line 2 of the triage list names src\/a.ts:2:1 EqualityOperator again/);
	});

	test('refuses a report whose mutants lack a place or carry an unknown status', function() {
		expect(function() {
			return(parseReport({ files: { 'src/a.ts': { mutants: [{ mutatorName: 'StringLiteral', status: 'Killed' }] } } }));
		}).toThrow(/mutants\[0\] has no location/);
		expect(function() {
			return(parseReport({ files: { 'src/a.ts': { mutants: [{ mutatorName: 'StringLiteral', status: 'Unknown', location: { start: { line: 1, column: 1 } } }] } } }));
		}).toThrow(/unknown status Unknown/);
	});
});
