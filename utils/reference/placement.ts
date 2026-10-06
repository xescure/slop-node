import type { BundleModule } from './bundle.js';
import { assertNever } from './never.js';

declare const typingsPathBrand: unique symbol;
/** Package-relative, for example `lib/ledger/index.d.ts`. */
export type TypingsPath = string & { readonly [typingsPathBrand]: true };

export const minimumPlacementScore = 0.5;

export type ModulePlacement =
	| { readonly kind: 'placed'; readonly module: BundleModule; readonly typingsPath: TypingsPath; readonly outputPath: string; readonly score: number }
	| { readonly kind: 'unmatched'; readonly module: BundleModule; readonly outputPath: string; readonly bestScore: number; readonly reason: 'below-threshold' | 'tie' }
	| { readonly kind: 'third-party'; readonly module: BundleModule };

type TypingsScore = { readonly typingsPath: TypingsPath; readonly score: number };

/** The only place a plain string becomes a typings path: call it with a path taken from the published package listing. */
export function convertStringToTypingsPath(value: string): TypingsPath {
	return(value as TypingsPath);
}

function jaccardSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	const intersection = [...left].filter(function(name): boolean {
		return(right.has(name));
	}).length;
	const union = left.size + right.size - intersection;
	if (union === 0) {
		return(0);
	}
	return(intersection / union);
}

function scoreAgainstTypings(module: BundleModule, typings: ReadonlyMap<TypingsPath, ReadonlySet<string>>): readonly TypingsScore[] {
	return([...typings].map(function([typingsPath, names]): TypingsScore {
		return({ typingsPath, score: jaccardSimilarity(module.exportedNames, names) });
	}));
}

function placedOutputPath(typingsPath: TypingsPath): string {
	return(`modules/${typingsPath.replace(/^lib\//, '').replace(/\.d\.ts$/, '')}.js`);
}

function placeKeetaModule(module: BundleModule, typings: ReadonlyMap<TypingsPath, ReadonlySet<string>>): ModulePlacement {
	const scores = scoreAgainstTypings(module, typings);
	const bestScore = Math.max(0, ...scores.map(function(entry): number {
		return(entry.score);
	}));
	const unmatchedPath = `modules/unmatched/${module.id}.js`;
	if (bestScore < minimumPlacementScore) {
		return({ kind: 'unmatched', module, outputPath: unmatchedPath, bestScore, reason: 'below-threshold' });
	}

	const best = scores.filter(function(entry): boolean {
		return(entry.score === bestScore);
	});
	const [winner, ...runnersUp] = best;
	/*
	 * Two typings files that fit equally well give no basis for choosing one,
	 * and a wrong guess would put the module under a misleading name.
	 */
	if (winner === undefined || runnersUp.length > 0) {
		return({ kind: 'unmatched', module, outputPath: unmatchedPath, bestScore, reason: 'tie' });
	}
	return({ kind: 'placed', module, typingsPath: winner.typingsPath, outputPath: placedOutputPath(winner.typingsPath), score: bestScore });
}

function placeModule(module: BundleModule, typings: ReadonlyMap<TypingsPath, ReadonlySet<string>>): ModulePlacement {
	const origin = module.origin;
	switch (origin) {
		case 'third-party':
			return({ kind: 'third-party', module });
		case 'keeta':
			return(placeKeetaModule(module, typings));
		default:
			return(assertNever(origin));
	}
}

function countPlacedOutputPaths(placements: readonly ModulePlacement[]): ReadonlyMap<string, number> {
	const retval = new Map<string, number>();
	for (const placement of placements) {
		if (placement.kind === 'placed') {
			retval.set(placement.outputPath, (retval.get(placement.outputPath) ?? 0) + 1);
		}
	}
	return(retval);
}

function suffixCollidingPath(placement: ModulePlacement, pathCounts: ReadonlyMap<string, number>): ModulePlacement {
	switch (placement.kind) {
		case 'placed':
			if ((pathCounts.get(placement.outputPath) ?? 0) > 1) {
				return({ ...placement, outputPath: placement.outputPath.replace(/\.js$/, `-${placement.module.id}.js`) });
			}
			return(placement);
		case 'unmatched':
		case 'third-party':
			return(placement);
		default:
			return(assertNever(placement));
	}
}

export function placeModules(modules: readonly BundleModule[], typings: ReadonlyMap<TypingsPath, ReadonlySet<string>>): readonly ModulePlacement[] {
	const placements = modules.map(function(module): ModulePlacement {
		return(placeModule(module, typings));
	});
	const pathCounts = countPlacedOutputPaths(placements);
	return(placements.map(function(placement): ModulePlacement {
		return(suffixCollidingPath(placement, pathCounts));
	}));
}
