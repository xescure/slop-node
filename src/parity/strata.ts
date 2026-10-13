import type { AccountKind } from './follower-store.js';

/** The operation types a block may carry, by the names the client gives them [Keeta TS] index.js:65626-65636. */
export const OPERATION_NAMES = ['SEND', 'SET_REP', 'SET_INFO', 'MODIFY_PERMISSIONS', 'CREATE_IDENTIFIER', 'TOKEN_ADMIN_SUPPLY', 'TOKEN_ADMIN_MODIFY_BALANCE', 'RECEIVE', 'MANAGE_CERTIFICATE'] as const;

export type OperationName = typeof OPERATION_NAMES[number];

export const ACCOUNT_KINDS: readonly AccountKind[] = ['token', 'storage', 'multisig', 'certificates', 'permissions'];

export type OperationStratum = `operation:${OperationName}`;

/**
 * A class of risk the API diff samples apart: accounts of a kind whose
 * answers differ most from a plain account's, blocks carrying each type of
 * operation, and the staples an independent decoder first refused.
 */
export type Stratum = AccountKind | OperationStratum | 'edge-cases';

export function operationStratum(name: OperationName): OperationStratum {
	return(`operation:${name}`);
}

export const STRATA: readonly Stratum[] = [...ACCOUNT_KINDS, ...OPERATION_NAMES.map(operationStratum), 'edge-cases'];

export function stratumOf(value: unknown): Stratum | undefined {
	return(STRATA.find(function(stratum): boolean {
		return(stratum === value);
	}));
}
