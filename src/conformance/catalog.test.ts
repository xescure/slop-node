import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { decodeVoteCaseFile } from './case.js';
import { CATALOG_ROWS, CITED_WITHOUT_ROWS, CORPUS_EXTRAS } from './catalog.js';
import { EXCLUDED_ROWS } from './exclusions.js';

/*
 * The corpus must answer for every catalog row: each ID is a case, an
 * exclusion, or, for a row split between them, both. Every case it holds is
 * a catalog row or an extra declared with the row it extends.
 */

const CORPUS_DIRECTORY = new URL('../../conformance/vote-cases/', import.meta.url);

async function committedCaseIDs(): Promise<ReadonlySet<string>> {
	const caseIDs = new Set<string>();
	for (const name of await readdir(CORPUS_DIRECTORY)) {
		for (const voteCase of decodeVoteCaseFile(await readFile(new URL(name, CORPUS_DIRECTORY), 'utf8')).cases) {
			caseIDs.add(voteCase.id);
		}
	}
	return(caseIDs);
}

const catalogIDs: readonly string[] = CATALOG_ROWS.flat();

const excludedIDs: ReadonlySet<string> = new Set(EXCLUDED_ROWS.map(function(row): string {
	return(row.id);
}));

const extraIDs: ReadonlySet<string> = new Set(CORPUS_EXTRAS.map(function(extra): string {
	return(extra.id);
}));

describe('catalog coverage', function() {
	test('each catalog ID is listed once', function() {
		expect(new Set(catalogIDs).size).toBe(catalogIDs.length);
	});

	test('every catalog ID is a case or an exclusion', async function() {
		const caseIDs = await committedCaseIDs();
		const uncovered = catalogIDs.filter(function(id): boolean {
			return(!caseIDs.has(id) && !excludedIDs.has(id));
		});

		expect(uncovered).toEqual([]);
	});

	test('every case is a catalog ID or a declared extra', async function() {
		const catalog = new Set(catalogIDs);
		const undeclared = [...await committedCaseIDs()].filter(function(id): boolean {
			return(!catalog.has(id) && !extraIDs.has(id));
		});

		expect(undeclared).toEqual([]);
	});

	test('an excluded row has no case, and an excluded part shares its ID with the case that carries the rest', async function() {
		const caseIDs = await committedCaseIDs();
		const mismatched = EXCLUDED_ROWS.filter(function(row): boolean {
			return(caseIDs.has(row.id) !== (row.extent === 'part'));
		}).map(function(row): string {
			return(`${row.id} (${row.extent})`);
		});

		expect(mismatched).toEqual([]);
	});

	test('each declared extra is a case of its own, listed once, outside the catalog', async function() {
		const caseIDs = await committedCaseIDs();
		const catalog = new Set(catalogIDs);
		const stale = CORPUS_EXTRAS.filter(function(extra): boolean {
			return(!caseIDs.has(extra.id) || catalog.has(extra.id));
		}).map(function(extra): string {
			return(extra.id);
		});

		expect(extraIDs.size).toBe(CORPUS_EXTRAS.length);
		expect(stale).toEqual([]);
	});

	test('IDs the catalog cites without a row of their own are no catalog IDs, cases or exclusions', async function() {
		const caseIDs = await committedCaseIDs();
		const catalog = new Set(catalogIDs);
		const misused = CITED_WITHOUT_ROWS.filter(function(id): boolean {
			return(catalog.has(id) || caseIDs.has(id) || excludedIDs.has(id) || extraIDs.has(id));
		});

		expect(CITED_WITHOUT_ROWS).not.toEqual([]);
		expect(misused).toEqual([]);
	});
});
