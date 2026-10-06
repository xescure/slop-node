import { vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, NetworkAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger, LedgerConfig, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Node, NodeConfig } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';

const lib = KeetaNet.lib;

const NETWORK = 0n;

const SEEDS = {
	trustedRoot: '5f1d2c9a7b3e48d0a6c4e8f1b2d3a495c7e0f6b8a1d2c3e4f5a6b7c8d9e0f1a2',
	representative: '0b7e3a91c4d85f26e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8',
	user: 'c3a8e5f1d92b7064a8c1e3f5b7d9021436587a9bcde0f1a2b3c4d5e6f708192a'
} as const;

const BASE_TOKEN_INFO = {
	name: 'Test Token',
	currencyCode: 'TEST',
	decimalPlaces: 0
} as const;

// Without TOKEN_ADMIN_CREATE nobody could create tokens on the test network.
// [Keeta TS] index.js:79607 defaults the network address to STORAGE_CREATE only.
const NETWORK_DEFAULT_PERMISSION = ['ACCESS', 'STORAGE_CREATE', 'TOKEN_ADMIN_CREATE'] as const;

const GENESIS_VOTE_SERIAL = 0n;

export type TestNetworkOptions = { readonly representativeWeights: readonly bigint[] };

/** A flat fee without a payee is paid to the issuer of each vote. */
export type TestFeePolicy = { readonly kind: 'free' } | { readonly kind: 'flat'; readonly amount: bigint; readonly payTo?: Account };

export type TestLedgerOptions = {
	readonly fee?: TestFeePolicy;
	readonly heapProcessWindowMs?: LedgerConfig['heapProcessWindowMs'];
};

export type TestNetwork = {
	readonly network: 0n;
	readonly trustedRoot: Account;
	readonly trustedSigner: Account;
	readonly representatives: readonly Account[];
	readonly users: readonly Account[];
	readonly baseToken: TokenAddress;
	readonly networkAddress: NetworkAddress;
	readonly genesis: VoteStaple;
	createLedger(storageDriver: LedgerStorageAPI, representative: Account, options?: TestLedgerOptions): Ledger;
	/**
	 * A representative node that owns its ledger, so the ledger records the
	 * statistics that upstream gathers only when a node is attached.
	 */
	createNode(storageDriver: LedgerStorageAPI, representative: Account, options?: TestLedgerOptions): Node;
};

type Holder = {
	readonly weight: bigint;
	readonly representative: Account;
	readonly user: Account;
};

type ComputeFee = ConstructorParameters<typeof lib.Ledger>[0]['computeFeeFromBlocks'];

function assertNever(value: never): never {
	throw(new Error(`Unexpected value: ${String(value)}`));
}

function computeFeeFor(policy: TestFeePolicy): ComputeFee {
	switch (policy.kind) {
		case 'free':
			return(function() {
				return(null);
			});
		case 'flat': {
			const { amount, payTo } = policy;
			return(function() {
				if (payTo === undefined) {
					return({ amount });
				}
				return({ amount, payTo });
			});
		}
		default:
			return(assertNever(policy));
	}
}

function ledgerSettings(storageDriver: LedgerStorageAPI, options: TestLedgerOptions): NodeConfig['ledger'] {
	const settings: NodeConfig['ledger'] = {
		computeFeeFromBlocks: computeFeeFor(options.fee ?? { kind: 'free' }),
		storageDriver
	};
	if (options.heapProcessWindowMs !== undefined) {
		settings.heapProcessWindowMs = options.heapProcessWindowMs;
	}
	return(settings);
}

function networkInfo(): { defaultPermission: InstanceType<typeof lib.Permissions> } {
	return({ defaultPermission: new lib.Permissions([...NETWORK_DEFAULT_PERMISSION]) });
}

function baseTokenMetadata(): string {
	return(btoa(JSON.stringify({ decimalPlaces: BASE_TOKEN_INFO.decimalPlaces })));
}

/*
 * The upstream generator funds one recipient, so it covers only the case with a
 * single representative.
 * [Keeta TS] index.js:79586
 */
async function buildSingleHolderGenesis(trustedSigner: Account, holder: Holder): Promise<VoteStaple> {
	const { voteStaple } = await lib.Utils.Initial.generateInitialVoteStaple({
		network: NETWORK,
		initialTrustedAccount: trustedSigner,
		voteSerial: GENESIS_VOTE_SERIAL,
		baseTokenInfo: BASE_TOKEN_INFO,
		baseNetworkInfo: networkInfo(),
		addSupply: {
			recipient: holder.user,
			amount: holder.weight,
			delegate: true,
			delegateTo: holder.representative
		}
	});
	return(voteStaple);
}

/*
 * The same blocks as the upstream generator, with one funding block and one
 * SET_REP block per holder. Genesis is only ever added to a ledger: it spends
 * TOKEN_ADMIN_MODIFY_BALANCE, which voting does not support, and total weight
 * is still zero while it is added.
 * [Keeta TS] index.js:69747-69751
 */
async function buildMultiHolderGenesis(trustedSigner: Account, holders: readonly Holder[], date: Date): Promise<VoteStaple> {
	const { networkAddress, baseToken } = lib.Account.generateBaseAddresses(NETWORK);
	const ownerPermission = new lib.Permissions(['OWNER']);
	const totalSupply = holders.reduce(function(total, holder): bigint {
		return(total + holder.weight);
	}, 0n);

	const networkBlock = await new lib.Block.Builder({
		network: NETWORK,
		account: networkAddress,
		signer: trustedSigner,
		previous: lib.Block.NO_PREVIOUS,
		date,
		operations: [
			{ type: lib.Block.OperationType.MODIFY_PERMISSIONS, method: lib.Block.AdjustMethod.SET, principal: trustedSigner, permissions: ownerPermission },
			{ type: lib.Block.OperationType.SET_INFO, name: 'KEETANET', description: 'Network Address For KeetaNet', metadata: '', ...networkInfo() }
		]
	}).seal();

	const baseTokenBlock = await new lib.Block.Builder({
		network: NETWORK,
		account: baseToken,
		signer: trustedSigner,
		previous: lib.Block.NO_PREVIOUS,
		date,
		operations: [
			{ type: lib.Block.OperationType.MODIFY_PERMISSIONS, method: lib.Block.AdjustMethod.SET, principal: trustedSigner, permissions: ownerPermission },
			{
				type: lib.Block.OperationType.SET_INFO,
				name: BASE_TOKEN_INFO.currencyCode,
				description: BASE_TOKEN_INFO.name,
				metadata: baseTokenMetadata(),
				defaultPermission: new lib.Permissions(['ACCESS'])
			},
			{ type: lib.Block.OperationType.TOKEN_ADMIN_SUPPLY, method: lib.Block.AdjustMethod.ADD, amount: totalSupply }
		]
	}).seal();

	const blocks: Block[] = [networkBlock, baseTokenBlock];
	for (const holder of holders) {
		const funding = await new lib.Block.Builder({
			network: NETWORK,
			account: holder.user,
			signer: trustedSigner,
			previous: lib.Block.NO_PREVIOUS,
			date,
			operations: [{ type: lib.Block.OperationType.TOKEN_ADMIN_MODIFY_BALANCE, method: lib.Block.AdjustMethod.ADD, token: baseToken, amount: holder.weight }]
		}).seal();
		const delegation = await new lib.Block.Builder({
			network: NETWORK,
			account: holder.user,
			previous: funding.hash,
			date,
			operations: [{ type: lib.Block.OperationType.SET_REP, to: holder.representative }]
		}).seal();
		blocks.push(funding, delegation);
	}

	const voteBuilder = new lib.Vote.Builder(trustedSigner, blocks);
	const vote = await voteBuilder.seal(GENESIS_VOTE_SERIAL, null);
	return(lib.Vote.Staple.fromVotesAndBlocks([vote], blocks));
}

function buildGenesis(trustedSigner: Account, holders: readonly Holder[]): Promise<VoteStaple> {
	const [first, ...others] = holders;
	if (first !== undefined && others.length === 0) {
		return(buildSingleHolderGenesis(trustedSigner, first));
	}
	return(buildMultiHolderGenesis(trustedSigner, holders, new Date()));
}

/*
 * Genesis and the blocks built afterwards read the global clock, so callers
 * freeze it with freezeClock() before creating the network to get identical
 * bytes.
 */
export async function createTestNetwork(options: TestNetworkOptions): Promise<TestNetwork> {
	const { representativeWeights } = options;
	if (representativeWeights.length === 0) {
		throw(new Error('a test network needs at least one representative'));
	}
	if (representativeWeights.some(function(weight): boolean {
		return(weight <= 0n);
	})) {
		throw(new Error('every representative weight must be positive'));
	}

	const trustedSigner = lib.Account.fromSeed(SEEDS.trustedRoot, 0);
	const trustedRoot = lib.Account.fromPublicKeyString(trustedSigner.publicKeyString.get());
	const holders = representativeWeights.map(function(weight, index): Holder {
		return({
			weight,
			representative: lib.Account.fromSeed(SEEDS.representative, index),
			user: lib.Account.fromSeed(SEEDS.user, index)
		});
	});
	const { networkAddress, baseToken } = lib.Account.generateBaseAddresses(NETWORK);
	const genesis = await buildGenesis(trustedSigner, holders);

	return({
		network: NETWORK,
		trustedRoot,
		trustedSigner,
		representatives: holders.map(function(holder): Account {
			return(holder.representative);
		}),
		users: holders.map(function(holder): Account {
			return(holder.user);
		}),
		baseToken,
		networkAddress,
		genesis,
		createLedger(storageDriver, representative, ledgerOptions = {}) {
			const config: LedgerConfig = {
				...ledgerSettings(storageDriver, ledgerOptions),
				kind: lib.Ledger.Kind.REPRESENTATIVE,
				privateKey: representative,
				initialTrustedAccount: trustedRoot,
				network: NETWORK
			};
			return(new lib.Ledger(config));
		},
		createNode(storageDriver, representative, ledgerOptions = {}) {
			// Peers are never connected, so the node only ever talks to its own ledger.
			return(new lib.Node({
				kind: lib.Node.Kind.REPRESENTATIVE,
				// A log without targets discards everything.
				log: new lib.Log(),
				initialTrustedAccount: trustedRoot,
				ledgerPrivateKey: representative,
				network: NETWORK,
				networkAlias: 'test',
				ledger: ledgerSettings(storageDriver, ledgerOptions),
				stats: { kv: null }
			}));
		}
	});
}

export function freezeClock(at: Date): void {
	vi.setSystemTime(at);
}

export function advanceClock(milliseconds: number): void {
	vi.setSystemTime(Date.now() + milliseconds);
}
