import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { balancesOfHistory, selfCheckOf } from './self-check.js';

const lib = KeetaNet.lib;

const NETWORK = 0x5382n;

const SEED = '8f1b3c5d7e9fa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182930';
const owner = lib.Account.fromSeed(SEED, 0);
const other = lib.Account.fromSeed(SEED, 1);
const representative = lib.Account.fromSeed(SEED, 2);
const token: TokenAddress = owner.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);
const TOKEN = token.publicKeyString.get();
const OTHER = other.publicKeyString.get();

async function sendsToOther(amounts: readonly bigint[]) {
	const staples = [];
	let previous: BlockHash | null = null;
	for (const [index, amount] of amounts.entries()) {
		const block = await sendBlock({ from: owner, to: other, amount, token, previous, network: NETWORK, date: new Date(Date.UTC(2025, 10, 1, 0, index)) });
		previous = block.hash;
		staples.push(await confirmedStaple([block], [representative]));
	}
	return(staples);
}

describe('the follower\'s balances against its own history', function() {
	test('are the net of the balance changes of every staple of an account\'s history, by token', async function() {
		const staples = await sendsToOther([5n, 7n]);
		expect(balancesOfHistory(staples, OTHER)).toEqual(new Map([[TOKEN, 12n]]));
		expect(balancesOfHistory(staples, owner.publicKeyString.get())).toEqual(new Map([[TOKEN, -12n]]));
	});

	test('agree with a served state that holds them, and name the first token they do not', function() {
		const fromHistory = new Map([[TOKEN, 12n]]);
		expect(selfCheckOf({ account: OTHER, balances: [{ token: TOKEN, balance: '0xC' }] }, fromHistory)).toEqual({ kind: 'consistent', tokens: 1 });
		expect(selfCheckOf({ account: OTHER, balances: [{ token: TOKEN, balance: '0xD' }] }, fromHistory)).toEqual({ kind: 'inconsistent', token: TOKEN, served: '0xD', fromHistory: '0xC' });
		expect(selfCheckOf({ account: OTHER, balances: [] }, fromHistory)).toEqual({ kind: 'inconsistent', token: TOKEN, served: '0x0', fromHistory: '0xC' });
		expect(selfCheckOf({ error: true }, fromHistory)).toEqual({ kind: 'unchecked', why: 'the follower served no state with balances' });
	});
});
