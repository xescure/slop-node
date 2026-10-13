import { vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, NetworkAddress, StorageAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger, LedgerConfig, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Node, NodeConfig } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { FeeAmountAndToken, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { assertNever } from '../util/assert-never.js';

const lib = KeetaNet.lib;

const NETWORK = 0n;

/**
 * Representative and user i derive from their seed at index i, the trusted
 * root from its seed at index 0, all as secp256k1 keys.
 */
export type TestNetworkSeeds = {
	readonly trustedRoot: string;
	readonly representative: string;
	readonly user: string;
};

export const TEST_NETWORK_SEEDS: TestNetworkSeeds = {
	trustedRoot: '5f1d2c9a7b3e48d0a6c4e8f1b2d3a495c7e0f6b8a1d2c3e4f5a6b7c8d9e0f1a2',
	representative: '0b7e3a91c4d85f26e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8',
	user: 'c3a8e5f1d92b7064a8c1e3f5b7d9021436587a9bcde0f1a2b3c4d5e6f708192a'
};

const BASE_TOKEN_INFO = {
	name: 'Test Token',
	currencyCode: 'TEST',
	decimalPlaces: 0
} as const;

// Without TOKEN_ADMIN_CREATE nobody could create tokens on the test network.
// [Keeta TS] index.js:80759 defaults the network address to STORAGE_CREATE only.
const NETWORK_DEFAULT_PERMISSION = ['ACCESS', 'STORAGE_CREATE', 'TOKEN_ADMIN_CREATE'] as const;

const GENESIS_VOTE_SERIAL = 0n;

export type TestNetworkOptions = {
	readonly representativeWeights: readonly bigint[];
	readonly seeds?: TestNetworkSeeds;
};

/** A fee without a payee is paid to the issuer of each vote, and without a token in the base token. */
export type TestFeeAmount = { readonly amount: bigint; readonly token?: TokenAddress; readonly payTo?: Account | StorageAddress };

/** Nothing, one amount, or a list of amounts the payer chooses from, the same for every request. */
export type TestFeePolicy =
	{ readonly kind: 'free' } |
	({ readonly kind: 'flat' } & TestFeeAmount) |
	{ readonly kind: 'choices'; readonly choices: readonly TestFeeAmount[] };

export type TestLedgerOptions = {
	readonly fee?: TestFeePolicy;
	readonly heapProcessWindowMs?: LedgerConfig['heapProcessWindowMs'];
	readonly ledgerWriteMode?: LedgerConfig['ledgerWriteMode'];
	readonly subnet?: LedgerConfig['subnet'];
	readonly operations?: LedgerConfig['operations'];
	/** Where a ledger without a node logs; a node keeps its own log. */
	readonly log?: LedgerConfig['log'];
};

/** The keys a network derives from its seeds; none of them needs genesis. */
export type TestKeys = {
	readonly trustedRoot: Account;
	readonly trustedSigner: Account;
	readonly representatives: readonly Account[];
	readonly users: readonly Account[];
};

/** Builds ledgers and nodes for one trusted root on network 0, each on the storage driver given. */
export type TestLedgerFactory = {
	createLedger(storageDriver: LedgerStorageAPI, representative: Account, options?: TestLedgerOptions): Ledger;
	/** A ledger of a node that is not a representative: it holds no key, so it can never vote. */
	createAccountLedger(storageDriver: LedgerStorageAPI, options?: TestLedgerOptions): Ledger;
	/** The configuration createNode builds its node from, for nodes of other classes. */
	nodeConfig(storageDriver: LedgerStorageAPI, representative: Account, options?: TestLedgerOptions): NodeConfig;
	/**
	 * A representative node that owns its ledger, so the ledger records the
	 * statistics that upstream gathers only when a node is attached.
	 */
	createNode(storageDriver: LedgerStorageAPI, representative: Account, options?: TestLedgerOptions): Node;
};

export type TestNetwork = TestKeys & TestLedgerFactory & {
	readonly network: 0n;
	readonly baseToken: TokenAddress;
	readonly networkAddress: NetworkAddress;
	readonly genesis: VoteStaple;
};

type Holder = {
	readonly weight: bigint;
	readonly representative: Account;
	readonly user: Account;
};

type ComputeFee = ConstructorParameters<typeof lib.Ledger>[0]['computeFeeFromBlocks'];

function feeAmountAndToken(fee: TestFeeAmount): FeeAmountAndToken {
	const { amount, token, payTo } = fee;
	const result: FeeAmountAndToken = { amount };
	if (token !== undefined) {
		result.token = token;
	}
	if (payTo !== undefined) {
		result.payTo = payTo;
	}
	return(result);
}

function computeFeeFor(policy: TestFeePolicy): ComputeFee {
	switch (policy.kind) {
		case 'free':
			return(function() {
				return(null);
			});
		case 'flat':
			return(function() {
				return(feeAmountAndToken(policy));
			});
		case 'choices':
			return(function() {
				return(policy.choices.map(feeAmountAndToken));
			});
		default:
			return(assertNever(policy));
	}
}

/*
 * How often Ledger.run retries a retryable failure. Upstream's default budget
 * is 5 s of wall clock, which never runs out while a test freezes the clock,
 * so a failure that is retryable but certain to recur would loop until the
 * test timed out. Counting attempts makes it fail at once instead. Four is
 * enough for the races two processes of one representative can lose, each
 * attempt seeing the winner's commit.
 * [Keeta TS] index.js:71343-71366, 71397-71404
 */
export const TEST_TRANSACTION_RETRIES = 4;

function ledgerSettings(storageDriver: LedgerStorageAPI, options: TestLedgerOptions): NodeConfig['ledger'] {
	const settings: NodeConfig['ledger'] = {
		computeFeeFromBlocks: computeFeeFor(options.fee ?? { kind: 'free' }),
		storageDriver,
		transactionRetries: { maxRetries: TEST_TRANSACTION_RETRIES }
	};
	if (options.heapProcessWindowMs !== undefined) {
		settings.heapProcessWindowMs = options.heapProcessWindowMs;
	}
	if (options.ledgerWriteMode !== undefined) {
		settings.ledgerWriteMode = options.ledgerWriteMode;
	}
	if (options.subnet !== undefined) {
		settings.subnet = options.subnet;
	}
	if (options.operations !== undefined) {
		settings.operations = options.operations;
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
 * [Keeta TS] index.js:80738
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
 * [Keeta TS] index.js:70783-70787
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

/** Representative and user i are the keys of their seeds at index i. */
export function deriveTestKeys(seeds: TestNetworkSeeds, count: number): TestKeys {
	const trustedSigner = lib.Account.fromSeed(seeds.trustedRoot, 0);
	const indexes = Array.from({ length: count }, function(_value, index): number {
		return(index);
	});
	return({
		trustedSigner,
		trustedRoot: lib.Account.fromPublicKeyString(trustedSigner.publicKeyString.get()),
		representatives: indexes.map(function(index): Account {
			return(lib.Account.fromSeed(seeds.representative, index));
		}),
		users: indexes.map(function(index): Account {
			return(lib.Account.fromSeed(seeds.user, index));
		})
	});
}

/** The trusted root is public only, as on a real node, which refuses a root with a private key. */
export function createTestLedgerFactory(trustedRoot: Account): TestLedgerFactory {
	function ledgerConfig(storageDriver: LedgerStorageAPI, ledgerOptions: TestLedgerOptions): LedgerConfig {
		const config: LedgerConfig = {
			...ledgerSettings(storageDriver, ledgerOptions),
			kind: lib.Ledger.Kind.ACCOUNT,
			initialTrustedAccount: trustedRoot,
			network: NETWORK
		};
		if (ledgerOptions.log !== undefined) {
			config.log = ledgerOptions.log;
		}
		return(config);
	}
	function nodeConfig(storageDriver: LedgerStorageAPI, representative: Account, ledgerOptions: TestLedgerOptions = {}): NodeConfig {
		// Peers are never connected, so the node only ever talks to its own ledger.
		return({
			kind: lib.Node.Kind.REPRESENTATIVE,
			// A log without targets discards everything.
			log: new lib.Log(),
			initialTrustedAccount: trustedRoot,
			ledgerPrivateKey: representative,
			network: NETWORK,
			networkAlias: 'test',
			ledger: ledgerSettings(storageDriver, ledgerOptions),
			stats: { kv: null }
		});
	}
	return({
		createLedger(storageDriver, representative, ledgerOptions = {}) {
			return(new lib.Ledger({ ...ledgerConfig(storageDriver, ledgerOptions), kind: lib.Ledger.Kind.REPRESENTATIVE, privateKey: representative }));
		},
		createAccountLedger(storageDriver, ledgerOptions = {}) {
			return(new lib.Ledger(ledgerConfig(storageDriver, ledgerOptions)));
		},
		nodeConfig,
		createNode(storageDriver, representative, ledgerOptions = {}) {
			return(new lib.Node(nodeConfig(storageDriver, representative, ledgerOptions)));
		}
	});
}

/*
 * Genesis and the blocks built afterwards read the global clock, so callers
 * freeze it with freezeClock() before creating the network to get identical
 * bytes.
 */
export async function createTestNetwork(options: TestNetworkOptions): Promise<TestNetwork> {
	const { representativeWeights, seeds = TEST_NETWORK_SEEDS } = options;
	if (representativeWeights.length === 0) {
		throw(new Error('a test network needs at least one representative'));
	}
	if (representativeWeights.some(function(weight): boolean {
		return(weight <= 0n);
	})) {
		throw(new Error('every representative weight must be positive'));
	}

	const keys = deriveTestKeys(seeds, representativeWeights.length);
	const holders = representativeWeights.map(function(weight, index): Holder {
		return({ weight, representative: requireKey(keys.representatives, index), user: requireKey(keys.users, index) });
	});
	const { networkAddress, baseToken } = lib.Account.generateBaseAddresses(NETWORK);
	const genesis = await buildGenesis(keys.trustedSigner, holders);

	return({
		...keys,
		...createTestLedgerFactory(keys.trustedRoot),
		network: NETWORK,
		baseToken,
		networkAddress,
		genesis
	});
}

function requireKey(keys: readonly Account[], index: number): Account {
	const key = keys[index];
	if (key === undefined) {
		throw(new Error(`no key at index ${String(index)}`));
	}
	return(key);
}

export function freezeClock(at: Date): void {
	vi.setSystemTime(at);
}

export function advanceClock(milliseconds: number): void {
	vi.setSystemTime(Date.now() + milliseconds);
}
