import { describe, expect, test } from 'vitest';
import { assess, mutatedRangesOf, parseReport, parseTriage, passes, placeOf } from './triage.js';
import type { MutantStatus, MutatedRanges, ReportedMutant } from './triage.js';

type Mutant = {
	readonly line: number;
	readonly column: number;
	readonly mutatorName: string;
	readonly status: MutantStatus;
	/** 'x' when absent. */
	readonly replacement?: string;
	/** Absent from the report when absent here. */
	readonly testsCompleted?: number;
	/** Absent from the report when absent here. */
	readonly static?: boolean;
};

/** A report of a run that mutated each file whole, unless mutate names what it mutated. */
function report(files: Readonly<Record<string, readonly Mutant[]>>, mutate: readonly string[] = Object.keys(files)): unknown {
	return({
		schemaVersion: '2',
		config: { mutate },
		files: Object.fromEntries(Object.entries(files).map(function([file, mutants]): [string, unknown] {
			return([file, {
				language: 'typescript',
				source: '',
				mutants: mutants.map(function({ line, column, mutatorName, status, replacement = 'x', testsCompleted, static: isStatic }, index): unknown {
					const mutant: Record<string, unknown> = { id: String(index), mutatorName, replacement, status, location: { start: { line, column }, end: { line, column: column + 1 } } };
					if (testsCompleted !== undefined) {
						mutant['testsCompleted'] = testsCompleted;
					}
					if (isStatic !== undefined) {
						mutant['static'] = isStatic;
					}
					return(mutant);
				})
			}]);
		}))
	});
}

/** The mutants and the ranges of a report, as the checker reads them. */
function read(files: Readonly<Record<string, readonly Mutant[]>>, mutate?: readonly string[]): { readonly mutants: readonly ReportedMutant[]; readonly ranges: MutatedRanges } {
	const written = report(files, mutate);
	return({ mutants: parseReport(written), ranges: mutatedRangesOf(written) });
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
		const { mutants, ranges } = read({
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
		});
		const entries = parseTriage([
			'# Surviving mutants',
			'',
			entryFor('src/a.ts', { line: 50, column: 7, mutatorName: 'ConditionalExpression' }, 'equivalent: the guard repeats the loop condition'),
			entryFor('src/a.ts', { line: 51, column: 2, mutatorName: 'StringLiteral', replacement: '``' }, 'harmless: only a log message changes'),
			entryFor('src/a.ts', { line: 52, column: 2, mutatorName: 'StringLiteral', replacement: '"say \\"hi\\""' }, 'equivalent: the key is never read')
		].join('\n'));

		const assessment = assess(mutants, entries, ranges);

		expect(assessment.modules).toEqual([{
			file: 'src/a.ts',
			killed: 16,
			timedOut: 1,
			survived: 2,
			noCoverage: 1,
			ranNoTest: 0,
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
		const { mutants, ranges } = read({
			'src/a.ts': [
				killed(1),
				{ line: 2, column: 4, mutatorName: 'ConditionalExpression', status: 'Survived', replacement: 'true' },
				{ line: 2, column: 4, mutatorName: 'ConditionalExpression', status: 'Survived', replacement: 'false' }
			]
		});

		const assessment = assess(mutants, parseTriage(entryFor('src/a.ts', { line: 2, column: 4, mutatorName: 'ConditionalExpression', replacement: 'true' }, 'equivalent: the branch is never taken')), ranges);

		expect(assessment.unaccounted.map(function(mutant): string {
			return(mutant.place);
		})).toEqual([placeOf({ file: 'src/a.ts', start: { line: 2, column: 4 }, end: { line: 2, column: 5 }, mutatorName: 'ConditionalExpression', replacement: 'false' })]);
		expect(passes(assessment)).toBe(false);
	});

	test('fails a survivor no entry names, an entry for a module that names no survivor, and a module below the minimum', function() {
		const survivor: Mutant = { line: 2, column: 4, mutatorName: 'EqualityOperator', status: 'Survived' };
		const { mutants, ranges } = read({
			'src/a.ts': [killed(1), survivor],
			'src/b.ts': [killed(1), killed(2), killed(3), killed(4), killed(5), killed(6), killed(7), killed(8), killed(9), { line: 3, column: 1, mutatorName: 'StringLiteral', status: 'Killed' }]
		});
		const entries = parseTriage([
			entryFor('src/a.ts', survivor, 'harmless: the bound is never reached'),
			entryFor('src/b.ts', { line: 3, column: 1, mutatorName: 'StringLiteral' }, 'equivalent: killed since'),
			entryFor('src/c.ts', { line: 9, column: 9, mutatorName: 'StringLiteral' }, 'equivalent: a module this run did not mutate')
		].join('\n'));

		const harmlessOnly = assess(mutants, entries, ranges);
		expect(harmlessOnly.unaccounted).toEqual([]);
		expect(harmlessOnly.stale.map(function(entry): string {
			return(entry.place);
		})).toEqual([placeOf({ file: 'src/b.ts', start: { line: 3, column: 1 }, end: { line: 3, column: 2 }, mutatorName: 'StringLiteral', replacement: 'x' })]);
		expect(harmlessOnly.modules[0]?.scoreAfter).toBe(50);
		expect(passes(harmlessOnly)).toBe(false);

		const unaccounted = assess(mutants, [], ranges);
		expect(unaccounted.unaccounted.map(function(mutant): string {
			return(mutant.place);
		})).toEqual([placeOf({ file: 'src/a.ts', start: { line: 2, column: 4 }, end: { line: 2, column: 5 }, mutatorName: 'EqualityOperator', replacement: 'x' })]);
		expect(passes(unaccounted)).toBe(false);
	});

	test('judges an entry stale only inside the lines a run mutated of a file it mutated by ranges', function() {
		const survivor: Mutant = { line: 15, column: 2, mutatorName: 'ConditionalExpression', status: 'Survived' };
		const { mutants, ranges } = read({
			'src/a.ts': [killed(10), { line: 12, column: 1, mutatorName: 'StringLiteral', status: 'Killed' }, survivor, killed(45), { line: 46, column: 1, mutatorName: 'StringLiteral', status: 'Killed' }]
		}, ['src/a.ts:10-20', 'src/a.ts:40-50']);
		// One in each range, so that every range of the file is judged, not only the last.
		const killedSince = [12, 46].map(function(line): string {
			return(entryFor('src/a.ts', { line, column: 1, mutatorName: 'StringLiteral' }, 'equivalent: killed since'));
		}).join('\n');
		const entries = parseTriage([
			entryFor('src/a.ts', survivor, 'equivalent: the guard repeats the loop condition'),
			entryFor('src/a.ts', { line: 30, column: 1, mutatorName: 'StringLiteral' }, 'equivalent: another module mutates these lines'),
			'- src/a.ts:20:1-21:1 BlockStatement "{}" equivalent: it ends past the range, so the run made no such mutant',
			entryFor('src/a.ts', { line: 9, column: 1, mutatorName: 'StringLiteral' }, 'equivalent: it starts before the range')
		].join('\n'));

		const outside = assess(mutants, entries, ranges);
		expect(outside.stale).toEqual([]);
		expect(outside.unaccounted).toEqual([]);
		expect(passes(outside)).toBe(true);

		const inside = assess(mutants, [...entries, ...parseTriage(killedSince)], ranges);
		expect(inside.stale.map(function(entry): string {
			return(entry.place);
		})).toEqual([12, 46].map(function(line): string {
			return(placeOf({ file: 'src/a.ts', start: { line, column: 1 }, end: { line, column: 2 }, mutatorName: 'StringLiteral', replacement: 'x' }));
		}));
		expect(passes(inside)).toBe(false);
	});

	test('judges every entry of a file a pattern alone named as mutated, whatever other files it mutated by ranges', function() {
		const { mutants, ranges } = read({
			'src/a.ts': [killed(1)],
			'src/b.ts': [killed(2)]
		}, ['src/*.ts', '!src/c.ts', 'src/b.ts:1-5']);
		const entries = parseTriage([
			entryFor('src/a.ts', { line: 900, column: 1, mutatorName: 'StringLiteral' }, 'equivalent: the file was mutated whole'),
			entryFor('src/b.ts', { line: 900, column: 1, mutatorName: 'StringLiteral' }, 'equivalent: the run mutated other lines')
		].join('\n'));

		const assessment = assess(mutants, entries, ranges);

		expect([...ranges]).toEqual([['src/b.ts', [{ first: 1, last: 5 }]]]);
		expect(assessment.stale.map(function(entry): string {
			return(entry.file);
		})).toEqual(['src/a.ts']);
		expect(passes(assessment)).toBe(false);
	});

	test('refuses a report that does not say what its run mutated, names a range by columns, or names a file both with ranges and whole', function() {
		expect(function() {
			return(mutatedRangesOf({ files: {} }));
		}).toThrow(/the report has no config/);
		expect(function() {
			return(mutatedRangesOf({ files: {}, config: {} }));
		}).toThrow(/the report's config has no mutate/);
		expect(function() {
			return(mutatedRangesOf({ files: {}, config: { mutate: [3] } }));
		}).toThrow(/config.mutate\[0\] is not a string/);
		expect(function() {
			return(mutatedRangesOf({ files: {}, config: { mutate: ['src/a.ts', 'src/b.ts:1:4-5:2'] } }));
		}).toThrow(/config.mutate\[1\] names columns, of which only lines are read/);
		expect(function() {
			return(mutatedRangesOf({ files: {}, config: { mutate: ['src/a.ts:1-5', 'src/b.ts', 'src/a.ts'] } }));
		}).toThrow('the report\'s config.mutate names src/a.ts both with ranges and whole, which Stryker mutates whole');
	});

	test('leaves out of the score a static survivor of a run that completed no test, and needs no entry for it', function() {
		const { mutants, ranges } = read({
			'src/a.ts': [
				...Array.from({ length: 9 }, function(_, index): Mutant {
					return(killed(index + 1));
				}),
				{ line: 20, column: 1, mutatorName: 'StringLiteral', status: 'Survived', testsCompleted: 0, static: true },
				{ line: 21, column: 1, mutatorName: 'StringLiteral', status: 'Survived', testsCompleted: 4 }
			]
		});
		const entries = parseTriage(entryFor('src/a.ts', { line: 21, column: 1, mutatorName: 'StringLiteral' }, 'equivalent: the message is never read'));

		const assessment = assess(mutants, entries, ranges);

		expect(assessment.modules[0]).toMatchObject({ killed: 9, survived: 1, ranNoTest: 1, equivalent: 1, scoreBefore: 90, scoreAfter: 100 });
		expect(assessment.ranNoTest.map(function(mutant): string {
			return(mutant.place);
		})).toEqual([placeOf({ file: 'src/a.ts', start: { line: 20, column: 1 }, end: { line: 20, column: 2 }, mutatorName: 'StringLiteral', replacement: 'x' })]);
		expect(assessment.unaccounted).toEqual([]);
		expect(passes(assessment)).toBe(true);
		expect(function() {
			return(parseReport({ files: { 'src/a.ts': { mutants: [{ mutatorName: 'StringLiteral', replacement: 'x', status: 'Survived', testsCompleted: -1, location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }] } } }));
		}).toThrow(/testsCompleted is not a whole number/);
		expect(function() {
			return(parseReport({ files: { 'src/a.ts': { mutants: [{ mutatorName: 'StringLiteral', replacement: 'x', status: 'Survived', testsCompleted: 0, static: 'yes', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }] } } }));
		}).toThrow(/static is not a boolean/);
	});

	test('fails a survivor of a run that completed no test unless its code runs as its module loads', function() {
		const nonStatic: Mutant = { line: 20, column: 1, mutatorName: 'StringLiteral', status: 'Survived', testsCompleted: 0, static: false };
		const unstated: Mutant = { line: 21, column: 1, mutatorName: 'StringLiteral', status: 'Survived', testsCompleted: 0 };
		const { mutants, ranges } = read({ 'src/a.ts': [killed(1), nonStatic, unstated] });

		const assessment = assess(mutants, [], ranges);

		expect(assessment.ranNoTest).toEqual([]);
		expect(assessment.unaccounted.map(function(mutant): string {
			return(mutant.place);
		})).toEqual([20, 21].map(function(line): string {
			return(placeOf({ file: 'src/a.ts', start: { line, column: 1 }, end: { line, column: 2 }, mutatorName: 'StringLiteral', replacement: 'x' }));
		}));
		expect(assessment.modules[0]).toMatchObject({ survived: 2, ranNoTest: 0 });
		expect(passes(assessment)).toBe(false);
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
