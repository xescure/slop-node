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
import { SUITE_GROUPS } from './suite/types.js';
import type { DriverUnderTest, SuiteGroup } from './suite/types.js';
import { defineVoteCases } from './suite/votes.js';

const defineGroup: Readonly<Record<SuiteGroup, (driver: DriverUnderTest) => void>> = {
	transactions: defineTransactionCases,
	genesis: defineGenesisCases,
	confirmed: defineConfirmedCases,
	deferral: defineDeferralCases,
	votes: defineVoteCases,
	gc: defineGcCases,
	stats: defineStatsCases,
	concurrency: defineConcurrencyCases,
	canaries: defineCanaryCases
};

describe.each(driversUnderTest)('$name driver', function(driver) {
	for (const group of SUITE_GROUPS) {
		defineGroup[group](driver);
	}
});
