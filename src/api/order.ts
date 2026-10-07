import type { ACLRow, GetAllBalancesResponse } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { Vote } from '@keetanetwork/keetanet-client/lib/vote.js';
import { assertNever } from '../util/assert-never.js';
import { compareText } from '../util/compare-text.js';

/*
 * A representative lists balances, permissions and votes in the order of the
 * texts that name them, whatever order its storage holds them in, so these
 * answers do not depend on the storage driver.
 */

/** Orders by the first key that differs. */
function compareKeys(left: readonly string[], right: readonly string[]): number {
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const order = compareText(left[index] ?? '', right[index] ?? '');
		if (order !== 0) {
			return(order);
		}
	}
	return(left.length - right.length);
}

function sortedBy<Entry>(entries: readonly Entry[], keys: (entry: Entry) => readonly string[]): Entry[] {
	return([...entries].sort(function(left, right): number {
		return(compareKeys(keys(left), keys(right)));
	}));
}

/** An account's balances by token. */
export function balancesByToken(balances: GetAllBalancesResponse): GetAllBalancesResponse {
	return(sortedBy(balances, function(entry): readonly string[] {
		return([entry.token.publicKeyString.get()]);
	}));
}

/** A principal's permissions by entity, then target. */
export function permissionsByEntity(rows: readonly ACLRow[]): ACLRow[] {
	return(sortedBy(rows, function(row): readonly string[] {
		return([row.entity.publicKeyString.get(), row.target.publicKeyString.get()]);
	}));
}

/**
 * The principal's account, then the certificate it holds the permissions
 * through, an account principal's rows first, then the target.
 */
function principalKeys(row: ACLRow): readonly string[] {
	const target = row.target.publicKeyString.get();
	switch (row.principalType) {
		case 'ACCOUNT':
			return([row.principal.publicKeyString.get(), '', target]);
		case 'CERTIFICATE':
			return([row.principal.certificateAccount.publicKeyString.get(), row.principal.certificate.toString(), target]);
		default:
			return(assertNever(row));
	}
}

/** The permissions on an entity by principal. */
export function permissionsByPrincipal(rows: readonly ACLRow[]): ACLRow[] {
	return(sortedBy(rows, principalKeys));
}

/** A block's votes by their ID, the hash of their issuer and serial [Keeta TS] index.js:80569-80570. */
export function votesByID(votes: readonly Vote[]): Vote[] {
	return(sortedBy(votes, function(vote): readonly string[] {
		return([vote.$id]);
	}));
}
