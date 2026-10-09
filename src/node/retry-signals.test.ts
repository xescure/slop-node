import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { DEFAULT_WEIGHTS, GENESIS_MOMENT, headOf, requireAt } from '../ledger/storage/suite/support.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { createTestNetwork, freezeClock } from '../testing/network.js';
import { awaitedOf, landedOn, weightSufficesOn } from './retry-signals.js';

describe('the signals the bootstrap retry queue watches for', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('a staple refused for weight awaits its voters, one refused otherwise the accounts its blocks name, and one added lands on its accounts and recipients', async function() {
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const sender = requireAt(network.users, 0);
		const recipient = requireAt(network.users, 1);
		const staple = await confirmedStaple([await sendBlock({ from: sender, previous: headOf(network.genesis, sender), to: recipient, amount: 1n, token: network.baseToken, network: network.network })], network.representatives.slice(0, 2));
		const keys = function(...accounts: readonly { readonly publicKeyString: { get(): string } }[]): string[] {
			return(accounts.map(function(account): string {
				return(account.publicKeyString.get());
			}).sort());
		};

		const weight = awaitedOf(staple, 'LEDGER_INSUFFICIENT_VOTING_WEIGHT');
		expect(weight.kind === 'weight' && [...weight.voters].sort()).toEqual(keys(...network.representatives.slice(0, 2)));
		const other = awaitedOf(staple, 'LEDGER_INVALID_BALANCE');
		expect(other.kind === 'accounts' && [...other.accounts].sort()).toEqual(keys(sender, recipient, network.baseToken));
		expect(landedOn([staple]).sort()).toEqual(keys(sender, recipient));
	});

	test('voters\' weight suffices once it passes two thirds of the weight delegated, as the ledger reads it', async function() {
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
		const ledger = network.createLedger(new MemoryLedgerStorage(), requireAt(network.representatives, 0));
		const [first, second, third] = network.representatives.map(function(representative): string {
			return(representative.publicKeyString.get());
		});
		if (first === undefined || second === undefined || third === undefined) {
			throw(new Error('three representatives expected'));
		}

		// No weight is delegated before genesis, when the ledger wants its trusted account's vote, which the offer checks.
		expect(await weightSufficesOn(ledger, [[first]])).toEqual([true]);
		await ledger.add(network.genesis);
		expect(await weightSufficesOn(ledger, [[first], [first, second], [second, third], [second, second]])).toEqual([false, true, false, false]);
	});
});
