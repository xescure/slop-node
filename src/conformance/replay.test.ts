import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { sendBlock, setRepresentativeBlock } from '../testing/blocks.js';
import { TEST_NETWORK_SEEDS, createTestNetwork, freezeClock } from '../testing/network.js';
import type { TestNetwork } from '../testing/network.js';
import { toBase64, toCaseBlockHash, toCaseSeed, toDecimal, toMoment } from './case.js';
import type { CaseExpectation, CaseNode, CaseStep, VoteCase } from './case.js';
import { replayVoteCase } from './replay.js';

const START = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const WEIGHTS = [400n, 300n, 300n];
const SEVEN_MINUTES = 7 * 60 * 1000;

const REPRESENTATIVE_NODES: readonly CaseNode[] = [
	{ representative: 0, fee: { type: 'free' }, mode: 'read-write' },
	{ representative: 1, fee: { type: 'free' }, mode: 'read-write' }
];

function createMemory(): Promise<LedgerStorageDriverBase> {
	return(Promise.resolve(new MemoryLedgerStorage()));
}

async function startNetwork(): Promise<TestNetwork> {
	freezeClock(START);
	return(await createTestNetwork({ representativeWeights: WEIGHTS }));
}

function caseOf(steps: readonly CaseStep[], nodes: readonly CaseNode[] = REPRESENTATIVE_NODES): VoteCase {
	return({
		id: 'R1',
		title: 'a hand-made case',
		basis: 'upstream',
		network: {
			id: '0',
			seeds: {
				trustedRoot: toCaseSeed(TEST_NETWORK_SEEDS.trustedRoot),
				representative: toCaseSeed(TEST_NETWORK_SEEDS.representative),
				user: toCaseSeed(TEST_NETWORK_SEEDS.user)
			},
			representativeWeights: WEIGHTS.map(toDecimal)
		},
		nodes,
		steps
	});
}

function at(moment: Date, actor: number, action: CaseStep['action'], expectation: CaseExpectation): CaseStep {
	return({ moment: toMoment(moment), actor, action, expect: expectation });
}

/** Genesis on node 0 literally, and on every other listed node by reference. */
function addGenesis(network: TestNetwork, ...others: readonly number[]): CaseStep[] {
	return([
		at(START, 0, { type: 'add', staple: { type: 'literal', kind: 'staple', bytes: toBase64(network.genesis.toBytes(true)) } }, { outcome: 'added' }),
		...others.map(function(actor): CaseStep {
			return(at(START, actor, { type: 'add', staple: { type: 'step', fromStep: 0 } }, { outcome: 'added' }));
		})
	]);
}

async function firstSend(network: TestNetwork): Promise<Block> {
	const [user, other] = network.users;
	const head = network.genesis.blocks.filter(function(block): boolean {
		return(user !== undefined && block.account.comparePublicKey(user));
	}).at(-1);
	if (user === undefined || other === undefined || head === undefined) {
		throw(new Error('the network has no users'));
	}
	return(await sendBlock({ from: user, to: other, amount: 1n, token: network.baseToken, previous: head.hash, network: network.network }));
}

function temporaryOn(block: Block): CaseExpectation {
	return({ outcome: 'temporary', blocks: [toCaseBlockHash(block.hash)], fee: { type: 'single', amount: toDecimal(0n) } });
}

describe('vote case replay', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('a case that only adds genesis replays without failures', async function() {
		const network = await startNetwork();

		expect(await replayVoteCase(caseOf(addGenesis(network, 1)), createMemory)).toEqual([]);
	});

	test('an expectation the ledger does not meet is reported with what happened', async function() {
		const network = await startNetwork();
		const expected = { outcome: 'refused', error: { type: 'plain', message: 'never thrown' } } as const;
		const [genesis] = addGenesis(network);
		if (genesis === undefined) {
			throw(new Error('no genesis step'));
		}

		const failures = await replayVoteCase(caseOf([{ ...genesis, expect: expected }]), createMemory);

		expect(failures).toEqual([{ caseID: 'R1', step: 0, expected, actual: '{"outcome":"added"}' }]);
	});

	test('a vote is checked against its blocks and fee, and a refused add against its code', async function() {
		const network = await startNetwork();
		const send = await firstSend(network);
		const vote = at(START, 0, { type: 'vote', blocks: [toBase64(send.toBytes())] }, temporaryOn(send));
		// Once genesis has given the representatives weight, the trusted vote alone no longer suffices.
		const again = at(START, 0, { type: 'add', staple: { type: 'step', fromStep: 0 } }, { outcome: 'refused', error: { type: 'coded', code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT' } });

		expect(await replayVoteCase(caseOf([...addGenesis(network), vote, again]), createMemory)).toEqual([]);

		const wrongFee = { ...vote, expect: { ...temporaryOn(send), fee: { type: 'none' } } } as const;
		const failures = await replayVoteCase(caseOf([...addGenesis(network), wrongFee]), createMemory);
		expect(failures.map(function(failure) {
			return(failure.step);
		})).toEqual([1]);
	});

	test('a reference to bytes that replay did not produce ends the case', async function() {
		const network = await startNetwork();
		const refused = at(START, 0, { type: 'vote', blocks: [] }, { outcome: 'temporary', blocks: [], fee: { type: 'none' } });
		const referencing = at(START, 1, { type: 'vote', blocks: [], otherVotes: [{ type: 'step', fromStep: 1 }] }, { outcome: 'refused', error: { type: 'coded', code: 'LEDGER_MISSING_BLOCKS' } });

		const failures = await replayVoteCase(caseOf([...addGenesis(network), refused, referencing, referencing]), createMemory);

		expect(failures).toEqual([
			{ caseID: 'R1', step: 1, expected: refused.expect, actual: '{"outcome":"refused","error":{"type":"coded","code":"LEDGER_MISSING_BLOCKS"}}' },
			{ caseID: 'R1', step: 2, expected: referencing.expect, actual: 'broken: step 1 offers no bytes to reference' }
		]);
	});

	test('a quote among the other votes is refused the same way by reference and as literal bytes', async function() {
		const network = await startNetwork();
		const send = await firstSend(network);
		const quoteBytes = await quoteBytesOutsideCase(network, send);
		const blocks = [toBase64(send.toBytes())];
		const refused: CaseExpectation = { outcome: 'refused', error: { type: 'coded', code: 'LEDGER_VOTE_WITH_QUOTE' } };
		const steps = [
			...addGenesis(network, 1),
			at(START, 1, { type: 'quote', blocks }, { outcome: 'quote', blocks: [toCaseBlockHash(send.hash)], fee: { type: 'single', amount: toDecimal(0n) } }),
			at(START, 0, { type: 'vote', blocks }, temporaryOn(send)),
			at(START, 0, { type: 'vote', blocks, otherVotes: [{ type: 'step', fromStep: 3 }, { type: 'step', fromStep: 2 }] }, refused),
			at(START, 0, { type: 'vote', blocks, otherVotes: [{ type: 'step', fromStep: 3 }, { type: 'literal', kind: 'quote', bytes: quoteBytes }] }, refused)
		];

		expect(await replayVoteCase(caseOf(steps), createMemory)).toEqual([]);
	});

	test('bytes parse as the kind they are given, at the moment of the step that references them', async function() {
		const network = await startNetwork();
		const send = await firstSend(network);
		const blocks = [toBase64(send.toBytes())];
		const later = new Date(START.getTime() + SEVEN_MINUTES);
		const steps = [
			...addGenesis(network, 1),
			at(START, 1, { type: 'quote', blocks }, { outcome: 'quote', blocks: [toCaseBlockHash(send.hash)], fee: { type: 'single', amount: toDecimal(0n) } }),
			at(START, 0, { type: 'vote', blocks }, temporaryOn(send))
		];
		const quoteBytes = await quoteBytesOutsideCase(network, send);

		const failures = await replayVoteCase(caseOf([
			...steps,
			// A quote's bytes offered as a vote are parsed as a vote.
			at(START, 0, { type: 'vote', blocks, otherVotes: [{ type: 'literal', kind: 'vote', bytes: quoteBytes }] }, { outcome: 'rejectedInput', error: { type: 'coded', code: 'VOTE_MALFORMED_FEES_QUOTE_INVALID' } }),
			// Seven minutes on, the temporary vote of step 3 no longer parses.
			at(later, 1, { type: 'vote', blocks, otherVotes: [{ type: 'step', fromStep: 3 }] }, { outcome: 'rejectedInput', error: { type: 'coded', code: 'VOTE_EXPIRED' } })
		]), createMemory);

		expect(failures).toEqual([]);
	});

	// Upstream throws a plain Error inside the ledger transaction; the driver's LEDGER_OTHER wrapping is unwrapped.
	test('a node without a representative adds staples but refuses to vote', async function() {
		const network = await startNetwork();
		const send = await firstSend(network);
		const accountNode: CaseNode = { representative: null, fee: { type: 'free' }, mode: 'read-write' };
		const steps = [
			...addGenesis(network),
			at(START, 0, { type: 'vote', blocks: [toBase64(send.toBytes())] }, { outcome: 'refused', error: { type: 'plain', message: 'Cannot vote on block, no private key loaded' } })
		];

		expect(await replayVoteCase(caseOf(steps, [accountNode]), createMemory)).toEqual([]);
	});

	test('each node\'s fee choices, subnet and operations reach its own ledger', async function() {
		const network = await startNetwork();
		const send = await firstSend(network);
		const [user, , other] = network.users;
		if (user === undefined || other === undefined) {
			throw(new Error('the network has no users'));
		}
		const delegation = await setRepresentativeBlock({ account: user, representative: other, previous: send.hash, network: network.network });
		const choices = [{ amount: toDecimal(0n) }, { amount: toDecimal(5n) }];
		const nodes: readonly CaseNode[] = [
			{ representative: 0, fee: { type: 'choices', choices }, mode: 'read-write', operations: { setRep: 'refuseAll' } },
			{ representative: 1, fee: { type: 'free' }, mode: 'read-write', subnet: toDecimal(5n) }
		];
		const steps = [
			...addGenesis(network),
			at(START, 0, { type: 'vote', blocks: [toBase64(send.toBytes()), toBase64(delegation.toBytes())] }, { outcome: 'refused', error: { type: 'coded', code: 'LEDGER_INVALID_SET_REP' } }),
			at(START, 0, { type: 'vote', blocks: [toBase64(send.toBytes())] }, { outcome: 'temporary', blocks: [toCaseBlockHash(send.hash)], fee: { type: 'choices', choices } }),
			at(START, 1, { type: 'add', staple: { type: 'step', fromStep: 0 } }, { outcome: 'refused', error: { type: 'plain', message: 'Cannot process block for a different subnet' } })
		];

		expect(await replayVoteCase(caseOf(steps, nodes), createMemory)).toEqual([]);
	});
});

/** A quote by representative 1 on the block, made outside any case. */
async function quoteBytesOutsideCase(network: TestNetwork, block: Block): Promise<ReturnType<typeof toBase64>> {
	const representative = network.representatives[1];
	if (representative === undefined) {
		throw(new Error('the network has no second representative'));
	}
	const ledger = network.createLedger(new MemoryLedgerStorage(), representative);
	await ledger.add(network.genesis);
	return(toBase64((await ledger.quote([block])).toBytes()));
}
