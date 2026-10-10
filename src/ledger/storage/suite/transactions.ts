import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Vote } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals } from '../../../upstream/internals.js';
import { freezeClock } from '../../../testing/network.js';
import type { TestNetwork } from '../../../testing/network.js';
import { confirmedStaple, sendBlock } from '../../../testing/blocks.js';
import { isVoteLive, isVoteUnexpired, voteExpirySlopMilliseconds } from '../expiry.js';
import { GENESIS_MOMENT, TESTING_KEY, headOf, requireAt, useFixtures } from './support.js';
import type { DriverUnderTest } from './types.js';

const lib = KeetaNet.lib;

const TEMPORARY_VOTE_LIFETIME_MILLISECONDS = 5 * 60 * 1000;

function constructsAsVote(bytes: ArrayBuffer): boolean {
	try {
		new lib.Vote(bytes);
		return(true);
	} catch (error: unknown) {
		if (lib.Error.isInstance(error) && (error.code === 'VOTE_EXPIRED' || error.code === 'VOTE_MOMENT_BEFORE_VALIDITY_FROM')) {
			return(false);
		}
		throw(error);
	}
}

async function firstUserSend(network: TestNetwork): Promise<Block> {
	const user = requireAt(network.users, 0);
	return(await sendBlock({ from: user, previous: headOf(network.genesis, user), to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, network: network.network }));
}

/*
 * Judges a vote one millisecond before, at, and one millisecond after a
 * boundary, by the shared predicate and by constructing it under a clock
 * frozen at that moment.
 */
function judgeAround(vote: Vote, boundary: number): { readonly predicate: boolean; readonly voteClass: boolean }[] {
	return([boundary - 1, boundary, boundary + 1].map(function(milliseconds) {
		const moment = new Date(milliseconds);
		freezeClock(moment);
		return({ predicate: isVoteLive(vote, moment), voteClass: constructsAsVote(vote.toBytes()) });
	}));
}

export function defineTransactionCases(driver: DriverUnderTest): void {
	describe('transactions', function() {
		const startNetwork = useFixtures(driver);

		test('a driver serves exactly one ledger', async function() {
			const { network, storage, ledger } = await startNetwork();
			const effects = LedgerInternals.computeEffectOfBlocks(network.genesis.blocks, ledger);
			const unbound = await driver.create();
			try {
				const transaction = await unbound.beginTransaction({ identifier: 'suite-unbound', readOnly: false });
				await expect(unbound.adjust(transaction, network.genesis, effects)).rejects.toMatchObject({ name: 'StorageDriverNotInitializedError', message: 'storage driver used before Ledger called init()' });
				await unbound.abortTransaction(transaction);
			} finally {
				await driver.destroy(unbound);
			}

			expect(function() {
				network.createLedger(storage, requireAt(network.representatives, 1));
			}).toThrow('storage driver is already initialized');
		});

		test('abort discards writes but never reuses a serial', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const serialBefore = await storage.getNextSerialNumber();

			const abandoned = await storage.beginTransaction({ identifier: 'suite-abort', readOnly: false });
			const serialInAbandoned = await storage.getNextSerialNumber(abandoned);
			await storage.adjust(abandoned, network.genesis, LedgerInternals.computeEffectOfBlocks(network.genesis.blocks, ledger));
			await storage.abortTransaction(abandoned);
			const serialAfter = await storage.getNextSerialNumber();

			expect(await ledger.getBalance(user, network.baseToken)).toBe(0n);
			expect(await ledger.getHeadBlock(user, 'main')).toBeNull();
			expect(await ledger.votingPower()).toBe(0n);
			expect(serialInAbandoned).toBeGreaterThan(serialBefore);
			expect(serialAfter).toBeGreaterThan(serialInAbandoned);
		});

		test('a finished transaction rejects further use', async function() {
			const { network, storage } = await startNetwork();
			const transaction = await storage.beginTransaction({ identifier: 'suite-finished', readOnly: true });
			await storage.commitTransaction(transaction);

			await expect(storage.getBalance(transaction, requireAt(network.users, 0), network.baseToken)).rejects.toThrow('transaction suite-finished is already committed');
			// An answer the driver knows without reading still needs an open transaction.
			await expect(storage.listACLsByPrincipal(transaction, requireAt(network.users, 0), [])).rejects.toThrow();
			await expect(storage.abortTransaction(transaction)).rejects.toThrow();
			await expect(storage.commitTransaction(transaction)).rejects.toThrow();

			const aborted = await storage.beginTransaction({ identifier: 'suite-aborted', readOnly: true });
			await storage.abortTransaction(aborted);

			await expect(storage.getBalance(aborted, requireAt(network.users, 0), network.baseToken)).rejects.toThrow('transaction suite-aborted is already aborted');
			await expect(storage.commitTransaction(aborted)).rejects.toThrow();
			await expect(storage.abortTransaction(aborted)).rejects.toThrow();
		});

		// [Keeta TS] index.js:68952-68958
		test('a transaction is read-only unless it is opened for writing, as upstream\'s are', async function() {
			const { storage } = await startNetwork();
			const unsaid = await storage.beginTransaction({ identifier: 'suite-unsaid' });
			await storage.abortTransaction(unsaid);
			const writing = await storage.beginTransaction({ identifier: 'suite-writing', readOnly: false });
			await storage.abortTransaction(writing);

			expect([unsaid.readOnly, writing.readOnly]).toEqual([true, false]);
		});

		test('the test hooks answer to their key alone', async function() {
			const { storage } = await startNetwork();

			expect(function() {
				return(storage._Testing(`${TESTING_KEY}-guess`));
			}).toThrow('This is a testing only method');
		});

		test('concurrent calls within one transaction keep every write', async function() {
			const { network, ledger } = await startNetwork();
			const first = requireAt(network.users, 0);
			const second = requireAt(network.users, 1);
			const receiver = requireAt(network.users, 2);
			await ledger.add(network.genesis);
			const fromFirst = await confirmedStaple([await sendBlock({ from: first, previous: headOf(network.genesis, first), to: receiver, amount: 10n, token: network.baseToken, network: network.network })], network.representatives);
			const fromSecond = await confirmedStaple([await sendBlock({ from: second, previous: headOf(network.genesis, second), to: receiver, amount: 20n, token: network.baseToken, network: network.network })], network.representatives);

			const applied = await ledger.run('suite-concurrent', function(transaction) {
				return(Promise.all([transaction.add(fromFirst), transaction.add(fromSecond)]));
			});

			expect(applied.flat()).toHaveLength(2);

			expect(await ledger.getBalance(first, network.baseToken)).toBe(390n);
			expect(await ledger.getBalance(second, network.baseToken)).toBe(280n);
			expect(await ledger.getBalance(receiver, network.baseToken)).toBe(330n);
			expect(await ledger.votingPower(requireAt(network.representatives, 2))).toBe(330n);
			expect(await ledger.votingPower()).toBe(1000n);
			expect((await ledger.getHeadBlock(first, 'main'))?.hash.toString()).toBe(headOf(fromFirst, first).toString());
			expect((await ledger.getHeadBlock(second, 'main'))?.hash.toString()).toBe(headOf(fromSecond, second).toString());
		});

		test('reads see the transaction\'s own writes', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);

			const seen = await ledger.run('suite-read-your-writes', async function(transaction) {
				const balanceBefore = await transaction.getBalance(user, network.baseToken);
				await transaction.add(network.genesis);
				return({
					balanceBefore,
					balanceAfter: await transaction.getBalance(user, network.baseToken),
					head: (await transaction.getHeadBlock(user, 'main'))?.hash.toString(),
					totalWeight: await transaction.votingPower()
				});
			});

			expect(seen).toEqual({
				balanceBefore: 0n,
				balanceAfter: 400n,
				head: headOf(network.genesis, user).toString(),
				totalWeight: 1000n
			});
		});

		test('ledger errors pass through evaluateError and anything else becomes non-retryable', async function() {
			const { storage, ledger } = await startNetwork();
			const retryable = lib.Error.fromJSON({ type: 'LEDGER', code: 'LEDGER_TRANSACTION_ABORTED', message: 'conflict', shouldRetry: true, retryDelay: 1 });
			const plain = new Error('disk on fire');

			const passed: unknown = await storage.evaluateError(retryable);
			const wrapped: unknown = await storage.evaluateError(plain);

			expect(passed).toBe(retryable);
			expect(lib.Error.isInstance(wrapped)).toBe(true);
			expect(wrapped).toMatchObject({ type: 'LEDGER', code: 'LEDGER_OTHER', shouldRetry: false, message: 'disk on fire' });
			if (!lib.Error.isInstance(wrapped)) {
				throw(new Error('evaluateError did not return a KeetaNet error'));
			}
			expect(wrapped.cause).toBe(plain);

			let retriedAttempts = 0;
			const retried = await ledger.run('suite-retry', function() {
				retriedAttempts++;
				if (retriedAttempts === 1) {
					return(Promise.reject(retryable));
				}
				return(Promise.resolve('committed'));
			});
			let failedAttempts = 0;
			const failure = ledger.run('suite-no-retry', function() {
				failedAttempts++;
				return(Promise.reject(plain));
			});

			expect(retried).toBe('committed');
			expect(retriedAttempts).toBe(2);
			await expect(failure).rejects.toMatchObject({ shouldRetry: false, message: 'disk on fire' });
			expect(failedAttempts).toBe(1);
		});

		test('expiry boundary matches the Vote class', async function() {
			const { network } = await startNetwork();
			const block = await firstUserSend(network);
			const validTo = new Date(GENESIS_MOMENT.getTime() + TEMPORARY_VOTE_LIFETIME_MILLISECONDS);
			const vote = await new lib.Vote.Builder(requireAt(network.representatives, 0), [block]).seal(1n, validTo);
			const edge = validTo.getTime() + voteExpirySlopMilliseconds;

			expect(vote.$permanent).toBe(false);
			expect(judgeAround(vote, edge)).toEqual([
				{ predicate: true, voteClass: true },
				{ predicate: true, voteClass: true },
				{ predicate: false, voteClass: false }
			]);
		});

		test('issued-in-the-future boundary matches the Vote class', async function() {
			const { network } = await startNetwork();
			const block = await firstUserSend(network);
			const validFrom = new Date(GENESIS_MOMENT.getTime() + TEMPORARY_VOTE_LIFETIME_MILLISECONDS);
			const validTo = new Date(validFrom.getTime() + TEMPORARY_VOTE_LIFETIME_MILLISECONDS);
			const signer = requireAt(network.representatives, 0);
			// Sealed as an issuer whose clock runs ahead would seal them.
			const issuerClock = { now: validFrom };
			const temporary = await new lib.Vote.Builder(signer, [block]).seal(1n, validTo, validFrom, issuerClock);
			const permanent = await new lib.Vote.Builder(signer, [block]).seal(2n, null, validFrom, issuerClock);
			const edge = validFrom.getTime() - voteExpirySlopMilliseconds;
			const expected = [
				{ predicate: false, voteClass: false },
				{ predicate: true, voteClass: true },
				{ predicate: true, voteClass: true }
			];

			expect(temporary.$permanent).toBe(false);
			expect(permanent.$permanent).toBe(true);
			expect(judgeAround(temporary, edge)).toEqual(expected);
			expect(judgeAround(permanent, edge)).toEqual(expected);
		});

		test('a permanent vote stays unexpired past the end of its validity', async function() {
			const { network } = await startNetwork();
			const block = await firstUserSend(network);
			const permanent = await new lib.Vote.Builder(requireAt(network.representatives, 0), [block]).seal(1n, null);
			const afterValidity = new Date(permanent.validityTo.getTime() + voteExpirySlopMilliseconds + 1);

			expect(permanent.$permanent).toBe(true);
			expect(isVoteUnexpired(permanent, afterValidity)).toBe(true);
		});
	});
}
