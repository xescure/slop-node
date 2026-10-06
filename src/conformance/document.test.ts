import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { assertNever } from '../util/assert-never.js';
import { base64Bytes, decodeVoteCaseFile, toCaseAccount } from './case.js';
import type { Base64, CaseAccount, CaseError, CaseFeeAmount, CaseFeePolicy, CaseNetwork, CaseVoteFee, StapleReference, VoteCase, VoteReference } from './case.js';
import { CATALOG_ROWS } from './catalog.js';
import { EXCLUDED_ROWS } from './exclusions.js';

/*
 * VOTE-CASES.md lists the corpus in tables written by hand. These checks
 * hold each table to the committed files, so a case added, moved or
 * re-based without the document fails here.
 */

const lib = KeetaNet.lib;

const CORPUS_DIRECTORY = new URL('../../conformance/vote-cases/', import.meta.url);
const DOCUMENT_FILE = new URL('../../conformance/VOTE-CASES.md', import.meta.url);

/** Marks a row whose catalog IDs are excluded whole, in place of case IDs. */
const EXCLUDED_CELL = 'excluded';

/** A row's file cell when it names no file. */
const NO_FILE_CELL = '-';

type CommittedCase = {
	readonly file: string;
	readonly voteCase: VoteCase;
};

async function committedCases(): Promise<readonly CommittedCase[]> {
	const cases: CommittedCase[] = [];
	for (const name of (await readdir(CORPUS_DIRECTORY)).sort()) {
		const file = name.replace(/\.json$/, '');
		for (const voteCase of decodeVoteCaseFile(await readFile(new URL(name, CORPUS_DIRECTORY), 'utf8')).cases) {
			cases.push({ file, voteCase });
		}
	}
	return(cases);
}

function fileOfCase(cases: readonly CommittedCase[]): ReadonlyMap<string, string> {
	return(new Map(cases.map(function({ file, voteCase }): [string, string] {
		return([voteCase.id, file]);
	})));
}

function headingLevel(line: string): number {
	const match = /^(#+) /.exec(line);
	if (match === null) {
		return(0);
	}
	return(match[1]?.length ?? 0);
}

/** The lines under a heading, up to the next heading of the same level or above. */
function section(document: string, heading: string): readonly string[] {
	const lines = document.split('\n');
	const start = lines.indexOf(heading);
	if (start === -1) {
		throw(new Error(`VOTE-CASES.md has no heading ${JSON.stringify(heading)}`));
	}
	const level = headingLevel(heading);
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const lineLevel = headingLevel(line);
		if (lineLevel !== 0 && lineLevel <= level) {
			break;
		}
		body.push(line);
	}
	return(body);
}

/** The data rows of every table in the lines, as trimmed cells; header and separator rows are left out. */
function tableRows(lines: readonly string[]): readonly (readonly string[])[] {
	const rows: (readonly string[])[] = [];
	for (const [index, line] of lines.entries()) {
		const isHeader = lines[index + 1]?.startsWith('|---') ?? false;
		if (!line.startsWith('|') || line.startsWith('|---') || isHeader) {
			continue;
		}
		rows.push(line.split('|').slice(1, -1).map(function(cell): string {
			return(cell.trim());
		}));
	}
	return(rows);
}

function cell(row: readonly string[], index: number): string {
	const value = row[index];
	if (value === undefined) {
		throw(new Error(`a table row has no column ${String(index)}: ${row.join(' | ')}`));
	}
	return(value);
}

/** The group names of a file cell such as "`kind.json`, `fees.json`". */
function filesOf(value: string): readonly string[] {
	if (value === NO_FILE_CELL) {
		return([]);
	}
	return(value.split(', ').map(function(file): string {
		const match = /^`([a-z]+)\.json`$/.exec(file);
		if (match?.[1] === undefined) {
			throw(new Error(`not a corpus file: ${file}`));
		}
		return(match[1]);
	}));
}

function idsOf(value: string): readonly string[] {
	return(value.split(', '));
}

function sorted(values: Iterable<string>): readonly string[] {
	return([...values].sort());
}

/** Every file of the cases named, once each, sorted. */
function filesOfCases(ids: readonly string[], files: ReadonlyMap<string, string>): readonly string[] {
	return(sorted(new Set(ids.map(function(id): string {
		return(files.get(id) ?? `<no case ${id}>`);
	}))));
}

/**
 * The plain messages a bullet list names. A message with a "<mode>"
 * placeholder stands for one message per mode that follows it in backticks.
 */
function listedMessages(lines: readonly string[]): readonly string[] {
	const messages: string[] = [];
	for (const line of lines) {
		if (!line.startsWith('- `')) {
			continue;
		}
		const quoted = [...line.matchAll(/`([^`]+)`/g)].map(function(match): string {
			return(match[1] ?? '');
		});
		const [template, ...modes] = quoted;
		if (template === undefined) {
			continue;
		}
		if (!template.includes('<mode>')) {
			messages.push(template);
			continue;
		}
		for (const mode of modes) {
			messages.push(template.replace('<mode>', mode));
		}
	}
	return(messages);
}

function plainMessage(error: CaseError): string | null {
	switch (error.type) {
		case 'plain':
			return(error.message);
		case 'coded':
			return(null);
		default:
			return(assertNever(error));
	}
}

function plainMessagesOf(cases: readonly CommittedCase[]): ReadonlySet<string> {
	const messages = new Set<string>();
	for (const { voteCase } of cases) {
		for (const step of voteCase.steps) {
			if (step.expect.outcome !== 'refused' && step.expect.outcome !== 'rejectedInput') {
				continue;
			}
			const message = plainMessage(step.expect.error);
			if (message !== null) {
				messages.add(message);
			}
		}
	}
	return(messages);
}

/** The statement of section 3.5 that holds while no case collects. */
const NO_GC_STATEMENT = 'No committed case has a `gc` step yet; the action is part of the format.';

type SeedName = keyof CaseNetwork['seeds'];

const SEED_NAMES: readonly SeedName[] = ['trustedRoot', 'representative', 'user'];

/** Keys are looked for at every index below this; the corpus uses far fewer. */
const KEY_SCAN_LIMIT = 64;

/** The text of a cell written in backticks. */
function unquoted(value: string): string {
	const match = /^`([^`]+)`$/.exec(value);
	if (match?.[1] === undefined) {
		throw(new Error(`not a cell in backticks: ${value}`));
	}
	return(match[1]);
}

function seedName(value: string): SeedName {
	const name = SEED_NAMES.find(function(candidate): boolean {
		return(candidate === value);
	});
	if (name === undefined) {
		throw(new Error(`not a seed: ${value}`));
	}
	return(name);
}

/** A derived key as "seed index account". */
function keyLine(seed: SeedName, index: number, account: string): string {
	return(`${seed} ${String(index)} ${account}`);
}

function derivedAccount(seeds: CaseNetwork['seeds'], seed: SeedName, index: number): CaseAccount {
	return(toCaseAccount(lib.Account.fromSeed(seeds[seed], index)));
}

/** The seeds every committed case uses; the document's key table is derived from them. */
function corpusSeeds(cases: readonly CommittedCase[]): CaseNetwork['seeds'] {
	const distinct = new Map(cases.map(function({ voteCase }): [string, CaseNetwork['seeds']] {
		return([JSON.stringify(voteCase.network.seeds), voteCase.network.seeds]);
	}));
	const [seeds] = distinct.values();
	if (seeds === undefined || distinct.size !== 1) {
		throw(new Error(`expected one set of seeds across the corpus, found ${String(distinct.size)}`));
	}
	return(seeds);
}

function feeAccounts(amount: CaseFeeAmount): readonly CaseAccount[] {
	return([amount.token, amount.payTo].filter(function(account): account is CaseAccount {
		return(account !== undefined);
	}));
}

function policyAccounts(fee: CaseFeePolicy): readonly CaseAccount[] {
	switch (fee.type) {
		case 'free':
			return([]);
		case 'flat':
			return(feeAccounts(fee));
		case 'choices':
			return(fee.choices.flatMap(feeAccounts));
		default:
			return(assertNever(fee));
	}
}

function voteFeeAccounts(fee: CaseVoteFee): readonly CaseAccount[] {
	switch (fee.type) {
		case 'none':
			return([]);
		case 'single':
			return(feeAccounts(fee));
		case 'choices':
			return(fee.choices.flatMap(feeAccounts));
		default:
			return(assertNever(fee));
	}
}

function errorAccounts(error: CaseError): readonly CaseAccount[] {
	switch (error.type) {
		case 'coded':
			return(error.accounts ?? []);
		case 'plain':
			return([]);
		default:
			return(assertNever(error));
	}
}

/** Every account a case states as a string. */
function statedAccounts(voteCase: VoteCase): readonly CaseAccount[] {
	const accounts = voteCase.nodes.flatMap(function(node): readonly CaseAccount[] {
		return(policyAccounts(node.fee));
	});
	for (const { expect: expectation } of voteCase.steps) {
		switch (expectation.outcome) {
			case 'added':
			case 'collected':
				break;
			case 'temporary':
			case 'permanent':
			case 'quote':
				accounts.push(...voteFeeAccounts(expectation.fee));
				break;
			case 'rejectedInput':
			case 'refused':
				accounts.push(...errorAccounts(expectation.error));
				break;
			default:
				assertNever(expectation);
		}
	}
	return(accounts);
}

function literalBytes(reference: VoteReference | StapleReference | undefined): readonly Base64[] {
	if (reference === undefined || reference.type === 'step') {
		return([]);
	}
	return([reference.bytes]);
}

/** Every block, vote, quote and staple a case carries as bytes. */
function carriedBytes(voteCase: VoteCase): readonly Buffer[] {
	return(voteCase.steps.flatMap(function({ action }): readonly Base64[] {
		switch (action.type) {
			case 'add':
				return(literalBytes(action.staple));
			case 'vote':
				return([...action.blocks, ...(action.otherVotes ?? []).flatMap(literalBytes), ...literalBytes(action.quote)]);
			case 'quote':
				return(action.blocks);
			case 'gc':
				return([]);
			default:
				return(assertNever(action));
		}
	}).map(base64Bytes));
}

/** The derived keys the corpus uses: a key is used when a case states its account or carries its public key in some bytes. */
function usedKeys(cases: readonly CommittedCase[]): readonly string[] {
	const seeds = corpusSeeds(cases);
	const accounts = new Set(cases.flatMap(function({ voteCase }): readonly CaseAccount[] {
		return(statedAccounts(voteCase));
	}));
	const bytes = cases.flatMap(function({ voteCase }): readonly Buffer[] {
		return(carriedBytes(voteCase));
	});
	const used: string[] = [];
	for (const seed of SEED_NAMES) {
		for (let index = 0; index < KEY_SCAN_LIMIT; index++) {
			const account = lib.Account.fromSeed(seeds[seed], index);
			const publicKey = Buffer.from(account.publicKey.get());
			const carried = bytes.some(function(item): boolean {
				return(item.includes(publicKey));
			});
			if (carried || accounts.has(toCaseAccount(account))) {
				used.push(keyLine(seed, index, toCaseAccount(account)));
			}
		}
	}
	return(used);
}

/** The key table of section 4.1, as "seed index account" lines. */
function listedKeys(document: string): readonly string[] {
	return(tableRows(section(document, '### 4.1 Keys')).map(function(row): string {
		return(keyLine(seedName(unquoted(cell(row, 0))), Number(cell(row, 1)), unquoted(cell(row, 2))));
	}));
}

describe('VOTE-CASES.md tables', function() {
	test('the file table counts each file\'s cases', async function() {
		const document = await readFile(DOCUMENT_FILE, 'utf8');
		const counts = new Map<string, number>();
		for (const { file } of await committedCases()) {
			counts.set(file, (counts.get(file) ?? 0) + 1);
		}
		const listed = tableRows(section(document, '## 1. Files')).map(function(row): [string, number] {
			const [file] = filesOf(cell(row, 0));
			return([file ?? '', Number(cell(row, 1))]);
		});

		expect(new Map(listed)).toEqual(counts);
		expect(listed.length).toBe(counts.size);
	});

	test('the coverage, extra and order tables list every case once, in its file', async function() {
		const document = await readFile(DOCUMENT_FILE, 'utf8');
		const files = fileOfCase(await committedCases());
		const listed: string[] = [];
		const misfiled: string[] = [];
		const catalogRows = tableRows(section(document, '### 10.1 Catalog rows'));
		for (const row of catalogRows) {
			const caseCell = cell(row, 1);
			if (caseCell === EXCLUDED_CELL) {
				continue;
			}
			listed.push(...idsOf(caseCell));
			if (filesOf(cell(row, 2)).join() !== filesOfCases(idsOf(caseCell), files).join()) {
				misfiled.push(cell(row, 0));
			}
		}
		const singleCaseRows = [
			...tableRows(section(document, '### 10.2 Extras')),
			...tableRows(section(document, '### 7.3 The order cases'))
		];
		for (const row of singleCaseRows) {
			listed.push(cell(row, 0));
			if (filesOf(cell(row, 1)).join() !== files.get(cell(row, 0))) {
				misfiled.push(cell(row, 0));
			}
		}

		expect(sorted(listed)).toEqual(sorted(files.keys()));
		expect(new Set(listed).size).toBe(listed.length);
		expect(misfiled).toEqual([]);
	});

	test('the coverage table lists the catalog\'s cases, and marks only whole-row exclusions as excluded', async function() {
		const document = await readFile(DOCUMENT_FILE, 'utf8');
		const files = fileOfCase(await committedCases());
		const listedCases: string[] = [];
		const listedExclusions: string[] = [];
		for (const row of tableRows(section(document, '### 10.1 Catalog rows'))) {
			const caseCell = cell(row, 1);
			if (caseCell === EXCLUDED_CELL) {
				listedExclusions.push(cell(row, 0));
				expect(cell(row, 2)).toBe(NO_FILE_CELL);
				continue;
			}
			listedCases.push(...idsOf(caseCell));
		}
		const catalogCases = CATALOG_ROWS.flat().filter(function(id): boolean {
			return(files.has(id));
		});
		const wholeRowExclusions = EXCLUDED_ROWS.filter(function(row): boolean {
			return(row.extent === 'row');
		}).map(function(row): string {
			return(row.id);
		});

		expect(sorted(listedCases)).toEqual(sorted(catalogCases));
		expect(sorted(listedExclusions)).toEqual(sorted(wholeRowExclusions));
	});

	test('the contract table lists exactly the contract cases, in their files', async function() {
		const document = await readFile(DOCUMENT_FILE, 'utf8');
		const cases = await committedCases();
		const contractCases = cases.filter(function({ voteCase }): boolean {
			return(voteCase.basis === 'contract');
		}).map(function({ file, voteCase }): string {
			return(`${voteCase.id} ${file}`);
		});
		const listed = tableRows(section(document, '## 5. Contract cases')).map(function(row): string {
			return(`${cell(row, 0)} ${filesOf(cell(row, 1)).join()}`);
		});

		expect(sorted(listed)).toEqual(sorted(contractCases));
	});

	test('each key of the key table derives from its seed and index', async function() {
		const document = await readFile(DOCUMENT_FILE, 'utf8');
		const seeds = corpusSeeds(await committedCases());
		const listed = listedKeys(document);
		const derived = listed.map(function(line): string {
			const [seed = '', index = ''] = line.split(' ');
			return(keyLine(seedName(seed), Number(index), derivedAccount(seeds, seedName(seed), Number(index))));
		});

		expect(listed.length).toBeGreaterThan(0);
		expect(listed).toEqual(derived);
	});

	test('the key table lists exactly the derived keys the corpus uses', async function() {
		const document = await readFile(DOCUMENT_FILE, 'utf8');

		expect(sorted(listedKeys(document))).toEqual(sorted(usedKeys(await committedCases())));
	});

	test('the document says no case has a gc step exactly when none has', async function() {
		const document = await readFile(DOCUMENT_FILE, 'utf8');
		const gcSteps = (await committedCases()).flatMap(function({ voteCase }) {
			return(voteCase.steps.filter(function(step): boolean {
				return(step.action.type === 'gc');
			}));
		});

		expect(section(document, '### 3.5 Actions').includes(NO_GC_STATEMENT)).toBe(gcSteps.length === 0);
	});

	test('the list of plain messages is the corpus\'s', async function() {
		const document = await readFile(DOCUMENT_FILE, 'utf8');
		const expectations = section(document, '### 3.7 Expectations');
		const start = expectations.indexOf('The plain messages in the corpus are:');

		expect(start).not.toBe(-1);
		expect(sorted(listedMessages(expectations.slice(start)))).toEqual(sorted(plainMessagesOf(await committedCases())));
	});
});
