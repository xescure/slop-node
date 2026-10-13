import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { publicOnly } from '../node/config.js';
import type { Environment } from '../node/config.js';
import { assertNever } from '../util/assert-never.js';

const lib = KeetaNet.lib;

export type UserClient = InstanceType<typeof KeetaNet.UserClient>;

export const REPRESENTATIVE_INDEXES = [0, 1, 2, 3] as const;

export type RepresentativeIndex = typeof REPRESENTATIVE_INDEXES[number];

/** One value for each representative of the devnet. */
export type PerRepresentative<Value> = { readonly [Index in RepresentativeIndex]: Value };

export type RepresentativeWeights = PerRepresentative<bigint>;

export function perRepresentative<Value>(valueOf: (index: RepresentativeIndex) => Value): PerRepresentative<Value> {
	return({ 0: valueOf(0), 1: valueOf(1), 2: valueOf(2), 3: valueOf(3) });
}

/** The value of every representative, awaited together. */
export async function settledPerRepresentative<Value>(pending: PerRepresentative<Promise<Value>>): Promise<PerRepresentative<Value>> {
	const [zero, one, two, three] = await Promise.all([pending[0], pending[1], pending[2], pending[3]]);
	return({ 0: zero, 1: one, 2: two, 3: three });
}

/** Every key of the devnet derives from one of these at an index. */
const SEEDS = {
	trusted: '9c41e7b2d05a8f36c1e94b7d2a60f85c3e17d9a4b28f6c05e3d1a97b4c62f08e',
	representative: '3f8a1c6e9d24b57f0a3c8e1d6b49f27a5c0e83d1b6f49a27c5e08d3b1f6a94c2',
	holder: 'd27b5e0a9c34f81e6b2d07a5c93f4e18b6d20a7c5e9f31b4d8a62c07e5f9b1d3',
	faucet: '61c9f3a7e2b85d04c7a1e6f39b2d58c0a4e7f12b9d63c85a0e4b7f2d16c9a53e',
	feeAccount: 'a5e2c8f14b7d30e9a6c2f57d1b84e03c9a6f2d58b1e47c03a9d6f25b8e14c7a0',
	user: '7e04b9d2f6a13c58e0b7d4f29a6c31e85b0d7f4a2c96e13b58d0f7a4c2e96b1d'
} as const;

export const TRUSTED_SIGNER: Account = lib.Account.fromSeed(SEEDS.trusted, 0);

/** The network's trusted account, as every node is given it. */
export const TRUSTED_ACCOUNT: Account = publicOnly(TRUSTED_SIGNER);

/** The faucet's seed, which a user of the devnet signs with to fund accounts of their own. */
export const FAUCET_SEED: string = SEEDS.faucet;

/** Holds the spending money of the devnet and delegates to no representative, so spending it moves no voting weight. */
export const FAUCET: Account = lib.Account.fromSeed(FAUCET_SEED, 0);

export const REPRESENTATIVE_SEED: string = SEEDS.representative;

export function representativeOf(index: RepresentativeIndex): Account {
	return(publicOnly(lib.Account.fromSeed(SEEDS.representative, index)));
}

/**
 * The account holding the weight delegated to a representative. Genesis
 * delegates the supply to the first representative through the trusted
 * account, which keeps that one's share itself.
 */
function holderOf(index: Exclude<RepresentativeIndex, 0>): Account {
	return(lib.Account.fromSeed(SEEDS.holder, index));
}

/** A user account of the scenarios, from a fixed seed, never one of the devnet's own. */
export function userOf(index: number): Account {
	return(lib.Account.fromSeed(SEEDS.user, index));
}

/** The weight delegated to each representative, before the fees its holder pays. */
export const DELEGATED_WEIGHT = 1_000_000_000n;

export const FAUCET_BALANCE = 1_000_000_000_000n;

export const SUPPLY: bigint = (DELEGATED_WEIGHT * BigInt(REPRESENTATIVE_INDEXES.length)) + FAUCET_BALANCE;

export const PLANNED_WEIGHTS: RepresentativeWeights = perRepresentative(function(): bigint {
	return(DELEGATED_WEIGHT);
});

/*
 * Anyone may create tokens and storage accounts, as on a development
 * network; the genesis command's default grants storage accounts only.
 */
const NETWORK_DEFAULT_PERMISSION = ['ACCESS', 'STORAGE_CREATE', 'TOKEN_ADMIN_CREATE'] as const;

/** What the genesis command reads besides the first node's own settings. */
export const GENESIS_ENVIRONMENT: Environment = {
	KEETANET_GENESIS_TRUSTED_SEED: SEEDS.trusted,
	KEETANET_GENESIS_SUPPLY: String(SUPPLY),
	KEETANET_GENESIS_NETWORK_DEFAULT_PERMISSION: NETWORK_DEFAULT_PERMISSION.join(',')
};

/** Who a representative's fee is paid to: an account of its own, or the representative when none is named. */
export type FeePayee = 'fee-account' | 'representative';

export type RepresentativeFee = { readonly amountPerBlock: bigint; readonly payee: FeePayee };

/** Distinct amounts, so that a fee credited to the wrong account cannot go unnoticed. */
export const FEES: PerRepresentative<RepresentativeFee> = {
	0: { amountPerBlock: 2n, payee: 'fee-account' },
	1: { amountPerBlock: 3n, payee: 'fee-account' },
	2: { amountPerBlock: 5n, payee: 'fee-account' },
	3: { amountPerBlock: 7n, payee: 'representative' }
};

/** The account a representative's fees are credited to. */
export function feeRecipientOf(index: RepresentativeIndex): Account {
	const payee = FEES[index].payee;
	switch (payee) {
		case 'fee-account':
			return(publicOnly(lib.Account.fromSeed(SEEDS.feeAccount, index)));
		case 'representative':
			return(representativeOf(index));
		default:
			return(assertNever(payee));
	}
}

/** The fee settings of a representative's node. */
export function feeEnvironmentOf(index: RepresentativeIndex): Environment {
	const fee = FEES[index];
	const schedule: Environment = { KEETANET_LOCAL_NODE_FEE_SCHEDULE: `flat:${String(fee.amountPerBlock)}` };
	switch (fee.payee) {
		case 'fee-account':
			return({ ...schedule, KEETANET_LOCAL_NODE_FEE_ACCOUNTS: feeRecipientOf(index).publicKeyString.get() });
		case 'representative':
			return(schedule);
		default:
			return(assertNever(fee.payee));
	}
}

/** A staple is confirmed by votes holding at least this much of the delegated weight [Keeta TS] index.js:70789-70796. */
export function requiredVotingWeight(totalWeight: bigint): bigint {
	return(((totalWeight * 2n) / 3n) + 1n);
}

export type QuorumShape =
	| { readonly kind: 'any-three-not-two' }
	| { readonly kind: 'two-reach'; readonly voters: readonly RepresentativeIndex[] }
	| { readonly kind: 'three-fall-short'; readonly voters: readonly RepresentativeIndex[] };

function subsetsOf(size: number, from: readonly RepresentativeIndex[] = REPRESENTATIVE_INDEXES): RepresentativeIndex[][] {
	if (size === 0) {
		return([[]]);
	}
	const [first, ...rest] = from;
	if (first === undefined) {
		return([]);
	}
	const withFirst = subsetsOf(size - 1, rest).map(function(subset): RepresentativeIndex[] {
		return([first, ...subset]);
	});
	return([...withFirst, ...subsetsOf(size, rest)]);
}

function weightOf(weights: RepresentativeWeights, voters: readonly RepresentativeIndex[]): bigint {
	return(voters.reduce(function(sum, voter): bigint {
		return(sum + weights[voter]);
	}, 0n));
}

/** Whether every three representatives confirm a staple without the fourth, and no two confirm one alone. */
export function checkQuorumShape(weights: RepresentativeWeights): QuorumShape {
	const required = requiredVotingWeight(weightOf(weights, REPRESENTATIVE_INDEXES));
	const reachingPair = subsetsOf(2).find(function(voters): boolean {
		return(weightOf(weights, voters) >= required);
	});
	if (reachingPair !== undefined) {
		return({ kind: 'two-reach', voters: reachingPair });
	}
	const shortTriple = subsetsOf(3).find(function(voters): boolean {
		return(weightOf(weights, voters) < required);
	});
	if (shortTriple !== undefined) {
		return({ kind: 'three-fall-short', voters: shortTriple });
	}
	return({ kind: 'any-three-not-two' });
}

/** The staple a client published itself, which it always does without a publish aid. */
export function publishedStaple(published: Awaited<ReturnType<UserClient['publishBuilder']>>): VoteStaple {
	switch (published.from) {
		case 'direct':
			if (!published.publish) {
				throw(new Error(`the network refused staple ${published.voteStaple.blocksHash.toString()}`));
			}
			return(published.voteStaple);
		case 'publish-aid':
			throw(new Error('the client published through a publish aid'));
		default:
			return(assertNever(published));
	}
}

/** What delegating needs of the devnet: clients that know every representative, and a wait for every node to hold a staple. */
export type DelegationNetwork = {
	readonly client: (signer: Account) => UserClient;
	readonly settled: (staple: VoteStaple) => Promise<void>;
};

/*
 * The client caches each representative's weight and asks only those with
 * some for votes [Keeta TS] index.js:60721-60750, so every step takes a new
 * client once every node holds the step before.
 */
export async function delegateWeight(network: DelegationNetwork): Promise<void> {
	const trusted = network.client(TRUSTED_SIGNER);
	const funding = trusted.initBuilder();
	funding.send(FAUCET, FAUCET_BALANCE, trusted.baseToken);
	for (const index of REPRESENTATIVE_INDEXES) {
		if (index !== 0) {
			funding.send(holderOf(index), DELEGATED_WEIGHT, trusted.baseToken);
		}
	}
	await network.settled(publishedStaple(await trusted.publishBuilder(funding)));
	for (const index of REPRESENTATIVE_INDEXES) {
		if (index !== 0) {
			const holder = network.client(holderOf(index));
			const delegation = holder.initBuilder();
			delegation.setRep(representativeOf(index));
			await network.settled(publishedStaple(await holder.publishBuilder(delegation)));
		}
	}
}
