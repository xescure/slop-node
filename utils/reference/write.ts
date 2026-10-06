import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { splitBundle } from './bundle.js';
import type { BundleLineRange, SplitBundle } from './bundle.js';
import { assertNever } from './never.js';
import { convertStringToTypingsPath, placeModules } from './placement.js';
import type { ModulePlacement, TypingsPath } from './placement.js';
import { collectTypingsValueExports } from './typings.js';

export type ReferenceSource = { readonly packageRoot: string; readonly packageName: string; readonly version: string };

type WrittenPlacement = Exclude<ModulePlacement, { readonly kind: 'third-party' }>;

type BundleText = {
	readonly bytes: Buffer;
	readonly lines: readonly string[];
};

const bundlePath = 'client/index.js';
const typingsRoots = ['lib', 'api'] as const;

const indexColumns = ['module', 'lines', 'origin', 'placement', 'file', 'score', 'exports'] as const;
type IndexCells = { readonly [Column in typeof indexColumns[number]]: string };
type IndexRow = { readonly first: number; readonly cells: IndexCells };

function decodeBundle(bytes: Buffer): BundleText {
	const text = bytes.toString('utf8');
	/*
	 * Module files are rebuilt from decoded text, so bytes that do not survive
	 * decoding would silently differ from the upstream bundle.
	 */
	if (!Buffer.from(text, 'utf8').equals(bytes)) {
		throw(new Error(`${bundlePath} is not valid UTF-8`));
	}
	if (text.endsWith('\n')) {
		return({ bytes, lines: text.slice(0, -1).split('\n') });
	}
	return({ bytes, lines: text.split('\n') });
}

/*
 * A module always ends before the epilogue, which has at least one line, so
 * a newline follows every module whether or not the bundle ends with one.
 */
function moduleText(bundle: BundleText, range: BundleLineRange): string {
	return(bundle.lines.slice(range.first - 1, range.last).join('\n') + '\n');
}

function isWritten(placement: ModulePlacement): placement is WrittenPlacement {
	return(placement.kind !== 'third-party');
}

function namingScore(placement: WrittenPlacement): number {
	switch (placement.kind) {
		case 'placed':
			return(placement.score);
		case 'unmatched':
			return(placement.bestScore);
		default:
			return(assertNever(placement));
	}
}

function formatLineRange(range: BundleLineRange): string {
	return(`${String(range.first)}-${String(range.last)}`);
}

function provenanceHeader(source: ReferenceSource, placement: WrittenPlacement): string {
	return(`// [Keeta TS] ${source.packageName}@${source.version} ${bundlePath}:${formatLineRange(placement.module.lines)}, webpack module ${placement.module.id} (naming: ${namingScore(placement).toFixed(2)})\n`);
}

function toPortablePath(path: string): string {
	return(path.split(sep).join('/'));
}

async function listTypingsPaths(packageRoot: string): Promise<readonly TypingsPath[]> {
	const retval: TypingsPath[] = [];
	for (const root of typingsRoots) {
		const entries = await readdir(join(packageRoot, root), { recursive: true, withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.d.ts')) {
				retval.push(convertStringToTypingsPath(toPortablePath(relative(packageRoot, join(entry.parentPath, entry.name)))));
			}
		}
	}
	return(retval.sort());
}

async function collectTypings(packageRoot: string, typingsPaths: readonly TypingsPath[]): Promise<ReadonlyMap<TypingsPath, ReadonlySet<string>>> {
	const retval = new Map<TypingsPath, ReadonlySet<string>>();
	for (const typingsPath of typingsPaths) {
		const text = await readFile(join(packageRoot, typingsPath), 'utf8');
		retval.set(typingsPath, collectTypingsValueExports(text, typingsPath));
	}
	return(retval);
}

function isFileExistsError(error: unknown): boolean {
	return(error instanceof Error && 'code' in error && error.code === 'EEXIST');
}

async function createOutputDirectory(outputDirectory: string): Promise<void> {
	await mkdir(dirname(outputDirectory), { recursive: true });
	try {
		await mkdir(outputDirectory);
	} catch (error: unknown) {
		if (isFileExistsError(error)) {
			throw(new Error(`output directory already exists: ${outputDirectory}`));
		}
		throw(error);
	}
}

// The exclusive flag turns two files claiming one path into an error instead of a silent overwrite.
async function writeNewFile(path: string, contents: string | Buffer): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents, { flag: 'wx' });
}

async function copyNewFile(from: string, to: string): Promise<void> {
	await mkdir(dirname(to), { recursive: true });
	await copyFile(from, to, constants.COPYFILE_EXCL);
}

function escapeCell(text: string): string {
	return(text.replaceAll('|', '\\|'));
}

function renderRow(cells: IndexCells): string {
	return(`| ${indexColumns.map(function(column): string {
		return(escapeCell(cells[column]));
	}).join(' | ')} |`);
}

function rangeRow(name: 'prologue' | 'epilogue', range: BundleLineRange): IndexRow {
	return({
		first: range.first,
		cells: {
			module: name,
			lines: formatLineRange(range),
			origin: '-',
			placement: name,
			file: bundlePath,
			score: '-',
			exports: ''
		}
	});
}

function placementCells(placement: ModulePlacement): Pick<IndexCells, 'placement' | 'file' | 'score'> {
	switch (placement.kind) {
		case 'placed':
			return({ placement: `placed ${placement.typingsPath}`, file: placement.outputPath, score: placement.score.toFixed(2) });
		case 'unmatched':
			return({ placement: `unmatched (${placement.reason})`, file: placement.outputPath, score: placement.bestScore.toFixed(2) });
		case 'third-party':
			return({ placement: 'third-party', file: bundlePath, score: '-' });
		default:
			return(assertNever(placement));
	}
}

function moduleRow(placement: ModulePlacement): IndexRow {
	const { module } = placement;
	return({
		first: module.lines.first,
		cells: {
			module: module.id,
			lines: formatLineRange(module.lines),
			origin: module.origin,
			...placementCells(placement),
			exports: [...module.exportedNames].sort().join(', ')
		}
	});
}

export function renderModulesIndex(source: ReferenceSource, split: SplitBundle, placements: readonly ModulePlacement[]): string {
	const placementsMatchModules = placements.length === split.modules.length && placements.every(function(placement, position): boolean {
		return(placement.module === split.modules[position]);
	});
	if (!placementsMatchModules) {
		throw(new Error('placements do not correspond to the modules of the split bundle'));
	}

	const rows = [rangeRow('prologue', split.prologue), ...placements.map(moduleRow), rangeRow('epilogue', split.epilogue)].sort(function(left, right): number {
		return(left.first - right.first);
	});
	const header: IndexCells = { module: 'module', lines: 'lines', origin: 'origin', placement: 'placement', file: 'file', score: 'score', exports: 'exports' };
	const divider: IndexCells = { module: '---', lines: '---', origin: '---', placement: '---', file: '---', score: '---', exports: '---' };
	return([
		`# Reference modules: ${source.packageName}@${source.version}`,
		'',
		renderRow(header),
		renderRow(divider),
		...rows.map(function(row): string {
			return(renderRow(row.cells));
		}),
		''
	].join('\n'));
}

export async function writeReference(source: ReferenceSource, outputDirectory: string): Promise<void> {
	const bundle = decodeBundle(await readFile(join(source.packageRoot, bundlePath)));
	const split = splitBundle(bundle.lines);
	const typingsPaths = await listTypingsPaths(source.packageRoot);
	const placements = placeModules(split.modules, await collectTypings(source.packageRoot, typingsPaths));
	const index = renderModulesIndex(source, split, placements);

	await createOutputDirectory(outputDirectory);
	await writeNewFile(join(outputDirectory, bundlePath), bundle.bytes);
	for (const typingsPath of typingsPaths) {
		await copyNewFile(join(source.packageRoot, typingsPath), join(outputDirectory, typingsPath));
	}
	for (const placement of placements.filter(isWritten)) {
		await writeNewFile(join(outputDirectory, placement.outputPath), provenanceHeader(source, placement) + moduleText(bundle, placement.module.lines));
	}
	await writeNewFile(join(outputDirectory, 'MODULES.md'), index);
}

function manifestField(manifest: object, field: 'name' | 'version'): string {
	const value: unknown = Reflect.get(manifest, field);
	if (typeof value !== 'string') {
		throw(new Error(`package.json has no string "${field}"`));
	}
	return(value);
}

export async function readReferenceSource(packageRoot: string): Promise<ReferenceSource> {
	const manifest: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
	if (typeof manifest !== 'object' || manifest === null) {
		throw(new Error('package.json is not an object'));
	}
	return({ packageRoot, packageName: manifestField(manifest, 'name'), version: manifestField(manifest, 'version') });
}
