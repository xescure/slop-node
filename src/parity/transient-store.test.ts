import { describe, expect, test } from 'vitest';
import { followerStoreOf } from '../testing/follower-store.js';
import type { KnownAccount } from './follower-store.js';
import { retryingStore, transientCauseOf, UNREACHABLE_LIMIT_MILLISECONDS } from './transient-store.js';
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
		expect(transientCauseOf(new Error('timeout exceeded when trying to connect'))).toBe('load');
		expect(transientCauseOf(statementTimeout())).toBe('load');
		expect(transientCauseOf(Object.assign(new Error('sorry, too many clients already'), { code: '53300' }))).toBe('load');
		expect(transientCauseOf(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).toBe('unreachable');
		expect(transientCauseOf(Object.assign(new Error('the database system is starting up'), { code: '57P03' }))).toBe('unreachable');
		expect(transientCauseOf(Object.assign(new Error('connect ECONNREFUSED /run/.s.PGSQL.5432'), { code: 'ECONNREFUSED' }))).toBe('unreachable');
		expect(transientCauseOf(Object.assign(new Error('connect ENOENT /run/.s.PGSQL.5432'), { code: 'ENOENT' }))).toBe('unreachable');
		expect(transientCauseOf(new Error('Connection terminated unexpectedly'))).toBe('unreachable');
		expect(transientCauseOf(Object.assign(new Error('relation "heads" does not exist'), { code: '42P01' }))).toBeUndefined();
		expect(transientCauseOf('timeout exceeded when trying to connect')).toBeUndefined();
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

	test('gives a read up once its statement timed out ten times in a row, as one that always runs longer than its timeout', async function() {
		const retry = recordedRetry(20);
		let attempts = 0;
		const store = retryingStore(followerStoreOf({
			accountCount(): Promise<number> {
				attempts++;
				return(Promise.reject(statementTimeout()));
			}
		}), retry);

		await expect(store.accountCount()).rejects.toThrow('the read ran past its statement timeout 10 times in a row, so it is too slow to finish rather than slowed by load');
		expect(attempts).toBe(10);
	});

	test('counts only the statement timeouts in a row, a wait for a session between starting the count again', async function() {
		const retry = recordedRetry();
		const failures = [...Array.from({ length: 9 }, statementTimeout), new Error('timeout exceeded when trying to connect'), ...Array.from({ length: 9 }, statementTimeout)];
		const store = retryingStore(followerStoreOf({
			accountCount(): Promise<number> {
				const failure = failures.shift();
				if (failure !== undefined) {
					return(Promise.reject(failure));
				}
				return(Promise.resolve(42));
			}
		}), retry);

		expect(await store.accountCount()).toBe(42);
	});

	test('fails at once when the follower\'s database cannot be reached before any read of the command succeeded', async function() {
		for (const code of ['ENOENT', 'ECONNREFUSED']) {
			const retry = recordedRetry();
			const unreachable = Object.assign(new Error(`connect ${code} /home/follower/run/.s.PGSQL.54329`), { code });
			await expect(retryingStore(followerStoreOf({ accountCount: () => Promise.reject(unreachable) }), retry).accountCount()).rejects.toThrow('is the follower running');
			expect(retry.waits).toEqual([]);
		}
	});

	test('waits for a follower that stops serving after a read succeeded, as through its restart, and gives the read up after 15 minutes', async function() {
		const refused = Object.assign(new Error('connect ECONNREFUSED /home/follower/run/.s.PGSQL.54329'), { code: 'ECONNREFUSED' });
		let refusals = 3;
		const restarting = recordedRetry();
		const restarted = retryingStore(followerStoreOf({
			accountCount: () => Promise.resolve(1),
			lastSequence(): Promise<bigint> {
				refusals--;
				if (refusals >= 0) {
					return(Promise.reject(refused));
				}
				return(Promise.resolve(7n));
			}
		}), restarting);
		expect(await restarted.accountCount()).toBe(1);
		expect(await restarted.lastSequence()).toBe(7n);
		expect(restarting.waits).toEqual([1000, 2000, 4000]);

		const gone = recordedRetry();
		const store = retryingStore(followerStoreOf({ accountCount: () => Promise.resolve(1), lastSequence: () => Promise.reject(refused) }), gone);
		expect(await store.accountCount()).toBe(1);
		await expect(store.lastSequence()).rejects.toThrow('has not been reachable for 15 min');
		const waited = gone.waits.reduce(function(sum, wait): number {
			return(sum + wait);
		}, 0);
		expect(waited).toBeGreaterThanOrEqual(UNREACHABLE_LIMIT_MILLISECONDS - 30_000);
		expect(waited).toBeLessThan(UNREACHABLE_LIMIT_MILLISECONDS + 30_000);
	});

	test('counts the 15 minutes from the first failure to reach the database, whatever load failures come between', async function() {
		const refused = Object.assign(new Error('connect ECONNREFUSED /home/follower/run/.s.PGSQL.54329'), { code: 'ECONNREFUSED' });
		let reads = 0;
		const retry = recordedRetry(200);
		const store = retryingStore(followerStoreOf({
			accountCount: () => Promise.resolve(1),
			lastSequence(): Promise<bigint> {
				reads++;
				if (reads % 2 === 0) {
					return(Promise.reject(statementTimeout()));
				}
				return(Promise.reject(refused));
			}
		}), retry);
		expect(await store.accountCount()).toBe(1);

		await expect(store.lastSequence()).rejects.toThrow('has not been reachable for 15 min');
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
