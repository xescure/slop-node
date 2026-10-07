import { afterEach, describe, expect, test, vi } from 'vitest';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { LedgerStorageDriverBase } from '../../ledger/storage/base.js';
import { driversUnderTest } from '../../ledger/storage/suite/drivers.js';
import { blocksHashesOf } from '../../ledger/storage/suite/support.js';
import type { DriverUnderTest } from '../../ledger/storage/suite/types.js';
import { loadMainnetFixture } from './fixture.js';
import { replayMainnet, replayOrder } from './replay.js';
import type { Orderable } from './replay.js';

/*
 * A replay of the head's 2,037 staples took about 6 s on the memory driver
 * and 22 s on Postgres on an idle machine, and parsing the head adds about 4 s
 * once. While make -j8 ran the other tests and the linters beside it, one
 * replay on Postgres took 27 s and two took 45 s. The limit for one replay is
 * about nine times that, so it leaves room for a machine several times slower,
 * and the test of two replays has twice that.
 */
const REPLAY_TIMEOUT_MILLISECONDS = 240_000;

describe.each(driversUnderTest)('mainnet replay on the $name driver', function(driver) {
	afterEach(function() {
		vi.useRealTimers();
	});

	async function withStorage<Result>(use: (storage: LedgerStorageDriverBase) => Promise<Result>): Promise<Result> {
		const storage = await driver.create();
		try {
			return(await use(storage));
		} finally {
			await driver.destroy(storage);
		}
	}

	test('every mainnet head staple applies and none stays deferred', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const staples = await loadMainnetFixture('head');

		const result = await withStorage(function(storage) {
			return(replayMainnet(storage, staples));
		});

		expect(result.deferred).toEqual([]);
		expect(result.applied).toBe(staples.length);
		expect(result.touched.length).toBeGreaterThan(0);
	});

	test('two replays end with the same checksum', { timeout: 2 * REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const staples = await loadMainnetFixture('head');

		const first = await withStorage(function(storage) {
			return(replayMainnet(storage, staples));
		});
		const second = await withStorage(function(storage) {
			return(replayMainnet(storage, staples));
		});

		expect(first.ledgerChecksum).not.toBe(0n);
		expect(second.ledgerChecksum).toBe(first.ledgerChecksum);
	});
});

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

	test('the hook sees every staple, oldest first, with the clock at its timestamp', async function() {
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
