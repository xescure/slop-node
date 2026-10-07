import { afterEach, describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { FeeAmountAndToken } from '@keetanetwork/keetanet-client/lib/vote.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { GENESIS_MOMENT, requireAt } from '../ledger/storage/suite/support.js';
import { sendBlock } from '../testing/blocks.js';
import { createTestNetwork, freezeClock } from '../testing/network.js';
import type { TestNetwork } from '../testing/network.js';
import { computeFeeFromBlocksFor, parseFeeSchedule } from './fees.js';
import type { FeePolicy } from './fees.js';
import { LocalNode } from './local.js';

const lib = KeetaNet.lib;

afterEach(function() {
	vi.useRealTimers();
});

describe('the fee schedule', function() {
	test('is free, or a flat amount per block', function() {
		expect(parseFeeSchedule('free')).toEqual({ kind: 'free' });
		expect(parseFeeSchedule('flat:25')).toEqual({ kind: 'flat', amountPerBlock: 25n });
		expect(parseFeeSchedule('flat:123456789012345678901234567890')).toEqual({ kind: 'flat', amountPerBlock: 123456789012345678901234567890n });
	});

	test.each([
		'',
		'Free',
		'flat',
		'flat:',
		'flat:0',
		'flat:007',
		'flat:-1',
		'flat:+1',
		'flat:1.5',
		'flat:0x10',
		'flat: 1',
		'flat:1 ',
		'FLAT:1',
		'per-vote:1'
	])('refuses %j', function(text) {
		expect(parseFeeSchedule(text)).toBeUndefined();
	});
});

type Quoted = {
	readonly network: TestNetwork;
	readonly fee: FeeAmountAndToken;
};

/** What representative 0 quotes for user 0's chain of sends, one block per send. */
async function quote(policy: FeePolicy, sends: number): Promise<Quoted> {
	freezeClock(GENESIS_MOMENT);
	const network = await createTestNetwork({ representativeWeights: [1000n] });
	const base = network.nodeConfig(new MemoryLedgerStorage(), requireAt(network.representatives, 0));
	const node = new LocalNode({ ...base, ledger: { ...base.ledger, computeFeeFromBlocks: computeFeeFromBlocksFor(policy) } });
	await node.ledger.add(network.genesis);
	const blocks: Block[] = [];
	for (let index = 0; index < sends; index++) {
		blocks.push(await sendBlock({
			network: network.network,
			previous: blocks.at(-1)?.hash ?? (await node.ledger.getHeadBlock(requireAt(network.users, 0), 'main'))?.hash ?? null,
			from: requireAt(network.users, 0),
			to: requireAt(network.representatives, 0),
			amount: 1n,
			token: network.baseToken
		}));
	}
	const fee = (await node.ledger.quote(blocks)).fee;
	await node.stop();
	if (fee === undefined || Array.isArray(fee)) {
		throw(new Error('the quote carries no single fee'));
	}
	return({ network, fee });
}

function tokenOf(owner: Account): TokenAddress {
	return(owner.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0));
}

describe('the fee policy', function() {
	test('free quotes a zero fee', async function() {
		const { fee } = await quote({ kind: 'free' }, 1);
		expect(fee).toEqual({ amount: 0n });
	});

	test('flat charges its amount for every block, to the vote issuer in the base token', async function() {
		const { fee } = await quote({ kind: 'flat', amountPerBlock: 7n, payTo: [], token: undefined }, 3);
		expect(fee).toEqual({ amount: 21n });
	});

	test('flat names the fee account and the fee token', async function() {
		freezeClock(GENESIS_MOMENT);
		const keys = await createTestNetwork({ representativeWeights: [1000n] });
		const collector = requireAt(keys.users, 0);
		const token = tokenOf(collector);
		const { fee } = await quote({ kind: 'flat', amountPerBlock: 5n, payTo: [collector], token }, 1);
		expect(fee.amount).toBe(5n);
		expect(fee.payTo?.publicKeyString.get()).toBe(collector.publicKeyString.get());
		expect(fee.token?.publicKeyString.get()).toBe(token.publicKeyString.get());
	});

	/*
	 * Upstream leaves out a payee that is the vote issuer and a token that is
	 * the base token, so both go to their defaults.
	 * [Keeta TS] index.js:70267-70280
	 */
	test('flat leaves out the representative as payee and the base token', async function() {
		freezeClock(GENESIS_MOMENT);
		const keys = await createTestNetwork({ representativeWeights: [1000n] });
		const { fee } = await quote({ kind: 'flat', amountPerBlock: 5n, payTo: [requireAt(keys.representatives, 0)], token: keys.baseToken }, 1);
		expect(fee).toEqual({ amount: 5n });
	});

	test('flat picks its payee among the fee accounts', async function() {
		freezeClock(GENESIS_MOMENT);
		const keys = await createTestNetwork({ representativeWeights: [1000n] });
		const accounts = [requireAt(keys.users, 0), keys.trustedRoot];
		const { fee } = await quote({ kind: 'flat', amountPerBlock: 1n, payTo: accounts, token: undefined }, 1);
		expect(accounts.map(function(account): string {
			return(account.publicKeyString.get());
		})).toContain(fee.payTo?.publicKeyString.get());
	});
});
