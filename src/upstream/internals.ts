import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { LedgerStorageBase, computeLedgerEffect, addTimeStatistic } from '@keetanetwork/keetanet-client/lib/ledger/common.js';
import type { computeEffectOfBlocks } from '@keetanetwork/keetanet-client/lib/ledger/effects.js';
import type { IdempotentKey } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { StatsPending as StatsPendingClass } from '@keetanetwork/keetanet-client/lib/stats.js';

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

function isStatsPendingConstructor(candidate: unknown): candidate is typeof StatsPendingClass {
	return(typeof candidate === 'function' && candidate.name === 'StatsPending' && KeetaNet.lib.Stats.prototype instanceof candidate);
}

/*
 * Every storage transaction carries upstream's own pending-statistics
 * accumulator, which Stats.merge consumes on commit. The package exports only
 * its subclass Stats, so the class is reached as that export's parent.
 * [Keeta TS] index.js:74304-74352, 68952-68960
 */
const statsParent: unknown = Object.getPrototypeOf(KeetaNet.lib.Stats);
if (!isStatsPendingConstructor(statsParent)) {
	throw(new Error('upstream StatsPending is no longer the parent class of lib.Stats'));
}

export const StatsPending: typeof StatsPendingClass = statsParent;
