import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { splitBundle } from './bundle.js';
import { writeReference } from './write.js';
import type { ReferenceSource } from './write.js';

const prologue = [
	'/******/ (() => { // webpackBootstrap',
	'/******/ \tvar __webpack_modules__ = ({'
];
const epilogue = [
	'/******/ \t});',
	'/******/ \t// The module cache',
	';'
];

function moduleLines(id: string, body: readonly string[]): string[] {
	return([
		`/***/ ${id}:`,
		'/***/ ((__unused_webpack_module, exports, __webpack_require__) => {',
		...body,
		'/***/ }),'
	]);
}

const syntheticLines = [
	...prologue,
	...moduleLines('10', ['exports.Alpha = exports.Beta = void 0;']),
	...moduleLines('20', ['exports.Zed = "caf\u00e9";', '', 'exports.Zed += "\r";']),
	...moduleLines('30', ['exports.Vendor = void 0;', '//# sourceMappingURL=vendor.js.map']),
	...epilogue
];

let workDirectory = '';

beforeEach(async function(): Promise<void> {
	workDirectory = await mkdtemp(join(tmpdir(), 'slop-node-write-'));
});

afterEach(async function(): Promise<void> {
	await rm(workDirectory, { recursive: true, force: true });
});

async function createSyntheticPackage(bundleText: string): Promise<ReferenceSource> {
	const packageRoot = join(workDirectory, 'package');
	await mkdir(join(packageRoot, 'client'), { recursive: true });
	await mkdir(join(packageRoot, 'lib', 'thing'), { recursive: true });
	await mkdir(join(packageRoot, 'api'), { recursive: true });
	await writeFile(join(packageRoot, 'client', 'index.js'), bundleText);
	await writeFile(join(packageRoot, 'lib', 'thing', 'index.d.ts'), 'export declare const Alpha: number;\nexport declare const Beta: number;\n');
	await writeFile(join(packageRoot, 'lib', 'types.d.ts'), 'export interface Shape { size: number }');
	await writeFile(join(packageRoot, 'lib', 'thing', 'index.js'), 'not a typings file');
	await writeFile(join(packageRoot, 'api', 'node.d.ts'), 'export declare class Node {}\n');
	return({ packageRoot, packageName: 'synthetic-package', version: '1.2.3' });
}

async function listFiles(directory: string): Promise<readonly string[]> {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true });
	return(entries.filter(function(entry): boolean {
		return(entry.isFile());
	}).map(function(entry): string {
		return(join(entry.parentPath, entry.name).slice(directory.length + 1));
	}).sort());
}

describe.each([
	{ label: 'without a trailing newline', suffix: '' },
	{ label: 'with a trailing newline', suffix: '\n' }
])('a bundle $label', function({ suffix }): void {
	const bundleText = syntheticLines.join('\n') + suffix;

	test('module files reproduce their bundle lines byte for byte after the provenance header', async function(): Promise<void> {
		const source = await createSyntheticPackage(bundleText);
		const outputDirectory = join(workDirectory, 'out');

		await writeReference(source, outputDirectory);

		const split = splitBundle(syntheticLines);
		const expectedBody = split.modules.map(function(entry): string {
			return(syntheticLines.slice(entry.lines.first - 1, entry.lines.last).join('\n') + '\n');
		});

		expect(await readFile(join(outputDirectory, 'client', 'index.js'), 'utf8')).toBe(bundleText);
		expect(await readFile(join(outputDirectory, 'modules', 'thing', 'index.js'), 'utf8')).toBe(
			'// [Keeta TS] synthetic-package@1.2.3 client/index.js:3-6, webpack module 10 (naming: 1.00)\n' + (expectedBody[0] ?? '')
		);
		expect(await readFile(join(outputDirectory, 'modules', 'unmatched', '20.js'), 'utf8')).toBe(
			'// [Keeta TS] synthetic-package@1.2.3 client/index.js:7-12, webpack module 20 (naming: 0.00)\n' + (expectedBody[1] ?? '')
		);
		expect(await listFiles(join(outputDirectory, 'modules'))).toEqual(['thing/index.js', 'unmatched/20.js']);
	});

	test('copies typings byte for byte and ignores other files', async function(): Promise<void> {
		const source = await createSyntheticPackage(bundleText);
		const outputDirectory = join(workDirectory, 'out');

		await writeReference(source, outputDirectory);

		expect(await listFiles(outputDirectory)).toEqual([
			'MODULES.md',
			'api/node.d.ts',
			'client/index.js',
			'lib/thing/index.d.ts',
			'lib/types.d.ts',
			'modules/thing/index.js',
			'modules/unmatched/20.js'
		]);
		expect(await readFile(join(outputDirectory, 'lib', 'types.d.ts'), 'utf8')).toBe('export interface Shape { size: number }');
		expect(await readFile(join(outputDirectory, 'api', 'node.d.ts'), 'utf8')).toBe('export declare class Node {}\n');
	});
});

test('keeps the final newline of a module that ends the bundle only when the bundle has one', async function(): Promise<void> {
	const lines = [...prologue, ...moduleLines('10', ['exports.Alpha = exports.Beta = void 0;']), '/******/ \t});'];
	const withNewline = await createSyntheticPackage(lines.join('\n') + '\n');
	const outputWith = join(workDirectory, 'with');
	await writeReference(withNewline, outputWith);
	const withoutNewline = await createSyntheticPackage(lines.join('\n'));
	const outputWithout = join(workDirectory, 'without');
	await writeReference(withoutNewline, outputWithout);

	const moduleWith = await readFile(join(outputWith, 'modules', 'thing', 'index.js'), 'utf8');
	const moduleWithout = await readFile(join(outputWithout, 'modules', 'thing', 'index.js'), 'utf8');
	expect(moduleWith).toBe(moduleWithout);
	expect(moduleWith.endsWith('/***/ }),\n')).toBe(true);
});

test('refuses to write into an existing directory', async function(): Promise<void> {
	const source = await createSyntheticPackage(syntheticLines.join('\n'));
	const outputDirectory = join(workDirectory, 'out');
	await mkdir(outputDirectory);

	await expect(writeReference(source, outputDirectory)).rejects.toThrow('already exists');

	expect(await readdir(outputDirectory)).toEqual([]);
});

test('MODULES.md lists prologue, every module and epilogue in line order', async function(): Promise<void> {
	const source = await createSyntheticPackage(syntheticLines.join('\n'));
	const outputDirectory = join(workDirectory, 'out');

	await writeReference(source, outputDirectory);

	const index = await readFile(join(outputDirectory, 'MODULES.md'), 'utf8');
	const rows = index.split('\n').filter(function(line): boolean {
		return(line.startsWith('| '));
	});
	expect(index.split('\n')[0]).toBe('# Reference modules: synthetic-package@1.2.3');
	expect(rows).toEqual([
		'| module | lines | origin | placement | file | score | exports |',
		'| --- | --- | --- | --- | --- | --- | --- |',
		'| prologue | 1-2 | - | prologue | client/index.js | - |  |',
		'| 10 | 3-6 | keeta | placed lib/thing/index.d.ts | modules/thing/index.js | 1.00 | Alpha, Beta |',
		'| 20 | 7-12 | keeta | unmatched (below-threshold) | modules/unmatched/20.js | 0.00 | Zed |',
		'| 30 | 13-17 | third-party | third-party | client/index.js | - | Vendor |',
		'| epilogue | 18-20 | - | epilogue | client/index.js | - |  |'
	]);
	expect(index.endsWith('\n')).toBe(true);
});

test('escapes table separators inside export names', async function(): Promise<void> {
	const lines = [...prologue, ...moduleLines('1', ['exports["a|b"] = 1;']), ...epilogue];
	const source = await createSyntheticPackage(lines.join('\n'));
	const outputDirectory = join(workDirectory, 'out');

	await writeReference(source, outputDirectory);

	expect(await readFile(join(outputDirectory, 'MODULES.md'), 'utf8')).toContain('a\\|b');
});
