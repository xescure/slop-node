import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals } from '../../../upstream/internals.js';
import { confirmedStaple, sendBlock } from '../../../testing/blocks.js';
import { createTestNetwork, freezeClock } from '../../../testing/network.js';
import type { TestNetwork } from '../../../testing/network.js';
import { computeConfirmedStapleChange } from '../confirmed.js';
import type { ConfirmedStapleChange } from '../confirmed.js';
import { toBlockHashKey } from '../keys.js';
import { GENESIS_MOMENT, DEFAULT_WEIGHTS, headOf, requireAt } from '../suite/support.js';
import { MemoryLedgerStorage } from './driver.js';
import type { MemoryTransaction } from './driver.js';

/*
 * Reaches the protected write primitive directly. The ledger's own pre-checks
 * refuse duplicates and forks before persisting, so only a direct call shows
 * that the write itself never overwrites confirmed history.
 */
class PersistingMemoryLedgerStorage extends MemoryLedgerStorage {
	persist(transaction: MemoryTransaction, change: ConfirmedStapleChange): Promise<void> {
		return(this.persistConfirmedStaple(transaction, change));
	}
}

async function changeFor(input: { readonly network: TestNetwork; readonly ledger: Ledger; readonly storage: PersistingMemoryLedgerStorage; readonly transaction: MemoryTransaction; readonly staple: VoteStaple; readonly block: Block; readonly height: bigint }): Promise<ConfirmedStapleChange> {
	const { network, ledger, storage, transaction, staple, block, height } = input;
	return(await computeConfirmedStapleChange({
		transaction,
		staple,
		effects: LedgerInternals.computeEffectOfBlocks(staple.blocks, ledger),
		blockHeights: new Map([[toBlockHashKey(block.hash), height]]),
		storage,
		network: network.network,
		baseToken: network.baseToken,
		moment: transaction.moment
	}));
}

describe('memory driver writes', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('persisting never overwrites a confirmed block or successor', async function() {
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const storage = new PersistingMemoryLedgerStorage();
		const ledger = network.createLedger(storage, requireAt(network.representatives, 0));
		const user = requireAt(network.users, 0);
		const other = requireAt(network.users, 1);
		const genesisHead = headOf(network.genesis, user);
		await ledger.add(network.genesis);
		const kept = await sendBlock({ from: user, previous: genesisHead, to: other, amount: 5n, token: network.baseToken, network: network.network });
		const fork = await sendBlock({ from: user, previous: genesisHead, to: other, amount: 7n, token: network.baseToken, network: network.network });
		const keptStaple = await confirmedStaple([kept], network.representatives);
		const forkStaple = await confirmedStaple([fork], network.representatives);
		await ledger.add(keptStaple);
		const keptHeight = (await ledger.getAccountsBlockHeightInfo([{ account: user }]))[user.publicKeyString.get()]?.height;
		if (keptHeight === undefined || keptHeight === null) {
			throw(new Error('the kept block has no height'));
		}

		const transaction = await storage.beginTransaction({ identifier: 'memory-persist-probe', readOnly: false });
		try {
			const duplicate = await changeFor({ network, ledger, storage, transaction, staple: keptStaple, block: kept, height: keptHeight });
			const forked = await changeFor({ network, ledger, storage, transaction, staple: forkStaple, block: fork, height: keptHeight });

			await expect(storage.persist(transaction, duplicate)).rejects.toMatchObject({ code: 'LEDGER_BLOCK_ALREADY_EXISTS', shouldRetry: false });
			await expect(storage.persist(transaction, forked)).rejects.toMatchObject({ code: 'LEDGER_PREVIOUS_ALREADY_USED', shouldRetry: false });

			// A refused change leaves nothing behind in the transaction.
			expect(await storage.getBlock(transaction, fork.hash, 'main')).toBeNull();
			expect((await storage.getBlockFromPrevious(transaction, genesisHead, 'main'))?.hash.toString()).toBe(kept.hash.toString());
			expect((await storage.getVoteStaples(transaction, [forkStaple.blocksHash], 'main')).get(forkStaple.blocksHash)).toBeNull();
			expect(await storage.getBalance(transaction, user, network.baseToken)).toBe(395n);
			expect(await storage.getHistory(transaction, user, null, 25)).toHaveLength(2);
		} finally {
			await storage.abortTransaction(transaction);
		}
	});
});
