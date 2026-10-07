import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, test } from 'vitest';
import type { LedgerStorageDriverBase } from '../../ledger/storage/base.js';
import { driversUnderTest } from '../../ledger/storage/suite/drivers.js';
import type { DriverUnderTest } from '../../ledger/storage/suite/types.js';
import { stateDumpViolations } from '../schema.js';
import { STATE_DUMP_FORMAT, renderReplayStateDump } from './dump.js';
import type { StateDumpKind } from './dump.js';
import { loadMainnetFixture } from './fixture.js';
import { compareText, replayMainnet } from './replay.js';
import type { ReplayResult } from './replay.js';

/*
 * One replay of the head per driver serves every assertion about it, so the
 * test time does not grow with each property checked. The committed golden
 * file must equal what the reference driver's replay dumps now; with
 * SLOP_NODE_UPDATE_CONFORMANCE=1 it is written instead.
 */

const UPDATE = process.env['SLOP_NODE_UPDATE_CONFORMANCE'] === '1';

const REFERENCE_DRIVER_NAME = 'memory';

const HEAD_LEDGER_CHECKSUM = 0xc4896d171cb02d3c9cd929de064de0df788d100c20cb8260cc0072017c130a3an;

const GOLDEN_FILE = new URL('../../../conformance/mainnet/head.state.jsonl', import.meta.url);

const STATE_DUMP_DOCUMENT = new URL('../../../conformance/STATE-DUMP.md', import.meta.url);

/*
 * One replay of the head with its dump took 10 s on the memory driver,
 * parsing the head included, and 25 s on Postgres on an idle machine; while
 * make -j8 ran the other tests and the linters beside it, 19 s and 29 s. The
 * dump alone took 0.3 s and 2.4 s. The limit is about eight times the slowest,
 * so it leaves room for a machine several times slower.
 */
const REPLAY_TIMEOUT_MILLISECONDS = 240_000;

/** The fields that identify a record of each kind, in the order they sort by. */
const RECORD_KEYS = {
	account: ['account'],
	acl: ['principalType', 'principal', 'certificate', 'entity', 'target'],
	balance: ['account', 'token'],
	certificate: ['account', 'hash'],
	checksum: [],
	head: ['account'],
	supply: ['token'],
	weight: ['representative']
} as const satisfies Record<StateDumpKind, readonly string[]>;

type HeadReplay = {
	readonly result: ReplayResult;
	readonly dump: string;
};

const opened: { readonly driver: DriverUnderTest; readonly storage: LedgerStorageDriverBase }[] = [];

afterAll(async function() {
	for (const { driver, storage } of opened.splice(0)) {
		await driver.destroy(storage);
	}
});

async function replayHead(driver: DriverUnderTest): Promise<HeadReplay> {
	const storage = await driver.create();
	opened.push({ driver, storage });
	const result = await replayMainnet(storage, await loadMainnetFixture('head'));
	return({ result, dump: await renderReplayStateDump(result) });
}

const sharedReplays = new Map<string, Promise<HeadReplay>>();

function sharedReplay(driver: DriverUnderTest): Promise<HeadReplay> {
	const replay = sharedReplays.get(driver.name) ?? replayHead(driver);
	sharedReplays.set(driver.name, replay);
	return(replay);
}

function driverNamed(name: string): DriverUnderTest {
	const driver = driversUnderTest.find(function(candidate): boolean {
		return(candidate.name === name);
	});
	if (driver === undefined) {
		throw(new Error(`the ${name} driver is not under test`));
	}
	return(driver);
}

async function readGolden(): Promise<string> {
	if (UPDATE) {
		await writeFile(GOLDEN_FILE, (await sharedReplay(driverNamed(REFERENCE_DRIVER_NAME))).dump);
	}
	try {
		return(await readFile(GOLDEN_FILE, 'utf8'));
	} catch (error: unknown) {
		throw(new Error('cannot read the committed mainnet head state; run make conformance', { cause: error }));
	}
}

let golden: Promise<string> | undefined;

function committedGolden(): Promise<string> {
	golden ??= readGolden();
	return(golden);
}

type LineDifference = { readonly line: number; readonly expected: string | undefined; readonly actual: string | undefined };

/** The first line where two dumps differ, so a failure names one record instead of printing megabytes. */
function firstDifference(expected: string, actual: string): LineDifference | null {
	const expectedLines = expected.split('\n');
	const actualLines = actual.split('\n');
	for (let index = 0; index < Math.max(expectedLines.length, actualLines.length); index++) {
		if (expectedLines[index] !== actualLines[index]) {
			return({ line: index + 1, expected: expectedLines[index], actual: actualLines[index] });
		}
	}
	return(null);
}

type ParsedRecord = { readonly kind: StateDumpKind; readonly line: string; readonly key: readonly string[] };

function isStateDumpKind(kind: unknown): kind is StateDumpKind {
	return(typeof kind === 'string' && Object.hasOwn(RECORD_KEYS, kind));
}

function parseRecord(line: string): ParsedRecord {
	const record: unknown = JSON.parse(line);
	const kind: unknown = Reflect.get(Object(record), 'kind');
	if (!isStateDumpKind(kind)) {
		throw(new Error(`not a record: ${line}`));
	}
	const key = [kind, ...RECORD_KEYS[kind].map(function(field): string {
		return(String(Reflect.get(Object(record), field) ?? ''));
	})];
	return({ kind, line, key });
}

function compareKeys(left: readonly string[], right: readonly string[]): number {
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const order = compareText(left[index] ?? '', right[index] ?? '');
		if (order !== 0) {
			return(order);
		}
	}
	return(left.length - right.length);
}

function recordLinesOf(dump: string): string[] {
	return(dump.split('\n').slice(1, -1));
}

describe.each(driversUnderTest)('the mainnet head replayed on the $name driver', function(driver) {
	test('every staple applies and none stays deferred', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { result } = await sharedReplay(driver);

		expect(result.deferred).toEqual([]);
		expect(result.applied).toBe((await loadMainnetFixture('head')).length);
	});

	test('the ledger checksum is the pinned value', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { result } = await sharedReplay(driver);

		expect(result.ledgerChecksum).toBe(HEAD_LEDGER_CHECKSUM);
	});

	test('the state dump equals the committed golden file', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { dump } = await sharedReplay(driver);

		expect(firstDifference(await committedGolden(), dump)).toBeNull();
	});
});

describe('the mainnet head state', function() {
	const reference = driverNamed(REFERENCE_DRIVER_NAME);
	const others = driversUnderTest.filter(function(driver): boolean {
		return(driver !== reference);
	});

	test.each(others)(`the $name dump is byte-identical to the ${REFERENCE_DRIVER_NAME} dump`, { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function(driver) {
		const [expected, actual] = await Promise.all([sharedReplay(reference), sharedReplay(driver)]);

		expect(firstDifference(expected.dump, actual.dump)).toBeNull();
	});

	test(`a second replay on the ${REFERENCE_DRIVER_NAME} driver dumps the same state`, { timeout: 2 * REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const first = await sharedReplay(reference);
		const second = await replayHead(reference);

		expect(firstDifference(first.dump, second.dump)).toBeNull();
	});

	test('the golden file is valid under the schema, and its records are in key order with unique keys', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const dump = await committedGolden();
		const lines = dump.split('\n');
		const records = recordLinesOf(dump).map(parseRecord);

		expect(lines[0]).toBe(JSON.stringify({ format: STATE_DUMP_FORMAT }));
		expect(lines.at(-1)).toBe('');
		for (const line of lines.slice(0, -1)) {
			expect(stateDumpViolations(JSON.parse(line))).toEqual([]);
		}
		expect(records.map(function(record): string {
			return(record.line);
		})).toEqual([...records].sort(function(left, right): number {
			return(compareKeys(left.key, right.key));
		}).map(function(record): string {
			return(record.line);
		}));
		expect(new Set(records.map(function(record): string {
			return(JSON.stringify(record.key));
		})).size).toBe(records.length);
	});

	test('STATE-DUMP.md states the record count of each kind in the golden file', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const records = recordLinesOf(await committedGolden()).map(parseRecord);
		const document = await readFile(STATE_DUMP_DOCUMENT, 'utf8');

		for (const kind of Object.keys(RECORD_KEYS).filter(isStateDumpKind)) {
			const count = records.filter(function(record): boolean {
				return(record.kind === kind);
			}).length;
			expect(document).toContain(`| \`${kind}\` | ${count.toLocaleString('en-US')} |`);
		}
	});
});
