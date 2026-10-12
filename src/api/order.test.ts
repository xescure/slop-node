import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { ACLRow } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import { TEST_NETWORK_SEEDS } from '../testing/network.js';
import { compareText } from '../util/compare-text.js';
import { balancesByToken, permissionsByEntity, permissionsByPrincipal } from './order.js';

const lib = KeetaNet.lib;

/** Accounts in the order their public key strings sort, as a representative lists them. */
function orderedAccounts(count: number): GenericAccount[] {
	return(Array.from({ length: count }, function(_unused, index): GenericAccount {
		return(lib.Account.fromSeed(TEST_NETWORK_SEEDS.user, index + 10));
	}).sort(function(left, right): number {
		return(compareText(left.publicKeyString.get(), right.publicKeyString.get()));
	}));
}

function orderedTokens(count: number): TokenAddress[] {
	const issuer = lib.Account.fromSeed(TEST_NETWORK_SEEDS.user, 9);
	return(Array.from({ length: count }, function(_unused, index): TokenAddress {
		return(issuer.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, index));
	}).sort(function(left, right): number {
		return(compareText(left.publicKeyString.get(), right.publicKeyString.get()));
	}));
}

function accountRow(principal: GenericAccount, entity: GenericAccount, target: GenericAccount): ACLRow {
	return({ principalType: 'ACCOUNT', principal, entity, target, permissions: new lib.Permissions(['ACCESS']) });
}

function certificateRow(certificateAccount: GenericAccount, entity: GenericAccount, target: GenericAccount): ACLRow {
	const principal = { usingCertificate: true as const, certificate: new lib.Utils.Certificate.CertificateHash('0'.repeat(64)), certificateAccount };
	return({ principalType: 'CERTIFICATE', principal, entity, target, permissions: new lib.Permissions(['ACCESS']) });
}

describe('lists a representative orders by the texts that name their entries', function() {
	test('balances by token, whatever order the storage gives them in', function() {
		const [first, second, third] = orderedTokens(3);
		if (first === undefined || second === undefined || third === undefined) {
			throw(new Error('three tokens were made'));
		}

		expect(balancesByToken([{ token: third, balance: 3n }, { token: first, balance: 1n }, { token: second, balance: 2n }])).toEqual([
			{ token: first, balance: 1n },
			{ token: second, balance: 2n },
			{ token: third, balance: 3n }
		]);
	});

	test('permissions by entity, then by target on the same entity', function() {
		const [principal, entity, otherEntity, firstTarget, secondTarget] = orderedAccounts(5);
		if (principal === undefined || entity === undefined || otherEntity === undefined || firstTarget === undefined || secondTarget === undefined) {
			throw(new Error('five accounts were made'));
		}
		const rows = [
			accountRow(principal, otherEntity, firstTarget),
			accountRow(principal, entity, secondTarget),
			accountRow(principal, entity, firstTarget)
		];

		expect(permissionsByEntity(rows)).toEqual([rows[2], rows[1], rows[0]]);
	});

	test('permissions by principal, an account\'s own rows before those it holds through a certificate, then by target', function() {
		const [principal, otherPrincipal, entity, firstTarget, secondTarget] = orderedAccounts(5);
		if (principal === undefined || otherPrincipal === undefined || entity === undefined || firstTarget === undefined || secondTarget === undefined) {
			throw(new Error('five accounts were made'));
		}
		const rows = [
			accountRow(otherPrincipal, entity, firstTarget),
			certificateRow(principal, entity, firstTarget),
			accountRow(principal, entity, secondTarget),
			accountRow(principal, entity, firstTarget)
		];

		expect(permissionsByPrincipal(rows)).toEqual([rows[3], rows[2], rows[1], rows[0]]);
	});
});
