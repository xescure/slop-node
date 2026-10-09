import { describe, expect, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BootstrapConfig } from '@keetanetwork/keetanet-client/lib/bootstrap.js';
import type { KVStorageProvider } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { P2PPeer } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { GENESIS_MOMENT, ChainCursor, requireAt } from '../ledger/storage/suite/support.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { VOTES_PER_READ, listedByVotes, pageFrom, startFailingPeer, startRecordingPeer, startServingPeer, startSilentAPIPeer, unreachableEndpoint } from '../testing/bootstrap-peers.js';
import type { RecordedPage } from '../testing/bootstrap-peers.js';
import { useLocalNodes } from '../testing/local-node.js';
import type { CreatedLocalNode, LocalNodeOptions, RunningLocalNode } from '../testing/local-node.js';
import { advanceClock, freezeClock } from '../testing/network.js';
import type { TestNetwork } from '../testing/network.js';
import { watchOpenHandles } from '../testing/open-handles.js';
import { STORAGES_UNDER_TEST, useSDKNodes } from '../testing/sdk.js';
import { KVInternals } from '../upstream/internals.js';
import { eachStapleOnce } from '../util/each-staple-once.js';
import type { ServingNode, StorageUnderTest } from '../testing/sdk.js';
import { BootstrapClient } from './bootstrap.js';
import { BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RETRY_ARENA, BootstrapCursors } from './bootstrap-cursors.js';
import { bootstrapFrom, bootstrapSources } from './bootstrap-peers.js';
import { MAX_PASS_MILLISECONDS } from './bootstrap-pass.js';
import { REPORT_REFUSED_AFTER_MILLISECONDS } from './bootstrap-retry.js';
import { BOOTSTRAP_MARGIN_MILLISECONDS } from './bootstrap-window.js';
import type { LocalNode } from './local.js';

const lib = KeetaNet.lib;

const nodes = useLocalNodes();
const sdkNodes = useSDKNodes();

/** Two representatives, so that each of two users has funds and a chain of its own; every staple carries both votes. */
const WEIGHTS: readonly bigint[] = [1000n, 1000n];

/** The network of a node configured from its environment has a single representative (src/testing/sdk.ts). */
const SINGLE_WEIGHT: readonly bigint[] = [1000n];

/** An account no node holds the key of, from a fixed seed. */
const RECIPIENT: Account = lib.Account.fromSeed('4e2a6c8f0b1d3e5f7a9c1b3d5f7e9a0c2b4d6f8e0a1c3b5d7f9e1a3c5b7d9f0e', 0);

const EPOCH = new Date(0).toISOString();

/** Far less than the 20 s a deployment gives the node to stop (conformance/DEPLOY.md), of which the bootstrap client's share is a fraction. */
const STOP_BOUND_MILLISECONDS = 2000;

/** Sends of one base unit from the user, each following the one before and made a second after it. */
async function sendsFrom(network: TestNetwork, user: number, count: number): Promise<VoteStaple[]> {
	const cursor = new ChainCursor(network.genesis);
	const from = requireAt(network.users, user);
	const staples: VoteStaple[] = [];
	for (let index = 0; index < count; index++) {
		advanceClock(1000);
		const block = cursor.append(await sendBlock({ from, to: RECIPIENT, amount: 1n, token: network.baseToken, previous: cursor.previous(from), network: network.network }));
		staples.push(await confirmedStaple([block], network.representatives));
	}
	return(staples);
}

async function addAll(node: Node, staples: readonly VoteStaple[]): Promise<void> {
	for (const staple of staples) {
		await node.ledger.add(staple);
	}
}

/** The blocks hashes of every staple the node's ledger holds, sorted. */
async function heldBlocksHashes(node: Node): Promise<string[]> {
	return(eachStapleOnce(await node.ledger.getVoteStaplesAfter(new Date(0), 1000)).map(function(staple): string {
		return(staple.blocksHash.toString());
	}).sort());
}

function blocksHashesOf(staples: readonly VoteStaple[]): string[] {
	return(staples.map(function(staple): string {
		return(staple.blocksHash.toString());
	}).sort());
}

function servedCounts(pages: readonly RecordedPage[]): number[] {
	return(pages.map(function(page): number {
		return(page.served.length);
	}));
}

/** A client of the node's own, stopped as the test ends. */
function clientOf(node: LocalNode, config: BootstrapConfig = {}): BootstrapClient {
	const client = new BootstrapClient(node, config);
	onTestFinished(function() {
		return(client.stop());
	});
	return(client);
}

/** A node of the network that holds nothing yet, as one that joins late, and does not run. */
function joiner(options: LocalNodeOptions = {}): Promise<CreatedLocalNode> {
	return(nodes.create({ representativeWeights: WEIGHTS, representative: 1, genesis: 'absent', ...options }));
}

function representative(options: LocalNodeOptions = {}): Promise<RunningLocalNode> {
	return(nodes.start({ representativeWeights: WEIGHTS, ...options }));
}

function bootstrapOf(node: LocalNode): BootstrapClient {
	const client = node.bootstrap;
	if (client === undefined) {
		throw(new Error('the node has no bootstrap client'));
	}
	return(client);
}

/** The warnings the node logs from now on, each as one line. */
function warningsOf(node: Node): () => string[] {
	const warn = vi.spyOn(node.log, 'warn');
	return(function(): string[] {
		return(warn.mock.calls.map(function(call): string {
			return(call.map(String).join(' '));
		}));
	});
}

describe('a bootstrap client', function() {
	test('catches a node up on a peer page by page, from the beginning of its ledger, asking again from there with what it was sent named', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [recording.apiURL] });
		await addAll(peer.node, await sendsFrom(peer.network, 0, 4));

		expect(await clientOf(late.node).update(2)).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
		// Only the empty fourth page shows the peer had nothing more: a peer may answer short pages while it holds more.
		expect(servedCounts(recording.pages)).toEqual([2, 2, 1, 0]);
		expect(recording.pages.map(function(page): string | null {
			return(page.start);
		})).toEqual([EPOCH, EPOCH, EPOCH, EPOCH]);
		expect(recording.pages[0]).toMatchObject({ limit: '2', bloomFilter: undefined, status: 200 });
	});

	test('catches a node up on several peers, each holding staples the others do not', async function() {
		const first = await representative({ representative: 0 });
		const second = await representative({ representative: 1 });
		const late = await joiner({ bootstrapFrom: [first.apiURL, second.apiURL] });
		const ofFirst = await sendsFrom(first.network, 0, 3);
		const ofSecond = await sendsFrom(second.network, 1, 2);
		await addAll(first.node, ofFirst);
		await addAll(second.node, ofSecond);

		expect(await clientOf(late.node).update()).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([first.network.genesis, ...ofFirst, ...ofSecond]));
	});

	/*
	 * A peer orders its staples by the moment it applied each, and one that
	 * began applying a staple before the node's pass can commit it after
	 * (schema/CONTRACT.md); here the peer's clock is set back to apply it at
	 * a moment the node had already passed.
	 */
	test('fetches a staple that a peer applied at a moment the node had already passed, by asking again from before it', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [recording.apiURL] });
		const [early] = await sendsFrom(peer.network, 0, 1);
		const [committedLate] = await sendsFrom(peer.network, 1, 1);
		if (early === undefined || committedLate === undefined) {
			throw(new Error('no staples were made'));
		}
		advanceClock(4000);
		await peer.node.ledger.add(early);
		const client = clientOf(late.node);
		const reached = new Date();
		expect(await client.update()).toEqual({ complete: true });
		expect(await heldBlocksHashes(late.node)).not.toContain(committedLate.blocksHash.toString());

		freezeClock(new Date(reached.getTime() - 1000));
		await peer.node.ledger.add(committedLate);
		freezeClock(new Date(reached.getTime() + 5000));
		const before = recording.pages.length;
		expect(await client.update()).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
		const again = recording.pages.slice(before);
		expect(again[0]?.start).toBe(new Date(reached.getTime() - BOOTSTRAP_MARGIN_MILLISECONDS).toISOString());
		// What the node held from before is named in the filter, so only the late staple comes.
		expect(again.flatMap(function(page): readonly string[] {
			return(page.served);
		})).toEqual([Buffer.from(committedLate.toBytes()).toString('base64')]);
	});

	test('names the staples the node holds in its filter, so that a peer sends none of them', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const holder = await joiner({ genesis: 'held', bootstrapFrom: [recording.apiURL] });
		const staples = await sendsFrom(peer.network, 0, 3);
		await addAll(peer.node, staples);
		await addAll(holder.node, staples);

		expect(await clientOf(holder.node).update()).toEqual({ complete: true });

		expect(servedCounts(recording.pages)).toEqual([0]);
		const filter = recording.pages[0]?.bloomFilter;
		expect([peer.network.genesis, ...staples].map(function(staple): boolean | undefined {
			return(filter?.has(staple.toBytes()));
		})).toEqual([true, true, true, true]);
	});

	test('skips, without adding it, a staple on blocks the node holds with other votes, and names those votes from then on', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const holder = await joiner({ genesis: 'held', bootstrapFrom: [recording.apiURL] });
		const [first, second] = await sendsFrom(peer.network, 0, 2);
		if (first === undefined || second === undefined) {
			throw(new Error('no staples were made'));
		}
		await addAll(peer.node, [first, second]);
		const otherVotes = await confirmedStaple(first.blocks, peer.network.representatives, { voteDelays: [1, 1] });
		await holder.node.ledger.add(otherVotes);
		const add = vi.spyOn(holder.node.ledger, 'add');

		expect(await clientOf(holder.node).update()).toEqual({ complete: true });

		expect(Buffer.from(otherVotes.toBytes()).equals(Buffer.from(first.toBytes()))).toBe(false);
		expect(await heldBlocksHashes(holder.node)).toEqual(await heldBlocksHashes(peer.node));
		expect(servedCounts(recording.pages)).toEqual([2, 0]);
		expect(add.mock.calls.map(function([staple]): string {
			return(staple.blocksHash.toString());
		})).toEqual([second.blocksHash.toString()]);
	});

	test('downloads nothing again on a later update, though it asks again over the overlap', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [recording.apiURL] });
		await addAll(peer.node, await sendsFrom(peer.network, 0, 3));
		const client = clientOf(late.node);
		await client.update();
		const before = recording.pages.length;
		advanceClock(1000);

		expect(await client.update()).toEqual({ complete: true });

		expect(servedCounts(recording.pages.slice(before))).toEqual([0]);
	});

	test('logs what each pass that added staples did, and passes that added none only at debug level', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [recording.apiURL] });
		await addAll(peer.node, await sendsFrom(peer.network, 0, 3));
		const info = vi.spyOn(late.node.log, 'info');
		const debug = vi.spyOn(late.node.log, 'debug');
		const client = clientOf(late.node);

		await client.update(2);
		const requests = recording.pages.length;
		advanceClock(1000);
		await client.update(2);

		const lines = function(calls: readonly unknown[][]): string[] {
			return(calls.map(function(call): string {
				return(call.map(String).join(' '));
			}).filter(function(line): boolean {
				return(line.includes('Bootstrap pass over'));
			}));
		};
		expect(lines(info.mock.calls)).toEqual([`BOOTSTRAP Bootstrap pass over ${recording.apiURL}: drained after ${String(requests)} requests, 4 staples added, 0 held already, 0 queued for retry (0 in the queue)`]);
		expect(lines(debug.mock.calls)).toEqual([`BOOTSTRAP Bootstrap pass over ${recording.apiURL}: drained after ${String(recording.pages.length - requests)} requests, 0 staples added, 0 held already, 0 queued for retry (0 in the queue)`]);
	});

	/*
	 * The main network's representatives serve their history in the order
	 * they applied it, which is not causal: here the sends come before the
	 * genesis staple that gives their voters weight.
	 */
	test('queues the staples the ledger refuses until those they need arrive, naming them meanwhile, and applies them then', async function() {
		const peer = await representative();
		const sends = await sendsFrom(peer.network, 0, 2);
		const serving = await startServingPeer();
		serving.apply([...sends, peer.network.genesis]);
		const late = await joiner({ bootstrapFrom: [serving.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		const set = vi.spyOn(kv, 'set');

		expect(await clientOf(late.node, { kv }).update(2)).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([peer.network.genesis, ...sends]));
		expect(set.mock.calls.filter(function([arena, , value]): boolean {
			return(arena === BOOTSTRAP_RETRY_ARENA && value !== undefined);
		}).map(function([, key]): string {
			return(key);
		}).sort()).toEqual(blocksHashesOf(sends));
		expect(await kv.list(BOOTSTRAP_RETRY_ARENA)).toEqual([]);
		// The second page names the two staples queued, so that the peer sends genesis.
		expect(servedCounts(serving.pages)).toEqual([2, 1, 0]);
		expect(sends.map(function(staple): boolean | undefined {
			return(serving.pages[1]?.bloomFilter?.has(staple.toBytes()));
		})).toEqual([true, true]);
	});

	test('keeps the staples it queued across a restart, completing its passes meanwhile, and applies them once what they need arrives', async function() {
		const peer = await representative();
		const sends = await sendsFrom(peer.network, 0, 2);
		const serving = await startServingPeer();
		serving.apply(sends);
		const late = await joiner({ bootstrapFrom: [serving.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		expect(await clientOf(late.node, { kv }).update()).toEqual({ complete: true });
		expect((await kv.list(BOOTSTRAP_RETRY_ARENA)).sort()).toEqual(blocksHashesOf(sends));
		expect(await heldBlocksHashes(late.node)).toEqual([]);

		advanceClock(1000);
		serving.apply([peer.network.genesis]);
		const restarted = clientOf(late.node, { kv });
		const before = serving.pages.length;
		expect(await restarted.update()).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([peer.network.genesis, ...sends]));
		expect(await kv.list(BOOTSTRAP_RETRY_ARENA)).toEqual([]);
		// The restarted client named the queued staples from its first request on.
		expect(sends.map(function(staple): boolean | undefined {
			return(serving.pages[before]?.bloomFilter?.has(staple.toBytes()));
		})).toEqual([true, true]);
	});

	test('reports a staple the ledger still refuses an hour after it queued it, once', async function() {
		const peer = await representative();
		const [send] = await sendsFrom(peer.network, 0, 1);
		if (send === undefined) {
			throw(new Error('no staple was made'));
		}
		const serving = await startServingPeer();
		serving.apply([send]);
		const late = await joiner({ bootstrapFrom: [serving.apiURL] });
		const warnings = warningsOf(late.node);
		const client = clientOf(late.node);
		await client.update();

		advanceClock(REPORT_REFUSED_AFTER_MILLISECONDS);
		await client.update();
		advanceClock(60_000);
		await client.update();

		expect(warnings().filter(function(warning): boolean {
			return(warning.includes('bootstrap: staple refused'));
		})).toEqual([`BOOTSTRAP bootstrap: staple refused for 60 min: LEDGER_INSUFFICIENT_VOTING_WEIGHT (staple ${send.blocksHash.toString()})`]);
	});

	test('reads one peer at a time while no pass has completed, then the others from where that pass completed, so that it downloads the history once', async function() {
		const peer = await representative();
		await addAll(peer.node, await sendsFrom(peer.network, 0, 4));
		const first = await startRecordingPeer(peer.apiURL);
		const second = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [first.apiURL, second.apiURL] });

		expect(await clientOf(late.node).update(2)).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
		expect(servedCounts(first.pages)).toEqual([2, 2, 1, 0]);
		expect(second.pages[0]?.start).toBe(new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS).toISOString());
		expect(Math.max(...servedCounts(second.pages))).toBe(0);
		expect(Math.min(...first.pages.map(function(page): number {
			return(page.received);
		}))).toBeLessThan(Math.min(...second.pages.map(function(page): number {
			return(page.received);
		})));
	});

	test('reads the history it lacks in one range per peer, side by side, once it lacks more than a day of it, and then each peer from where the ranges end', async function() {
		const day = 24 * 60 * 60_000;
		const peer = await representative();
		const cursor = new ChainCursor(peer.network.genesis);
		const from = requireAt(peer.network.users, 0);
		async function sendOne(): Promise<void> {
			advanceClock(1000);
			const block = cursor.append(await sendBlock({ from, to: RECIPIENT, amount: 1n, token: peer.network.baseToken, previous: cursor.previous(from), network: peer.network.network }));
			await addAll(peer.node, [await confirmedStaple([block], peer.network.representatives)]);
		}
		await sendOne();
		const first = await startRecordingPeer(peer.apiURL);
		const second = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [first.apiURL, second.apiURL] });
		const client = clientOf(late.node);
		expect(await client.update()).toEqual({ complete: true });
		const reached = Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS;
		for (let days = 0; days < 3; days++) {
			advanceClock(day);
			await sendOne();
			await sendOne();
		}
		const info = vi.spyOn(late.node.log, 'info');
		const asked = [first.pages.length, second.pages.length];

		expect(await client.update()).toEqual({ complete: false });
		const end = Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS;
		expect([first.pages[asked[0] ?? 0]?.start, second.pages[asked[1] ?? 0]?.start]).toEqual([
			new Date(reached - 61_000).toISOString(),
			new Date(Math.floor(reached + (end - reached) / 2) - 61_000).toISOString()
		]);
		const logged = info.mock.calls.map(function(call): string {
			return(call.map(String).join(' '));
		});
		expect(logged.filter(function(line): boolean {
			return(line.includes('in as many ranges') || line.includes('are read; the peers are read from there on'));
		})).toEqual([
			expect.stringContaining(`the history from ${new Date(reached).toISOString()} to ${new Date(end).toISOString()}, which its 2 peers now read in as many ranges`),
			expect.stringContaining(`the ranges from ${new Date(reached).toISOString()} to ${new Date(end).toISOString()} are read`)
		]);
		expect(await client.update()).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
	});

	test('keeps trying the peers that fail, and catches up on the others meanwhile', async function() {
		const peer = await representative();
		const failing = await startFailingPeer();
		const unreachable = await unreachableEndpoint();
		const late = await joiner({ bootstrapFrom: [failing.apiURL, unreachable, peer.apiURL] });
		await addAll(peer.node, await sendsFrom(peer.network, 0, 2));
		const warnings = warningsOf(late.node);
		const client = clientOf(late.node);

		expect(await client.update()).toEqual({ complete: false });

		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
		for (const endpoint of [failing.apiURL, unreachable]) {
			expect(warnings().some(function(warning): boolean {
				return(warning.includes(`Bootstrapping from ${endpoint} failed`));
			})).toBe(true);
		}
		expect(warnings().some(function(warning): boolean {
			return(warning.includes(peer.apiURL));
		})).toBe(false);
		expect(failing.requests()).toBe(1);

		expect(await client.update()).toEqual({ complete: false });
		expect(failing.requests()).toBe(2);
		expect(await client.stats()).toMatchObject({ completeCount: 0 });
	});

	test('adds nothing more of a page it fetched once it is stopped', async function() {
		const peer = await representative();
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		await addAll(peer.node, await sendsFrom(peer.network, 0, 4));
		const client = clientOf(late.node);
		const add = late.node.ledger.add.bind(late.node.ledger);
		let stopped: Promise<void> | undefined;
		const adds = vi.spyOn(late.node.ledger, 'add').mockImplementation(function(...args: Parameters<typeof add>): Promise<VoteStaple[]> {
			stopped ??= client.stop();
			return(add(...args));
		});

		expect(await client.update()).toEqual({ complete: false });
		await stopped;

		// Genesis, the first staple of the page, was being added as the client stopped.
		expect(adds).toHaveBeenCalledTimes(1);
		expect(await heldBlocksHashes(late.node)).toEqual([peer.network.genesis.blocksHash.toString()]);
	});

	/*
	 * Until a pass completes, the peers are read one at a time, and a pass
	 * that fails, as one stopped does, hands over to the next; each pass
	 * reads what the node holds before its first request.
	 */
	test('stops at once while catching up from a slow peer with staples queued for retry, beginning no pass over the next peer', async function() {
		const peer = await representative();
		const serving = await startServingPeer();
		serving.apply(await sendsFrom(peer.network, 0, 30));
		const silent = await startSilentAPIPeer();
		// The sends are refused without genesis, which the peer does not serve, and an earlier client queued them all.
		const queuedBy = new KVInternals.KVStorageProviderMemory();
		await clientOf((await joiner({ bootstrapFrom: [serving.apiURL] })).node, { kv: queuedBy }).update();
		const kv = new KVInternals.KVStorageProviderMemory();
		for (const key of await queuedBy.list(BOOTSTRAP_RETRY_ARENA)) {
			await kv.set(BOOTSTRAP_RETRY_ARENA, key, await queuedBy.get(BOOTSTRAP_RETRY_ARENA, key));
		}
		expect(await kv.list(BOOTSTRAP_RETRY_ARENA)).toHaveLength(30);
		const late = await joiner({ bootstrapFrom: [silent.apiURL, serving.apiURL] });
		const client = clientOf(late.node, { kv });
		const reads = vi.spyOn(late.node.ledger, 'getVoteStaplesAfter');
		const adds = vi.spyOn(late.node.ledger, 'add');
		const requested = serving.pages.length;

		const updating = client.update();
		await silent.requested;
		const before = { reads: reads.mock.calls.length, adds: adds.mock.calls.length };
		const stopping = performance.now();
		await client.stop();
		const stoppedIn = performance.now() - stopping;

		expect(await updating).toEqual({ complete: false });
		expect({ reads: reads.mock.calls.length, adds: adds.mock.calls.length, requests: serving.pages.length - requested }).toEqual({ ...before, requests: 0 });
		expect(stoppedIn).toBeLessThan(STOP_BOUND_MILLISECONDS);
		// A read of what the node holds, which a stop cannot end, ends of itself in time.
		expect(reads.mock.calls.map(function([, , options]): number | undefined {
			return(options?.timeout);
		})).toEqual(Array<number>(before.reads).fill(STOP_BOUND_MILLISECONDS));
	});

	test('gives up on a peer that sends again what the filter names, rather than page through it forever', async function() {
		const peer = await representative();
		const ignoring = await startRecordingPeer(peer.apiURL, { filter: 'dropped' });
		const late = await joiner({ bootstrapFrom: [ignoring.apiURL] });
		await addAll(peer.node, await sendsFrom(peer.network, 0, 3));
		const warnings = warningsOf(late.node);

		expect(await clientOf(late.node).update(2)).toEqual({ complete: false });

		// The second page repeats the first, which its filter named.
		expect(servedCounts(ignoring.pages)).toEqual([2, 2]);
		expect(warnings()).toHaveLength(1);
		expect(warnings()[0]).toContain(`Bootstrapping from ${ignoring.apiURL} failed`);
		expect(warnings()[0]).toContain('which the filter named');
	});

	test('gives up on a request a peer does not answer in time, until the next update', async function() {
		const silent = await startSilentAPIPeer();
		const late = await joiner({ bootstrapFrom: [silent.apiURL] });
		const warnings = warningsOf(late.node);

		expect(await clientOf(late.node, { timeout: 50 }).update()).toEqual({ complete: false });

		expect(warnings()).toEqual([`BOOTSTRAP Bootstrapping from ${silent.apiURL} failed; it is tried again on the next update: Error: PageError: ${silent.apiURL} did not answer within 50 ms, though it carried no filter`]);
	});

	test('counts the updates in a row that drained every peer, and starts the count again after one that did not', async function() {
		const peer = await representative();
		const failing = await startFailingPeer();
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		const client = clientOf(late.node);
		expect(await client.stats()).toEqual({ lastUpdate: undefined, completeCount: 0 });

		await client.update();
		advanceClock(1000);
		await client.update();
		expect(await client.stats()).toEqual({ lastUpdate: new Date(), completeCount: 2 });

		bootstrapFrom(late.node.config, [peer.apiURL, failing.apiURL]);
		await client.update();
		expect(await client.stats()).toEqual({ lastUpdate: new Date(), completeCount: 0 });

		bootstrapFrom(late.node.config, [peer.apiURL]);
		await client.update();
		expect(await client.stats()).toMatchObject({ completeCount: 1 });
	});

	test('tells the callback of each staple it adds, once', async function() {
		const peer = await representative();
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		const staples = await sendsFrom(peer.network, 0, 2);
		await addAll(peer.node, staples);
		const told: string[] = [];
		const client = clientOf(late.node, { callback: function(staple: VoteStaple): Promise<void> {
			told.push(staple.blocksHash.toString());
			return(Promise.resolve());
		} });

		await client.update();
		advanceClock(1000);
		await client.update();

		expect(told.sort()).toEqual(blocksHashesOf([peer.network.genesis, ...staples]));
	});

	test('forgets where it has reached on each peer when its store is reset, and reads each from the beginning again', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [recording.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		const client = clientOf(late.node, { kv });
		await client.update();
		expect(await kv.list(BOOTSTRAP_CURSOR_ARENA)).toEqual([recording.apiURL]);

		await client.resetKV();

		expect(await kv.list(BOOTSTRAP_CURSOR_ARENA)).toEqual([]);
		const before = recording.pages.length;
		await client.update();
		expect(recording.pages[before]?.start).toBe(EPOCH);
	});

	test('asks for half as many staples whenever a page is larger than it accepts', async function() {
		const peer = await representative();
		const padded = await startRecordingPeer(peer.apiURL, { padAboveLimit: 2 });
		const late = await joiner({ bootstrapFrom: [padded.apiURL] });
		await addAll(peer.node, await sendsFrom(peer.network, 0, 4));

		expect(await clientOf(late.node).update(8)).toEqual({ complete: true });

		expect(padded.pages.map(function(page): string | null {
			return(page.limit);
		})).toEqual(['8', '4', '2', '2', '2', '2']);
		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
	});

	test('keeps updating on its period after an update fails', async function() {
		const late = await joiner();
		const errors = vi.spyOn(late.node.log, 'error');
		const update = vi.spyOn(BootstrapClient.prototype, 'update');
		update.mockRejectedValueOnce(new Error('the update failed'));
		const retried = new Promise<void>(function(resolve) {
			update.mockImplementationOnce(function() {
				resolve();
				return(Promise.resolve({ complete: true }));
			});
		});

		clientOf(late.node, { period: 1 });
		await retried;

		expect(errors).toHaveBeenCalledWith('BOOTSTRAP', 'A scheduled bootstrap update failed:', new Error('the update failed'));
	});

	test('starts its next update at once after a pass that ended at its bound, rather than wait its period', async function() {
		const peer = await representative();
		await addAll(peer.node, await sendsFrom(peer.network, 0, 2));
		let answered = 0;
		const recording = await startRecordingPeer(peer.apiURL, { beforeAnswer: function(): void {
			answered++;
			// The first page takes all the time a pass has.
			if (answered === 1) {
				advanceClock(MAX_PASS_MILLISECONDS);
			}
		} });
		const late = await joiner({ bootstrapFrom: [recording.apiURL] });
		const results: { complete: boolean }[] = [];
		let endSecond: (() => void) | undefined;
		const second = new Promise<void>(function(resolve) {
			endSecond = resolve;
		});
		class RecordingClient extends BootstrapClient {
			override async update(limit?: number): Promise<{ complete: boolean }> {
				const result = await super.update(limit);
				results.push(result);
				if (results.length === 2) {
					endSecond?.();
				}
				return(result);
			}
		}

		// The period is far longer than the test may take.
		const client = new RecordingClient(late.node, { period: 60 * 60_000 });
		onTestFinished(function() {
			return(client.stop());
		});
		await second;

		expect(results).toEqual([{ complete: false }, { complete: true }]);
		expect(recording.pages[0]?.start).toBe(EPOCH);
		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
		expect(await client.stats()).toMatchObject({ completeCount: 1 });
	});

	test('refuses a page larger than a representative sends', async function() {
		const late = await joiner();
		await expect(clientOf(late.node).update(1001)).rejects.toThrow(RangeError);
		await expect(clientOf(late.node).update(0)).rejects.toThrow(RangeError);
	});

	test('leaves nothing open once stopped, with a request in flight and further updates scheduled', async function() {
		const peer = await representative();
		const silent = await startSilentAPIPeer();
		const late = await joiner({ bootstrapFrom: [peer.apiURL, silent.apiURL] });
		await addAll(peer.node, await sendsFrom(peer.network, 0, 2));
		// The peer's own client has scheduled its next update by the time this one, queued behind its first, ends.
		await bootstrapOf(peer.node).update();
		const watch = watchOpenHandles();
		const client = new BootstrapClient(late.node, { period: 60_000 });
		await silent.requested;

		await client.stop();

		expect(await watch.open()).toEqual([]);
		expect(await client.stats()).toMatchObject({ completeCount: 0 });
		expect(await client.update()).toEqual({ complete: false });
	});

	test('updates at once and then periodically once given a period, until stopped', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [recording.apiURL] });
		const watch = watchOpenHandles();
		const client = new BootstrapClient(late.node, { period: 60_000 });
		// Queued behind the update the client ran as it was built, after which it waits for the next.
		await client.update();
		// The first update drains the peer with a page holding genesis and an empty one, and the second starts the margin before the first began; the clock stands still.
		expect(recording.pages.map(function(page): string | null {
			return(page.start);
		})).toEqual([EPOCH, EPOCH, new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS).toISOString()]);

		await client.stop();

		expect(await watch.open()).toEqual([]);
	});
});

/** How long after its first vote a straddling staple's second is made (straddlingHistory). */
const STRADDLE_MILLISECONDS = 200_000;

/**
 * A staple whose two votes were made STRADDLE_MILLISECONDS apart, and,
 * between them, sends with more votes than one read holds, which the peer
 * applies.
 */
async function straddlingHistory(peer: RunningLocalNode): Promise<{ readonly straddling: VoteStaple; readonly between: readonly VoteStaple[] }> {
	const network = peer.network;
	advanceClock(1000);
	const from = requireAt(network.users, 1);
	const block = await sendBlock({ from, to: RECIPIENT, amount: 1n, token: network.baseToken, previous: new ChainCursor(network.genesis).previous(from), network: network.network });
	const between = await sendsFrom(network, 0, VOTES_PER_READ / WEIGHTS.length + 10);
	advanceClock(STRADDLE_MILLISECONDS);
	// Voted on now, as of when the block was made and that long after: no vote is issued in the future.
	const straddling = await confirmedStaple([block], network.representatives, { voteDelays: [0, STRADDLE_MILLISECONDS] });
	await addAll(peer.node, [straddling, ...between]);
	return({ straddling, between });
}

describe('this node\'s bootstrap route', function() {
	test('lists staples as the main network\'s representatives do: by when their votes were made, once for each read of votes holding one of them', async function() {
		const peer = await representative();
		const { straddling, between } = await straddlingHistory(peer);
		const staples = [peer.network.genesis, straddling, ...between];
		const straddlingKey = straddling.blocksHash.toString();
		const [firstVote] = straddling.votes.map(function(vote): number {
			return(vote.validityFrom.getTime());
		}).sort();
		const afterFirstVote = new Date((firstVote ?? 0) + 1);

		const everything = await pageFrom(peer.apiURL, new Date(0));
		const later = await pageFrom(peer.apiURL, afterFirstVote);

		expect(everything).toEqual(listedByVotes(staples, new Date(0)));
		// The read holding its first vote lists it, and so does the one holding its second.
		expect(everything.filter(function(key): boolean {
			return(key === straddlingKey);
		})).toHaveLength(2);
		expect(new Set(everything).size).toBe(staples.length);
		// From after its first vote, genesis is left out, and the staple is listed once, for its second.
		expect(later).toEqual(listedByVotes(staples, afterFirstVote));
		expect(later).not.toContain(peer.network.genesis.blocksHash.toString());
		expect(later.filter(function(key): boolean {
			return(key === straddlingKey);
		})).toHaveLength(1);
	});

	test('is learned by a client to key staples by votes, which it lists twice in one answer', async function() {
		const peer = await representative();
		// Made first, as making a node sets the clock back to when its network began.
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		await straddlingHistory(peer);
		const kv = new KVInternals.KVStorageProviderMemory();
		const warnings = warningsOf(late.node);

		expect([await clientOf(late.node, { kv }).update(), warnings()]).toEqual([{ complete: true }, []]);

		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
		expect((await new BootstrapCursors(kv).read(peer.apiURL))?.keying).toBe('votes');
	});
});

describe('a node that bootstraps', function() {
	test('has no bootstrap client until it runs, nor when its ledger is read-only', async function() {
		const created = await nodes.create({ representativeWeights: WEIGHTS });
		expect(created.node.bootstrap).toBeUndefined();
		await created.node.run();
		expect(BootstrapClient.isInstance(created.node.bootstrap)).toBe(true);

		const readOnly = await nodes.start({ representativeWeights: WEIGHTS, ledgerWriteMode: 'read-only', genesis: 'absent' });
		expect(readOnly.node.bootstrap).toBeUndefined();
	});

	test('catches up once it runs, without being asked', async function() {
		const peer = await representative();
		const staples = await sendsFrom(peer.network, 0, 2);
		await addAll(peer.node, staples);
		const expected = blocksHashesOf([peer.network.genesis, ...staples]);
		const told: string[] = [];
		let caughtUp: (() => void) | undefined;
		const done = new Promise<void>(function(resolve) {
			caughtUp = resolve;
		});
		await nodes.start({ representativeWeights: WEIGHTS, representative: 1, genesis: 'absent', bootstrapFrom: [peer.apiURL], bootstrap: { callback: function(staple: VoteStaple): Promise<void> {
			told.push(staple.blocksHash.toString());
			if (told.length === expected.length) {
				caughtUp?.();
			}
			return(Promise.resolve());
		} } });

		await done;

		expect(told.sort()).toEqual(expected);
	});

	test('updates on the default period when its configuration leaves the period undefined', async function() {
		const peer = await representative();
		let caughtUp: (() => void) | undefined;
		const done = new Promise<void>(function(resolve) {
			caughtUp = resolve;
		});
		const bootstrap: BootstrapConfig = { callback: function(): Promise<void> {
			caughtUp?.();
			return(Promise.resolve());
		} };
		// As a caller in JavaScript may write it, which the typings forbid.
		Reflect.set(bootstrap, 'period', undefined);

		const late = await nodes.start({ representativeWeights: WEIGHTS, representative: 1, genesis: 'absent', bootstrapFrom: [peer.apiURL], bootstrap });

		await done;
		expect(BootstrapClient.isInstance(late.node.bootstrap)).toBe(true);
	});

	test('bootstraps from the representatives its switch knows only when they hold a hundredth of the voting weight on its ledger', async function() {
		const running = await nodes.start({ representativeWeights: [1000n, 960n, 20n, 19n, 1n] });
		const [, second, third, fourth, fifth] = running.network.representatives.map(function(key, index): P2PPeer {
			return(verifiedPeer(key, index));
		});
		const stranger = verifiedPeer(lib.Account.fromSeed('0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0', 0), 9);
		vi.spyOn(running.node.switch, 'peers').mockResolvedValue([second, third, fourth, fifth, stranger].filter(function(peer): peer is P2PPeer {
			return(peer !== undefined);
		}));

		expect(await bootstrapSources(running.node)).toEqual([apiOf(1), apiOf(2)]);
	});

	test('catches up from a manual peer that holds no voting weight, when it has no genesis and no other source', async function() {
		const peer = await representative();
		const staples = await sendsFrom(peer.network, 0, 2);
		await addAll(peer.node, staples);
		const late = await joiner();
		const unweighted = lib.Account.fromSeed('0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0', 0);
		late.node.config.manualPeers = [verifiedPeer(unweighted, 0, peer.apiURL)];
		expect(await heldBlocksHashes(late.node)).toEqual([]);

		expect(await bootstrapSources(late.node)).toEqual([peer.apiURL]);
		expect(await clientOf(late.node).update()).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([peer.network.genesis, ...staples]));
	});

	test('stops bootstrapping before it stops its switch', async function() {
		const running = await representative();
		const client = bootstrapOf(running.node);
		const stopBootstrap = vi.spyOn(client, 'stop');
		const stopSwitch = vi.spyOn(running.node.switch, 'stop');

		await running.node.stop();

		const [bootstrapOrder] = stopBootstrap.mock.invocationCallOrder;
		const [switchOrder] = stopSwitch.mock.invocationCallOrder;
		expect(bootstrapOrder).toBeLessThan(switchOrder ?? 0);
	});
});

describe('a node configured from its environment', function() {
	/** A representative of the network a node configured from its environment joins (src/testing/sdk.ts). */
	async function peerOfSDKNetwork(): Promise<{ readonly peer: RunningLocalNode; readonly staples: readonly VoteStaple[] }> {
		const peer = await nodes.start({ representativeWeights: SINGLE_WEIGHT });
		const staples = await sendsFrom(peer.network, 0, 3);
		await addAll(peer.node, staples);
		return({ peer, staples });
	}

	async function caughtUp(serving: ServingNode): Promise<void> {
		// The update the node ran as it started is ahead of this one in the queue.
		expect(await bootstrapOf(serving.node).update()).toEqual({ complete: true });
	}

	test.each(STORAGES_UNDER_TEST)('catches up in bootstrap-only mode, adding nothing it is sent otherwise (%s)', async function(storage: StorageUnderTest) {
		const { peer } = await peerOfSDKNetwork();
		const environment = await sdkNodes.environmentFor(storage, {
			KEETANET_LOCAL_NODE_SEED_INDEX: '1',
			KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'bootstrap-only',
			KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: peer.apiURL
		});
		const follower = await sdkNodes.start(environment);

		await caughtUp(follower);

		expect(await heldBlocksHashes(follower.node)).toEqual(await heldBlocksHashes(peer.node));
		const [next] = await sendsFrom(peer.network, 0, 1);
		if (next === undefined) {
			throw(new Error('no staple was made'));
		}
		await expect(follower.node.ledger.add(next)).rejects.toThrow('except for bootstrapping');
	});

	test('leaves the peer the interval it is configured with between the end of one request and the start of the next', async function() {
		const interval = 150;
		const { peer } = await peerOfSDKNetwork();
		const recording = await startRecordingPeer(peer.apiURL);
		const environment = await sdkNodes.environmentFor('memory', {
			KEETANET_LOCAL_NODE_SEED_INDEX: '1',
			KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: recording.apiURL,
			KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: String(interval)
		});
		const follower = await sdkNodes.start(environment);

		await caughtUp(follower);

		expect(await heldBlocksHashes(follower.node)).toEqual(await heldBlocksHashes(peer.node));
		const pages = recording.pages;
		expect(pages.length).toBeGreaterThan(2);
		const rests = pages.slice(1).map(function(page, index): number {
			return(page.received - requireAt(pages, index).answered);
		});
		// The node's timer may fire up to a millisecond early on the monotonic clock, which it truncates to milliseconds.
		expect(Math.min(...rests)).toBeGreaterThanOrEqual(interval - 1);
	});

	test('resumes from where it reached on each peer after a restart, when it keeps its state in Postgres', async function() {
		const { peer } = await peerOfSDKNetwork();
		const recording = await startRecordingPeer(peer.apiURL);
		const environment = await sdkNodes.environmentFor('postgres', {
			KEETANET_LOCAL_NODE_SEED_INDEX: '1',
			KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: recording.apiURL
		});
		const first = await sdkNodes.start(environment);
		await caughtUp(first);
		const reached = await cursorOf(first.node.config.bootstrap?.kv, recording.apiURL);
		await first.stop();
		advanceClock(60_000);
		const before = recording.pages.length;

		const restarted = await sdkNodes.start(environment);
		await caughtUp(restarted);

		expect(reached).toBe(GENESIS_MOMENT.getTime() + 3000 - BOOTSTRAP_MARGIN_MILLISECONDS);
		const afterRestart = recording.pages.slice(before);
		expect(afterRestart[0]?.start).toBe(new Date(reached).toISOString());
		expect(servedCounts(afterRestart)).toEqual([0, 0]);
		expect(await heldBlocksHashes(restarted.node)).toEqual(await heldBlocksHashes(peer.node));
	});
});

/** Where a representative that is never dialed would serve, told apart by the port. */
function apiOf(port: number): string {
	return(`http://127.0.0.1:${String(port)}/api`);
}

/** A representative as the switch lists it once verified; choosing whom to bootstrap from reads no signature. */
function verifiedPeer(key: Account, port: number, api: string = apiOf(port)): P2PPeer {
	return({ kind: lib.Node.Kind.REPRESENTATIVE, key, endpoints: { p2p: `ws://127.0.0.1:${String(port)}/p2p`, api }, preferUpdates: 'websocket', signature: new ArrayBuffer(64) });
}

async function cursorOf(kv: KVStorageProvider | null | undefined, endpoint: string): Promise<number> {
	if (kv === null || kv === undefined) {
		throw(new Error('the node keeps no store'));
	}
	const progress = await new BootstrapCursors(kv).read(endpoint);
	if (progress === undefined) {
		throw(new Error(`no cursor is kept for ${endpoint}`));
	}
	return(progress.reached.getTime());
}
