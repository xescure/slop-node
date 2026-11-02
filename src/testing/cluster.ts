import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { afterEach, inject } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { P2PConnection } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { VoteBlockHash, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { renderStateDump } from '../conformance/mainnet/dump.js';
import { nodeLedgerChecksum } from '../ledger/storage/base.js';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { formatManualPeer, getConfigFromEnv, localNodeConfig, manualPeerOf, publicOnly } from '../node/config.js';
import type { Environment, LedgerWriteMode } from '../node/config.js';
import { addGenesis } from '../node/genesis.js';
import { LocalNode } from '../node/local.js';
import { closeStorage, nodeResourcesOf, openStorage } from '../node/storage.js';
import type { OpenedStorage } from '../node/storage.js';
import { assertNever } from '../util/assert-never.js';
import { deriveTestKeys, NO_REPRESENTATIVES, TEST_NETWORK_SEEDS } from './network.js';
import { createDatabase } from './postgres.js';
import type { TestDatabase } from './postgres.js';
import { eachStapleOnce } from '../util/each-staple-once.js';
import { TRUSTED_SIGNER } from './sdk.js';
import type { StorageUnderTest, UserClient } from './sdk.js';

const lib = KeetaNet.lib;

const LOOPBACK = '127.0.0.1';

/*
 * Network 0 has no alias of its own [Keeta TS] index.js:62327-62355; the
 * node's configuration names it "test", and the client reads that alias only
 * for the publish aid, which stays off.
 */
const NETWORK = 0n;
const NETWORK_ALIAS = 'test';

/*
 * The network UserClient.initializeNetwork creates lets anyone create storage
 * accounts only [Keeta TS] index.js:80759; a development network lets anyone
 * create tokens as well.
 */
const NETWORK_DEFAULT_PERMISSION = ['ACCESS', 'STORAGE_CREATE', 'TOKEN_ADMIN_CREATE'] as const;

/*
 * Every node bootstraps as it runs and then once a period. Once the network
 * has started, a staple reaches a running node only over P2P unless a test
 * starts a node later or asks for an update, so the period is longer than any
 * test.
 */
const BOOTSTRAP_PERIOD_MILLISECONDS = 60 * 60 * 1000;

/** The balance the spender is given, which no representative is delegated, so spending it moves no voting weight. */
export const SPENDING = 1_000_000n;

/** Funded at the start, delegating to no representative. */
export const SPENDER: Account = lib.Account.fromSeed('4b8e2d6f0a3c5e7f9b1d3f5a7c9e0b2d4f6a8c1e3b5d7f9a0c2e4b6d8f1a3c5e', 0);

const EPOCH = new Date(0);

/*
 * A socket that asks for any port is given one of the system's ephemeral
 * range, 32768 to 60999 on Linux and above 49151 elsewhere, as is the local
 * end of an outgoing connection, so any socket of the test run could take a
 * port a member lets go of between its node and the placeholder that holds
 * the port while the node is offline. Members listen below that range
 * instead, each worker of the test run on ports of its own, so that nothing
 * else of the run asks for a member's port.
 */
const MEMBER_PORT_BASE = 20_000;
const MEMBER_PORTS_PER_WORKER = 500;
/** As many workers as fit below the ephemeral range; more share blocks of ports. */
const MEMBER_PORT_WORKERS = 25;

/** The ports of this worker's members handed out so far. */
let memberPortsTaken = 0;

/** The next port of this worker's block, wrapping around within it. */
function nextMemberPort(): number {
	const worker = (Number(process.env['VITEST_POOL_ID'] ?? '1') - 1) % MEMBER_PORT_WORKERS;
	const port = MEMBER_PORT_BASE + (worker * MEMBER_PORTS_PER_WORKER) + (memberPortsTaken % MEMBER_PORTS_PER_WORKER);
	memberPortsTaken++;
	return(port);
}

function isAddressInUse(error: unknown): boolean {
	return(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE');
}

/** More staples than any cluster holds, so that one read lists them all. */
const STAPLE_LIMIT = 1000;

export type PreferUpdates = 'websocket' | 'http';

/** What a representative charges for each block it votes on, and who is paid. */
export type RepresentativeFee =
	| { readonly kind: 'free' }
	| { readonly kind: 'flat'; readonly amountPerBlock: bigint; readonly payTo: Account };

export type ClusterOptions = {
	readonly storage: StorageUnderTest;
	/** The voting weight delegated to each representative, which is also how many there are. */
	readonly weights: readonly bigint[];
	readonly preferUpdates?: PreferUpdates;
	/** What each representative charges, by index; nothing unless given. */
	readonly fees?: readonly RepresentativeFee[];
};

/** How a node that joins later takes staples: as a representative would, or only as a follower. */
export type JoinerMode = Extract<LedgerWriteMode, 'read-write' | 'bootstrap-only'>;

/** Where a member keeps its ledger: a store in memory lives only while its node does. */
type MemberStore =
	| { readonly kind: 'memory' }
	| { readonly kind: 'postgres'; readonly database: TestDatabase };

type Running = {
	readonly node: LocalNode;
	readonly storage: OpenedStorage;
	readonly apiURL: string;
	readonly p2pURL: string;
	/** Called after each commit to the node's ledger. */
	readonly commits: Set<() => void>;
};

type Offline = {
	/** Holds the port while the node is down, so that it comes back where its peers know it. */
	readonly placeholder: Server;
};

type MemberState =
	| { readonly kind: 'running'; readonly running: Running }
	| { readonly kind: 'offline'; readonly offline: Offline }
	| { readonly kind: 'stopped' };

/** A key holding weight at the start, delegated to the representative of the same index. */
function holderOf(index: number): Account {
	return(lib.Account.fromSeed(TEST_NETWORK_SEEDS.user, index));
}

function representativeOf(index: number): Account {
	return(lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, index));
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

function feeEnvironment(fee: RepresentativeFee): Environment {
	switch (fee.kind) {
		case 'free':
			return({});
		case 'flat':
			return({
				KEETANET_LOCAL_NODE_FEE_SCHEDULE: `flat:${String(fee.amountPerBlock)}`,
				KEETANET_LOCAL_NODE_FEE_ACCOUNTS: fee.payTo.publicKeyString.get()
			});
		default:
			return(assertNever(fee));
	}
}

function preferUpdatesOf(options: ClusterOptions): PreferUpdates {
	return(options.preferUpdates ?? 'websocket');
}

function listening(server: Server, port: number): Promise<void> {
	return(new Promise<void>(function(resolve, reject) {
		server.once('error', reject);
		server.listen(port, LOOPBACK, function() {
			server.off('error', reject);
			resolve();
		});
	}));
}

function closed(server: Server): Promise<void> {
	return(new Promise<void>(function(resolve, reject) {
		server.close(function(error) {
			if (error !== undefined) {
				reject(error);
				return;
			}
			resolve();
		});
	}));
}

function messageOf(buffer: Buffer | ArrayBuffer): { readonly type: string; readonly id: string } | undefined {
	try {
		const message = lib.P2P.parseJSONMessage(Buffer.from(buffer));
		if (!message.valid) {
			return(undefined);
		}
		return({ type: message.type, id: message.id });
	} catch {
		return(undefined);
	}
}

/**
 * A node of the cluster, configured by its environment as the command
 * configures one, with storage of its own.
 */
export class ClusterMember {
	readonly index: number;
	readonly representative: Account;
	readonly #environment: Environment;
	readonly #store: MemberStore;
	readonly #genesis: VoteStaple | undefined;
	#state: MemberState = { kind: 'stopped' };
	#port = nextMemberPort();
	/** Whether the node has listened on the port, which peers then know it by. */
	#listened = false;
	readonly #adds: string[] = [];

	constructor(index: number, environment: Environment, store: MemberStore, genesis: VoteStaple | undefined) {
		this.index = index;
		this.representative = publicOnly(representativeOf(index));
		this.#environment = environment;
		this.#store = store;
		this.#genesis = genesis;
	}

	get #running(): Running {
		const state = this.#state;
		switch (state.kind) {
			case 'running':
				return(state.running);
			case 'offline':
			case 'stopped':
				throw(new Error(`member ${String(this.index)} is not running`));
			default:
				return(assertNever(state));
		}
	}

	get running(): boolean {
		return(this.#state.kind === 'running');
	}

	get node(): LocalNode {
		return(this.#running.node);
	}

	/** Where the API is served, with no trailing slash. */
	get apiURL(): string {
		return(this.#running.apiURL);
	}

	/** The representative as a client knows it. */
	get endpoint(): { readonly key: Account; readonly endpoints: { readonly api: string; readonly p2p: string } } {
		const { apiURL, p2pURL } = this.#running;
		return({ key: this.representative, endpoints: { api: apiURL, p2p: p2pURL } });
	}

	/** The IDs of the staples peers delivered over P2P since the cluster started, which are their blocks hashes. */
	get deliveredStaples(): readonly string[] {
		return(this.#adds);
	}

	/** The node's signed advertisement, as it prints it on its "peer:" line. */
	async peer(): Promise<string> {
		const peer = manualPeerOf(await this.node.switch.getOutgoingGreetingInfo());
		if (peer === undefined) {
			throw(new Error('the node does not advertise itself as a representative'));
		}
		return(formatManualPeer(peer));
	}

	/** The environment the member starts with, plus the variables given. */
	environment(extra: Environment = {}): Environment {
		return({ ...this.#environment, KEETANET_LOCAL_NODE_LISTEN_PORT: String(this.#port), ...extra });
	}

	/**
	 * Builds and runs the node as the command does, on the port it had before
	 * if it ran before. A port that a process outside the test run holds as
	 * the member first starts is passed over for the next.
	 */
	async start(): Promise<void> {
		if (this.#state.kind === 'running') {
			throw(new Error(`member ${String(this.index)} is already running`));
		}
		for (let attempt = 1; ; attempt++) {
			try {
				await this.#startOnPort();
				this.#listened = true;
				return;
			} catch (error: unknown) {
				if (this.#listened || !isAddressInUse(error) || attempt >= MEMBER_PORTS_PER_WORKER) {
					throw(error);
				}
				this.#port = nextMemberPort();
			}
		}
	}

	/**
	 * A store in memory starts empty, so it is given genesis, as every node of
	 * the network was when it was made, unless the member is to fetch it.
	 */
	async #startOnPort(): Promise<void> {
		const config = getConfigFromEnv(this.environment(), NO_REPRESENTATIVES);
		const storage = openStorage(config.storage);
		const nodeConfig = localNodeConfig(config, nodeResourcesOf(storage, new lib.Log()));
		nodeConfig.bootstrap = { ...nodeConfig.bootstrap, period: BOOTSTRAP_PERIOD_MILLISECONDS };
		const node = new LocalNode(nodeConfig);
		const commits = this.#observe(node, storage);
		try {
			const genesis = this.#genesis;
			if (genesis !== undefined && await node.ledger.getVoteStaple(genesis.blocksHash, 'main') === null) {
				await node.ledger.add(genesis);
			}
			const offline = this.#state;
			if (offline.kind === 'offline') {
				await closed(offline.offline.placeholder);
				this.#state = { kind: 'stopped' };
			}
			await node.run();
		} catch (error: unknown) {
			await node.stop();
			await closeStorage(storage);
			throw(error);
		}
		const { api, p2p } = node.config.endpoints ?? {};
		if (api === undefined || p2p === undefined) {
			throw(new Error('the node advertises no endpoints'));
		}
		this.#state = { kind: 'running', running: { node, storage, apiURL: api.replace(/\/$/, ''), p2pURL: p2p, commits } };
	}

	/** Records the staples peers deliver, and announces each commit, so that tests wait for events and not for time. */
	#observe(node: LocalNode, storage: OpenedStorage): Set<() => void> {
		const adds = this.#adds;
		const receive = node.switch.recvMessageFromPeer.bind(node.switch);
		node.switch.recvMessageFromPeer = function(from: P2PConnection, buffer: Buffer | ArrayBuffer): Promise<boolean> {
			const message = messageOf(buffer);
			if (message?.type === 'add') {
				adds.push(message.id);
			}
			return(receive(from, buffer));
		};
		const commits = new Set<() => void>();
		const ledger: LedgerStorageDriverBase = storage.ledger;
		const commit = ledger.commitTransaction.bind(ledger);
		// Reads commit too, the checks' own among them, so only writes are announced.
		ledger.commitTransaction = async function(transaction: Parameters<typeof commit>[0]): Promise<void> {
			await commit(transaction);
			if (transaction.readOnly) {
				return;
			}
			for (const committed of [...commits]) {
				committed();
			}
		};
		return(commits);
	}

	/**
	 * Resolves once the check holds, checking now and again after each commit
	 * to the node's ledger that came during or after the check before.
	 */
	async #until(check: () => Promise<boolean>): Promise<void> {
		const { commits } = this.#running;
		let commitCount = 0;
		let wake = function(): void {
			// Nothing waits until a check has failed.
		};
		const committed = function(): void {
			commitCount++;
			wake();
		};
		commits.add(committed);
		try {
			for (;;) {
				const countBefore = commitCount;
				if (await check()) {
					return;
				}
				if (commitCount === countBefore) {
					await new Promise<void>(function(resolve) {
						wake = resolve;
					});
				}
			}
		} finally {
			commits.delete(committed);
		}
	}

	/** Resolves once the node's ledger holds every one of the staples. */
	holds(staples: readonly VoteBlockHash[]): Promise<void> {
		const node = this.node;
		return(this.#until(async function(): Promise<boolean> {
			for (const blocksHash of staples) {
				if (await node.ledger.getVoteStaple(blocksHash, 'main') === null) {
					return(false);
				}
			}
			return(true);
		}));
	}

	/** The blocks hash of every staple the node's ledger holds. */
	async stapleHashes(): Promise<VoteBlockHash[]> {
		return(eachStapleOnce(await this.node.ledger.getVoteStaplesAfter(EPOCH, STAPLE_LIMIT)).map(function(staple): VoteBlockHash {
			return(staple.blocksHash);
		}));
	}

	/**
	 * The node's confirmed state in the canonical dump format, read through the
	 * storage API, over the accounts its own staples touch.
	 */
	async dump(): Promise<string> {
		const node = this.node;
		const listed = await node.ledger.getVoteStaplesAfter(EPOCH, STAPLE_LIMIT);
		if (listed.length >= STAPLE_LIMIT) {
			throw(new Error(`member ${String(this.index)} holds more staples than one read lists`));
		}
		const { checksum } = await nodeLedgerChecksum(node);
		return(await renderStateDump(node.ledger, eachStapleOnce(listed), checksum));
	}

	/**
	 * Stops the node and closes its storage, and holds its port meanwhile, so
	 * that the node comes back where its peers know it, as a restarted node
	 * does. Peers reaching the port are cut off at once.
	 */
	async takeOffline(): Promise<void> {
		const { node, storage } = this.#running;
		this.#state = { kind: 'stopped' };
		await node.stop();
		await closeStorage(storage);
		const placeholder = createServer(function(socket) {
			socket.destroy();
		});
		await listening(placeholder, this.#port);
		this.#state = { kind: 'offline', offline: { placeholder } };
	}

	/** Stops the node, closes its storage and drops its database. */
	async stop(): Promise<void> {
		const state = this.#state;
		this.#state = { kind: 'stopped' };
		switch (state.kind) {
			case 'running':
				await state.running.node.stop();
				await closeStorage(state.running.storage);
				break;
			case 'offline':
				await closed(state.offline.placeholder);
				break;
			case 'stopped':
				break;
			default:
				assertNever(state);
		}
		const store = this.#store;
		switch (store.kind) {
			case 'memory':
				return;
			case 'postgres':
				await store.database.drop();
				return;
			default:
				assertNever(store);
		}
	}
}

const trustedRoot = deriveTestKeys(TEST_NETWORK_SEEDS, 1).trustedRoot;

/** Representatives of one network, each a node in this process with its own storage, key and fees. */
export class Cluster {
	readonly genesis: VoteStaple;
	readonly #options: ClusterOptions;
	readonly #members: ClusterMember[] = [];
	readonly #clients: UserClient[] = [];
	#stopping: Promise<void> | undefined;

	private constructor(options: ClusterOptions, genesis: VoteStaple) {
		this.#options = options;
		this.genesis = genesis;
	}

	/** The representatives that hold weight, as they were started. */
	get representatives(): readonly ClusterMember[] {
		return(this.#members.slice(0, this.#options.weights.length));
	}

	/**
	 * Creates the network with the genesis command's own function, its supply
	 * delegated to the first representative and the default permission of a
	 * development network, and gives every node that genesis. Each node is then
	 * started with the earlier ones as manual peers, as an operator pastes the
	 * "peer:" lines nodes print, and once all are up each earlier node is given
	 * the later ones, whose ports were not known before, so that every node has
	 * dialed every other and knows it. Last, the weight is delegated: the
	 * supply less the spender's share is spread over holders delegating to each
	 * representative.
	 */
	static async start(options: ClusterOptions): Promise<Cluster> {
		const cluster = new Cluster(options, await Cluster.#createGenesis(options));
		const members = cluster.#members;
		try {
			for (const [index] of options.weights.entries()) {
				const earlier = await Promise.all(members.map(function(member): Promise<string> {
					return(member.peer());
				}));
				let peers: Environment = {};
				if (earlier.length > 0) {
					peers = { KEETANET_LOCAL_NODE_MANUAL_PEERS: earlier.join(',') };
				}
				const member = await cluster.#memberFor(index, { ...feeEnvironment(options.fees?.[index] ?? { kind: 'free' }), ...peers }, 'held');
				await member.start();
			}
			await cluster.#completeMesh();
			await cluster.#delegate();
		} catch (error: unknown) {
			await cluster.stop();
			throw(error);
		}
		return(cluster);
	}

	static async #createGenesis(options: ClusterOptions): Promise<VoteStaple> {
		const total = options.weights.reduce(function(sum, weight): bigint {
			return(sum + weight);
		}, SPENDING);
		const storage = openStorage({ kind: 'memory' });
		const config = getConfigFromEnv({
			KEETANET_LOCAL_NODE_SEED: TEST_NETWORK_SEEDS.representative,
			KEETANET_INITIAL_TRUSTED_ACCOUNT: trustedRoot.publicKeyString.get()
		}, NO_REPRESENTATIVES);
		const node = new LocalNode(localNodeConfig(config, nodeResourcesOf(storage, new lib.Log())));
		try {
			return(await addGenesis(node, {
				trustedSigner: TRUSTED_SIGNER,
				supply: total,
				delegateTo: publicOnly(representativeOf(0)),
				networkDefaultPermission: [...NETWORK_DEFAULT_PERMISSION]
			}));
		} finally {
			await node.stop();
		}
	}

	/** A member voting as the representative of that index, given genesis unless it is to fetch it. */
	async #memberFor(index: number, extra: Environment, genesis: 'held' | 'absent'): Promise<ClusterMember> {
		const environment: Environment = {
			KEETANET_LOCAL_NODE_SEED: TEST_NETWORK_SEEDS.representative,
			KEETANET_LOCAL_NODE_SEED_INDEX: String(index),
			KEETANET_INITIAL_TRUSTED_ACCOUNT: trustedRoot.publicKeyString.get(),
			KEETANET_LOCAL_NODE_LISTEN_IP: LOOPBACK,
			KEETANET_LOCAL_NODE_PREFER_UPDATES: preferUpdatesOf(this.#options),
			...extra
		};
		let given: VoteStaple | undefined;
		switch (genesis) {
			case 'held':
				given = this.genesis;
				break;
			case 'absent':
				break;
			default:
				assertNever(genesis);
		}
		const storage = this.#options.storage;
		let member: ClusterMember;
		switch (storage) {
			case 'memory':
				member = new ClusterMember(index, environment, { kind: 'memory' }, given);
				break;
			case 'postgres': {
				const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
				member = new ClusterMember(index, { ...environment, KEETANET_LOCAL_NODE_POSTGRES_URL: database.connectionString }, { kind: 'postgres', database }, given);
				break;
			}
			default:
				return(assertNever(storage));
		}
		this.#members.push(member);
		return(member);
	}

	/*
	 * Each node was given the earlier nodes when it started. The switch keeps a
	 * peer it was dialed by as unverified, and knows only the peers it dialed
	 * itself [Keeta TS] index.js:74696-74748, 74790-74793, so each earlier node
	 * dials the later ones too, in the form the setting takes and as the node
	 * dials the peers it was configured with.
	 */
	async #completeMesh(): Promise<void> {
		const peers = await Promise.all(this.#members.map(function(member): Promise<string> {
			return(member.peer());
		}));
		for (const member of this.#members) {
			const others = peers.filter(function(_peer, index): boolean {
				return(index !== member.index);
			});
			const { manualPeers } = getConfigFromEnv(member.environment({ KEETANET_LOCAL_NODE_MANUAL_PEERS: others.join(',') }), NO_REPRESENTATIVES);
			const configured = member.node.config.manualPeers ?? [];
			for (const peer of manualPeers) {
				const known = configured.some(function(existing): boolean {
					return('key' in existing && existing.key.comparePublicKey(peer.key));
				});
				if (!known) {
					member.node.switch.addManualPeer(peer);
				}
			}
			member.node.config.manualPeers = [...manualPeers];
		}
		await Promise.all(this.#members.map(async function(member): Promise<void> {
			await member.node.switch.wait();
			// Waits for the update the node began as it ran, which found only genesis.
			await member.node.bootstrap?.update();
		}));
	}

	/*
	 * The client caches each representative's weight and asks only those with
	 * some for votes [Keeta TS] index.js:60721-60750, so every step takes a new
	 * client once the network holds the step before.
	 */
	async #delegate(): Promise<void> {
		const representatives = this.representatives;
		const trusted = this.client(TRUSTED_SIGNER);
		const funding = trusted.initBuilder();
		funding.send(SPENDER, SPENDING, trusted.baseToken);
		for (const [index, weight] of this.#options.weights.entries()) {
			// Genesis delegated the whole supply to the first, and the trusted key keeps its share.
			if (index > 0) {
				funding.send(holderOf(index), weight, trusted.baseToken);
			}
		}
		await this.settled(publishedStaple(await trusted.publishBuilder(funding)));
		for (const member of representatives.slice(1)) {
			const holder = this.client(holderOf(member.index));
			const delegation = holder.initBuilder();
			delegation.setRep(member.representative);
			await this.settled(publishedStaple(await holder.publishBuilder(delegation)));
		}
	}

	/**
	 * A client of the official SDK that knows the members given, every running
	 * one unless told otherwise, and asks each for votes.
	 */
	client(signer: Account | null, members: readonly ClusterMember[] = this.running()): UserClient {
		const client = new KeetaNet.UserClient({
			client: new KeetaNet.Client(members.map(function(member) {
				const { key, endpoints } = member.endpoint;
				return({ key, endpoints: { ...endpoints } });
			})),
			signer,
			network: NETWORK,
			networkAlias: NETWORK_ALIAS
		});
		this.#clients.push(client);
		return(client);
	}

	/** The members whose nodes run, in the order they were first started. */
	running(): ClusterMember[] {
		return(this.#members.filter(function(member): boolean {
			return(member.running);
		}));
	}

	/** Resolves once every running member, or those given, holds the staple. */
	async settled(staple: VoteStaple, members: readonly ClusterMember[] = this.running()): Promise<void> {
		await Promise.all(members.map(function(member): Promise<void> {
			return(member.holds([staple.blocksHash]));
		}));
	}

	/** Resolves once the member holds every staple the reference holds now. */
	async caughtUp(member: ClusterMember, reference: ClusterMember): Promise<void> {
		await member.holds(await reference.stapleHashes());
	}

	/**
	 * Starts a node that knows no peer and that no peer knows, which takes
	 * staples only by bootstrapping from the running representatives' APIs,
	 * beginning with genesis.
	 */
	async join(mode: JoinerMode): Promise<ClusterMember> {
		const bootstrapPeers = this.running().map(function(member): string {
			return(member.apiURL);
		});
		const joiner = await this.#memberFor(this.#members.length, {
			KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode,
			KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: bootstrapPeers.join(',')
		}, 'absent');
		await joiner.start();
		return(joiner);
	}

	/** Stops every node and closes its storage, drops the databases and destroys the clients, once however often it is asked. */
	stop(): Promise<void> {
		this.#stopping ??= this.#stopAll();
		return(this.#stopping);
	}

	async #stopAll(): Promise<void> {
		for (const client of this.#clients.splice(0)) {
			await client.destroy();
		}
		const failures: unknown[] = [];
		for (const member of [...this.#members].reverse()) {
			try {
				await member.stop();
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw(new AggregateError(failures, 'stopping the cluster failed'));
		}
	}
}

/** Clusters for one test file, each stopped after the test that started it. */
export function useClusters(): { readonly start: (options: ClusterOptions) => Promise<Cluster> } {
	const started: Cluster[] = [];
	afterEach(async function() {
		for (const cluster of started.splice(0)) {
			await cluster.stop();
		}
	});
	return({
		start: async function(options: ClusterOptions): Promise<Cluster> {
			const cluster = await Cluster.start(options);
			started.push(cluster);
			return(cluster);
		}
	});
}
