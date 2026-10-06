import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import { LedgerStorageSkeleton } from './skeleton.js';

const Account = KeetaNet.lib.Account;

function buildLedger(storageDriver: LedgerStorageSkeleton) {
	const representative = Account.fromSeed(Account.generateRandomSeed(), 0);
	const other = Account.fromSeed(Account.generateRandomSeed(), 0);
	const trustedRoot = Account.fromPublicKeyString(other.publicKeyString.get());
	const token = Account.fromSeed(Account.generateRandomSeed(), 0, Account.AccountKeyAlgorithm.TOKEN);
	const ledger = new KeetaNet.lib.Ledger({
		kind: KeetaNet.lib.Ledger.Kind.REPRESENTATIVE,
		privateKey: representative,
		initialTrustedAccount: trustedRoot,
		network: 0n,
		computeFeeFromBlocks: () => null,
		storageDriver
	});

	return({ ledger, representative, token });
}

describe('LedgerStorageSkeleton', function() {
	test('Keeta Ledger initializes the skeleton with itself', function() {
		const storageDriver = new LedgerStorageSkeleton();
		const init = vi.spyOn(storageDriver, 'init');

		const { ledger } = buildLedger(storageDriver);

		expect(init).toHaveBeenCalledTimes(1);
		expect(init).toHaveBeenCalledWith(expect.anything(), ledger);
	});

	test('ledger operations enter the driver and surface its not-implemented failure', async function() {
		const storageDriver = new LedgerStorageSkeleton();
		const beginTransaction = vi.spyOn(storageDriver, 'beginTransaction');
		const { ledger, representative, token } = buildLedger(storageDriver);

		await expect(ledger.getBalance(representative, token)).rejects.toThrow(/^not implemented: /);
		expect(beginTransaction).toHaveBeenCalled();
	});

	test('skeleton satisfies the full storage contract', function() {
		expectTypeOf<LedgerStorageSkeleton>().toExtend<LedgerStorageAPI>();
	});
});
