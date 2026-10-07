import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { assertNever } from '../../util/assert-never.js';
import { stateDumpViolations } from '../schema.js';
import { STATE_DUMP_FORMAT, firstDifference, isStateDumpKind } from './dump.js';
import type { StateDumpKind } from './dump.js';
import { EDGE_CASE_OUTCOMES } from './edge-cases.js';
import { loadMainnetFixture } from './fixture.js';
import { REFERENCE_DRIVER_NAME, REPLAY_TIMEOUT_MILLISECONDS, describeHeadReplay } from './head-replay.js';
import { compareText } from './replay.js';
import { SHADOW_REFUSAL_REASONS } from './shadow.js';

/*
 * The reference driver's replay also writes the committed files under make
 * conformance, so the checks that read only those files, and the second
 * replay that shows a replay is deterministic, run beside it.
 */

const STATE_DUMP_DOCUMENT = new URL('../../../conformance/STATE-DUMP.md', import.meta.url);

const MAINNET_DOCUMENT = new URL('../../../conformance/MAINNET.md', import.meta.url);

/** The fields that identify a record of each kind, in the order they sort by. */
const RECORD_KEYS = {
	account: ['account'],
	acl: ['principalType', 'principal', 'certificate', 'entity', 'target'],
	balance: ['account', 'token'],
	certificate: ['account', 'hash'],
	checksum: [],
	head: ['account'],
	idempotent: ['account', 'key'],
	supply: ['token'],
	weight: ['representative']
} as const satisfies Record<StateDumpKind, readonly string[]>;

type ParsedRecord = { readonly kind: StateDumpKind; readonly line: string; readonly key: readonly string[] };

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

const replays = describeHeadReplay(REFERENCE_DRIVER_NAME);

describe('the mainnet head state', function() {
	test(`a second replay on the ${REFERENCE_DRIVER_NAME} driver, without shadow votes, dumps the same state`, { timeout: 2 * REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const first = await replays.shared();
		const second = await replays.withoutVoting();

		expect(firstDifference(first.dump, second.dump)).toBeNull();
	});

	test('the golden file is valid under the schema, and its records are in key order with unique keys', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const dump = await replays.committedGolden();
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
		const records = recordLinesOf(await replays.committedGolden()).map(parseRecord);
		const document = await readFile(STATE_DUMP_DOCUMENT, 'utf8');

		for (const kind of Object.keys(RECORD_KEYS).filter(isStateDumpKind)) {
			const count = records.filter(function(record): boolean {
				return(record.kind === kind);
			}).length;
			expect(document).toContain(`| \`${kind}\` | ${count.toLocaleString('en-US')} |`);
		}
	});

	test('MAINNET.md states the staple count of each edge-case outcome', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const outcomes = await replays.committedEdgeCaseOutcomes();
		const document = await readFile(MAINNET_DOCUMENT, 'utf8');

		for (const outcome of EDGE_CASE_OUTCOMES) {
			const count = outcomes.split(`"outcome": ${JSON.stringify(outcome)}`).length - 1;
			expect(document).toContain(`| \`${outcome}\` | ${count.toLocaleString('en-US')} |`);
		}
	});

	test('MAINNET.md states how many deferred edge cases wait only on blocks in neither file, and how many only on other edge cases', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { edgeCases } = await replays.shared();
		const edgeCaseBlocks = new Set((await loadMainnetFixture('edge-cases')).flatMap(function(staple): string[] {
			return(staple.blocks.map(function(block): string {
				return(block.hash.toString());
			}));
		}));
		const waits = edgeCases.flatMap(function(result): (readonly string[])[] {
			switch (result.outcome) {
				case 'deferred':
					return([result.waitingOn]);
				case 'applied':
				case 'refused':
					return([]);
				default:
					return(assertNever(result));
			}
		});
		const onEdgeCasesOnly = waits.filter(function(waitingOn): boolean {
			return(waitingOn.every(function(hash): boolean {
				return(edgeCaseBlocks.has(hash));
			}));
		}).length;
		const outsideOnly = waits.filter(function(waitingOn): boolean {
			return(!waitingOn.some(function(hash): boolean {
				return(edgeCaseBlocks.has(hash));
			}));
		}).length;
		const document = await readFile(MAINNET_DOCUMENT, 'utf8');

		expect(onEdgeCasesOnly + outsideOnly).toBe(waits.length);
		expect(document).toContain(`Of the deferred staples, ${String(outsideOnly)} wait only on blocks that are in neither file`);
		expect(document).toContain(`The other ${String(onEdgeCasesOnly)} wait only on blocks of other edge-case staples`);
	});

	test('MAINNET.md states the staple count of each reason in the shadow-vote exceptions', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const exceptions = await replays.committedExceptions();
		const document = await readFile(MAINNET_DOCUMENT, 'utf8');

		for (const reason of SHADOW_REFUSAL_REASONS) {
			const count = exceptions.split(`"reason": ${JSON.stringify(reason)}`).length - 1;
			expect(document).toContain(`| \`${reason}\` | ${count.toLocaleString('en-US')} |`);
		}
	});
});
