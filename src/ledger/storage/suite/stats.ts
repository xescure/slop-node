import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { LedgerStatistics } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { advanceClock } from '../../../testing/network.js';
import { confirmedStaple, sendBlock, setRepresentativeBlock } from '../../../testing/blocks.js';
import { headOf, requireAt, useFixtures } from './support.js';
import type { DriverUnderTest } from './types.js';

const lib = KeetaNet.lib;

// Lands in upstream's settlement-time bucket for 901 to 1000 ms.
const SETTLEMENT_MILLISECONDS = 1000;

type LedgerCounts = Pick<LedgerStatistics, 'blockCount' | 'transactionCount' | 'representativeCount'>;

async function countsOf(ledger: Ledger): Promise<LedgerCounts> {
	const { blockCount, transactionCount, representativeCount } = await ledger.stats();
	return({ blockCount, transactionCount, representativeCount });
}

function operationsOf(staples: readonly VoteStaple[]): number {
	let operations = 0;
	for (const staple of staples) {
		for (const block of staple.blocks) {
			operations += block.operations.length;
		}
	}
	return(operations);
}

function blocksOf(staples: readonly VoteStaple[]): number {
	let blocks = 0;
	for (const staple of staples) {
		blocks += staple.blocks.length;
	}
	return(blocks);
}

export function defineStatsCases(driver: DriverUnderTest): void {
	describe('stats', function() {
		const startNetwork = useFixtures(driver);

		test('stats returns the upstream shape with counts that follow the staples added', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const other = requireAt(network.users, 1);

			// A ledger without a node has no settlement times or retry count to report.
			expect(await ledger.stats()).toEqual({
				moment: new Date().toISOString(),
				momentRange: 0,
				blockCount: 0,
				transactionCount: 0,
				representativeCount: 0,
				db: { retries: -1 },
				settlementTimes: lib.Stats.placeholderTimingData()
			});

			await ledger.add(network.genesis);
			const afterGenesis = { blockCount: blocksOf([network.genesis]), transactionCount: operationsOf([network.genesis]), representativeCount: 3 };
			expect(await countsOf(ledger)).toEqual(afterGenesis);

			const first = await sendBlock({ from: user, previous: headOf(network.genesis, user), to: other, amount: 5n, token: network.baseToken, network: network.network });
			const second = await sendBlock({ from: user, previous: first.hash, to: other, amount: 7n, token: network.baseToken, network: network.network });
			// Pending votes and deferred staples are not on the main ledger yet.
			await ledger.vote([first]);
			const secondStaple = await confirmedStaple([second], network.representatives);
			expect(await ledger.add(secondStaple)).toEqual([]);
			expect(await countsOf(ledger)).toEqual(afterGenesis);

			const firstStaple = await confirmedStaple([first], network.representatives);
			expect(await ledger.add(firstStaple)).toHaveLength(2);
			const afterSends = {
				blockCount: blocksOf([network.genesis, firstStaple, secondStaple]),
				transactionCount: operationsOf([network.genesis, firstStaple, secondStaple]),
				representativeCount: 3
			};
			expect(await countsOf(ledger)).toEqual(afterSends);

			// The other user moves all of its representative's weight away.
			const moved = await setRepresentativeBlock({ account: other, representative: requireAt(network.representatives, 0), previous: headOf(network.genesis, other), network: network.network });
			const movedStaple = await confirmedStaple([moved], network.representatives);
			await ledger.add(movedStaple);
			expect(await countsOf(ledger)).toEqual({
				blockCount: afterSends.blockCount + 1,
				transactionCount: afterSends.transactionCount + 1,
				representativeCount: 2
			});
		});

		test('stats reads settlement times and retries from the node', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			const node = await startNode(0);
			const send = await sendBlock({ from: user, previous: headOf(network.genesis, user), to: requireAt(network.users, 1), amount: 5n, token: network.baseToken, network: network.network });
			await node.ledger.vote([send]);
			advanceClock(SETTLEMENT_MILLISECONDS);
			await node.ledger.add(await confirmedStaple([send], network.representatives));

			const stats = await node.ledger.stats();

			expect(stats.db).toEqual({ retries: 0 });
			expect(Object.keys(stats.settlementTimes).sort()).toEqual(Object.keys(lib.Stats.placeholderTimingData()).sort());
			expect(stats.settlementTimes['1000ms']).toEqual({ count: 1, range: lib.Stats.placeholderTimingData()['1000ms'].range });
			expect(stats.settlementTimes['100ms'].count).toBe(0);
			expect(stats.blockCount).toBe(blocksOf([network.genesis]) + 1);
		});
	});
}
