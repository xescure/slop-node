import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { LedgerInternals } from './internals.js';

const Account = KeetaNet.lib.Account;

describe('LedgerInternals', function() {
	test('exposes every driver internal', function() {
		expect(typeof LedgerInternals.LedgerStorageBase).toBe('function');
		expect(LedgerInternals.LedgerStorageBase.prototype).toBeDefined();
		expect(typeof LedgerInternals.computeEffectOfBlocks).toBe('function');
		expect(typeof LedgerInternals.computeLedgerEffect).toBe('function');
		expect(typeof LedgerInternals.addTimeStatistic).toBe('function');
		expect(typeof LedgerInternals.IdempotentKey).toBe('function');
	});

	test('computeEffectOfBlocks reports the touched accounts of a block', async function() {
		const sender = Account.fromSeed(Account.generateRandomSeed(), 0);
		const recipient = Account.fromSeed(Account.generateRandomSeed(), 0);
		const token = Account.fromSeed(Account.generateRandomSeed(), 0, Account.AccountKeyAlgorithm.TOKEN);
		const builder = new KeetaNet.lib.Block.Builder();
		builder.account = sender;
		builder.signer = sender;
		builder.network = 0n;
		builder.previous = KeetaNet.lib.Block.Builder.NO_PREVIOUS;
		builder.date = new Date(0);
		builder.addOperation({
			type: KeetaNet.lib.Block.OperationType.SEND,
			to: recipient,
			amount: 1n,
			token
		});
		const block = await builder.seal();

		const effect = LedgerInternals.computeEffectOfBlocks([block]);

		expect(effect.touched.has(sender)).toBe(true);
	});
});
