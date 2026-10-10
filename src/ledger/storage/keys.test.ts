import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { parseAccountKey, toAccountKey } from './keys.js';

const lib = KeetaNet.lib;

const SEED = '3c5e7f9b1d3f5a7c9e0b2d4f6a8c1e3b5d7f9a0c2e4b6d8f1a3c5e4b8e2d6f0a';

describe('account keys', function() {
	test('a parsed string names the account toPublicKeyString names, in either spelling, with its key type', function() {
		const user = lib.Account.fromSeed(SEED, 0);
		const token = user.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);
		for (const account of [user, token]) {
			for (const spelling of [account.publicKeyString.get(), account.publicKeyAndTypeString]) {
				expect(parseAccountKey(spelling)).toEqual({ key: lib.Account.toPublicKeyString(spelling), keyType: account.keyType });
				expect(toAccountKey(spelling)).toBe(account.publicKeyString.get());
			}
		}
	});

	test('a string is parsed once while its parse is kept', function() {
		const spelling = lib.Account.fromSeed(SEED, 1).publicKeyString.get();
		expect(parseAccountKey(spelling)).toBe(parseAccountKey(spelling));
	});

	test('a string that names no account is refused every time', function() {
		const spelling = `${lib.Account.fromSeed(SEED, 2).publicKeyString.get().slice(0, -1)}x`;
		expect(function() {
			return(parseAccountKey(spelling));
		}).toThrow();
		expect(function() {
			return(parseAccountKey(spelling));
		}).toThrow();
	});
});
