import { describe, expect, test } from 'vitest';
import { followerStoreOf } from '../testing/follower-store.js';
import { isTransientStoreError, retryingStore } from './transient-store.js';
import type { TransientRetry } from './transient-store.js';

function statementTimeout(): Error {
	return(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
}

/** A retry whose waits are recorded rather than waited, stopped once the stop asks. */
function recordedRetry(stopAfter = Number.POSITIVE_INFINITY): TransientRetry & { readonly waits: number[] } {
	const stopping = new AbortController();
	const waits: number[] = [];
	return({
		waits,
		stopped: stopping.signal,
		clock: {
			pause(milliseconds: number): Promise<void> {
				waits.push(milliseconds);
				if (waits.length >= stopAfter) {
					stopping.abort();
				}
				return(Promise.resolve());
			}
		}
	});
}

describe('a read of the follower\'s database under load', function() {
	test('tells the cluster\'s load from a failure of the read', function() {
		expect(isTransientStoreError(new Error('timeout exceeded when trying to connect'))).toBe(true);
		expect(isTransientStoreError(statementTimeout())).toBe(true);
		expect(isTransientStoreError(Object.assign(new Error('sorry, too many clients already'), { code: '53300' }))).toBe(true);
		expect(isTransientStoreError(Object.assign(new Error('relation "heads" does not exist'), { code: '42P01' }))).toBe(false);
		expect(isTransientStoreError('timeout exceeded when trying to connect')).toBe(false);
	});

	test('is run again after waits doubling from 1 s up to 30 s until it succeeds', async function() {
		let failures = 7;
		const retry = recordedRetry();
		const store = retryingStore(followerStoreOf({
			accountCount(): Promise<number> {
				failures--;
				if (failures >= 0) {
					return(Promise.reject(new Error('timeout exceeded when trying to connect')));
				}
				return(Promise.resolve(42));
			}
		}), retry);

		expect(await store.accountCount()).toBe(42);
		expect(retry.waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
	});

	test('fails at once on any other failure, and on one under load once stopped', async function() {
		const failing = Object.assign(new Error('relation "heads" does not exist'), { code: '42P01' });
		const other = recordedRetry();
		await expect(retryingStore(followerStoreOf({ accountCount: () => Promise.reject(failing) }), other).accountCount()).rejects.toBe(failing);
		expect(other.waits).toEqual([]);

		const timeout = statementTimeout();
		const stopping = recordedRetry(2);
		await expect(retryingStore(followerStoreOf({ accountCount: () => Promise.reject(timeout) }), stopping).accountCount()).rejects.toBe(timeout);
		expect(stopping.waits).toEqual([1000, 2000]);
	});
});
