import { describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { P2PConnection } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { firstDifference } from '../conformance/mainnet/dump.js';
import { publishedStaple, SPENDER, SPENDING, useClusters } from '../testing/cluster.js';
import type { Cluster, ClusterMember, JoinerMode, PreferUpdates, RepresentativeFee } from '../testing/cluster.js';
import { watchOpenHandles } from '../testing/open-handles.js';
import { RECEIVER, STORAGES_UNDER_TEST } from '../testing/sdk.js';
import type { StorageUnderTest } from '../testing/sdk.js';

const lib = KeetaNet.lib;

const clusters = useClusters();

/*
 * Each cluster test took under 1.2 s alone and under 4 s under make -j8,
 * mostly starting nodes and the staples that delegate the weight, Postgres
 * about three times as long as memory. No wait here can be met by a node's
 * next bootstrap, an hour away, so the limit only allows for a slower or
 * busier machine, by fifteen times the slowest measured.
 */
const CLUSTER_TEST_TIMEOUT_MILLISECONDS = 60_000;

/** Two thirds of the weight is no quorum, so with equal weights every staple needs the votes of all three. */
const EQUAL_WEIGHTS: readonly bigint[] = [1000n, 1000n, 1000n];

/** The first two, holding four fifths, reach quorum without the third. */
const PARTITION_WEIGHTS: readonly bigint[] = [2000n, 2000n, 1000n];

/** An account no staple touches until a scenario sends to it, from a fixed seed. */
const OTHER: Account = lib.Account.fromSeed('e5c7a9b1d3f5071a2c4e6b8d0f2a4c6e8b1d3f5a7c9e0b2d4f6a8c1e3b5d7f90', 0);

/** Where each representative's fees are paid, from fixed seeds. */
const FEE_ACCOUNTS: readonly Account[] = [
	lib.Account.fromSeed('a1c3e5f7092b4d6f8a0c2e4b6d8f1a3c5e7b9d0f2a4c6e8b1d3f5a7c9e0b2d41', 0),
	lib.Account.fromSeed('b2d4f6a8c1e3b5d7f9a0c2e4b6d8f1a3c5e7092b4d6f8a0c2e4b6d8f1a3c5e72', 0),
	lib.Account.fromSeed('c3e5f7a9b1d3f5072a4c6e8b0d2f4a6c8e1b3d5f7a9c0e2b4d6f8a1c3e5b7d93', 0)
];

/** Each representative charges its own amount per block. */
const FEES_PER_BLOCK: readonly bigint[] = [3n, 5n, 7n];

function keyOf(account: GenericAccount): string {
	return(account.publicKeyString.get());
}

function keysOf(members: readonly ClusterMember[]): string[] {
	return(members.map(function(member): string {
		return(keyOf(member.representative));
	}).sort());
}

function issuersOf(staple: VoteStaple): string[] {
	return(staple.votes.map(function(vote): string {
		return(keyOf(vote.issuer));
	}).sort());
}

/** A send from the spender, voted on by the members given, every running one unless told otherwise, and held by every running member before it resolves. */
async function spend(cluster: Cluster, to: Account, amount: bigint, voters?: readonly ClusterMember[]): Promise<VoteStaple> {
	const spender = cluster.client(SPENDER, voters);
	const staple = publishedStaple(await spender.send(to, amount, spender.baseToken));
	await cluster.settled(staple);
	return(staple);
}

/** Every member's dump equals the first's, which is returned. */
async function convergedDump(members: readonly ClusterMember[]): Promise<string> {
	const [reference, ...others] = await Promise.all(members.map(function(member): Promise<string> {
		return(member.dump());
	}));
	if (reference === undefined) {
		throw(new Error('no member to dump'));
	}
	for (const dump of others) {
		expect(firstDifference(reference, dump)).toBeNull();
	}
	return(reference);
}

const BASE_TOKEN = lib.Account.generateBaseAddresses(0n).baseToken;

/** The dump's record of the account's balance in the base token. */
function balanceLine(account: GenericAccount, amount: bigint): string {
	return(`{"kind":"balance","account":"${keyOf(account)}","token":"${keyOf(BASE_TOKEN)}","amount":"${String(amount)}"}\n`);
}

/** The representatives the node knows, verified, by key. */
async function knownPeersOf(member: ClusterMember): Promise<string[]> {
	return((await member.node.switch.peers()).flatMap(function(peer): string[] {
		if (peer.kind !== lib.Node.Kind.REPRESENTATIVE) {
			return([]);
		}
		return([keyOf(peer.key)]);
	}).sort());
}

type Listener = {
	/** The IDs of the staples the node has sent the listener, which are their blocks hashes. */
	readonly staples: readonly string[];
	/** Resolves once the node has sent the listener that staple. */
	readonly received: (staple: VoteStaple) => Promise<void>;
	readonly close: () => void;
};

/** The switch sends its messages as text frames [Keeta TS] index.js:73552. */
function addOf(data: unknown): string | undefined {
	if (typeof data !== 'string') {
		return(undefined);
	}
	const message = lib.P2P.parseJSONMessage(Buffer.from(data));
	if (!message.valid || message.type !== 'add') {
		return(undefined);
	}
	return(message.id);
}

/**
 * A participant connected to the member's /p2p WebSocket, greeting it with a
 * filter on the account [Keeta TS] index.js:74696-74730, once the switch has
 * registered the connection, which it does once it has handled the greeting
 * [Keeta TS] index.js:73467-73491, 73841-73879.
 */
async function listen(member: ClusterMember, filter: Account): Promise<Listener> {
	const node = member.node;
	const register = node.switch.registerConnection.bind(node.switch);
	const registered = new Promise<void>(function(resolve) {
		const spy = vi.spyOn(node.switch, 'registerConnection').mockImplementation(async function(connection: P2PConnection): Promise<void> {
			await register(connection);
			if (connection.peer?.kind === lib.Node.Kind.PARTICIPANT) {
				spy.mockRestore();
				resolve();
			}
		});
	});
	const p2p = node.config.endpoints?.p2p;
	if (p2p === undefined) {
		throw(new Error('the node advertises no p2p endpoint'));
	}
	const socket = new WebSocket(p2p);
	const staples: string[] = [];
	const waiting = new Map<string, () => void>();
	socket.addEventListener('message', function(event: MessageEvent<unknown>) {
		const id = addOf(event.data);
		if (id !== undefined) {
			staples.push(id);
			waiting.get(id)?.();
		}
	});
	await new Promise<void>(function(resolve, reject) {
		socket.addEventListener('open', function() {
			resolve();
		});
		socket.addEventListener('error', function() {
			reject(new Error(`the listener could not connect to ${p2p}`));
		});
	});
	socket.send(JSON.stringify({ id: `listener-${String(member.index)}`, greeting: { kind: lib.Node.Kind.PARTICIPANT, filter: keyOf(filter) }, ttl: 0 }));
	await registered;
	return({
		staples,
		received: function(staple: VoteStaple): Promise<void> {
			const id = staple.blocksHash.toString();
			return(new Promise<void>(function(resolve) {
				if (staples.includes(id)) {
					resolve();
					return;
				}
				waiting.set(id, resolve);
			}));
		},
		close: function(): void {
			socket.close();
		}
	});
}

/** Resolves once the switch has kept a staple from a connection whose filter it does not pass [Keeta TS] index.js:74239-74244. */
function filteredOnce(member: ClusterMember): Promise<void> {
	const stats = member.node.stats;
	const increment = stats.incr.bind(stats);
	return(new Promise<void>(function(resolve) {
		vi.spyOn(stats, 'incr').mockImplementation(function(arena: string, key: string, change?: number): void {
			increment(arena, key, change);
			if (arena === 'p2p' && key === 'outgoingMessagesPeerFiltered') {
				resolve();
			}
		});
	}));
}

describe.each(STORAGES_UNDER_TEST)('representatives on %s', function(storage: StorageUnderTest) {
	test.each([
		{ transport: 'the WebSocket', preferUpdates: 'websocket' },
		{ transport: 'HTTP republish', preferUpdates: 'http' }
	] as const satisfies readonly { readonly transport: string; readonly preferUpdates: PreferUpdates }[])('know each other over $transport, and each applies a send voted by all of them, reaching one state', async function({ preferUpdates }) {
		const cluster = await clusters.start({ storage, weights: EQUAL_WEIGHTS, preferUpdates });
		const representatives = cluster.representatives;
		for (const member of representatives) {
			expect(await knownPeersOf(member)).toEqual(keysOf(representatives.filter(function(other): boolean {
				return(other !== member);
			})));
			for (const peer of await member.node.switch.peers()) {
				expect(peer).toMatchObject({ kind: lib.Node.Kind.REPRESENTATIVE, preferUpdates });
			}
		}

		const staple = await spend(cluster, RECEIVER, 100n);

		expect(issuersOf(staple)).toEqual(keysOf(representatives));
		// The client publishes to one representative; the others take the staple from their peers.
		const blocksHash = staple.blocksHash.toString();
		expect(representatives.filter(function(member): boolean {
			return(member.deliveredStaples.includes(blocksHash));
		}).length).toBeGreaterThanOrEqual(representatives.length - 1);
		const dump = await convergedDump(representatives);
		expect(dump).toContain(balanceLine(RECEIVER, 100n));
		expect(dump).toContain(balanceLine(SPENDER, SPENDING - 100n));
	}, CLUSTER_TEST_TIMEOUT_MILLISECONDS);

	test.each(['read-write', 'bootstrap-only'] as const satisfies readonly JoinerMode[])('let a node that joins later in %s mode, with no peer, catch up by bootstrap alone', async function(mode) {
		const cluster = await clusters.start({ storage, weights: EQUAL_WEIGHTS });
		for (const amount of [10n, 20n, 30n]) {
			await spend(cluster, RECEIVER, amount);
		}
		const [first] = cluster.representatives;
		if (first === undefined) {
			throw(new Error('the cluster has no representative'));
		}

		const joiner = await cluster.join(mode);
		await cluster.caughtUp(joiner, first);

		expect(joiner.node.ledger.ledgerWriteMode).toBe(mode);
		expect(joiner.deliveredStaples).toEqual([]);
		expect(await joiner.node.switch.peers({ includeUnverified: true, includeStale: true })).toEqual([]);
		expect((await joiner.stapleHashes()).length).toBe((await first.stapleHashes()).length);
		const dump = await convergedDump([...cluster.representatives, joiner]);
		expect(dump).toContain(balanceLine(RECEIVER, 60n));
	}, CLUSTER_TEST_TIMEOUT_MILLISECONDS);

	test('keep a quorum while one is offline, which catches up when it comes back and then votes again', async function() {
		const cluster = await clusters.start({ storage, weights: PARTITION_WEIGHTS });
		const [first, second, third] = cluster.representatives;
		if (first === undefined || second === undefined || third === undefined) {
			throw(new Error('the cluster has fewer than three representatives'));
		}
		await spend(cluster, RECEIVER, 10n);

		await third.takeOffline();
		/*
		 * The client tries a representative it cannot reach 33 times, waiting
		 * up to half a second between tries [Keeta TS] index.js:60562-60564,
		 * 60693-60701, so while one is offline the client knows the reachable
		 * ones, as a wallet would after failing to reach it.
		 */
		const reachable = [first, second];
		const missed: VoteStaple[] = [];
		for (const amount of [20n, 30n]) {
			missed.push(await spend(cluster, RECEIVER, amount, reachable));
		}
		for (const staple of missed) {
			expect(issuersOf(staple)).toEqual(keysOf(reachable));
		}

		await third.start();
		await cluster.caughtUp(third, first);
		for (const staple of missed) {
			expect(await third.node.ledger.getVoteStaple(staple.blocksHash, 'main')).not.toBeNull();
		}
		const healed = await spend(cluster, RECEIVER, 40n);

		expect(issuersOf(healed)).toEqual(keysOf(cluster.representatives));
		// Back where its peers know it, it takes new staples from them again.
		expect(third.deliveredStaples).toContain(healed.blocksHash.toString());
		const dump = await convergedDump(cluster.representatives);
		expect(dump).toContain(balanceLine(RECEIVER, 100n));
	}, CLUSTER_TEST_TIMEOUT_MILLISECONDS);

	test('send a listener that filters on an account only the staples that touch it', async function() {
		const cluster = await clusters.start({ storage, weights: EQUAL_WEIGHTS });
		const representatives = cluster.representatives;
		const listeners: Listener[] = [];
		for (const member of representatives) {
			listeners.push(await listen(member, RECEIVER));
		}
		const filtered = Promise.all(representatives.map(filteredOnce));

		const elsewhere = await spend(cluster, OTHER, 10n);
		await filtered;
		const touching = await spend(cluster, RECEIVER, 20n);
		await Promise.all(listeners.map(function(listener): Promise<void> {
			return(listener.received(touching));
		}));

		for (const listener of listeners) {
			expect(listener.staples).toEqual([touching.blocksHash.toString()]);
			expect(listener.staples).not.toContain(elsewhere.blocksHash.toString());
			listener.close();
		}
	}, CLUSTER_TEST_TIMEOUT_MILLISECONDS);

	test('charge each representative\'s own fee, which the SDK pays to each', async function() {
		const fees = FEE_ACCOUNTS.map(function(payTo, index): RepresentativeFee {
			return({ kind: 'flat', amountPerBlock: FEES_PER_BLOCK[index] ?? 0n, payTo });
		});
		const cluster = await clusters.start({ storage, weights: EQUAL_WEIGHTS, fees });
		const [first] = cluster.representatives;
		if (first === undefined) {
			throw(new Error('the cluster has no representative'));
		}
		const balanceOf = function(account: Account): Promise<bigint> {
			return(first.node.ledger.getBalance(account, first.node.baseToken));
		};
		const feesBefore = await Promise.all(FEE_ACCOUNTS.map(balanceOf));
		const spentBefore = await balanceOf(SPENDER);

		const staple = await spend(cluster, RECEIVER, 100n);

		expect(issuersOf(staple)).toEqual(keysOf(cluster.representatives));
		// One block is voted on, so each representative's fee is one block's.
		const feesAfter = await Promise.all(FEE_ACCOUNTS.map(balanceOf));
		expect(feesAfter.map(function(balance, index): bigint {
			return(balance - (feesBefore[index] ?? 0n));
		})).toEqual(FEES_PER_BLOCK);
		const totalFee = FEES_PER_BLOCK.reduce(function(sum, fee): bigint {
			return(sum + fee);
		}, 0n);
		expect(spentBefore - await balanceOf(SPENDER)).toBe(100n + totalFee);
		const dump = await convergedDump(cluster.representatives);
		for (const [index, account] of FEE_ACCOUNTS.entries()) {
			expect(dump).toContain(balanceLine(account, feesAfter[index] ?? 0n));
		}
	}, CLUSTER_TEST_TIMEOUT_MILLISECONDS);

	test('stop every node, leaving no server, socket or timer open', async function() {
		const handles = watchOpenHandles();
		const cluster = await clusters.start({ storage, weights: EQUAL_WEIGHTS });
		await spend(cluster, RECEIVER, 10n);

		await cluster.stop();

		expect(await handles.open()).toEqual([]);
	}, CLUSTER_TEST_TIMEOUT_MILLISECONDS);
});
