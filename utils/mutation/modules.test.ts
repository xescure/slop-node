import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseTriage } from './triage.js';

const CONFIG = 'src/node/config.ts';

/** The declarations of config.ts that close a network to peers, each of which a range must hold. */
const CLOSURE_DECLARATIONS = [
	'export const PUBLIC_NETWORKS',
	'const VOTING_RULES',
	'function votesIn(',
	'function mayVoteWithPeersOn(',
	'const NON_VOTING_WRITE_MODES',
	'function networkWithID(',
	'export function publicNetworkOf(',
	'function closureToP2P(',
	'export function networkClosedToP2P(',
	'export function nodeNetworkClosedToP2P(',
	'function nonVotingModesOpenOn(',
	'function alternatives(',
	'function refuseWhereClosed(',
	'function refuseVotesInMemory('
] as const;

/* The modules are the mutation runs' own JavaScript, which the suite's TypeScript does not type, so they are read by a path the compiler does not follow. */
async function exportOfModules(name: string): Promise<unknown> {
	const modules: unknown = await import(pathToFileURL(resolve('mutation/modules.js')).href);
	if (typeof modules !== 'object' || modules === null) {
		throw(new Error('mutation/modules.js is no module'));
	}
	return(Reflect.get(modules, name));
}

type RangeReader = (source: string) => string[];

function isRangeReader(candidate: unknown): candidate is RangeReader {
	return(typeof candidate === 'function');
}

async function closureRangesOf(source: string): Promise<string[]> {
	const reader = await exportOfModules('closureRanges');
	if (!isRangeReader(reader)) {
		throw(new Error('mutation/modules.js exports no closureRanges'));
	}
	return(reader(source));
}

type ModuleReader = (name: string) => { readonly mutate: readonly string[] };

function isModuleReader(candidate: unknown): candidate is ModuleReader {
	return(typeof candidate === 'function');
}

/** What the module mutates, as Stryker's configuration reads it. */
async function mutateOf(module: string): Promise<readonly string[]> {
	const reader = await exportOfModules('moduleNamed');
	if (!isModuleReader(reader)) {
		throw(new Error('mutation/modules.js exports no moduleNamed'));
	}
	return(reader(module).mutate);
}

type LineRange = { readonly first: number; readonly last: number };

function lineRangeOf(range: string): LineRange {
	const match = /^src\/node\/config\.ts:(\d+)-(\d+)$/u.exec(range);
	if (match?.[1] === undefined || match[2] === undefined) {
		throw(new Error(`not a range of ${CONFIG}: ${range}`));
	}
	return({ first: Number(match[1]), last: Number(match[2]) });
}

describe('the parts of config.ts the peer-to-peer module mutates', function() {
	test('hold every declaration that closes a network to peers, and end where a declaration does', async function() {
		const source = readFileSync(CONFIG, 'utf8');
		const lines = source.split('\n');
		const ranges = (await closureRangesOf(source)).map(lineRangeOf);

		for (const declaration of CLOSURE_DECLARATIONS) {
			const line = lines.findIndex(function(text): boolean {
				return(text.startsWith(declaration));
			}) + 1;
			expect(ranges.some(function(range): boolean {
				return(range.first <= line && line <= range.last);
			}), declaration).toBe(true);
		}
		for (const range of ranges) {
			expect(lines[range.last - 1]).toMatch(/^\}\)?;?$/u);
		}
	});

	test('and the config module the rest, each line of the file in exactly one of the two', async function() {
		const lineCount = readFileSync(CONFIG, 'utf8').split('\n').length - 1;
		const modules = ['p2p', 'config'] as const;
		const timesMutated = new Array<number>(lineCount + 1).fill(0);

		for (const module of modules) {
			const ofConfig = (await mutateOf(module)).filter(function(pattern): boolean {
				return(pattern.startsWith(CONFIG));
			});
			expect(ofConfig.length, module).toBeGreaterThan(0);
			for (const range of ofConfig.map(lineRangeOf)) {
				for (let line = range.first; line <= range.last; line++) {
					timesMutated[line] = (timesMutated[line] ?? 0) + 1;
				}
			}
		}

		expect(timesMutated.slice(1)).toEqual(new Array<number>(lineCount).fill(1));
	});

	test('hold each entry of config.ts in mutation/equivalent.md wholly, in the module whose section it is under', async function() {
		const modules = ['p2p', 'config'] as const;
		const rangesOf = new Map<string, readonly LineRange[]>();
		for (const module of modules) {
			rangesOf.set(module, (await mutateOf(module)).filter(function(pattern): boolean {
				return(pattern.startsWith(CONFIG));
			}).map(lineRangeOf));
		}
		let section = '';
		let entries = 0;
		for (const line of readFileSync('mutation/equivalent.md', 'utf8').split('\n')) {
			if (line.startsWith('## ')) {
				section = line.slice(3);
				continue;
			}
			const [entry] = parseTriage(line);
			if (entry?.file !== CONFIG) {
				continue;
			}
			entries++;
			const holding = modules.filter(function(module): boolean {
				return((rangesOf.get(module) ?? []).some(function(range): boolean {
					return(range.first <= entry.start.line && entry.end.line <= range.last);
				}));
			});
			// An entry no module's lines hold wholly is judged by no run, and would stay however stale it became.
			expect(holding, entry.place).toEqual([section]);
		}
		expect(entries).toBeGreaterThan(0);
	});

	test('stop the run when a part is no longer there', async function() {
		const source = readFileSync(CONFIG, 'utf8').replace('type P2PClosure =', 'type P2PClosed =');

		await expect(closureRangesOf(source)).rejects.toThrow(`${CONFIG} has not exactly one line 'type P2PClosure ='`);
	});
});
