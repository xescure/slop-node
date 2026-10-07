import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPOSITORY = new URL('../../../', import.meta.url);

/** Where SQL lives; each must exist and hold at least one file, so the scan is never vacuous. */
const REQUIRED_ROOTS = ['schema/migrations/', 'src/ledger/storage/postgres/'] as const;

/** Scanned once it exists. */
const OPTIONAL_ROOTS = ['src/kv/'] as const;

// Whitespace and comments may separate a function name from its parenthesis.
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|--[^\n]*(?:\n|$))*`;

/*
 * Every way SQL can read the database server's clock: the functions, quoted
 * or not, the SQL-standard keywords, the special input strings, and age,
 * whose one-argument form measures from the current date. JavaScript's
 * Date.now is the caller's clock, which is the one the schema is meant to use.
 */
const DATABASE_CLOCK = new RegExp([
	String.raw`(?<![\w$])(?<!Date\.)(?:now|"now")${GAP}\(`,
	String.raw`(?<![\w$])(?:age|"age")${GAP}\(`,
	String.raw`\b(?:current_timestamp|current_time|current_date|localtimestamp|localtime)\b`,
	String.raw`(?<![\w$])(?:clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\b`,
	String.raw`'(?:now|today|tomorrow|yesterday)'`
].join('|'), 'gi');

const matchesClock = function(text: string): boolean {
	return(Array.from(text.matchAll(DATABASE_CLOCK)).length > 0);
};

const exists = async function(root: URL): Promise<boolean> {
	try {
		return((await stat(root)).isDirectory());
	} catch {
		return(false);
	}
};

const filesUnder = async function(root: string): Promise<string[]> {
	const entries = await readdir(new URL(root, REPOSITORY), { recursive: true, withFileTypes: true });
	return(entries.filter(function(entry) {
		return(entry.isFile());
	}).map(function(entry) {
		return(relative(fileURLToPath(REPOSITORY), join(entry.parentPath, entry.name)));
	}));
};

const lineOf = function(content: string, index: number): number {
	return(content.slice(0, index).split('\n').length);
};

// The whole file is scanned at once, so a call split across lines is still seen.
const offenses = async function(file: string): Promise<string[]> {
	const content = await readFile(new URL(file, REPOSITORY), 'utf-8');
	return(Array.from(content.matchAll(DATABASE_CLOCK), function(match) {
		return(`${file}:${String(lineOf(content, match.index))}: ${match[0].replace(/\s+/g, ' ')}`);
	}));
};

describe('the database clock', function() {
	test('the scan recognizes every form of the database clock', function() {
		const forbidden = [
			'SELECT now()',
			'SELECT pg_catalog.NOW ()',
			'DEFAULT CURRENT_TIMESTAMP',
			'SELECT current_time, current_date, localtime, localtimestamp',
			'SELECT clock_timestamp(), statement_timestamp(), transaction_timestamp(), timeofday()',
			'SELECT \'now\'::timestamptz',
			'SELECT \'today\'::date',
			'SELECT now/**/()',
			'SELECT now\n\t()',
			'SELECT now -- the clock\n()',
			'SELECT "now"()',
			'SELECT pg_catalog."now" ()',
			'SELECT age(applied_at)',
			'SELECT AGE (\n\tapplied_at)'
		];
		const allowed = [
			'const moment = Date.now();',
			'SELECT current_database()',
			'applied_at timestamptz NOT NULL',
			'nowhere',
			'storage(usage(1))',
			'known(1)'
		];

		expect(forbidden.filter(function(text) {
			return(!matchesClock(text));
		})).toEqual([]);
		expect(allowed.filter(matchesClock)).toEqual([]);
	});

	test('no SQL uses the database clock', async function() {
		const optional: string[] = [];
		for (const root of OPTIONAL_ROOTS) {
			if (await exists(new URL(root, REPOSITORY))) {
				optional.push(root);
			}
		}

		const files: string[] = [];
		for (const root of REQUIRED_ROOTS) {
			const found = await filesUnder(root);
			expect(found, root).not.toEqual([]);
			files.push(...found);
		}
		for (const root of optional) {
			files.push(...await filesUnder(root));
		}

		const offending = (await Promise.all(files.map(offenses))).flat();
		expect(offending).toEqual([]);
	});
});
