import { describe, expect, test } from 'vitest';
import { definesTest, titleTemplatesOf } from './titles.js';

function templatesOf(source: string): ReturnType<typeof titleTemplatesOf> {
	return(titleTemplatesOf(source, 'example.test.ts'));
}

describe('the titles a test file gives', function() {
	test('name a test inside the blocks around it, by the titles written out', function() {
		const templates = templatesOf(`
			describe('a block', function() {
				describe("an inner block", function() {
					test('a test', async function() {});
					it(\`another test\`, function() {});
				});
			});
		`);

		expect(definesTest(templates, ['a block', 'an inner block', 'a test'])).toBe(true);
		expect(definesTest(templates, ['a block', 'another test'])).toBe(true);
		expect(definesTest(templates, ['a block', 'a missing test'])).toBe(false);
		expect(definesTest(templates, ['a missing block', 'a test'])).toBe(false);
		// A test's title names no block, and a block's no test.
		expect(definesTest(templates, ['a test', 'a test'])).toBe(false);
		expect(definesTest(templates, ['a block'])).toBe(false);
		expect(definesTest(templates, [])).toBe(false);
	});

	test('name a test by any value a parameterized title is filled with, by name or by directive, and only those', function() {
		const templates = templatesOf(`
			describe.each(drivers)('$name driver', { timeout: 1 }, function(driver) {
				test.each(matrix)('closes $network in $mode.text mode: $closed', function() {});
				test.each(['a'])('refuses %j, 100%% of it', function() {});
				test.for([1])('seed %i', function() {});
				test.skip('skipped', function() {});
			});
		`);

		expect(definesTest(templates, ['\'memory\' driver', 'closes \'main\' in \'read-only\' mode: true'])).toBe(true);
		expect(definesTest(templates, ['\'memory\' driver', 'refuses "x", 100% of it'])).toBe(true);
		expect(definesTest(templates, ['\'memory\' driver', 'seed 1'])).toBe(true);
		expect(definesTest(templates, ['\'memory\' driver', 'skipped'])).toBe(true);
		expect(definesTest(templates, ['\'memory\' storage', 'skipped'])).toBe(false);
		expect(definesTest(templates, ['\'memory\' driver', 'opens \'main\' in \'read-only\' mode: true'])).toBe(false);
	});

	test('take $ and % as written outside a parameterized title, and a template\'s expressions as any value', function() {
		const templates = templatesOf(`
			test('costs $5, 10%s off', function() {});
			test(\`answers \${name} as the representative did\`, function() {});
		`);

		expect(definesTest(templates, ['costs $5, 10%s off'])).toBe(true);
		expect(definesTest(templates, ['costs 1, 10x off'])).toBe(false);
		expect(definesTest(templates, ['answers ledger-block-both.json as the representative did'])).toBe(true);
		expect(definesTest(templates, ['answers ledger-block-both.json as a representative did'])).toBe(false);
	});

	test('take a computed title as any name', function() {
		const templates = templatesOf(`
			describe(driver.name, function() {
				test(titleOf(1), function() {});
			});
		`);

		expect(definesTest(templates, ['memory', 'anything at all'])).toBe(true);
	});

	test('leave out what only builds the tests, and calls of other functions', function() {
		const templates = templatesOf(`
			const build = test.each(['table title']);
			/x/.test('not a title');
			expect('neither').toBe('neither');
		`);

		expect(templates).toEqual([]);
	});
});
