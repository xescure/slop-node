import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { DEFAULT_WEIGHTS, GENESIS_MOMENT, headOf, requireAt } from '../ledger/storage/suite/support.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { createTestNetwork, freezeClock } from '../testing/network.js';
import type { TestNetwork } from '../testing/network.js';
import { admittedWithoutQuorum } from './admitted-staples.js';
import type { AdmitWithoutQuorum } from './admitted-staples.js';
import { getConfigFromEnv, localNodeConfig } from './config.js';

const lib = KeetaNet.lib;

const SEED = '0000000000000000000000000000000000000000000000000000000000000001';

const TEST_NETWORK = { kind: 'known', alias: 'test', network: 0x54455354n } as const;

/*
 * Staples of Keeta's test network, as GET /node/ledger/history of
 * rep1.test.network.api.keeta.com listed them on 2026-10-23, oldest first:
 * the delegation, voted by keeta_aabf7dz5... alone, that gave
 * keeta_aabmh4q7... more than two thirds of the weight (2026-10-15 16:07 UTC);
 * the staple keeta_aabmh4q7... voted alone (16:11); the five keeta_aabf7dz5...
 * voted alone without a quorum (2026-10-16 18:10 to 18:22); the first voted by
 * both of Keeta's representatives again (18:30); and one keeta_aabf7dz5...
 * voted alone once it held a quorum (2026-10-17 19:35).
 */
async function testNetworkStaples(): Promise<VoteStaple[]> {
	const parsed = JSON.parse(await readFile(new URL('../testing/fixtures/test-network-weightless-staples.json', import.meta.url), 'utf8')) as readonly string[];
	return(parsed.map(function(staple): VoteStaple {
		return(new lib.Vote.Staple(Buffer.from(staple, 'base64')));
	}));
}

const REP2 = 'keeta_aabf7dz5asq2n2lrldct33x2ww65cophxp7egfiixbb7tbyat5r3kcbcez7ftpi';

function votedByRep2Alone(staple: VoteStaple): boolean {
	return(staple.votes.every(function(vote): boolean {
		return(vote.issuer.publicKeyString.get() === REP2);
	}));
}

function requireAdmit(admit: AdmitWithoutQuorum | undefined): AdmitWithoutQuorum {
	if (admit === undefined) {
		throw(new Error('the network admits no staple without a quorum'));
	}
	return(admit);
}

function admitOn(variables: Record<string, string>): AdmitWithoutQuorum | undefined {
	const config = getConfigFromEnv({ KEETANET_LOCAL_NODE_SEED: SEED, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'no-voting', ...variables });
	return(localNodeConfig(config, { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() }).ledger.admitWithoutQuorum);
}

async function minorityStaple(network: TestNetwork, amount: bigint): Promise<VoteStaple> {
	const sender = requireAt(network.users, 0);
	const block = await sendBlock({ from: sender, previous: headOf(network.genesis, sender), to: requireAt(network.users, 1), amount, token: network.baseToken, network: network.network });
	return(await confirmedStaple([block], [requireAt(network.representatives, 1)]));
}

afterEach(function() {
	vi.useRealTimers();
});

describe('the staples a network admits without a quorum', function() {
	test('on the test network, are the five Keeta\'s representatives added with less than two thirds of the weight, and not those around them', async function() {
		const admit = requireAdmit(admittedWithoutQuorum(TEST_NETWORK));
		const staples = await testNetworkStaples();
		expect(staples.map(admit)).toEqual([false, false, true, true, true, true, true, false, false]);
		// Rep2's vote alone does not admit a staple: two it voted alone, outside the five, are not admitted.
		expect(staples.map(votedByRep2Alone)).toEqual([true, false, true, true, true, true, true, false, true]);
	});

	test('are those of the network the node configures as test, on whose ID their blocks are', async function() {
		const network = getConfigFromEnv({ KEETANET_LOCAL_NODE_SEED: SEED, KEETANET_LOCAL_NODE_NETWORK: 'test', KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'no-voting' }).network;
		expect(network).toEqual(TEST_NETWORK);
		const networks = new Set((await testNetworkStaples()).flatMap(function(staple): bigint[] {
			return(staple.blocks.map(function(block): bigint {
				return(block.network);
			}));
		}));
		expect([...networks]).toEqual([TEST_NETWORK.network]);
	});

	test('are a staple whole: the same votes and blocks encoded again are admitted, and one more vote on the same blocks is not', async function() {
		const admit = requireAdmit(admittedWithoutQuorum(TEST_NETWORK));
		const pinned = requireAt(await testNetworkStaples(), 2);
		const vote = requireAt(pinned.votes, 0);
		const extra = await new lib.Vote.Builder(lib.Account.fromSeed(SEED, 0), pinned.blocks).seal(1n, vote.validityTo, vote.validityFrom);

		expect(admit(lib.Vote.Staple.fromVotesAndBlocks(pinned.votes, pinned.blocks))).toBe(true);
		expect(admit(lib.Vote.Staple.fromVotesAndBlocks([...pinned.votes, extra], pinned.blocks))).toBe(false);
	});

	test('reach the ledger of a node on the test network only', function() {
		expect(admitOn({ KEETANET_LOCAL_NODE_NETWORK: 'test' })).toBeTypeOf('function');
		for (const network of ['main', 'staging', 'dev']) {
			expect(admitOn({ KEETANET_LOCAL_NODE_NETWORK: network }), network).toBeUndefined();
		}
		expect(admittedWithoutQuorum({ kind: 'local', network: 0n })).toBeUndefined();
	});

	test('are added by the ledger although their votes lack a quorum, while a staple it does not name is still refused', async function() {
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const admitted = await minorityStaple(network, 1n);
		const other = await minorityStaple(network, 2n);
		const admit: AdmitWithoutQuorum = function(staple) {
			return(staple.hash.toString() === admitted.hash.toString());
		};

		const stock = network.createLedger(new MemoryLedgerStorage(), requireAt(network.representatives, 0));
		await stock.add(network.genesis);
		await expect(stock.add(admitted)).rejects.toMatchObject({ code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT' });

		const ledger = network.createLedger(new MemoryLedgerStorage(), requireAt(network.representatives, 0), { admitWithoutQuorum: admit });
		await ledger.add(network.genesis);
		await expect(ledger.add(other)).rejects.toMatchObject({ code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT' });
		await ledger.add(admitted);
		expect(await ledger.getVoteStaple(admitted.blocksHash, 'main')).not.toBeNull();
	});
});
