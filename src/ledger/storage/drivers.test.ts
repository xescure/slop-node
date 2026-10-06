import { describe } from 'vitest';
import { defineCanaryCases } from './suite/canaries.js';
import { defineConcurrencyCases } from './suite/concurrency.js';
import { defineConfirmedCases } from './suite/confirmed.js';
import { defineDeferralCases } from './suite/deferral.js';
import { driversUnderTest } from './suite/drivers.js';
import { defineGcCases } from './suite/gc.js';
import { defineGenesisCases } from './suite/genesis.js';
import { defineStatsCases } from './suite/stats.js';
import { defineTransactionCases } from './suite/transactions.js';
import { defineVoteCases } from './suite/votes.js';

describe.each(driversUnderTest)('$name driver', function(driver) {
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
