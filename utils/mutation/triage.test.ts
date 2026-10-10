import { describe, expect, test } from 'vitest';
import { assess, parseReport, parseTriage, passes, placeOf } from './triage.js';
import type { MutantStatus } from './triage.js';

type Mutant = {
	readonly line: number;
	readonly column: number;
	readonly mutatorName: string;
	readonly status: MutantStatus;
	/** 'x' when absent. */
	readonly replacement?: string;
};

function report(files: Readonly<Record<string, readonly Mutant[]>>): unknown {
	return({
		schemaVersion: '2',
		files: Object.fromEntries(Object.entries(files).map(function([file, mutants]): [string, unknown] {
			return([file, {
				language: 'typescript',
				source: '',
				mutants: mutants.map(function({ line, column, mutatorName, status, replacement = 'x' }, index): unknown {
					return({ id: String(index), mutatorName, replacement, status, location: { start: { line, column }, end: { line, column: column + 1 } } });
				})
			}]);
		}))
	});
}

function killed(line: number): Mutant {
	return({ line, column: 1, mutatorName: 'BooleanLiteral', status: 'Killed' });
}

/** The entry for a mutant as report() places it. */
function entryFor(file: string, { line, column, mutatorName, replacement = 'x' }: Omit<Mutant, 'status'>, rest: string): string {
	return(`- ${file}:${String(line)}:${String(column)}-${String(line)}:${String(column + 1)} ${mutatorName} ${JSON.stringify(replacement)} ${rest}`);
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
				{ line: 51, column: 2, mutatorName: 'StringLiteral', status: 'NoCoverage', replacement: '``' },
				{ line: 52, column: 2, mutatorName: 'StringLiteral', status: 'Survived', replacement: '"say \\"hi\\""' },
				{ line: 60, column: 1, mutatorName: 'BlockStatement', status: 'CompileError' },
				{ line: 61, column: 1, mutatorName: 'BlockStatement', status: 'Ignored' }
			]
		}));
		const entries = parseTriage([
			'# Surviving mutants',
			'',
			entryFor('src/a.ts', { line: 50, column: 7, mutatorName: 'ConditionalExpression' }, 'equivalent: the guard repeats the loop condition'),
			entryFor('src/a.ts', { line: 51, column: 2, mutatorName: 'StringLiteral', replacement: '``' }, 'harmless: only a log message changes'),
			entryFor('src/a.ts', { line: 52, column: 2, mutatorName: 'StringLiteral', replacement: '"say \\"hi\\""' }, 'equivalent: the key is never read')
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

	test('an entry accounts only for the mutant of its span, mutator and replacement', function() {
		const mutants = parseReport(report({
			'src/a.ts': [
				killed(1),
				{ line: 2, column: 4, mutatorName: 'ConditionalExpression', status: 'Survived', replacement: 'true' },
				{ line: 2, column: 4, mutatorName: 'ConditionalExpression', status: 'Survived', replacement: 'false' }
			]
		}));

		const assessment = assess(mutants, parseTriage(entryFor('src/a.ts', { line: 2, column: 4, mutatorName: 'ConditionalExpression', replacement: 'true' }, 'equivalent: the branch is never taken')));

		expect(assessment.unaccounted.map(function(mutant): string {
			return(mutant.place);
		})).toEqual([placeOf({ file: 'src/a.ts', start: { line: 2, column: 4 }, end: { line: 2, column: 5 }, mutatorName: 'ConditionalExpression', replacement: 'false' })]);
		expect(passes(assessment)).toBe(false);
	});

	test('fails a survivor no entry names, an entry for a module that names no survivor, and a module below the minimum', function() {
		const survivor: Mutant = { line: 2, column: 4, mutatorName: 'EqualityOperator', status: 'Survived' };
		const mutants = parseReport(report({
			'src/a.ts': [killed(1), survivor],
			'src/b.ts': [killed(1), killed(2), killed(3), killed(4), killed(5), killed(6), killed(7), killed(8), killed(9), { line: 3, column: 1, mutatorName: 'StringLiteral', status: 'Killed' }]
		}));
		const entries = parseTriage([
			entryFor('src/a.ts', survivor, 'harmless: the bound is never reached'),
			entryFor('src/b.ts', { line: 3, column: 1, mutatorName: 'StringLiteral' }, 'equivalent: killed since'),
			entryFor('src/c.ts', { line: 9, column: 9, mutatorName: 'StringLiteral' }, 'equivalent: a module this run did not mutate')
		].join('\n'));

		const harmlessOnly = assess(mutants, entries);
		expect(harmlessOnly.unaccounted).toEqual([]);
		expect(harmlessOnly.stale.map(function(entry): string {
			return(entry.place);
		})).toEqual([placeOf({ file: 'src/b.ts', start: { line: 3, column: 1 }, end: { line: 3, column: 2 }, mutatorName: 'StringLiteral', replacement: 'x' })]);
		expect(harmlessOnly.modules[0]?.scoreAfter).toBe(50);
		expect(passes(harmlessOnly)).toBe(false);

		const unaccounted = assess(mutants, []);
		expect(unaccounted.unaccounted.map(function(mutant): string {
			return(mutant.place);
		})).toEqual([placeOf({ file: 'src/a.ts', start: { line: 2, column: 4 }, end: { line: 2, column: 5 }, mutatorName: 'EqualityOperator', replacement: 'x' })]);
		expect(passes(unaccounted)).toBe(false);
	});

	test('refuses an entry it cannot read, and one that names a mutant twice', function() {
		const entry = entryFor('src/a.ts', { line: 2, column: 1, mutatorName: 'EqualityOperator' }, 'equivalent: once');
		expect(function() {
			return(parseTriage('- src/a.ts:2:1 EqualityOperator equivalent: no span or replacement'));
		}).toThrow(/line 1 of the triage list is not/);
		expect(function() {
			return(parseTriage(entryFor('src/a.ts', { line: 2, column: 1, mutatorName: 'EqualityOperator' }, 'unknown: no class')));
		}).toThrow(/line 1 of the triage list is not/);
		expect(function() {
			return(parseTriage('- src/a.ts:2:1-2:2 EqualityOperator "\\q" equivalent: no JSON string'));
		}).toThrow(/line 1 of the triage list has a replacement that is not a JSON string/);
		expect(function() {
			return(parseTriage(`${entry}\n${entry}`));
		}).toThrow(/line 2 of the triage list names src\/a.ts:2:1-2:2 EqualityOperator "x" again/);
	});

	test('refuses a report whose mutants lack a place or carry an unknown status', function() {
		expect(function() {
			return(parseReport({ files: { 'src/a.ts': { mutants: [{ mutatorName: 'StringLiteral', replacement: 'x', status: 'Killed' }] } } }));
		}).toThrow(/mutants\[0\] has no location/);
		expect(function() {
			return(parseReport({ files: { 'src/a.ts': { mutants: [{ mutatorName: 'StringLiteral', replacement: 'x', status: 'Killed', location: { start: { line: 1, column: 1 } } }] } } }));
		}).toThrow(/location has no end/);
		expect(function() {
			return(parseReport({ files: { 'src/a.ts': { mutants: [{ mutatorName: 'StringLiteral', replacement: 'x', status: 'Unknown', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }] } } }));
		}).toThrow(/unknown status Unknown/);
	});
});
