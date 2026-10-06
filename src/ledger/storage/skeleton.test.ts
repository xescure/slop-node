import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account as AccountInstance, AccountKeyAlgorithm } from '@keetanetwork/keetanet-client/lib/account.js';
import type { LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { AccountInfoForType } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
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

	test('operations reject instead of throwing synchronously', async function() {
		const storageDriver = new LedgerStorageSkeleton();

		await expect(storageDriver.stats()).rejects.toThrow('not implemented: stats');
	});

	test('a subclass can override getAccountInfo as a method', async function() {
		class OverridingStorage extends LedgerStorageSkeleton {
			override getAccountInfo<T extends AccountKeyAlgorithm = AccountKeyAlgorithm>(transaction: Parameters<LedgerStorageAPI['getAccountInfo']>[0], account: AccountInstance<T> | string): Promise<AccountInfoForType<T>> {
				return(super.getAccountInfo(transaction, account));
			}
		}

		expectTypeOf<OverridingStorage>().toExtend<LedgerStorageAPI>();
		await expect(new OverridingStorage().getAccountInfo(undefined, 'any')).rejects.toThrow('not implemented: getAccountInfo');
	});
});
