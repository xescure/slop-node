import { afterEach, describe, expect, test, vi } from 'vitest';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { driversUnderTest } from '../../ledger/storage/suite/drivers.js';
import { blocksHashesOf } from '../../ledger/storage/suite/support.js';
import type { DriverUnderTest } from '../../ledger/storage/suite/types.js';
import { loadMainnetFixture } from './fixture.js';
import { replayMainnet, replayOrder } from './replay.js';
import type { Orderable } from './replay.js';

/*
 * Each test here parses the head unless an earlier one did, which took about
 * 4 s on an idle machine. While make -j8 ran the other tests and the linters
 * beside it, parsing it and replaying 200 of its staples took 8.6 s, and
 * parsing it and replaying all 2,037 on the memory driver up to 14 s. The
 * limit leaves room for a machine many times slower.
 */
const REPLAY_TIMEOUT_MILLISECONDS = 240_000;

describe('mainnet replay order and deferral', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	function memoryDriver(): DriverUnderTest {
		const driver = driversUnderTest.find(function(candidate): boolean {
			return(candidate.name === 'memory');
		});
		if (driver === undefined) {
			throw(new Error('the memory driver is not under test'));
		}
		return(driver);
	}

	function stapleAt(millisecond: number, blocksHash: string): Orderable {
		return({ timestamp: () => new Date(millisecond), blocksHash: { toString: () => blocksHash } });
	}

	test('the order is by timestamp, then by blocks hash, whatever the order of the input', function() {
		const early = stapleAt(1000, 'FF');
		const tieLow = stapleAt(2000, '0A');
		const tieHigh = stapleAt(2000, 'B0');
		const late = stapleAt(3000, '00');

		expect(replayOrder([late, tieHigh, early, tieLow])).toEqual([early, tieLow, tieHigh, late]);
		expect(replayOrder([tieLow, late, tieHigh, early])).toEqual([early, tieLow, tieHigh, late]);
	});

	test('the hook sees every staple, oldest first, with the clock at its timestamp', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const staples = (await loadMainnetFixture('head')).slice(0, 200);
		const seen: VoteStaple[] = [];

		await replayMainnet(await memoryDriver().create(), [...staples].reverse(), {
			beforeAdd: function(staple) {
				expect(Date.now()).toBe(staple.timestamp().valueOf());
				seen.push(staple);
				return(Promise.resolve());
			}
		});

		expect(blocksHashesOf(seen)).toEqual(blocksHashesOf(replayOrder(staples)));
	});

	test('a staple that never arrives leaves its successors deferred, and they are reported', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const staples = await loadMainnetFixture('head');
		const missing = replayOrder(staples)[300];
		const present = staples.filter(function(staple): boolean {
			return(staple !== missing);
		});

		const result = await replayMainnet(await memoryDriver().create(), present);

		expect(result.deferred.length).toBeGreaterThan(0);
		expect(result.applied + result.deferred.length).toBe(present.length);
	});
});
