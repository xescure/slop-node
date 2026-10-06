import { describe } from 'vitest';
import { MemoryLedgerStorage } from './memory/driver.js';
import { defineCanaryCases } from './suite/canaries.js';
import { defineConcurrencyCases } from './suite/concurrency.js';
import { defineConfirmedCases } from './suite/confirmed.js';
import { defineDeferralCases } from './suite/deferral.js';
import { defineGcCases } from './suite/gc.js';
import { defineGenesisCases } from './suite/genesis.js';
import { defineStatsCases } from './suite/stats.js';
import { defineTransactionCases } from './suite/transactions.js';
import type { DriverUnderTest } from './suite/types.js';
import { defineVoteCases } from './suite/votes.js';

const drivers = [
	{
		name: 'memory',
		create: function() {
			return(Promise.resolve(new MemoryLedgerStorage()));
		},
		destroy: function() {
			return(Promise.resolve());
		}
	}
] as const satisfies readonly DriverUnderTest[];

describe.each(drivers)('$name driver', function(driver) {
	defineTransactionCases(driver);
	defineGenesisCases(driver);
	defineConfirmedCases(driver);
	defineDeferralCases(driver);
	defineVoteCases(driver);
	defineGcCases(driver);
	defineStatsCases(driver);
	defineConcurrencyCases(driver);
	defineCanaryCases(driver);
});
