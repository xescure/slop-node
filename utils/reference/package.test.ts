import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { splitBundle } from './bundle.js';
import type { BundleLineRange } from './bundle.js';
import { readReferenceSource, writeReference } from './write.js';
import type { ReferenceSource } from './write.js';

const packageRoot = resolve(import.meta.dirname, '..', '..', 'node_modules', '@keetanetwork', 'keetanet-client');
const slowTestTimeout = 120_000;

let workDirectory = '';
let source: ReferenceSource | undefined = undefined;
let firstExtraction = '';

async function listFiles(directory: string): Promise<readonly string[]> {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true });
	return(entries.filter(function(entry): boolean {
		return(entry.isFile());
	}).map(function(entry): string {
		return(join(entry.parentPath, entry.name).slice(directory.length + 1));
	}).sort());
}

async function filesContaining(directory: string, needle: string): Promise<readonly string[]> {
	const retval: string[] = [];
	for (const file of await listFiles(join(directory, 'modules'))) {
		const text = await readFile(join(directory, 'modules', file), 'utf8');
		if (text.includes(needle)) {
			retval.push(`modules/${file}`);
		}
	}
	return(retval);
}

beforeAll(async function(): Promise<void> {
	workDirectory = await mkdtemp(join(tmpdir(), 'slop-node-package-'));
	source = await readReferenceSource(packageRoot);
	firstExtraction = join(workDirectory, 'first');
	await writeReference(source, firstExtraction);
}, slowTestTimeout);

afterAll(async function(): Promise<void> {
	await rm(workDirectory, { recursive: true, force: true });
});

test('prologue, modules and epilogue reproduce the upstream bundle exactly', async function(): Promise<void> {
	const bytes = await readFile(join(packageRoot, 'client', 'index.js'));
	const text = bytes.toString('utf8');
	expect(Buffer.from(text, 'utf8').equals(bytes)).toBe(true);

	const lines = text.split('\n');
	const split = splitBundle(lines);
	const ranges = [split.prologue, ...split.modules.map(function(entry): BundleLineRange {
		return(entry.lines);
	}), split.epilogue];
	const rebuilt = ranges.map(function(range): string {
		return(lines.slice(range.first - 1, range.last).join('\n'));
	}).join('\n');

	expect(rebuilt).toBe(text);
	expect(await readFile(join(firstExtraction, 'client', 'index.js'))).toEqual(bytes);
}, slowTestTimeout);

test('known anchors land in their typings modules', async function(): Promise<void> {
	const ledger = await filesContaining(firstExtraction, '\nclass Ledger {');
	const atomicInterface = await filesContaining(firstExtraction, '\nclass LedgerAtomicInterface {');
	const effects = await filesContaining(firstExtraction, '\nfunction computeEffectOfBlocks(');
	const storageBase = await filesContaining(firstExtraction, '\nclass LedgerStorageBase {');

	expect(ledger).toEqual(['modules/ledger/index.js']);
	expect(atomicInterface).toEqual(['modules/ledger/index.js']);
	expect(effects).toEqual(['modules/ledger/effects.js']);
	expect(storageBase).toEqual(['modules/ledger/common.js']);
}, slowTestTimeout);

test('two extractions of the same package are byte-identical', async function(): Promise<void> {
	if (source === undefined) {
		throw(new Error('the package source was not read'));
	}
	const secondExtraction = join(workDirectory, 'second');
	await writeReference(source, secondExtraction);

	const files = await listFiles(firstExtraction);
	expect(await listFiles(secondExtraction)).toEqual(files);
	for (const file of files) {
		expect(await readFile(join(secondExtraction, file))).toEqual(await readFile(join(firstExtraction, file)));
	}
}, slowTestTimeout);
