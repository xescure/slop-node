import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { driftOf } from './drift.js';
import { CANARIES, PATCH_DIRECTORY, patchOf } from './list.js';
import type { Canary } from './list.js';

const run = promisify(execFile);

/*
 * The canaries run only under "make canaries", so this is what tells the
 * suite that one no longer reverts its fix: its patch no longer applies to
 * the tree, or a test it names is gone.
 */
describe('the canary list', function() {
	test('gives each canary a name of its own and a patch, and every patch a canary', async function() {
		const names = CANARIES.map(function(canary): string {
			return(canary.name);
		});

		expect(new Set(names).size).toBe(names.length);
		expect((await readdir(PATCH_DIRECTORY)).sort()).toEqual(CANARIES.map(function(canary): string {
			return(patchOf(canary).slice(PATCH_DIRECTORY.length + 1));
		}).sort());
	});

	test.each(CANARIES)('reverts in a patch that applies to the tree, caught by tests the tree holds: $name', async function(canary) {
		expect(canary.catchers.length).toBeGreaterThan(0);
		expect(await driftOf(canary, process.cwd())).toEqual([]);
	});

	test('names fixes that are commits of the tree\'s history', async function() {
		for (const { fix } of CANARIES) {
			if (fix.kind === 'commit') {
				await expect(run('git', ['merge-base', '--is-ancestor', fix.commit, 'HEAD'])).resolves.toBeDefined();
			}
		}
	});
});

describe('a canary that drifted from the tree', function() {
	let tree = '';

	beforeEach(async function() {
		tree = await mkdtemp(join(tmpdir(), 'slop-node-canary-'));
		await mkdir(join(tree, PATCH_DIRECTORY), { recursive: true });
		await mkdir(join(tree, 'src'));
		await writeFile(join(tree, 'src/fix.ts'), 'export const checked = true;\n');
		await writeFile(join(tree, 'src/fix.test.ts'), 'describe(\'the fix\', function() {\n\ttest(\'holds\', function() {});\n});\n');
		await writeFile(join(tree, PATCH_DIRECTORY, 'reverted.patch'), [
			'--- a/src/fix.ts',
			'+++ b/src/fix.ts',
			'@@ -1 +1 @@',
			'-export const checked = true;',
			'+export const checked = false;',
			''
		].join('\n'));
	});

	afterEach(async function() {
		await rm(tree, { recursive: true, force: true });
	});

	const canary: Canary = {
		name: 'reverted',
		fix: { kind: 'commit', commit: '0000000' },
		reverts: 'the fix',
		catchers: [{ file: 'src/fix.test.ts', name: ['the fix', 'holds'], titlesIn: ['src/fix.test.ts'] }]
	};

	test('has none while its patch applies and its tests are there', async function() {
		expect(await driftOf(canary, tree)).toEqual([]);
	});

	test('says its patch no longer applies once the code it reverts has changed', async function() {
		await writeFile(join(tree, 'src/fix.ts'), 'export const checked = Boolean(1);\n');

		const [problem, ...rest] = await driftOf(canary, tree);

		expect(problem).toMatch(/^the patch utils\/canaries\/patches\/reverted\.patch no longer applies: error: patch failed: src\/fix\.ts:1/u);
		expect(rest).toEqual([]);
	});

	test('says a test it names is gone, by its file or by its title', async function() {
		await writeFile(join(tree, 'src/fix.test.ts'), 'describe(\'the fix\', function() {\n\ttest(\'holds still\', function() {});\n});\n');
		expect(await driftOf(canary, tree)).toEqual(['no test the fix > holds is defined in src/fix.test.ts']);

		await rm(join(tree, 'src/fix.test.ts'));
		expect(await driftOf(canary, tree)).toEqual(['the test file src/fix.test.ts no longer exists']);
	});

	test('reads the titles of a test the shared suite it runs names', async function() {
		await writeFile(join(tree, 'src/suite.ts'), 'export function define(): void {\n\ttest(\'holds in the suite\', function() {});\n}\n');
		const suite: Canary = { ...canary, catchers: [{ file: 'src/fix.test.ts', name: ['the fix', 'holds in the suite'], titlesIn: ['src/fix.test.ts', 'src/suite.ts'] }] };

		expect(await driftOf(suite, tree)).toEqual([]);
		expect(await driftOf({ ...suite, catchers: [{ file: 'src/fix.test.ts', name: ['the fix', 'holds in the suite'], titlesIn: ['src/fix.test.ts'] }] }, tree)).toEqual(['no test the fix > holds in the suite is defined in src/fix.test.ts']);
	});
});
