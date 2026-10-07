import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { assertNever } from '../util/assert-never.js';
import { AMOUNT } from './amount.js';
import { ConfigError, EnvironmentReader, parseAccountKey, publicNetworkOf, publicOnly, readSeedAccount } from './config.js';
import type { Environment, EnvironmentConfig } from './config.js';

const lib = KeetaNet.lib;

/**
 * The network's first staple, as UserClient.initializeNetwork builds it: the
 * trusted key signs it and receives the whole supply, which it delegates to a
 * representative [Keeta TS] index.js:60460-60478.
 */
export type GenesisSettings = {
	readonly trustedSigner: Account;
	/** In base units of the base token. */
	readonly supply: bigint;
	/** This node's representative unless another is named. */
	readonly delegateTo: Account;
};

function parseSupply(text: string): bigint {
	if (!AMOUNT.test(text)) {
		throw(new ConfigError({ kind: 'invalid', variable: 'KEETANET_GENESIS_SUPPLY', expected: 'a positive whole number of base units', value: text }));
	}
	return(BigInt(text));
}

/**
 * Genesis creates a network, so it is refused on a public one, which has its
 * own, and in memory, where it would be lost as the command ends. A name of
 * the genesis prefix that it does not read is refused as well, since it is
 * most likely a misspelling.
 */
export function getGenesisConfigFromEnv(environment: Environment, config: EnvironmentConfig): GenesisSettings {
	const network = publicNetworkOf(config.network);
	if (network !== undefined) {
		throw(new ConfigError({ kind: 'genesis-on-public-network', network }));
	}
	switch (config.storage.kind) {
		case 'memory':
			throw(new ConfigError({ kind: 'genesis-in-memory' }));
		case 'postgres':
			break;
		default:
			assertNever(config.storage);
	}

	const reader = new EnvironmentReader(environment);
	const unknown = reader.unknownGenesisVariable();
	if (unknown !== undefined) {
		throw(new ConfigError({ kind: 'unknown-variable', variable: unknown }));
	}
	const trustedSigner = readSeedAccount(reader, 'KEETANET_GENESIS_TRUSTED_SEED', 'KEETANET_GENESIS_TRUSTED_SEED_INDEX');
	const derived = trustedSigner.publicKeyString.get();
	const trusted = config.initialTrustedAccount.publicKeyString.get();
	if (derived !== trusted) {
		throw(new ConfigError({ kind: 'trusted-seed-mismatch', derived, trusted }));
	}
	return({
		trustedSigner,
		supply: parseSupply(reader.required('KEETANET_GENESIS_SUPPLY')),
		delegateTo: reader.read('KEETANET_GENESIS_DELEGATE_TO', function(text: string): Account {
			return(parseAccountKey('KEETANET_GENESIS_DELEGATE_TO', text));
		}, publicOnly(config.representative))
	});
}

/** Why genesis was not added. */
export type GenesisProblem = { readonly kind: 'already-initialized'; readonly networkAddress: string };

export class GenesisError extends Error {
	readonly problem: GenesisProblem;

	constructor(problem: GenesisProblem) {
		super(`the network already has its genesis: its address ${problem.networkAddress} has blocks`);
		this.name = 'GenesisError';
		this.problem = problem;
	}
}

/**
 * Builds the network's first staple with the client's own generator and adds
 * it to the node's ledger. The network address is the first account genesis
 * writes [Keeta TS] index.js:79590-79611, so a ledger holding blocks for it
 * already has a genesis, and a second one would conflict with it.
 */
export async function addGenesis(node: Node, settings: GenesisSettings): Promise<VoteStaple> {
	const head = await node.ledger.getHeadBlock(node.networkAddress, 'main');
	if (head !== null) {
		throw(new GenesisError({ kind: 'already-initialized', networkAddress: node.networkAddress.publicKeyString.get() }));
	}
	const { voteStaple } = await lib.Utils.Initial.generateInitialVoteStaple({
		network: node.config.network,
		initialTrustedAccount: settings.trustedSigner,
		addSupply: {
			recipient: settings.trustedSigner,
			amount: settings.supply,
			delegate: true,
			delegateTo: settings.delegateTo
		}
	});
	await node.ledger.add(voteStaple);
	return(voteStaple);
}
