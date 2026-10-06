import { describe } from 'vitest';
import { MemoryLedgerStorage } from './memory/driver.js';
import { defineDeferralCases } from './suite/deferral.js';
import { defineGenesisCases } from './suite/genesis.js';
import { defineTransactionCases } from './suite/transactions.js';
import type { DriverUnderTest } from './suite/types.js';

const drivers = [
	{
		name: 'memory',
		create: function() {
			return(new MemoryLedgerStorage());
		},
		destroy: function() {
			return(Promise.resolve());
		}
	}
] as const satisfies readonly DriverUnderTest[];

describe.each(drivers)('$name driver', function(driver) {
	defineTransactionCases(driver);
	defineGenesisCases(driver);
	defineDeferralCases(driver);
});
