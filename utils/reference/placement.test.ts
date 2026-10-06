import { expect, test } from 'vitest';
import { convertStringToWebpackModuleID } from './bundle.js';
import type { BundleModule, BundleModuleOrigin } from './bundle.js';
import { convertStringToTypingsPath, minimumPlacementScore, placeModules } from './placement.js';
import type { TypingsPath } from './placement.js';

function buildModule(id: string, names: readonly string[], origin: BundleModuleOrigin = 'keeta'): BundleModule {
	return({
		id: convertStringToWebpackModuleID(id),
		lines: { first: 1, last: 1 },
		origin,
		exportedNames: new Set(names)
	});
}

function buildTypings(entries: Record<string, readonly string[]>): ReadonlyMap<TypingsPath, ReadonlySet<string>> {
	return(new Map(Object.entries(entries).map(function([path, names]): [TypingsPath, ReadonlySet<string>] {
		return([convertStringToTypingsPath(path), new Set(names)]);
	})));
}

test('places a module on the typings file with the highest export overlap', function(): void {
	const typings = buildTypings({
		'lib/ledger/index.d.ts': ['Ledger', 'Kind', 'Config'],
		'api/node.d.ts': ['Node', 'Peer', 'Status']
	});

	const [ledger, node] = placeModules([
		buildModule('1', ['Ledger', 'Kind', 'Config', 'Extra']),
		buildModule('2', ['Node', 'Peer', 'Status'])
	], typings);

	expect(ledger).toMatchObject({ kind: 'placed', typingsPath: 'lib/ledger/index.d.ts', outputPath: 'modules/ledger/index.js', score: 0.75 });
	expect(node).toMatchObject({ kind: 'placed', typingsPath: 'api/node.d.ts', outputPath: 'modules/api/node.js', score: 1 });
});

test('places tied modules in unmatched', function(): void {
	const typings = buildTypings({
		'lib/a.d.ts': ['Shared', 'OnlyA'],
		'lib/b.d.ts': ['Shared', 'OnlyB']
	});

	const [placement] = placeModules([buildModule('9', ['Shared'])], typings);

	expect(placement).toMatchObject({ kind: 'unmatched', reason: 'tie', bestScore: 0.5, outputPath: 'modules/unmatched/9.js' });
});

test('places modules below the minimum score in unmatched', function(): void {
	const typings = buildTypings({ 'lib/a.d.ts': ['A', 'B', 'C', 'D'] });

	const [placement, empty] = placeModules([buildModule('4', ['A']), buildModule('5', [])], typings);

	expect(minimumPlacementScore).toBe(0.5);
	expect(placement).toMatchObject({ kind: 'unmatched', reason: 'below-threshold', bestScore: 0.25, outputPath: 'modules/unmatched/4.js' });
	expect(empty).toMatchObject({ kind: 'unmatched', reason: 'below-threshold', bestScore: 0 });
});

test('suffixes colliding placements with module IDs', function(): void {
	const typings = buildTypings({
		'lib/ledger/index.d.ts': ['Ledger', 'Kind'],
		'lib/other.d.ts': ['Other']
	});

	const placements = placeModules([
		buildModule('11', ['Ledger', 'Kind']),
		buildModule('12', ['Ledger', 'Kind']),
		buildModule('13', ['Other'])
	], typings);

	expect(placements.map(function(placement): string | undefined {
		if (placement.kind === 'third-party') {
			return(undefined);
		}
		return(placement.outputPath);
	})).toEqual(['modules/ledger/index-11.js', 'modules/ledger/index-12.js', 'modules/other.js']);
});

test('never splits out third-party modules', function(): void {
	const typings = buildTypings({ 'lib/vendor.d.ts': ['Vendor'] });
	const vendor = buildModule('3', ['Vendor'], 'third-party');

	const [placement] = placeModules([vendor], typings);

	expect(placement).toEqual({ kind: 'third-party', module: vendor });
});
