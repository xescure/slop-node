import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { LedgerStorageBase, computeLedgerEffect, addTimeStatistic } from '@keetanetwork/keetanet-client/lib/ledger/common.js';
import type { computeEffectOfBlocks } from '@keetanetwork/keetanet-client/lib/ledger/effects.js';
import type { IdempotentKey } from '@keetanetwork/keetanet-client/lib/ledger/index.js';

export type LedgerInternalsAPI = {
	readonly LedgerStorageBase: typeof LedgerStorageBase;
	readonly computeEffectOfBlocks: typeof computeEffectOfBlocks;
	readonly computeLedgerEffect: typeof computeLedgerEffect;
	readonly addTimeStatistic: typeof addTimeStatistic;
	readonly IdempotentKey: typeof IdempotentKey;
};

const requiredInternals = {
	LedgerStorageBase: true,
	computeEffectOfBlocks: true,
	computeLedgerEffect: true,
	addTimeStatistic: true,
	IdempotentKey: true
} satisfies Record<keyof LedgerInternalsAPI, true>;

function findMissingInternals(candidate: object | undefined): string[] {
	return(Object.keys(requiredInternals).filter(function(name) {
		return(candidate === undefined || Reflect.get(candidate, name) === undefined);
	}));
}

// The published package does not export these; patches/ adds them to lib.
const exposed: object | undefined = KeetaNet.lib.LedgerInternals;
const missing = findMissingInternals(exposed);
if (missing.length > 0) {
	throw(new Error(`upstream ledger internals are not exposed: ${missing.join(', ')}`));
}

export const LedgerInternals: LedgerInternalsAPI = KeetaNet.lib.LedgerInternals;
