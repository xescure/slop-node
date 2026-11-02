import { afterEach, inject } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { getConfigFromEnv, localNodeConfig, publicOnly } from '../node/config.js';
import type { Environment, EnvironmentConfig } from '../node/config.js';
import { LocalNode } from '../node/local.js';
import { closeStorage, nodeResourcesOf, openStorage } from '../node/storage.js';
import { assertNever } from '../util/assert-never.js';
import { deriveTestKeys, NO_REPRESENTATIVES, TEST_NETWORK_SEEDS } from './network.js';
import { createDatabase } from './postgres.js';
import type { TestDatabase } from './postgres.js';

const lib = KeetaNet.lib;

export type UserClient = InstanceType<typeof KeetaNet.UserClient>;

/** Where a node under test keeps its ledger. */
export type StorageUnderTest = 'memory' | 'postgres';

export const STORAGES_UNDER_TEST: readonly StorageUnderTest[] = ['memory', 'postgres'];

const keys = deriveTestKeys(TEST_NETWORK_SEEDS, 1);

/** The trusted root with its private key: whoever initializes the network signs with it [Keeta TS] index.js:61450-61468. */
export const TRUSTED_SIGNER: Account = keys.trustedSigner;

/** The representative a node of NODE_ENVIRONMENT votes as. */
export const REPRESENTATIVE: Account = publicOnly(lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 0));

/** The base token supply the SDK tests create, in base units. */
export const SUPPLY = 1_000_000n;

/** An account the SDK tests send to, from a fixed seed. */
export const RECEIVER: Account = lib.Account.fromSeed('7d3c1e5a9b2f4068a1c3e5f7092b4d6f8a0c2e4f6081a3c5e7f9b1d3f5a7c9e1', 0);

/** The blocks hashes of the staples a history lists, newest first as the API answers. */
export function stapleHashes(entries: readonly { readonly voteStaple: VoteStaple }[]): string[] {
	return(entries.map(function({ voteStaple }): string {
		return(voteStaple.blocksHash.toString());
	}));
}

/** A local representative trusting the test root, in memory, on the loopback interface at any free port. */
export const NODE_ENVIRONMENT: Environment = {
	KEETANET_LOCAL_NODE_SEED: TEST_NETWORK_SEEDS.representative,
	KEETANET_INITIAL_TRUSTED_ACCOUNT: keys.trustedRoot.publicKeyString.get(),
	KEETANET_LOCAL_NODE_LISTEN_PORT: '0'
};

/*
 * Network 0 has no alias of its own [Keeta TS] index.js:62327-62355, but the
 * client takes one, and the node's configuration gives it "test". The client
 * reads that network's defaults only for the publish aid, which stays off, and
 * for the trusted account UserClient.history() computes effects with
 * [Keeta TS] index.js:61758, which the scenarios do not read.
 */
const LOCAL_NETWORK = 0n;
const LOCAL_NETWORK_ALIAS = 'test';

/** Where a client reaches a representative. */
export type RepresentativeEndpoint = {
	/** The host and port of the API, as UserClient.fromSimpleSingleRep takes them. */
	readonly host: string;
	readonly representative: Account;
};

/** A node configured from its environment, as the command builds one, and serving. */
export type ServingNode = RepresentativeEndpoint & {
	readonly node: LocalNode;
	readonly config: EnvironmentConfig;
	/** Stops serving and closes the storage; the database stays for another node. */
	readonly stop: () => Promise<void>;
};

/** The endpoint of the API the node advertises, which it serves below "/api". */
export function endpointOf(apiURL: string, representative: Account): RepresentativeEndpoint {
	return({ host: new URL(apiURL).host, representative: publicOnly(representative) });
}

export type SDKNodes = {
	/** A fresh database of the migrated template, dropped after the test. */
	readonly database: () => Promise<TestDatabase>;
	/** The environment of a node keeping its ledger in a fresh store of that kind. */
	readonly environmentFor: (storage: StorageUnderTest, extra?: Environment) => Promise<Environment>;
	readonly start: (environment: Environment) => Promise<ServingNode>;
	/** A client of the official SDK that knows only that representative. */
	readonly userClient: (endpoint: RepresentativeEndpoint, signer: Account | null) => UserClient;
};

/**
 * Nodes and clients for one test file. After each test the clients are
 * destroyed, the nodes stopped, and then the databases dropped.
 */
export function useSDKNodes(): SDKNodes {
	const clients: UserClient[] = [];
	const nodes: ServingNode[] = [];
	const databases: TestDatabase[] = [];

	afterEach(async function() {
		for (const client of clients.splice(0)) {
			await client.destroy();
		}
		for (const serving of nodes.splice(0)) {
			await serving.stop();
		}
		for (const database of databases.splice(0)) {
			await database.drop();
		}
	});

	async function database(): Promise<TestDatabase> {
		const created = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
		databases.push(created);
		return(created);
	}

	async function environmentFor(storage: StorageUnderTest, extra: Environment = {}): Promise<Environment> {
		switch (storage) {
			case 'memory':
				return({ ...NODE_ENVIRONMENT, ...extra });
			case 'postgres':
				return({ ...NODE_ENVIRONMENT, KEETANET_LOCAL_NODE_POSTGRES_URL: (await database()).connectionString, ...extra });
			default:
				return(assertNever(storage));
		}
	}

	async function start(environment: Environment): Promise<ServingNode> {
		const config = getConfigFromEnv(environment, NO_REPRESENTATIVES);
		const storage = openStorage(config.storage);
		const node = new LocalNode(localNodeConfig(config, nodeResourcesOf(storage, new lib.Log())));
		let stopping: Promise<void> | undefined;
		const stop = function(): Promise<void> {
			stopping ??= node.stop().finally(function() {
				return(closeStorage(storage));
			});
			return(stopping);
		};
		try {
			await node.run();
		} catch (error: unknown) {
			await stop();
			throw(error);
		}
		const api = node.config.endpoints?.api;
		if (api === undefined) {
			await stop();
			throw(new Error('the node advertises no API endpoint'));
		}
		const serving: ServingNode = { ...endpointOf(api, config.representative), node, config, stop };
		nodes.push(serving);
		return(serving);
	}

	function userClient(endpoint: RepresentativeEndpoint, signer: Account | null): UserClient {
		const client = KeetaNet.UserClient.fromSimpleSingleRep(endpoint.host, false, endpoint.representative, LOCAL_NETWORK, LOCAL_NETWORK_ALIAS, signer);
		clients.push(client);
		return(client);
	}

	return({ database, environmentFor, start, userClient });
}
