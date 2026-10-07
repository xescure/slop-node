import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPOSITORY = new URL('../../../', import.meta.url);

/** Where SQL lives; each must exist and hold at least one file, so the scan is never vacuous. */
const REQUIRED_ROOTS = ['schema/migrations/', 'src/ledger/storage/postgres/'] as const;

/** Scanned once it exists. */
const OPTIONAL_ROOTS = ['src/kv/'] as const;

/*
 * Every way SQL can read the database server's clock: the functions, the
 * SQL-standard keywords, and the special input strings. JavaScript's Date.now
 * is the caller's clock, which is the one the schema is meant to use.
 */
const DATABASE_CLOCK = new RegExp([
	String.raw`(?<!Date\.)\bnow\s*\(`,
	String.raw`\b(?:current_timestamp|current_time|current_date|localtimestamp|localtime)\b`,
	String.raw`\b(?:clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\b`,
	String.raw`'(?:now|today|tomorrow|yesterday)'`
].join('|'), 'i');

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

const offendingLines = async function(file: string): Promise<string[]> {
	const content = await readFile(new URL(file, REPOSITORY), 'utf-8');
	return(content.split('\n').flatMap(function(line, index) {
		if (DATABASE_CLOCK.test(line)) {
			return([`${file}:${String(index + 1)}: ${line.trim()}`]);
		}
		return([]);
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
			'SELECT \'today\'::date'
		];
		const allowed = [
			'const moment = Date.now();',
			'SELECT current_database()',
			'applied_at timestamptz NOT NULL',
			'nowhere'
		];

		expect(forbidden.filter(function(line) {
			return(!DATABASE_CLOCK.test(line));
		})).toEqual([]);
		expect(allowed.filter(function(line) {
			return(DATABASE_CLOCK.test(line));
		})).toEqual([]);
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

		const offending = (await Promise.all(files.map(offendingLines))).flat();
		expect(offending).toEqual([]);
	});
});
