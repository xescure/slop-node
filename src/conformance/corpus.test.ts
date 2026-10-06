import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { driversUnderTest } from '../ledger/storage/suite/drivers.js';
import { VOTE_CASE_FORMAT, decodeVoteCaseFile, encodeVoteCaseFile } from './case.js';
import type { VoteCase } from './case.js';
import type { Scenario } from './record.js';
import { replayVoteCase } from './replay.js';
import type { ReplayFailure } from './replay.js';
import { schemaViolations } from './schema.js';
import { clockScenarios } from './scenarios/clock.js';
import { conflictScenarios } from './scenarios/conflicts.js';
import { kindScenarios } from './scenarios/kind.js';
import { quorumScenarios } from './scenarios/quorum.js';

/*
 * The committed corpus must equal what upstream's ledger produces now, so an
 * upgrade that changes a decision fails here until the corpus is regenerated
 * and the difference reviewed. With SLOP_NODE_UPDATE_CONFORMANCE=1 the files
 * are written instead.
 */

type Group = {
	readonly name: string;
	readonly scenarios: readonly Scenario[];
};

const groups: readonly Group[] = [
	{ name: 'kind', scenarios: kindScenarios },
	{ name: 'quorum', scenarios: quorumScenarios },
	{ name: 'clock', scenarios: clockScenarios },
	{ name: 'conflicts', scenarios: conflictScenarios }
];

const UPDATE = process.env['SLOP_NODE_UPDATE_CONFORMANCE'] === '1';

const CORPUS_DIRECTORY = new URL('../../conformance/vote-cases/', import.meta.url);

function fileOf(group: Group): URL {
	return(new URL(`${group.name}.json`, CORPUS_DIRECTORY));
}

async function upstreamVersion(): Promise<string> {
	const manifestPath = createRequire(import.meta.url).resolve('@keetanetwork/keetanet-client/package.json');
	const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
	const version: unknown = Reflect.get(Object(manifest), 'version');
	if (typeof version !== 'string') {
		throw(new Error('the keetanet-client manifest has no version'));
	}
	return(version);
}

function createMemory(): Promise<LedgerStorageDriverBase> {
	return(Promise.resolve(new MemoryLedgerStorage()));
}

/** Generation always runs on the memory driver, the reference. */
async function generate(group: Group): Promise<string> {
	const cases: VoteCase[] = [];
	for (const scenario of group.scenarios) {
		cases.push(await scenario.build({ createDriver: createMemory }));
	}
	vi.useRealTimers();
	return(encodeVoteCaseFile({ format: VOTE_CASE_FORMAT, keetanetClient: await upstreamVersion(), cases }));
}

async function readCommitted(group: Group): Promise<string> {
	try {
		return(await readFile(fileOf(group), 'utf8'));
	} catch (error: unknown) {
		throw(new Error(`cannot read the committed ${group.name} cases; run make conformance`, { cause: error }));
	}
}

describe('vote-decision corpus', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	describe.each(groups)('$name cases', function(group) {
		test('the committed file equals a fresh generation', async function() {
			const generated = await generate(group);
			if (UPDATE) {
				await mkdir(CORPUS_DIRECTORY, { recursive: true });
				await writeFile(fileOf(group), generated);
			}
			expect(await readCommitted(group)).toBe(generated);
		});

		test('two generations are byte-identical', async function() {
			expect(await generate(group)).toBe(await generate(group));
		});

		test('the committed file is valid under the schema and decodes', async function() {
			const text = await readCommitted(group);

			expect(schemaViolations(JSON.parse(text))).toEqual([]);
			expect(encodeVoteCaseFile(decodeVoteCaseFile(text))).toBe(text);
		});
	});

	test('case IDs are unique across every group, in the scenarios and in the committed files', async function() {
		const scenarioIDs = groups.flatMap(function(group): string[] {
			return(group.scenarios.map(function(scenario): string {
				return(scenario.id);
			}));
		});
		const committedIDs: string[] = [];
		for (const group of groups) {
			for (const voteCase of decodeVoteCaseFile(await readCommitted(group)).cases) {
				committedIDs.push(voteCase.id);
			}
		}

		expect(new Set(scenarioIDs).size).toBe(scenarioIDs.length);
		expect(new Set(committedIDs).size).toBe(committedIDs.length);
	});

	test('every committed file belongs to a group', async function() {
		const names = groups.map(function(group): string {
			return(`${group.name}.json`);
		}).sort();
		expect((await readdir(CORPUS_DIRECTORY)).sort()).toEqual(names);
	});

	describe.each(driversUnderTest)('replay on the $name driver', function(driver) {
		test.each(groups)('the committed $name cases replay from their data alone', async function(group) {
			const { cases } = decodeVoteCaseFile(await readCommitted(group));
			const created: LedgerStorageDriverBase[] = [];
			const failures: ReplayFailure[] = [];
			try {
				for (const voteCase of cases) {
					failures.push(...await replayVoteCase(voteCase, async function() {
						const storage = await driver.create();
						created.push(storage);
						return(storage);
					}));
				}
			} finally {
				for (const storage of created) {
					await driver.destroy(storage);
				}
			}

			expect(failures).toEqual([]);
		});
	});
});
