import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { StrandedDeferredStaple } from '../ledger/storage/base.js';
import { backoffAfter } from './bootstrap-retry.js';
import type { Awaited } from './bootstrap-retry.js';

const lib = KeetaNet.lib;

/** The refusal of votes whose voters' weight is too little [Keeta TS] index.js:70433-70436. */
const INSUFFICIENT_WEIGHT = 'LEDGER_INSUFFICIENT_VOTING_WEIGHT';

function keyOf(account: GenericAccount): string {
	return(account.publicKeyString.get());
}

function signersOf(block: Block): GenericAccount[] {
	const signers: GenericAccount[] = [];
	const pending: Block['signer'][] = [block.signer];
	for (let signer = pending.shift(); signer !== undefined; signer = pending.shift()) {
		if (Array.isArray(signer)) {
			signers.push(signer[0]);
			pending.push(...signer[1]);
		} else {
			signers.push(signer);
		}
	}
	return(signers);
}

/**
 * The accounts the staples' blocks change on the ledger: each block's
 * account, whose chain, balances, permissions and certificates its own
 * blocks set, and the accounts its sends credit.
 * [Keeta TS] index.js:69203-69264
 */
export function landedOn(staples: readonly VoteStaple[]): string[] {
	const landed = new Set<string>();
	for (const block of staples.flatMap(function(staple) {
		return(staple.blocks);
	})) {
		landed.add(keyOf(block.account));
		for (const operation of block.operations) {
			if (operation.type === lib.Block.OperationType.SEND) {
				landed.add(keyOf(operation.to));
			} else if (operation.type === lib.Block.OperationType.RECEIVE && operation.forward !== undefined) {
				landed.add(keyOf(operation.forward));
			}
		}
	}
	return([...landed]);
}

/**
 * What a staple the ledger refused with the code awaits: its voters'
 * weight, when that was too little; otherwise a staple on an account its
 * blocks name, which changes what the ledger checked against: a block's
 * account or signer, a send's recipient or token, a receive's sender.
 */
export function awaitedOf(staple: VoteStaple, code: string): Awaited {
	if (code === INSUFFICIENT_WEIGHT) {
		return({ kind: 'weight', voters: [...new Set(staple.votes.map(function(vote): string {
			return(keyOf(vote.issuer));
		}))] });
	}
	const accounts = new Set<string>();
	for (const block of staple.blocks) {
		for (const account of [block.account, ...signersOf(block)]) {
			accounts.add(keyOf(account));
		}
		for (const operation of block.operations) {
			if (operation.type === lib.Block.OperationType.SEND) {
				accounts.add(keyOf(operation.to));
				accounts.add(keyOf(operation.token));
			} else if (operation.type === lib.Block.OperationType.RECEIVE) {
				accounts.add(keyOf(operation.from));
				accounts.add(keyOf(operation.token));
			}
		}
	}
	return({ kind: 'accounts', accounts: [...accounts] });
}

/**
 * For each set of voters, whether their weight passes the ledger's own
 * check, read from one view of the ledger: more than two thirds of the
 * weight delegated in all. With no weight delegated at all, the ledger
 * wants a vote of its trusted account instead, which the offer itself
 * checks.
 * [Keeta TS] index.js:70776-70796
 */
export async function weightSufficesOn(ledger: Pick<Ledger, 'runReadOnly'>, voterSets: readonly (readonly string[])[]): Promise<boolean[]> {
	return(await ledger.runReadOnly('bootstrap-retry-weight', async function(reader): Promise<boolean[]> {
		const total = await reader.votingPower();
		if (total === 0n) {
			return(voterSets.map(function(): boolean {
				return(true);
			}));
		}
		const required = ((total * 2n) / 3n) + 1n;
		const weights = new Map<string, bigint>();
		for (const voter of new Set(voterSets.flat())) {
			const representative: Account = lib.Account.fromPublicKeyString(voter).assertAccount();
			weights.set(voter, await reader.votingPower(representative));
		}
		return(voterSets.map(function(voters): boolean {
			let weight = 0n;
			for (const voter of new Set(voters)) {
				weight += weights.get(voter) ?? 0n;
			}
			return(weight >= required);
		}));
	}));
}

/**
 * How many deferred staples awaiting blocks the main ledger lacks an update
 * reads to find those blocks, a page after the one the update before read:
 * a chain of such staples awaits, but for its first, blocks its own staples
 * carry, which no peer need be asked for, and one chain longer than a page
 * would otherwise hide every chain after it.
 */
export const STRANDED_READ = 64;

/** How many lacked blocks one update asks the peers for at most, so that it waits on at most so many rounds of requests. */
export const MOST_LACKED_PER_UPDATE = 8;

/** A lacked block asked for that did not land: how often, and when last. */
export type Unanswered = { readonly asked: number; readonly at: number };

/**
 * The blocks the staples lack that none of them carries, nor any staple of
 * a page read before in the same round, each once, in the order the staples
 * are listed: what the earliest staple of each chain of them lacks. Those
 * asked for whose wait since (backoffAfter) has not passed are left out, and
 * at most so many are given.
 */
export function dueLackedBlocks(stranded: readonly StrandedDeferredStaple[], carriedBefore: ReadonlySet<string>, unanswered: ReadonlyMap<string, Unanswered>, now: number, most: number): BlockHash[] {
	const carried = new Set<string>(carriedBefore);
	for (const { staple } of stranded) {
		for (const block of staple.blocks) {
			carried.add(block.hash.toString());
		}
	}
	const lacked = new Map<string, BlockHash>();
	for (const { lacks } of stranded) {
		for (const block of lacks) {
			const key = block.toString();
			const asked = unanswered.get(key);
			if (!carried.has(key) && (asked === undefined || now >= asked.at + backoffAfter(asked.asked))) {
				lacked.set(key, block);
			}
		}
	}
	return([...lacked.values()].slice(0, most));
}
