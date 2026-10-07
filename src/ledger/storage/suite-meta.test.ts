import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { LedgerSelector } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import { MemoryLedgerStorage } from './memory/driver.js';
import type { MemoryTransaction } from './memory/driver.js';
import { useFixtures } from './suite/support.js';
import type { FixtureFactory } from './suite/support.js';
import type { DriverUnderTest, SuiteCase } from './suite/types.js';
import { voteLifecycleCases } from './suite/votes.js';

const lib = KeetaNet.lib;

/*
 * Deliberately wrong: under 'both' an account's head is the last block of its
 * pending side chain, so heads count side blocks.
 */
class SideHeadsMemoryLedgerStorage extends MemoryLedgerStorage {
	override async getHeadBlocks(transaction: MemoryTransaction, accounts: GenericAccount[], from: LedgerSelector): Promise<{ [account: string]: Block | null }> {
		const heads = await super.getHeadBlocks(transaction, accounts, from);
		if (from !== 'both') {
			return(heads);
		}
		for (const account of accounts) {
			const key = account.publicKeyString.get();
			let head = heads[key] ?? null;
			let pending = await this.getBlockFromPrevious(transaction, head?.hash ?? lib.Block.getAccountOpeningHash(account), 'side');
			while (pending !== null && pending.account.comparePublicKey(account)) {
				head = pending;
				pending = await this.getBlockFromPrevious(transaction, head.hash, 'side');
			}
			heads[key] = head;
		}
		return(heads);
	}
}

function driverOf(name: string, create: () => MemoryLedgerStorage): DriverUnderTest {
	return({
		name,
		sharing: { kind: 'process-local' },
		create: function() {
			return(Promise.resolve(create()));
		},
		destroy: function() {
			return(Promise.resolve());
		}
	});
}

/*
 * Runs each case to completion and records its failure instead of failing
 * the test, so a failure of the broken driver is data to assert on.
 */
async function failingCases(cases: readonly SuiteCase[], startNetwork: FixtureFactory): Promise<string[]> {
	const failing: string[] = [];
	for (const suiteCase of cases) {
		try {
			await suiteCase.run(startNetwork);
		} catch {
			failing.push(suiteCase.name);
		}
	}
	return(failing);
}

describe('the shared driver suite', function() {
	const startOnMemory = useFixtures(driverOf('memory', function() {
		return(new MemoryLedgerStorage());
	}));
	const startOnSideHeads = useFixtures(driverOf('memory with side heads', function() {
		return(new SideHeadsMemoryLedgerStorage());
	}));

	test('the vote lifecycle cases run as data pass on the memory driver', async function() {
		expect(await failingCases(voteLifecycleCases, startOnMemory)).toEqual([]);
	});

	test('the vote lifecycle cases catch heads that count side blocks', async function() {
		const failing = await failingCases(voteLifecycleCases, startOnSideHeads);

		expect(failing.length).toBeGreaterThan(0);
		expect(failing).toContain('a temporary vote is stored on the side ledger and is not a head');
	});
});
