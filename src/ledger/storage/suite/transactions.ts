import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { LedgerInternals } from '../../../upstream/internals.js';
import { freezeClock } from '../../../testing/network.js';
import { confirmedStaple, sendBlock } from '../../../testing/blocks.js';
import { isVoteLive, voteExpirySlopMilliseconds } from '../expiry.js';
import { GENESIS_MOMENT, headOf, requireAt, useFixtures } from './support.js';
import type { DriverUnderTest } from './types.js';

const lib = KeetaNet.lib;

const TEMPORARY_VOTE_LIFETIME_MILLISECONDS = 5 * 60 * 1000;

function constructsAsVote(bytes: ArrayBuffer): boolean {
	try {
		new lib.Vote(bytes);
		return(true);
	} catch (error: unknown) {
		if (lib.Error.isInstance(error) && error.code === 'VOTE_EXPIRED') {
			return(false);
		}
		throw(error);
	}
}

export function defineTransactionCases(driver: DriverUnderTest): void {
	describe('transactions', function() {
		const startNetwork = useFixtures(driver);

		test('a driver serves exactly one ledger', async function() {
			const { network, storage, ledger } = await startNetwork();
			const effects = LedgerInternals.computeEffectOfBlocks(network.genesis.blocks, ledger);
			const unbound = driver.create();
			try {
				const transaction = await unbound.beginTransaction({ identifier: 'suite-unbound', readOnly: false });
				await expect(unbound.adjust(transaction, network.genesis, effects)).rejects.toThrow('storage driver used before Ledger called init()');
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
			const retryable = lib.Error.fromJSON({ type: 'LEDGER', code: 'LEDGER_TRANSACTION_ABORTED', message: 'conflict', shouldRetry: true, retryDelay: 0 });
			const plain = new Error('disk on fire');

			const passed: unknown = await storage.evaluateError(retryable);
			const wrapped: unknown = await storage.evaluateError(plain);

			expect(passed).toBe(retryable);
			expect(lib.Error.isInstance(wrapped)).toBe(true);
			expect(wrapped).toMatchObject({ type: 'LEDGER', shouldRetry: false, message: 'disk on fire' });

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
			const user = requireAt(network.users, 0);
			const block = await sendBlock({ from: user, previous: headOf(network.genesis, user), to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, network: network.network });
			const validTo = new Date(GENESIS_MOMENT.getTime() + TEMPORARY_VOTE_LIFETIME_MILLISECONDS);
			const vote = await new lib.Vote.Builder(requireAt(network.representatives, 0), [block]).seal(1n, validTo);
			const edge = validTo.getTime() + voteExpirySlopMilliseconds;

			const verdicts = [edge - 1, edge, edge + 1].map(function(milliseconds) {
				const moment = new Date(milliseconds);
				freezeClock(moment);
				return({ predicate: isVoteLive(vote, moment), voteClass: constructsAsVote(vote.toBytes()) });
			});

			expect(vote.$permanent).toBe(false);
			expect(verdicts).toEqual([
				{ predicate: true, voteClass: true },
				{ predicate: true, voteClass: true },
				{ predicate: false, voteClass: false }
			]);
		});
	});
}
