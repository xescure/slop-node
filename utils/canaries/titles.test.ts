import { describe, expect, test } from 'vitest';
import { definesTest, titleTemplatesOf } from './titles.js';

const FILE = 'example.test.ts';

const SUITE = 'suite.ts';

function defines(files: Readonly<Record<string, string>>, name: readonly string[]): boolean {
	const templates = new Map(Object.entries(files).map(function([file, source]): [string, ReturnType<typeof titleTemplatesOf>] {
		return([file, titleTemplatesOf(source, file)]);
	}));
	return(definesTest(templates, FILE, name));
}

function definesInFile(source: string, name: readonly string[]): boolean {
	return(defines({ [FILE]: source }, name));
}

describe('the titles a test file gives', function() {
	test('name a test inside the blocks around it, nested as written', function() {
		const source = `
			describe('a block', function() {
				describe("an inner block", function() {
					test('a test', async function() {});
				});
				it(\`another test\`, function() {});
			});
			describe('a second block', function() {
				test('a third test', function() {});
			});
		`;

		expect(definesInFile(source, ['a block', 'an inner block', 'a test'])).toBe(true);
		expect(definesInFile(source, ['a block', 'another test'])).toBe(true);
		expect(definesInFile(source, ['a second block', 'a third test'])).toBe(true);
		// Each title is there, but not nested so.
		expect(definesInFile(source, ['a second block', 'a test'])).toBe(false);
		expect(definesInFile(source, ['a block', 'a test'])).toBe(false);
		expect(definesInFile(source, ['an inner block', 'a test'])).toBe(false);
		expect(definesInFile(source, ['a block', 'a missing test'])).toBe(false);
		// A test's title names no block, and a block's no test.
		expect(definesInFile(source, ['a block', 'an inner block'])).toBe(false);
		expect(definesInFile(source, [])).toBe(false);
	});

	test('name no test that may not run, or whose failing means it passes, nor one in such a block', function() {
		const source = `
			describe('a block', function() {
				test.skip('skipped', function() {});
				test.todo('todo');
				test.fails('expected to fail', function() {});
				test.skipIf(process.env.CI)('skipped on a condition', function() {});
				it.runIf(process.env.CI)('run on a condition', function() {});
				test.concurrent('concurrent', function() {});
			});
			describe.skip('a skipped block', function() {
				test('held back', function() {});
			});
		`;

		for (const title of ['skipped', 'todo', 'expected to fail', 'skipped on a condition', 'run on a condition']) {
			expect(definesInFile(source, ['a block', title]), title).toBe(false);
		}
		expect(definesInFile(source, ['a block', 'concurrent'])).toBe(true);
		expect(definesInFile(source, ['a skipped block', 'held back'])).toBe(false);
	});

	test('name a test of a parameterized title only by a row of its literal table, as vitest fills it', function() {
		const source = `
			describe.each([{ name: 'memory' }, { name: 'postgres' }])('$name driver', { timeout: 1 }, function(driver) {
				test.each([
					{ sender: 'its own key', greetingOf: strangersGreeting },
					{ sender: 'the replayed greeting of the representative', greetingOf: secondsGreeting }
				])('refuses a greeting from $sender', function() {});
				test.each(['readwrite', 'READ-ONLY'])('refuses %j, 100%% of it', function() {});
				test.each([['a token', 1], ['an account', 2]])('refuses %s, seed %i, case %#', function() {});
			});
		`;

		expect(definesInFile(source, ['\'memory\' driver', 'refuses a greeting from \'its own key\''])).toBe(true);
		expect(definesInFile(source, ['\'postgres\' driver', 'refuses a greeting from \'the replayed greeting of the\u2026\''])).toBe(true);
		expect(definesInFile(source, ['\'postgres\' driver', 'refuses a greeting from \'the replayed greeting of the representative\''])).toBe(true);
		expect(definesInFile(source, ['\'memory\' driver', 'refuses "readwrite", 100% of it'])).toBe(true);
		expect(definesInFile(source, ['\'memory\' driver', 'refuses an account, seed 2, case 1'])).toBe(true);
		// A value no row holds, or a row cut short anywhere but at its end.
		expect(definesInFile(source, ['\'mysql\' driver', 'refuses "readwrite", 100% of it'])).toBe(false);
		expect(definesInFile(source, ['\'memory\' driver', 'refuses a greeting from \'its key\''])).toBe(false);
		expect(definesInFile(source, ['\'memory\' driver', 'refuses a greeting from \'the replayed\u2026 representative\''])).toBe(false);
		expect(definesInFile(source, ['\'memory\' driver', 'refuses "read-write", 100% of it'])).toBe(false);
		expect(definesInFile(source, ['\'memory\' driver', 'refuses a token, seed 2, case 1'])).toBe(false);
	});

	test('name a test of a computed table, title or value by any value there', function() {
		const source = `
			describe.each(drivers)('$name driver', function(driver) {
				test.each(matrix)('closes $network in $mode.text mode: $closed', function() {});
				test.each([{ seed: SEED }])('seeds $seed', function() {});
				test(titleOf(1), function() {});
				test(\`answers \${name} as the representative did\`, function() {});
			});
		`;

		expect(definesInFile(source, ['\'memory\' driver', 'closes \'main\' in \'read-only\' mode: true'])).toBe(true);
		expect(definesInFile(source, ['\'memory\' driver', 'seeds 7'])).toBe(true);
		expect(definesInFile(source, ['\'memory\' driver', 'anything at all'])).toBe(true);
		expect(definesInFile(source, ['\'memory\' driver', 'answers ledger-block-both.json as the representative did'])).toBe(true);
		expect(definesInFile(source, ['\'memory\' storage', 'anything at all'])).toBe(false);
	});

	test('take $ and % as written outside a parameterized title, and a primitive row\'s $name as written', function() {
		const source = `
			test('costs $5, 10%s off', function() {});
			test.each(['main'])('keeps $network for %s', function() {});
		`;

		expect(definesInFile(source, ['costs $5, 10%s off'])).toBe(true);
		expect(definesInFile(source, ['costs 1, 10x off'])).toBe(false);
		expect(definesInFile(source, ['keeps $network for main'])).toBe(true);
	});

	test('name a test of a shared suite inside a block of the file that runs it, and only there', function() {
		const files = {
			[FILE]: `
				describe.each(drivers)('$name driver', function(driver) {
					defineCases(driver);
				});
				describe('another block', function() {});
			`,
			[SUITE]: `
				export function defineCases(driver) {
					describe('permission canaries', function() {
						test('a grant is refused', async function() {});
					});
				}
			`
		};

		expect(defines(files, ['\'memory\' driver', 'permission canaries', 'a grant is refused'])).toBe(true);
		expect(defines(files, ['permission canaries', 'a grant is refused'])).toBe(true);
		expect(defines(files, ['another block', 'permission canaries', 'a grant is refused'])).toBe(true);
		expect(defines(files, ['\'memory\' driver', 'a grant is refused'])).toBe(false);
		expect(defines(files, ['a missing block', 'permission canaries', 'a grant is refused'])).toBe(false);
	});

	test('leave out what only builds the tests, and calls of other functions', function() {
		const templates = titleTemplatesOf(`
			const build = test.each(['table title']);
			const later = test.skipIf(true);
			/x/.test('not a title');
			expect('neither').toBe('neither');
		`, FILE);

		expect(templates).toEqual([]);
	});
});
