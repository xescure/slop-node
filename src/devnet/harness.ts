import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { Environment } from '../node/config.js';
import { startCluster } from '../testing/postgres.js';
import type { Cluster } from '../testing/postgres.js';
import { assertNever } from '../util/assert-never.js';
import { renderNodeDump, storedChecksum } from './dump.js';
import { checkQuorumShape, delegateWeight, feeEnvironmentOf, GENESIS_ENVIRONMENT, perRepresentative, REPRESENTATIVE_INDEXES, REPRESENTATIVE_SEED, representativeOf, settledPerRepresentative, TRUSTED_ACCOUNT } from './genesis.js';
import type { PerRepresentative, RepresentativeIndex, RepresentativeWeights, UserClient } from './genesis.js';
import { processOfConnection } from './origin.js';
import { logTail, NodeProcess } from './process.js';
import type { Exit, NodeCommand } from './process.js';
import { TCPProxy } from './proxy.js';

const lib = KeetaNet.lib;

const LOOPBACK = '127.0.0.1';

/*
 * Network 0 has no alias of its own [Keeta TS] index.js:61337-61365; the
 * client takes one, and reads it only for the publish aid, which stays off.
 */
const NETWORK = 0n;
const NETWORK_ALIAS = 'test';

const NETWORK_ADDRESS: string = lib.Account.generateBaseAddresses(NETWORK).networkAddress.publicKeyString.get();

const DATABASE = 'slop_node';

/** Lines the node prints: the last of its startup summary, and the first of what genesis reports. */
const PEER_LINE = /^peer: (\S+)$/m;
const GENESIS_LINE = /^genesis: ([0-9A-F]{64})$/m;

/** A bound on a wait, and what the wait was for, which a failure names. */
type Deadline = { readonly milliseconds: number; readonly reason: string };

/*
 * A node loads the client, about a second, and migrates its database before
 * it serves; four start at once, on a machine that may be running every other
 * test file as well.
 */
const START_MILLISECONDS = 60_000;

/** Starts of a node that may each find the port it was given taken. */
const START_ATTEMPTS = 3;

/** conformance/DEPLOY.md gives a node 20 s to stop before it is killed. */
const STOP_MILLISECONDS = 20_000;

/*
 * A staple reaches the other nodes over P2P as soon as one holds it; a node
 * that missed it catches up from its peers within the bootstrap period of a
 * minute, which this outlasts.
 */
const SETTLE_MILLISECONDS = 90_000;

/*
 * How often a wait reads the API again: a node offers nothing to subscribe
 * to for its ledger. Each request makes the node write its statistics, so
 * the waits of four nodes are kept to a few requests a second each.
 */
const POLL_MILLISECONDS = 100;

/** One request of a wait, short of the wait itself, so that a request the proxy holds is tried again. */
const REQUEST_MILLISECONDS = 5_000;

/** Log lines of each node that a failure carries. */
const FAILURE_LOG_LINES = 30;

export type DevnetOptions = {
	/** Where the node logs are written. */
	readonly directory: string;
	/** Where each node's Postgres cluster gets a directory of its own. */
	readonly clusterParent: string;
	readonly command: NodeCommand;
};

/** What a client needs to reach a representative: its key and the proxy's address. */
export type RepresentativeEndpoints = {
	readonly key: Account;
	readonly endpoints: { readonly api: string; readonly p2p: string };
};

/** The harness observes a node at the port it listens on, so that it sees the node even while the proxy cuts it off. */
type NodeState =
	| { readonly kind: 'running'; readonly process: NodeProcess; readonly observedAt: string }
	| { readonly kind: 'down' };

export type NodeDump = { readonly index: RepresentativeIndex; readonly dump: string };

function freePort(): Promise<number> {
	return(new Promise(function(resolve, reject) {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, LOOPBACK, function() {
			const address = server.address();
			server.close(function() {
				if (address === null || typeof address === 'string') {
					reject(new Error(`expected a TCP address, got ${String(address)}`));
					return;
				}
				resolve(address.port);
			});
		});
	}));
}

/** The value read() answers once it answers one, read again until the deadline. */
async function until<Value>(deadline: Deadline, read: () => Promise<Value | undefined>): Promise<Value> {
	const end = Date.now() + deadline.milliseconds;
	let lastProblem = 'none';
	for (;;) {
		try {
			const value = await read();
			if (value !== undefined) {
				return(value);
			}
		} catch (error: unknown) {
			lastProblem = String(error);
		}
		if (Date.now() >= end) {
			throw(new Error(`${deadline.reason}: not within ${String(deadline.milliseconds)} ms (last problem: ${lastProblem})`));
		}
		await delay(POLL_MILLISECONDS);
	}
}

/** A condition of a wait: true once it holds, and undefined, to be read again, until then. */
function holding(condition: boolean): true | undefined {
	if (condition) {
		return(true);
	}
	return(undefined);
}

/** Rejects with the reason once the deadline passes, unless the promise settles first. */
async function within<Value>(deadline: Deadline, promise: Promise<Value>): Promise<Value> {
	const timer = new AbortController();
	try {
		return(await Promise.race([
			promise,
			delay(deadline.milliseconds, undefined, { signal: timer.signal }).then(function(): never {
				throw(new Error(`${deadline.reason}: not within ${String(deadline.milliseconds)} ms`));
			})
		]));
	} finally {
		timer.abort();
	}
}

async function getJSON(url: string): Promise<unknown> {
	const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_MILLISECONDS) });
	if (!response.ok) {
		throw(new Error(`GET ${url} answered ${String(response.status)}`));
	}
	return(await response.json());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return(typeof value === 'object' && value !== null);
}

/** Whether the "block" of an answer is a block rather than null. */
function holdsBlock(answer: unknown): boolean {
	return(isRecord(answer) && 'block' in answer && answer['block'] !== null);
}

/** The members of the list an answer holds under the name, those that are objects. */
function listedRecords(answer: unknown, name: string): Record<string, unknown>[] {
	if (!isRecord(answer)) {
		return([]);
	}
	const list = answer[name];
	if (!Array.isArray(list)) {
		return([]);
	}
	return(list.filter(isRecord));
}

function bigintText(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') {
		return(value.toString());
	}
	return(value);
}

async function createNodeDatabase(cluster: Cluster): Promise<string> {
	const client = new pg.Client({ host: cluster.socketDirectory, port: cluster.port, user: cluster.user, database: 'postgres' });
	await client.connect();
	try {
		await client.query(`CREATE DATABASE ${DATABASE}`);
	} finally {
		await client.end();
	}
	return(`postgresql://${cluster.user}@${encodeURIComponent(cluster.socketDirectory)}:${String(cluster.port)}/${DATABASE}`);
}

/**
 * One representative's node: a process of its own, with its own Postgres
 * cluster, seed and fee policy, which peers and clients reach only through
 * its proxy, whose address it advertises.
 */
export class DevnetNode {
	readonly index: RepresentativeIndex;
	readonly representative: Account;
	readonly apiURL: string;
	readonly p2pURL: string;
	readonly logPath: string;
	readonly databaseURL: string;
	readonly proxy: TCPProxy;
	readonly #command: NodeCommand;
	#peers: Environment = {};
	#state: NodeState = { kind: 'down' };

	constructor(index: RepresentativeIndex, proxy: TCPProxy, databaseURL: string, logPath: string, command: NodeCommand) {
		this.index = index;
		this.representative = representativeOf(index);
		this.proxy = proxy;
		this.databaseURL = databaseURL;
		this.logPath = logPath;
		this.#command = command;
		this.apiURL = `http://${LOOPBACK}:${String(proxy.port)}/api`;
		this.p2pURL = `ws://${LOOPBACK}:${String(proxy.port)}/p2p`;
	}

	get running(): boolean {
		return(this.#state.kind === 'running');
	}

	/** The running process's ID, whose connections the other proxies refuse while the node is cut off. */
	get processID(): number | undefined {
		const state = this.#state;
		switch (state.kind) {
			case 'running':
				return(state.process.processID);
			case 'down':
				return(undefined);
			default:
				return(assertNever(state));
		}
	}

	get endpoints(): RepresentativeEndpoints {
		return({ key: this.representative, endpoints: { api: this.apiURL, p2p: this.p2pURL } });
	}

	/** The settings an operator gives this node, but the port it listens on, which each start picks. */
	environment(): Environment {
		return({
			KEETANET_LOCAL_NODE_SEED: REPRESENTATIVE_SEED,
			KEETANET_LOCAL_NODE_SEED_INDEX: String(this.index),
			KEETANET_INITIAL_TRUSTED_ACCOUNT: TRUSTED_ACCOUNT.publicKeyString.get(),
			KEETANET_LOCAL_NODE_NETWORK: 'local',
			KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-write',
			KEETANET_LOCAL_NODE_POSTGRES_URL: this.databaseURL,
			KEETANET_LOCAL_NODE_LISTEN_IP: LOOPBACK,
			KEETANET_LOCAL_NODE_ENDPOINT_API: this.apiURL,
			KEETANET_LOCAL_NODE_ENDPOINT_P2P: this.p2pURL,
			...feeEnvironmentOf(this.index),
			...this.#peers
		});
	}

	/** The peers the node dials from its next start, each as that node printed itself on its "peer:" line. */
	setPeers(peers: readonly string[]): void {
		this.#peers = { KEETANET_LOCAL_NODE_MANUAL_PEERS: peers.join(',') };
	}

	/** Runs the genesis command against this node's database, and answers the hash of the staple it printed. */
	async genesis(): Promise<string> {
		const genesis = NodeProcess.spawn(this.#command, 'genesis', { ...this.environment(), ...GENESIS_ENVIRONMENT }, this.logPath);
		const exit = await within({ milliseconds: START_MILLISECONDS, reason: `genesis on node ${String(this.index)}` }, genesis.exited);
		const hash = genesis.stdout.match(GENESIS_LINE)?.[1];
		if (exit.code !== 0 || hash === undefined) {
			throw(new Error(`genesis on node ${String(this.index)} exited ${JSON.stringify(exit)}, printing ${JSON.stringify(genesis.stdout)}`));
		}
		return(hash);
	}

	/**
	 * Starts the node on a free port, with its proxy holding the peers that
	 * dial it meanwhile, and answers its "peer:" line once its API answers.
	 * Another socket may take the port before the node listens on it, so a
	 * node that finds its port in use is started again on another.
	 */
	async start(): Promise<string> {
		if (this.#state.kind === 'running') {
			throw(new Error(`node ${String(this.index)} is already running`));
		}
		this.proxy.hold();
		for (let attempt = 1; ; attempt++) {
			const port = await freePort();
			this.proxy.setTarget(port);
			const started = NodeProcess.spawn(this.#command, 'run', { ...this.environment(), KEETANET_LOCAL_NODE_LISTEN_PORT: String(port) }, this.logPath);
			this.#state = { kind: 'running', process: started, observedAt: `http://${LOOPBACK}:${String(port)}/api` };
			const reason = `node ${String(this.index)} to serve`;
			let peer: string | undefined;
			try {
				peer = (await within({ milliseconds: START_MILLISECONDS, reason }, started.printed(PEER_LINE)))[1];
			} catch (error: unknown) {
				if (attempt < START_ATTEMPTS && started.stderr.includes(`port ${String(port)} in use`)) {
					this.#state = { kind: 'down' };
					continue;
				}
				throw(error);
			}
			if (peer === undefined) {
				throw(new Error(`node ${String(this.index)} printed no peer`));
			}
			this.proxy.release();
			await until({ milliseconds: START_MILLISECONDS, reason }, async () => {
				return(holding(isRecord(await this.#observe('/node/version'))));
			});
			return(peer);
		}
	}

	/** Sends the signal and waits for the process to exit, which it must with status 0 on SIGTERM. */
	async stop(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
		const state = this.#state;
		switch (state.kind) {
			case 'down':
				return;
			case 'running':
				break;
			default:
				assertNever(state);
		}
		this.#state = { kind: 'down' };
		state.process.signal(signal);
		let exit: Exit;
		try {
			exit = await within({ milliseconds: STOP_MILLISECONDS, reason: `node ${String(this.index)} to exit on ${signal}` }, state.process.exited);
		} catch (error: unknown) {
			state.process.signal('SIGKILL');
			await state.process.exited;
			throw(error);
		}
		switch (signal) {
			case 'SIGTERM':
				if (exit.code !== 0) {
					throw(new Error(`node ${String(this.index)} exited ${JSON.stringify(exit)} on SIGTERM; its log is ${this.logPath}`));
				}
				return;
			case 'SIGKILL':
				return;
			default:
				assertNever(signal);
		}
	}

	/** Reads the running node's API directly, where it listens. */
	async #observe(path: string): Promise<unknown> {
		const state = this.#state;
		switch (state.kind) {
			case 'running':
				return(await getJSON(`${state.observedAt}${path}`));
			case 'down':
				throw(new Error(`node ${String(this.index)} is not running`));
			default:
				return(assertNever(state));
		}
	}

	async holdsBlock(hash: string): Promise<boolean> {
		return(holdsBlock(await this.#observe(`/node/ledger/block/${hash}`)));
	}

	/** Whether the node holds genesis: the network address has a head block (conformance/DEPLOY.md, section 7). */
	async holdsGenesis(): Promise<boolean> {
		return(holdsBlock(await this.#observe(`/node/ledger/account/${NETWORK_ADDRESS}/head`)));
	}

	/** Whether the node's peers include each of the nodes given. */
	async listsPeers(nodes: readonly DevnetNode[]): Promise<boolean> {
		const listed = new Set(listedRecords(await this.#observe('/node/peers'), 'peers').map(function(peer): unknown {
			return(peer['key']);
		}));
		return(nodes.every(function(node): boolean {
			return(listed.has(node.representative.publicKeyString.get()));
		}));
	}

	/** The voting weight of each representative, as this node's ledger holds it. */
	async weights(): Promise<RepresentativeWeights> {
		const listed = new Map<unknown, unknown>(listedRecords(await this.#observe('/node/ledger/representatives'), 'representatives').map(function(entry): [unknown, unknown] {
			return([entry['representative'], entry['weight']]);
		}));
		return(perRepresentative(function(index): bigint {
			const weight = listed.get(representativeOf(index).publicKeyString.get());
			if (typeof weight !== 'string') {
				return(0n);
			}
			return(BigInt(weight));
		}));
	}

	/** The ledger checksum the running node reports, or the one a stopped node left in its database. */
	async checksum(): Promise<bigint> {
		if (!this.running) {
			return(await storedChecksum(this.databaseURL));
		}
		const answer = await this.#observe('/node/ledger/checksum');
		if (!isRecord(answer) || typeof answer['checksum'] !== 'string') {
			throw(new Error(`node ${String(this.index)} answered no checksum: ${JSON.stringify(answer)}`));
		}
		return(BigInt(answer['checksum']));
	}

	/** The node's confirmed state, rendered from its own database. */
	async dump(): Promise<string> {
		return(await renderNodeDump(this.databaseURL, await this.checksum()));
	}

	async logTail(): Promise<string> {
		return(`node ${String(this.index)} (${this.logPath}):\n${await logTail(this.logPath, FAILURE_LOG_LINES)}`);
	}
}

/** What was started, to be stopped again however far starting got. */
type Started = {
	readonly nodes: DevnetNode[];
	readonly proxies: TCPProxy[];
	readonly clusters: Cluster[];
	readonly clients: UserClient[];
};

/**
 * Destroys the clients, stops every node with SIGTERM, which each must exit 0
 * on, then the proxies and the clusters, going on past a step that fails.
 */
async function release(started: Started): Promise<void> {
	const failures: unknown[] = [];
	const attempt = async function(step: Promise<void>): Promise<void> {
		try {
			await step;
		} catch (error: unknown) {
			failures.push(error);
		}
	};
	await Promise.all(started.clients.splice(0).map(function(client): Promise<void> {
		return(attempt(client.destroy()));
	}));
	await Promise.all(started.nodes.map(function(node): Promise<void> {
		return(attempt(node.stop('SIGTERM')));
	}));
	await Promise.all(started.proxies.map(function(proxy): Promise<void> {
		return(attempt(proxy.close()));
	}));
	await Promise.all(started.clusters.map(function(cluster): Promise<void> {
		return(attempt(cluster.stop()));
	}));
	if (failures.length > 0) {
		throw(new AggregateError(failures, `stopping the devnet failed: ${failures.map(String).join('; ')}`));
	}
}

/**
 * Four representatives of network 0, each a node process with its own
 * Postgres cluster, created as conformance/DEPLOY.md section 7 tells an
 * operator to, and driven through the official SDK.
 */
export class Devnet {
	readonly nodes: PerRepresentative<DevnetNode>;
	readonly genesisHash: string;
	readonly #started: Started;
	readonly #partitioned = new Set<RepresentativeIndex>();
	#weights: RepresentativeWeights | undefined;
	#stopping: Promise<void> | undefined;

	private constructor(nodes: PerRepresentative<DevnetNode>, started: Started, genesisHash: string) {
		this.nodes = nodes;
		this.#started = started;
		this.genesisHash = genesisHash;
	}

	/**
	 * Creates the network on the first node's database, starts every node to
	 * learn its "peer:" line, restarts each with the others as its manual
	 * peers, waits for every node to hold genesis and list the others, and
	 * spreads the voting weight so that any three representatives confirm a
	 * staple and no two do. Whatever was started is stopped again if a step
	 * fails, and the failure carries the end of every node's log.
	 */
	static async start(options: DevnetOptions): Promise<Devnet> {
		await mkdir(options.directory, { recursive: true });
		const started: Started = { nodes: [], proxies: [], clusters: [], clients: [] };
		try {
			const nodes = await settledPerRepresentative(perRepresentative(async function(index): Promise<DevnetNode> {
				const cluster = await startCluster(options.clusterParent);
				started.clusters.push(cluster);
				const proxy = await TCPProxy.start({ target: 0, origin: processOfConnection });
				started.proxies.push(proxy);
				const node = new DevnetNode(index, proxy, await createNodeDatabase(cluster), join(options.directory, `node-${String(index)}.log`), options.command);
				started.nodes.push(node);
				return(node);
			}));
			const devnet = new Devnet(nodes, started, await nodes[0].genesis());
			await devnet.#connect();
			await devnet.#delegate();
			return(devnet);
		} catch (error: unknown) {
			const logs = await Promise.all(started.nodes.map(function(node): Promise<string> {
				return(node.logTail());
			}));
			await release(started).catch(function() {
				// The failure to start is the one reported.
			});
			throw(new Error(`the devnet did not start: ${String(error)}\n${logs.join('\n')}`, { cause: error }));
		}
	}

	/** Every node, in index order. */
	get all(): readonly DevnetNode[] {
		return(REPRESENTATIVE_INDEXES.map((index): DevnetNode => {
			return(this.nodes[index]);
		}));
	}

	/** The nodes whose process runs. */
	running(): DevnetNode[] {
		return(this.all.filter(function(node): boolean {
			return(node.running);
		}));
	}

	/** The weight each representative holds once the devnet has started. */
	get weights(): RepresentativeWeights {
		if (this.#weights === undefined) {
			throw(new Error('the devnet has not delegated its weight yet'));
		}
		return(this.#weights);
	}

	/*
	 * A node knows a peer's "peer:" line only once that peer has run, so every
	 * node runs once without peers and then again with the others' lines, as
	 * conformance/DEPLOY.md section 7 has an operator do.
	 */
	async #connect(): Promise<void> {
		const peers = await Promise.all(this.all.map(function(node): Promise<string> {
			return(node.start());
		}));
		await Promise.all(this.all.map(function(node): Promise<void> {
			return(node.stop('SIGTERM'));
		}));
		for (const node of this.all) {
			node.setPeers(peers.filter(function(_peer, index): boolean {
				return(index !== node.index);
			}));
		}
		await Promise.all(this.all.map(function(node): Promise<string> {
			return(node.start());
		}));
		await Promise.all(this.all.map((node): Promise<[true, true]> => {
			const others = this.all.filter(function(other): boolean {
				return(other.index !== node.index);
			});
			return(Promise.all([
				until({ milliseconds: SETTLE_MILLISECONDS, reason: `node ${String(node.index)} to hold genesis` }, async function() {
					return(holding(await node.holdsGenesis()));
				}),
				until({ milliseconds: SETTLE_MILLISECONDS, reason: `node ${String(node.index)} to list every other node as a peer` }, async function() {
					return(holding(await node.listsPeers(others)));
				})
			]));
		}));
	}

	/** Delegates, then checks on every node's ledger that exactly three of four representatives make a quorum. */
	async #delegate(): Promise<void> {
		await delegateWeight({
			client: (signer) => {
				return(this.client(signer));
			},
			settled: (staple) => {
				return(this.settled(staple));
			}
		});
		const views = await Promise.all(this.all.map(function(node): Promise<RepresentativeWeights> {
			return(node.weights());
		}));
		const [weights] = views;
		const texts = new Set(views.map(function(view): string {
			return(JSON.stringify(view, bigintText));
		}));
		if (weights === undefined || texts.size !== 1) {
			throw(new Error(`the nodes disagree on the weights: ${[...texts].join(' ')}`));
		}
		const shape = checkQuorumShape(weights);
		if (shape.kind !== 'any-three-not-two') {
			throw(new Error(`the delegated weights ${JSON.stringify(weights, bigintText)} do not make exactly three of four a quorum: ${JSON.stringify(shape)}`));
		}
		this.#weights = weights;
	}

	/**
	 * A client of the official SDK that knows the representatives given,
	 * every one unless told otherwise, and asks each for votes. It is
	 * destroyed as the devnet stops.
	 */
	client(signer: Account | null, indexes: readonly RepresentativeIndex[] = REPRESENTATIVE_INDEXES): UserClient {
		const client = new KeetaNet.UserClient({
			client: new KeetaNet.Client(indexes.map((index) => {
				const { key, endpoints } = this.nodes[index].endpoints;
				return({ key, endpoints: { ...endpoints } });
			})),
			signer,
			usePublishAid: false,
			network: NETWORK,
			networkAlias: NETWORK_ALIAS
		});
		this.#started.clients.push(client);
		return(client);
	}

	/**
	 * Resolves once every running node, or each of those given, holds the
	 * staple. A ledger adds a staple's blocks in one transaction, so holding
	 * its last block is holding all of them.
	 */
	async settled(staple: VoteStaple, nodes: readonly DevnetNode[] = this.running()): Promise<void> {
		const last = staple.blocks.at(-1)?.hash.toString();
		if (last === undefined) {
			throw(new Error(`staple ${staple.blocksHash.toString()} has no blocks`));
		}
		await Promise.all(nodes.map(function(node): Promise<true> {
			return(until({ milliseconds: SETTLE_MILLISECONDS, reason: `node ${String(node.index)} to hold staple ${staple.blocksHash.toString()}` }, async function() {
				return(holding(await node.holdsBlock(last)));
			}));
		}));
	}

	/** Each node's confirmed state in the canonical dump format, rendered from its own database. */
	async dumps(): Promise<NodeDump[]> {
		return(await Promise.all(this.all.map(async function(node): Promise<NodeDump> {
			return({ index: node.index, dump: await node.dump() });
		})));
	}

	/** Kills the node's process outright, as a crash would. */
	async kill(index: RepresentativeIndex): Promise<void> {
		await this.nodes[index].stop('SIGKILL');
	}

	/** Starts the node again with the settings it had, on its database, still cut off if it was. */
	async restart(index: RepresentativeIndex): Promise<void> {
		await this.nodes[index].start();
		await this.#applyPartitions();
	}

	/** Cuts the node off from the other nodes and from clients, in both directions. */
	async partition(index: RepresentativeIndex): Promise<void> {
		this.#partitioned.add(index);
		await this.#applyPartitions();
	}

	async heal(index: RepresentativeIndex): Promise<void> {
		this.#partitioned.delete(index);
		await this.#applyPartitions();
	}

	/*
	 * A partitioned node's own proxy refuses everything, and every other proxy
	 * refuses the connections the partitioned node's process opens: its dials,
	 * its republishing and its bootstrap requests.
	 */
	async #applyPartitions(): Promise<void> {
		const refused = new Set<number>();
		for (const index of this.#partitioned) {
			const processID = this.nodes[index].processID;
			if (processID !== undefined) {
				refused.add(processID);
			}
		}
		await Promise.all(this.all.map(async (node): Promise<void> => {
			if (this.#partitioned.has(node.index)) {
				node.proxy.block();
				return;
			}
			node.proxy.unblock();
			await node.proxy.refuseFrom(refused);
		}));
	}

	/** The last lines of every node's log, for a failure to carry. */
	async logTails(): Promise<string> {
		return((await Promise.all(this.all.map(function(node): Promise<string> {
			return(node.logTail());
		}))).join('\n'));
	}

	/** Stops everything the devnet started, once however often it is asked. */
	stop(): Promise<void> {
		this.#stopping ??= release(this.#started);
		return(this.#stopping);
	}
}
