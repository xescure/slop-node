import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { stateDumpViolations } from '../schema.js';
import { STATE_DUMP_FORMAT, firstDifference, isStateDumpKind } from './dump.js';
import type { LineDifference, StateDumpKind } from './dump.js';

/*
 * conformance/mainnet/head.rust-mirror.jsonl is the state that a second,
 * independent implementation reaches from the same staples
 * (conformance/MAINNET.md section 8). It is committed data: this test reads
 * it and never builds or runs that implementation.
 */

const GOLDEN_FILE = new URL('../../../conformance/mainnet/head.state.jsonl', import.meta.url);

const SECOND_IMPLEMENTATION_FILE = new URL('../../../conformance/mainnet/head.rust-mirror.jsonl', import.meta.url);

/** Whether the second implementation writes each kind, with every field of it, or does not model it at all. */
const SECOND_IMPLEMENTATION_KINDS = {
	account: 'compared',
	acl: 'compared',
	balance: 'compared',
	certificate: 'compared',
	checksum: 'compared',
	head: 'compared',
	idempotent: 'not modelled',
	supply: 'compared',
	weight: 'compared'
} as const satisfies Record<StateDumpKind, 'compared' | 'not modelled'>;

function isComparedKind(kind: unknown): boolean {
	return(isStateDumpKind(kind) && SECOND_IMPLEMENTATION_KINDS[kind] === 'compared');
}

function kindOf(line: string): unknown {
	return(Reflect.get(Object(JSON.parse(line)), 'kind'));
}

/** The dump without the records of kinds the second implementation does not model; the format line stays. */
function restrictedToComparedKinds(dump: string): string {
	const [format, ...rest] = dump.split('\n');
	const records = rest.slice(0, -1).filter(function(line): boolean {
		return(isComparedKind(kindOf(line)));
	});
	return([format, ...records, ''].join('\n'));
}

/*
 * Nothing here regenerates the second implementation's file, so a difference
 * after a deliberate change to the golden state is a disagreement to resolve
 * on that implementation's side, never by editing its file.
 */
function disagreement(difference: LineDifference | null): string {
	if (difference === null) {
		return('');
	}
	return([
		`conformance/mainnet/head.rust-mirror.jsonl differs from head.state.jsonl at line ${String(difference.line)}.`,
		'That file is a second, independent implementation\'s dump (conformance/MAINNET.md section 8), and make conformance does not regenerate it.',
		'If head.state.jsonl changed on purpose, the shown line is an open disagreement between the two implementations until that implementation\'s maintainers regenerate and commit their dump.',
		'Do not edit or delete the file to make this pass.'
	].join(' '));
}

async function read(file: URL): Promise<string> {
	return(await readFile(file, 'utf8'));
}

describe('the mainnet head state of a second, independent implementation', function() {
	test('equals the golden state, restricted to the kinds it models, byte for byte', async function() {
		const [golden, second] = await Promise.all([read(GOLDEN_FILE), read(SECOND_IMPLEMENTATION_FILE)]);
		const difference = firstDifference(restrictedToComparedKinds(golden), second);

		expect(difference, disagreement(difference)).toBeNull();
	});

	test('is a state dump of only the kinds it models, each line valid under the schema', async function() {
		const lines = (await read(SECOND_IMPLEMENTATION_FILE)).split('\n');

		expect(lines[0]).toBe(JSON.stringify({ format: STATE_DUMP_FORMAT }));
		expect(lines.at(-1)).toBe('');
		for (const line of lines.slice(0, -1)) {
			expect(stateDumpViolations(JSON.parse(line))).toEqual([]);
		}
		expect(lines.slice(1, -1).filter(function(line): boolean {
			return(!isComparedKind(kindOf(line)));
		})).toEqual([]);
	});
});
