import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { stateDumpViolations } from '../schema.js';
import { STATE_DUMP_FORMAT, firstDifference } from './dump.js';
import type { StateDumpKind } from './dump.js';

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

function isStateDumpKind(kind: unknown): kind is StateDumpKind {
	return(typeof kind === 'string' && Object.hasOwn(SECOND_IMPLEMENTATION_KINDS, kind));
}

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

async function read(file: URL): Promise<string> {
	return(await readFile(file, 'utf8'));
}

describe('the mainnet head state of a second, independent implementation', function() {
	test('equals the golden state, restricted to the kinds it models, byte for byte', async function() {
		const [golden, second] = await Promise.all([read(GOLDEN_FILE), read(SECOND_IMPLEMENTATION_FILE)]);

		expect(firstDifference(restrictedToComparedKinds(golden), second)).toBeNull();
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
