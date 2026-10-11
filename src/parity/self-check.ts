import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals } from '../upstream/internals.js';
import type { SelfCheck } from './log.js';

const lib = KeetaNet.lib;

/**
 * The balance of each token an account's history leaves it with: the net of
 * every change to its balances the staples of that history make, in order,
 * as the ledger computes their effects [Keeta TS] index.js:68117-68160,
 * 68195-68305. A send's sender and recipient, a forwarded receive, a
 * supply change and a modified balance all list the staple in the history
 * of the account whose balance moves (schema/CONTRACT.md, D18), so no other
 * staple changes them; a receive the block requires changes nothing itself.
 */
export function balancesOfHistory(staples: readonly VoteStaple[], account: string): ReadonlyMap<string, bigint> {
	const balances = new Map<string, bigint>();
	foldBalances(balances, staples, account);
	return(balances);
}

/** Folds the balance changes the staples make to the account into the balances given, in order, as balancesOfHistory does over a whole history. */
export function foldBalances(balances: Map<string, bigint>, staples: readonly VoteStaple[], account: string): void {
	for (const staple of staples) {
		const [first] = staple.blocks;
		if (first === undefined) {
			continue;
		}
		const { baseToken, networkAddress } = lib.Account.generateBaseAddresses(first.network);
		const effect = LedgerInternals.computeEffectOfBlocks([...staple.blocks], { baseToken, networkAddress }).accounts[account];
		if (effect === undefined || effect.type !== 'ACCOUNT') {
			continue;
		}
		for (const [token, entries] of Object.entries(effect.fields.balance ?? {})) {
			for (const entry of entries) {
				if (entry.isReceive) {
					continue;
				}
				let balance = (balances.get(token) ?? 0n) + entry.value;
				if (entry.set) {
					balance = entry.value;
				}
				balances.set(token, balance);
			}
		}
	}
}

function isFields(value: unknown): value is Readonly<Record<string, unknown>> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** The balances a state serves, by token, or nothing when it serves none. */
function servedBalances(state: unknown): ReadonlyMap<string, bigint> | undefined {
	if (!isFields(state) || !Array.isArray(state['balances'])) {
		return(undefined);
	}
	const balances = new Map<string, bigint>();
	for (const entry of state['balances']) {
		if (!isFields(entry) || typeof entry['token'] !== 'string' || typeof entry['balance'] !== 'string') {
			return(undefined);
		}
		balances.set(entry['token'], BigInt(entry['balance']));
	}
	return(balances);
}

function hex(value: bigint): string {
	return(`0x${value.toString(16).toUpperCase()}`);
}

/** Whether the balances the follower serves are those its own history leaves the account with, token by token. */
export function selfCheckOf(state: unknown, fromHistory: ReadonlyMap<string, bigint>): SelfCheck {
	const served = servedBalances(state);
	if (served === undefined) {
		return({ kind: 'unchecked', why: 'the follower served no state with balances' });
	}
	const tokens = [...new Set([...served.keys(), ...fromHistory.keys()])].sort();
	for (const token of tokens) {
		const own = served.get(token) ?? 0n;
		const expected = fromHistory.get(token) ?? 0n;
		if (own !== expected) {
			return({ kind: 'inconsistent', token, served: hex(own), fromHistory: hex(expected) });
		}
	}
	return({ kind: 'consistent', tokens: tokens.length });
}
