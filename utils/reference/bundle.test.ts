import { expect, test } from 'vitest';
import { splitBundle } from './bundle.js';
import type { BundleLineRange } from './bundle.js';
import { collectTypingsValueExports } from './typings.js';

type SyntheticModule = { readonly id: string; readonly body: readonly string[] };

const prologue = [
	'/******/ (() => { // webpackBootstrap',
	'/******/ \tvar __webpack_modules__ = ({'
];
const epilogue = [
	'/******/ \t});',
	'/******/ \t// The module cache',
	';'
];

function buildBundle(modules: readonly SyntheticModule[]): string[] {
	const moduleLines = modules.flatMap(function(entry): string[] {
		return([
			`/***/ ${entry.id}:`,
			'/***/ ((__unused_webpack_module, exports, __webpack_require__) => {',
			...entry.body,
			'/***/ }),'
		]);
	});
	return([...prologue, ...moduleLines, ...epilogue]);
}

function textInRange(lines: readonly string[], range: BundleLineRange): string[] {
	return(lines.slice(range.first - 1, range.last));
}

test('splits prologue, modules and epilogue so their ranges cover every line exactly once', function(): void {
	const lines = buildBundle([
		{ id: '10', body: ['exports.Alpha = void 0;'] },
		{ id: '20', body: ['exports.Beta = void 0;', '/***/ nested comment line'] },
		{ id: '30', body: [] }
	]);

	const split = splitBundle(lines);

	const ranges = [split.prologue, ...split.modules.map(function(entry): BundleLineRange {
		return(entry.lines);
	}), split.epilogue];
	expect(ranges[0]?.first).toBe(1);
	expect(ranges.at(-1)?.last).toBe(lines.length);
	for (const [index, range] of ranges.entries()) {
		const previous = ranges[index - 1];
		if (previous !== undefined) {
			expect(range.first).toBe(previous.last + 1);
		}
	}

	expect(split.prologue).toEqual({ first: 1, last: 2 });
	expect(split.modules.map(function(entry): string {
		return(entry.id);
	})).toEqual(['10', '20', '30']);
	expect(split.modules[0]?.lines).toEqual({ first: 3, last: 6 });
	expect(textInRange(lines, split.modules[2]?.lines ?? split.prologue)[0]).toBe('/***/ 30:');
	expect(textInRange(lines, split.epilogue)).toEqual(epilogue);
});

test('round-trips a bundle without trailing newline', function(): void {
	const text = buildBundle([
		{ id: '1', body: ['exports.One = void 0;'] },
		{ id: '2', body: ['exports.Two = void 0;'] }
	]).join('\n');
	expect(text.endsWith('\n')).toBe(false);

	const lines = text.split('\n');
	const split = splitBundle(lines);
	const rebuilt = [
		...textInRange(lines, split.prologue),
		...split.modules.flatMap(function(entry): string[] {
			return(textInRange(lines, entry.lines));
		}),
		...textInRange(lines, split.epilogue)
	].join('\n');

	expect(rebuilt).toBe(text);
	expect(textInRange(lines, split.epilogue).at(-1)).toBe(';');
});

test('marks modules with a sourceMappingURL as third-party', function(): void {
	const split = splitBundle(buildBundle([
		{ id: '1', body: ['exports.Own = void 0;'] },
		{ id: '2', body: ['exports.Vendor = void 0;', '//# sourceMappingURL=vendor.js.map'] }
	]));

	expect(split.modules.map(function(entry): string {
		return(entry.origin);
	})).toEqual(['keeta', 'third-party']);
});

test('collects dot, bracket and defineProperty exports but not __esModule', function(): void {
	const split = splitBundle(buildBundle([
		{
			id: '7',
			body: [
				'Object.defineProperty(exports, "__esModule", ({ value: true }));',
				'exports.Dotted = exports.Chained = void 0;',
				'exports["default"] = Dotted;',
				'Object.defineProperty(exports, "BloomFilter", ({ enumerable: true, get: function () { return x.BloomFilter; } }));',
				'if (exports.Compared == null) { return exports.Read; }'
			]
		}
	]));

	expect([...(split.modules[0]?.exportedNames ?? [])].sort()).toEqual(['BloomFilter', 'Chained', 'Dotted', 'default']);
});

test('collects only value exports from typings', function(): void {
	const source = [
		'export interface Shape { size: number }',
		'export type Alias = string;',
		'export declare class Widget {}',
		'export declare function build(): Widget;',
		'export declare const limit: number, other: string;',
		'export declare enum Color { Red }',
		'declare class Hidden {}',
		'interface LocalShape {}',
		'export { Hidden, LocalShape };',
		'export { Reexported, type TypeOnlyReexport } from "./other.js";',
		'export type { Shape as ShapeAgain } from "./other.js";',
		'export default class Main {}'
	].join('\n');

	expect([...collectTypingsValueExports(source, 'sample.d.ts')].sort()).toEqual([
		'Color', 'Hidden', 'Reexported', 'Widget', 'build', 'default', 'limit', 'other'
	]);
});

test('rejects a module ID that could escape an output directory', function(): void {
	expect(function(): void {
		splitBundle(buildBundle([
			{ id: '10', body: ['exports.Alpha = void 0;'] },
			{ id: '../escape', body: ['exports.Beta = void 0;'] }
		]));
	}).toThrow('unsafe webpack module ID "../escape" on bundle line 7');
});
