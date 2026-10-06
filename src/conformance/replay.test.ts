import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { sendBlock } from '../testing/blocks.js';
import { TEST_NETWORK_SEEDS, createTestNetwork, freezeClock } from '../testing/network.js';
import type { TestNetwork } from '../testing/network.js';
import { toBase64, toCaseBlockHash, toCaseSeed, toDecimal, toMoment } from './case.js';
import type { CaseStep, VoteCase } from './case.js';
import { replayVoteCase } from './replay.js';

const START = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const WEIGHTS = [400n, 300n, 300n];

function createMemory(): Promise<LedgerStorageDriverBase> {
	return(Promise.resolve(new MemoryLedgerStorage()));
}

async function startNetwork(): Promise<TestNetwork> {
	freezeClock(START);
	return(await createTestNetwork({ representativeWeights: WEIGHTS }));
}

function caseOf(steps: readonly CaseStep[]): VoteCase {
	return({
		id: 'R1',
		title: 'a hand-made case',
		network: {
			id: '0',
			seeds: {
				trustedRoot: toCaseSeed(TEST_NETWORK_SEEDS.trustedRoot),
				representative: toCaseSeed(TEST_NETWORK_SEEDS.representative),
				user: toCaseSeed(TEST_NETWORK_SEEDS.user)
			},
			representativeWeights: WEIGHTS.map(toDecimal)
		},
		fee: { type: 'free' },
		mode: 'read-write',
		steps
	});
}

function addGenesis(network: TestNetwork): CaseStep {
	return({ moment: toMoment(START), actor: 0, action: { type: 'add', staple: toBase64(network.genesis.toBytes()) }, expect: { outcome: 'added' } });
}

describe('vote case replay', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('a case that only adds genesis replays without failures', async function() {
		const network = await startNetwork();

		expect(await replayVoteCase(caseOf([addGenesis(network)]), createMemory)).toEqual([]);
	});

	test('an expectation the ledger does not meet is reported with what happened', async function() {
		const network = await startNetwork();
		const expected = { outcome: 'refused', error: { type: 'plain', message: 'never thrown' } } as const;

		const failures = await replayVoteCase(caseOf([{ ...addGenesis(network), expect: expected }]), createMemory);

		expect(failures).toEqual([{ caseID: 'R1', step: 0, expected, actual: '{"outcome":"added"}' }]);
	});

	test('a vote is checked against its blocks and fee, and a refused add against its code', async function() {
		const network = await startNetwork();
		const [user, other] = network.users;
		const head = network.genesis.blocks.filter(function(block): boolean {
			return(user !== undefined && block.account.comparePublicKey(user));
		}).at(-1);
		if (user === undefined || other === undefined || head === undefined) {
			throw(new Error('the network has no users'));
		}
		const send = await sendBlock({ from: user, to: other, amount: 1n, token: network.baseToken, previous: head.hash, network: network.network });
		const vote: CaseStep = {
			moment: toMoment(START),
			actor: 0,
			action: { type: 'vote', blocks: [toBase64(send.toBytes())] },
			expect: { outcome: 'temporary', blocks: [toCaseBlockHash(send.hash)], fee: { type: 'single', amount: toDecimal(0n) } }
		};
		// Once genesis has given the representatives weight, the trusted vote alone no longer suffices.
		const again: CaseStep = { ...addGenesis(network), expect: { outcome: 'refused', error: { type: 'coded', code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT' } } };

		expect(await replayVoteCase(caseOf([addGenesis(network), vote, again]), createMemory)).toEqual([]);

		const wrongFee: CaseStep = { ...vote, expect: { outcome: 'temporary', blocks: [toCaseBlockHash(send.hash)], fee: { type: 'none' } } };
		const failures = await replayVoteCase(caseOf([addGenesis(network), wrongFee]), createMemory);
		expect(failures.map(function(failure) {
			return(failure.step);
		})).toEqual([1]);
	});

	test('a reference to a vote that replay did not produce ends the case', async function() {
		const network = await startNetwork();
		const refused: CaseStep = { moment: toMoment(START), actor: 0, action: { type: 'vote', blocks: [] }, expect: { outcome: 'temporary', blocks: [], fee: { type: 'none' } } };
		const referencing: CaseStep = { moment: toMoment(START), actor: 1, action: { type: 'vote', blocks: [], otherVotes: [{ fromStep: 1 }] }, expect: { outcome: 'refused', error: { type: 'coded', code: 'LEDGER_MISSING_BLOCKS' } } };

		const failures = await replayVoteCase(caseOf([addGenesis(network), refused, referencing, referencing]), createMemory);

		expect(failures).toEqual([
			{ caseID: 'R1', step: 1, expected: refused.expect, actual: '{"outcome":"refused","error":{"type":"coded","code":"LEDGER_MISSING_BLOCKS"}}' },
			{ caseID: 'R1', step: 2, expected: referencing.expect, actual: 'broken: step 1 produced no vote or quote to reference' }
		]);
	});
});
