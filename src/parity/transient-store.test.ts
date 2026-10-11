import { describe, expect, test } from 'vitest';
import { followerStoreOf } from '../testing/follower-store.js';
import type { KnownAccount } from './follower-store.js';
import { isTransientStoreError, retryingStore } from './transient-store.js';
import type { TransientFailure, TransientRetry } from './transient-store.js';

function statementTimeout(): Error {
	return(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
}

/** A retry whose waits are recorded and pass on its clock rather than waited, stopped once the stop asks. */
function recordedRetry(stopAfter = Number.POSITIVE_INFINITY): TransientRetry & { readonly waits: number[]; readonly failures: TransientFailure[] } {
	const stopping = new AbortController();
	const waits: number[] = [];
	const failures: TransientFailure[] = [];
	let now = 0;
	return({
		waits,
		failures,
		stopped: stopping.signal,
		retrying(_error: unknown, failure: TransientFailure): void {
			failures.push(failure);
		},
		clock: {
			now(): number {
				return(now);
			},
			pause(milliseconds: number): Promise<void> {
				now += milliseconds;
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
		expect(isTransientStoreError(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).toBe(true);
		expect(isTransientStoreError(Object.assign(new Error('connect ECONNREFUSED /run/.s.PGSQL.5432'), { code: 'ECONNREFUSED' }))).toBe(true);
		expect(isTransientStoreError(new Error('Connection terminated unexpectedly'))).toBe(true);
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
		expect(retry.failures.slice(-2)).toEqual([{ attempt: 6, elapsedMilliseconds: 31_000, waitMilliseconds: 30_000 }, { attempt: 7, elapsedMilliseconds: 61_000, waitMilliseconds: 30_000 }]);
	});

	test('reads every account with a chain again from the page a failure cut, not from the first', async function() {
		const accounts = Array.from({ length: 1500 }, function(_, index): KnownAccount {
			return({ rowID: String(index + 1), account: `keeta_${String(index + 1)}`, newestStaple: undefined });
		});
		const asked: string[] = [];
		let failed = false;
		const store = retryingStore(followerStoreOf({
			chainAccountsAfter(rowID: string, count: number): Promise<readonly KnownAccount[]> {
				asked.push(rowID);
				if (rowID !== '0' && !failed) {
					failed = true;
					return(Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })));
				}
				return(Promise.resolve(accounts.filter(function(entry): boolean {
					return(BigInt(entry.rowID) > BigInt(rowID));
				}).slice(0, count)));
			}
		}), recordedRetry());

		expect(await store.chainAccounts()).toEqual(accounts);
		expect(asked).toEqual(['0', '1000', '1000']);
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
