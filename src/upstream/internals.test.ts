import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { LedgerInternals } from './internals.js';

const Account = KeetaNet.lib.Account;

const senderSeed = '0000000000000000000000000000000000000000000000000000000000000001';
const recipientSeed = '0000000000000000000000000000000000000000000000000000000000000002';
const tokenSeed = '0000000000000000000000000000000000000000000000000000000000000003';

type StorageBase = InstanceType<typeof LedgerInternals.LedgerStorageBase>;

class ProbeStorage extends LedgerInternals.LedgerStorageBase {
	protected adjustDefer(): Promise<void> {
		return(Promise.reject(new Error('not implemented: adjustDefer')));
	}

	getBlockHeight(): Promise<bigint | null> {
		return(Promise.reject(new Error('not implemented: getBlockHeight')));
	}

	getHeadBlocks(): ReturnType<StorageBase['getHeadBlocks']> {
		return(Promise.reject(new Error('not implemented: getHeadBlocks')));
	}

	getVotesFromMultiplePrevious(): ReturnType<StorageBase['getVotesFromMultiplePrevious']> {
		return(Promise.reject(new Error('not implemented: getVotesFromMultiplePrevious')));
	}

	protected gcBatch(): Promise<boolean> {
		return(Promise.reject(new Error('not implemented: gcBatch')));
	}
}

describe('LedgerInternals', function() {
	test('exposes every driver internal', function() {
		expect(new ProbeStorage()).toBeInstanceOf(LedgerInternals.LedgerStorageBase);
		expect(typeof LedgerInternals.computeEffectOfBlocks).toBe('function');
		expect(typeof LedgerInternals.computeLedgerEffect).toBe('function');
		expect(typeof LedgerInternals.addTimeStatistic).toBe('function');
		expect(typeof LedgerInternals.IdempotentKey).toBe('function');
	});

	test('computeEffectOfBlocks reports the touched accounts of a block', async function() {
		const sender = Account.fromSeed(senderSeed, 0);
		const recipient = Account.fromSeed(recipientSeed, 0);
		const token = Account.fromSeed(tokenSeed, 0, Account.AccountKeyAlgorithm.TOKEN);
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
