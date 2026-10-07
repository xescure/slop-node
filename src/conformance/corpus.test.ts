import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { driversUnderTest } from '../ledger/storage/suite/drivers.js';
import { VOTE_CASE_FORMAT, decodeVoteCaseFile, encodeVoteCaseFile } from './case.js';
import type { VoteCase } from './case.js';
import { EXCLUDED_ROWS } from './exclusions.js';
import type { Scenario } from './record.js';
import { replayVoteCase } from './replay.js';
import type { ReplayFailure } from './replay.js';
import { voteCaseViolations } from './schema.js';
import { balanceScenarios } from './scenarios/balances.js';
import { clockScenarios } from './scenarios/clock.js';
import { conflictScenarios } from './scenarios/conflicts.js';
import { feeScenarios } from './scenarios/fees.js';
import { kindScenarios } from './scenarios/kind.js';
import { modeScenarios } from './scenarios/modes.js';
import { networkScenarios } from './scenarios/network.js';
import { permissionScenarios } from './scenarios/permissions.js';
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
	{ name: 'conflicts', scenarios: conflictScenarios },
	{ name: 'balances', scenarios: balanceScenarios },
	{ name: 'permissions', scenarios: permissionScenarios },
	{ name: 'fees', scenarios: feeScenarios },
	{ name: 'network', scenarios: networkScenarios },
	{ name: 'modes', scenarios: modeScenarios }
];

const UPDATE = process.env['SLOP_NODE_UPDATE_CONFORMANCE'] === '1';

/*
 * A group replays its cases one after another, each on storage of its own.
 * On Postgres that is a database copied from the template and dropped
 * afterwards, and the slowest group, fees, with 31 cases on 80 databases,
 * took 4.0 to 4.6 s while make -j8 ran the other tests and the linters
 * beside it, close to the default timeout of 5 s. This leaves room for a
 * machine several times slower.
 */
const REPLAY_TIMEOUT_MILLISECONDS = 30_000;

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

			expect(voteCaseViolations(JSON.parse(text))).toEqual([]);
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

	test('each excluded row is listed once, with a reason', function() {
		const excludedIDs = EXCLUDED_ROWS.map(function(row): string {
			return(row.id);
		});

		expect(new Set(excludedIDs).size).toBe(excludedIDs.length);
		for (const row of EXCLUDED_ROWS) {
			expect(row.reason).not.toBe('');
		}
	});

	test('every committed file belongs to a group', async function() {
		const names = groups.map(function(group): string {
			return(`${group.name}.json`);
		}).sort();
		expect((await readdir(CORPUS_DIRECTORY)).sort()).toEqual(names);
	});

	describe.each(driversUnderTest)('replay on the $name driver', function(driver) {
		/** Replays one case on fresh storage, released before the next case, so a driver backed by a database holds one case's storage at a time. */
		async function replayOnDriver(voteCase: VoteCase): Promise<readonly ReplayFailure[]> {
			const created: LedgerStorageDriverBase[] = [];
			try {
				return(await replayVoteCase(voteCase, async function() {
					const storage = await driver.create();
					created.push(storage);
					return(storage);
				}));
			} finally {
				for (const storage of created) {
					await driver.destroy(storage);
				}
			}
		}

		test.each(groups)('the committed $name cases replay from their data alone', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function(group) {
			const { cases } = decodeVoteCaseFile(await readCommitted(group));
			const failures: ReplayFailure[] = [];
			for (const voteCase of cases) {
				failures.push(...await replayOnDriver(voteCase));
			}

			expect(failures).toEqual([]);
		});
	});
});
