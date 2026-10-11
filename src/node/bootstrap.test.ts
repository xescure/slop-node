import { createHash } from 'node:crypto';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BootstrapConfig } from '@keetanetwork/keetanet-client/lib/bootstrap.js';
import type { KVStorageProvider } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { P2PPeer } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import type { StrandedDeferredStaple } from '../ledger/storage/base.js';
import { GENESIS_MOMENT, ChainCursor, requireAt } from '../ledger/storage/suite/support.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { VOTES_PER_READ, listedByVotes, pageFrom, startAnsweringPeer, startFailingPeer, startReadingPeer, startRecordingPeer, startServingPeer, startSilentAPIPeer, unreachableEndpoint } from '../testing/bootstrap-peers.js';
import type { ReadingRule, RecordedPage } from '../testing/bootstrap-peers.js';
import { request, useLocalNodes } from '../testing/local-node.js';
import type { CreatedLocalNode, LocalNodeOptions, RunningLocalNode } from '../testing/local-node.js';
import { advanceClock, freezeClock } from '../testing/network.js';
import type { TestNetwork } from '../testing/network.js';
import { watchOpenHandles } from '../testing/open-handles.js';
import { STORAGES_UNDER_TEST, useSDKNodes } from '../testing/sdk.js';
import { KVInternals } from '../upstream/internals.js';
import { assertNever } from '../util/assert-never.js';
import { eachStapleOnce } from '../util/each-staple-once.js';
import type { ServingNode, StorageUnderTest } from '../testing/sdk.js';
import { BootstrapClient } from './bootstrap.js';
import { BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RETRY_ARENA, BootstrapCursors } from './bootstrap-cursors.js';
import { bootstrapEndpointsOf, bootstrapFrom, bootstrapSources } from './bootstrap-peers.js';
import { DEEP_SCAN_PERIOD_MILLISECONDS, MAX_PASS_MILLISECONDS } from './bootstrap-pass.js';
import { FIRST_BACKOFF_MILLISECONDS, REPORT_REFUSED_AFTER_MILLISECONDS } from './bootstrap-retry.js';
import { stagedOf } from './bootstrap-stage.js';
import { MOST_LACKED_PER_UPDATE, STRANDED_READ, awaitedOf, dueLackedBlocks } from './retry-signals.js';
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

/** How many sections of work the node's request timing holds. */
function timedSections(node: Node): number {
	return(Object.keys(node.timing.getAllTiming()).length);
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

/** The lines the node logs at that level from now on, each as one line. */
function linesOf(node: Node, level: 'info' | 'debug' | 'error'): () => string[] {
	const logged = vi.spyOn(node.log, level);
	return(function(): string[] {
		return(logged.mock.calls.map(function(call): string {
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

	/*
	 * A main network representative leaves out of a page a vote made a
	 * millisecond or less after the last vote of one of its reads, so a pass
	 * moves past a staple that has no other vote; the staple after it on the
	 * same chain then waits, deferred, for a block nothing brings.
	 */
	test('asks its peers for the staple holding a block that deferred staples await, once an update completes without it', async function() {
		const peer = await representative();
		const leftOut = new Set<string>();
		const recording = await startRecordingPeer(peer.apiURL, { leavesOut: function(staple): boolean {
			return(leftOut.has(new lib.Vote.Staple(Buffer.from(staple, 'base64')).blocksHash.toString()));
		} });
		const late = await joiner({ bootstrapFrom: [recording.apiURL] });
		const [lost, after] = await sendsFrom(peer.network, 0, 2);
		if (lost === undefined || after === undefined) {
			throw(new Error('no staples were made'));
		}
		leftOut.add(lost.blocksHash.toString());
		await addAll(peer.node, [lost, after]);
		// Every pass has read past both staples' votes.
		advanceClock(BOOTSTRAP_MARGIN_MILLISECONDS + 1000);
		const lines = linesOf(late.node, 'info');

		expect(await clientOf(late.node).update()).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
		const [lostBlock] = lost.blocks;
		expect(lines()).toContainEqual(expect.stringContaining(`lacked block ${lostBlock?.hash.toString() ?? ''}, which deferred staples await; staple ${lost.blocksHash.toString()} holding it, from ${recording.apiURL}, was added`));
	});

	/**
	 * A staple of one user voted a millisecond after another user's, which a
	 * representative reading one vote at a time leaves out of every page
	 * whose read ends on the earlier vote, and the user's next staple, which
	 * then waits on it.
	 */
	async function nearTiedHistory(network: TestNetwork, lostVoters: readonly Account[] = network.representatives): Promise<{ readonly before: VoteStaple; readonly lost: VoteStaple; readonly after: VoteStaple; readonly lostBlock: string }> {
		const cursor = new ChainCursor(network.genesis);
		const [first, second] = network.users;
		if (first === undefined || second === undefined) {
			throw(new Error('two users expected'));
		}
		const send = async function(from: Account, voters: readonly Account[]): Promise<VoteStaple> {
			const block = cursor.append(await sendBlock({ from, to: RECIPIENT, amount: 1n, token: network.baseToken, previous: cursor.previous(from), network: network.network }));
			return(await confirmedStaple([block], voters));
		};
		advanceClock(1000);
		const before = await send(first, network.representatives);
		advanceClock(1);
		const lost = await send(second, lostVoters);
		advanceClock(2000);
		const after = await send(second, network.representatives);
		return({ before, lost, after, lostBlock: lost.blocks[0]?.hash.toString() ?? '' });
	}

	const ONE_VOTE_A_READ: ReadingRule = { votesPerRead: 1, resumesPast: 1 };

	test('ends holding a staple a representative left out of its pages, as its reads resume a millisecond past the last vote of a read', async function() {
		const peer = await representative();
		const reading = await startReadingPeer(ONE_VOTE_A_READ);
		const late = await joiner({ bootstrapFrom: [reading.apiURL] });
		const { before, lost, after, lostBlock } = await nearTiedHistory(peer.network);
		reading.apply([peer.network.genesis, before, lost, after]);
		advanceClock(BOOTSTRAP_MARGIN_MILLISECONDS + 1000);

		expect(await clientOf(late.node).update()).toEqual({ complete: true });

		expect(reading.pages.flatMap(function(page): readonly string[] {
			return(page.served);
		})).not.toContain(Buffer.from(lost.toBytes()).toString('base64'));
		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([peer.network.genesis, before, lost, after]));
		expect(reading.askedFor).toEqual([lostBlock]);
	});

	test('asks the next peer for a lacked block when one holds no staple of it, or fails, after a pass over some peer completed', async function() {
		const peer = await representative();
		const holdsNot = await startReadingPeer(ONE_VOTE_A_READ);
		const holds = await startReadingPeer(ONE_VOTE_A_READ);
		const failing = await startFailingPeer();
		const late = await joiner({ bootstrapFrom: [failing.apiURL, holdsNot.apiURL, holds.apiURL] });
		const { before, lost, after, lostBlock } = await nearTiedHistory(peer.network);
		for (const reading of [holdsNot, holds]) {
			reading.apply([peer.network.genesis, before, lost, after]);
		}
		holdsNot.holdsNot(lostBlock);
		advanceClock(BOOTSTRAP_MARGIN_MILLISECONDS + 1000);
		const warnings = warningsOf(late.node);

		// The failing peer leaves the update incomplete, which holds back nothing of the fetch.
		expect(await clientOf(late.node).update()).toEqual({ complete: false });

		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([peer.network.genesis, before, lost, after]));
		expect([holdsNot.askedFor, holds.askedFor]).toEqual([[lostBlock], [lostBlock]]);
		expect(warnings()).toContainEqual(expect.stringContaining(`Asking ${failing.apiURL} for the staple holding block ${lostBlock}, which deferred staples await, failed`));
	});

	test('asks for a lacked block that does not land, because no peer holds it or the ledger refuses its staple, again only once its wait has passed', async function() {
		const peer = await representative();
		const [firstVoter] = peer.network.representatives;
		if (firstVoter === undefined) {
			throw(new Error('no representative'));
		}
		const reading = await startReadingPeer(ONE_VOTE_A_READ);
		const late = await joiner({ bootstrapFrom: [reading.apiURL] });
		// One representative's vote alone carries too little weight.
		const refused = await nearTiedHistory(peer.network, [firstVoter]);
		reading.apply([peer.network.genesis, refused.before, refused.lost, refused.after]);
		advanceClock(BOOTSTRAP_MARGIN_MILLISECONDS + 1000);
		const warnings = warningsOf(late.node);
		const client = clientOf(late.node);

		expect(await client.update()).toEqual({ complete: true });
		expect(reading.askedFor).toEqual([refused.lostBlock]);
		expect(warnings()).toContainEqual(expect.stringContaining(`was queued for retry; it is asked for again later`));
		expect(await client.update()).toEqual({ complete: true });
		expect(reading.askedFor).toEqual([refused.lostBlock]);
		advanceClock(FIRST_BACKOFF_MILLISECONDS);
		await client.update();
		expect(reading.askedFor).toEqual([refused.lostBlock, refused.lostBlock]);
		// Asked twice, it waits twice as long.
		advanceClock(FIRST_BACKOFF_MILLISECONDS);
		await client.update();
		expect(reading.askedFor).toHaveLength(2);

		reading.holdsNot(refused.lostBlock);
		advanceClock(FIRST_BACKOFF_MILLISECONDS);
		await client.update();
		expect(warnings()).toContainEqual(expect.stringContaining(`lacks block ${refused.lostBlock}, which deferred staples await, and none of its peers holds a staple holding it`));
		await client.update();
		expect(reading.askedFor).toHaveLength(3);
	});

	test('reads the stranded staples a page at a time, from after the last page read', async function() {
		const peer = await representative();
		const reading = await startReadingPeer(ONE_VOTE_A_READ);
		const late = await joiner({ bootstrapFrom: [reading.apiURL] });
		const { before, lost, after } = await nearTiedHistory(peer.network);
		reading.apply([peer.network.genesis, before, lost, after]);
		const storage = late.node.config.ledger.storageDriver;
		if (!(storage instanceof LedgerStorageDriverBase)) {
			throw(new Error('the node\'s storage is no driver of this node'));
		}
		const read = vi.spyOn(storage, 'listStrandedDeferredStaples');
		advanceClock(BOOTSTRAP_MARGIN_MILLISECONDS + 1000);
		const began = Date.now();

		await clientOf(late.node).update();

		// Those voted before the margin before the update began, whose dependencies its passes read past.
		expect(read.mock.calls.map(function([before, limit, after_]): [number, number, string | undefined] {
			return([before.getTime(), limit, after_?.staple.blocksHash.toString()]);
		})).toEqual([[began - BOOTSTRAP_MARGIN_MILLISECONDS, STRANDED_READ, undefined]]);
	});

	test('reads no stranded staple in an update in which no pass completed', async function() {
		const failing = await startFailingPeer();
		const late = await joiner({ bootstrapFrom: [failing.apiURL] });
		const storage = late.node.config.ledger.storageDriver;
		if (!(storage instanceof LedgerStorageDriverBase)) {
			throw(new Error('the node\'s storage is no driver of this node'));
		}
		const read = vi.spyOn(storage, 'listStrandedDeferredStaples');

		expect(await clientOf(late.node).update()).toEqual({ complete: false });

		expect(read).not.toHaveBeenCalled();
	});

	test('warns, and asks for nothing, when reading the stranded staples fails, and reads them again after the next update', async function() {
		const peer = await representative();
		const reading = await startReadingPeer(ONE_VOTE_A_READ);
		const late = await joiner({ bootstrapFrom: [reading.apiURL] });
		const { before, lost, after } = await nearTiedHistory(peer.network);
		reading.apply([peer.network.genesis, before, lost, after]);
		const storage = late.node.config.ledger.storageDriver;
		if (!(storage instanceof LedgerStorageDriverBase)) {
			throw(new Error('the node\'s storage is no driver of this node'));
		}
		const read = vi.spyOn(storage, 'listStrandedDeferredStaples').mockRejectedValueOnce(new Error('the read failed'));
		advanceClock(BOOTSTRAP_MARGIN_MILLISECONDS + 1000);
		const warnings = warningsOf(late.node);
		const client = clientOf(late.node);

		expect(await client.update()).toEqual({ complete: true });

		expect(reading.askedFor).toEqual([]);
		expect(warnings()).toContainEqual(expect.stringContaining('Reading the deferred staples that await blocks the ledger lacks failed; it is read again after the next update: Error: the read failed'));
		await client.update();
		expect(read).toHaveBeenCalledTimes(2);
		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([peer.network.genesis, before, lost, after]));
	});

	test('warns when adding the staple holding a lacked block fails, and asks for it again only once its wait has passed', async function() {
		const peer = await representative();
		const reading = await startReadingPeer(ONE_VOTE_A_READ);
		const late = await joiner({ bootstrapFrom: [reading.apiURL] });
		const { before, lost, after, lostBlock } = await nearTiedHistory(peer.network);
		reading.apply([peer.network.genesis, before, lost, after]);
		// The ledger failing to say whether it holds the staple, which the queue asks before it adds one.
		const ledger = late.node.ledger;
		const getVoteStaple = ledger.getVoteStaple.bind(ledger);
		let failing = true;
		vi.spyOn(ledger, 'getVoteStaple').mockImplementation(function(blocksHash, ...rest) {
			if (failing && blocksHash.toString() === lost.blocksHash.toString()) {
				return(Promise.reject(new Error('the read failed')));
			}
			return(getVoteStaple(blocksHash, ...rest));
		});
		advanceClock(BOOTSTRAP_MARGIN_MILLISECONDS + 1000);
		const warnings = warningsOf(late.node);
		const client = clientOf(late.node);

		await client.update();

		expect(reading.askedFor).toEqual([lostBlock]);
		expect(warnings()).toContainEqual(expect.stringContaining(`Adding staple ${lost.blocksHash.toString()}, which holds block ${lostBlock} that deferred staples await, failed; it is asked for again later`));
		failing = false;
		await client.update();
		expect(reading.askedFor).toEqual([lostBlock]);
		advanceClock(FIRST_BACKOFF_MILLISECONDS);
		await client.update();
		expect(reading.askedFor).toEqual([lostBlock, lostBlock]);
		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([peer.network.genesis, before, lost, after]));
	});

	test('says a fetched staple the queue found held already, which the ledger then holds no more, was held already', async function() {
		const peer = await representative();
		const reading = await startReadingPeer(ONE_VOTE_A_READ);
		const late = await joiner({ bootstrapFrom: [reading.apiURL] });
		const { before, lost, after, lostBlock } = await nearTiedHistory(peer.network);
		reading.apply([peer.network.genesis, before, lost, after]);
		// The staple on its blocks gone between the queue's look, which finds it held, and the client's, as when the ledger drops it.
		const ledger = late.node.ledger;
		const getVoteStaple = ledger.getVoteStaple.bind(ledger);
		let looks = 0;
		vi.spyOn(ledger, 'getVoteStaple').mockImplementation(function(blocksHash, ...rest) {
			if (blocksHash.toString() === lost.blocksHash.toString() && looks++ === 0) {
				return(Promise.resolve(lost));
			}
			return(getVoteStaple(blocksHash, ...rest));
		});
		advanceClock(BOOTSTRAP_MARGIN_MILLISECONDS + 1000);
		const warnings = warningsOf(late.node);

		await clientOf(late.node).update();

		expect(warnings()).toContainEqual(expect.stringContaining(`the node lacks block ${lostBlock}, which deferred staples await; staple ${lost.blocksHash.toString()} holding it, from ${reading.apiURL}, was held already; it is asked for again later`));
	});

	/*
	 * Two staples of one user voted in the same millisecond, right after
	 * another user's, both of which a representative reading one vote at a
	 * time leaves out, and the user's next staple, which waits on the second.
	 */
	test('says a fetched staple the ledger deferred was deferred, and fetches what it awaits in the next update', async function() {
		const peer = await representative();
		const reading = await startReadingPeer(ONE_VOTE_A_READ);
		const late = await joiner({ bootstrapFrom: [reading.apiURL] });
		const network = peer.network;
		const cursor = new ChainCursor(network.genesis);
		const [first, second] = network.users;
		if (first === undefined || second === undefined) {
			throw(new Error('two users expected'));
		}
		const send = async function(from: Account): Promise<VoteStaple> {
			const block = cursor.append(await sendBlock({ from, to: RECIPIENT, amount: 1n, token: network.baseToken, previous: cursor.previous(from), network: network.network }));
			return(await confirmedStaple([block], network.representatives));
		};
		advanceClock(1000);
		const before = await send(first);
		advanceClock(1);
		const firstLost = await send(second);
		const secondLost = await send(second);
		advanceClock(2000);
		const after = await send(second);
		reading.apply([network.genesis, before, firstLost, secondLost, after]);
		advanceClock(BOOTSTRAP_MARGIN_MILLISECONDS + 1000);
		const warnings = warningsOf(late.node);
		const client = clientOf(late.node);

		await client.update();

		const secondBlock = secondLost.blocks[0]?.hash.toString() ?? '';
		expect(reading.askedFor).toEqual([secondBlock]);
		expect(warnings()).toContainEqual(expect.stringContaining(`the node lacks block ${secondBlock}, which deferred staples await; staple ${secondLost.blocksHash.toString()} holding it, from ${reading.apiURL}, was deferred; it is asked for again later`));
		await client.update();
		expect(reading.askedFor).toEqual([secondBlock, firstLost.blocks[0]?.hash.toString() ?? '']);
		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([network.genesis, before, firstLost, secondLost, after]));
	});

	test('reads the next page of stranded staples from after the last one read, carrying the blocks of a round\'s pages, and a new round after a short page', async function() {
		const peer = await representative();
		const reading = await startReadingPeer(ONE_VOTE_A_READ);
		reading.apply([peer.network.genesis]);
		const late = await joiner({ bootstrapFrom: [reading.apiURL] });
		const [carrier, waiting] = await sendsFrom(peer.network, 0, 2);
		const carried = carrier?.blocks[0]?.hash;
		if (carrier === undefined || waiting === undefined || carried === undefined) {
			throw(new Error('no staples were made'));
		}
		const latestVote = new Date();
		const full = Array.from({ length: STRANDED_READ }, function(_ignored, index): StrandedDeferredStaple {
			return({ staple: carrier, lacks: [], latestVote: new Date(latestVote.getTime() + index) });
		});
		const lacking: StrandedDeferredStaple = { staple: waiting, lacks: [carried], latestVote };
		const pages = [full, [lacking], [lacking]];
		const storage = late.node.config.ledger.storageDriver;
		if (!(storage instanceof LedgerStorageDriverBase)) {
			throw(new Error('the node\'s storage is no driver of this node'));
		}
		const read = vi.spyOn(storage, 'listStrandedDeferredStaples').mockImplementation(function(): Promise<readonly StrandedDeferredStaple[]> {
			return(Promise.resolve(pages.shift() ?? []));
		});
		const client = clientOf(late.node);

		await client.update();
		await client.update();
		// The second page lacks only a block the first page's staples carry.
		expect(reading.askedFor).toEqual([]);
		await client.update();

		expect(read.mock.calls.map(function([, , after]): StrandedDeferredStaple | undefined {
			return(after);
		})).toEqual([undefined, full.at(-1), undefined]);
		expect(reading.askedFor).toEqual([carried.toString()]);
	});

	test('asks only for the blocks deferred staples await that none of them carries, nor a page before, each once, none waiting out its backoff, and at most so many', async function() {
		const peer = await representative();
		const [first, second, third] = await sendsFrom(peer.network, 0, 3);
		const [firstBlock] = first?.blocks ?? [];
		const [secondBlock] = second?.blocks ?? [];
		if (first === undefined || second === undefined || third === undefined || firstBlock === undefined || secondBlock === undefined) {
			throw(new Error('no staples were made'));
		}
		const latestVote = new Date();
		const stranded = [{ staple: second, lacks: [firstBlock.hash], latestVote }, { staple: third, lacks: [secondBlock.hash, firstBlock.hash], latestVote }];
		const due = function(carried: ReadonlySet<string>, unanswered: ReadonlyMap<string, { readonly asked: number; readonly at: number }>, now: number, most: number): string[] {
			return(dueLackedBlocks(stranded, carried, unanswered, now, most).map(String));
		};
		const noBackoff = new Map<string, { readonly asked: number; readonly at: number }>();

		expect(due(new Set(), noBackoff, 0, MOST_LACKED_PER_UPDATE)).toEqual([firstBlock.hash.toString()]);
		expect(due(new Set([firstBlock.hash.toString()]), noBackoff, 0, MOST_LACKED_PER_UPDATE)).toEqual([]);
		expect(due(new Set(), noBackoff, 0, 0)).toEqual([]);
		const askedOnce = new Map([[firstBlock.hash.toString(), { asked: 1, at: 1000 }]]);
		expect(due(new Set(), askedOnce, 1000 + FIRST_BACKOFF_MILLISECONDS - 1, MOST_LACKED_PER_UPDATE)).toEqual([]);
		expect(due(new Set(), askedOnce, 1000 + FIRST_BACKOFF_MILLISECONDS, MOST_LACKED_PER_UPDATE)).toEqual([firstBlock.hash.toString()]);
		expect([MOST_LACKED_PER_UPDATE, STRANDED_READ]).toEqual([8, 64]);
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
		expect(lines(info.mock.calls)).toEqual([`BOOTSTRAP Bootstrap pass over ${recording.apiURL}: drained after ${String(requests)} requests, 4 staples added, 0 held already, 0 queued for retry, 0 staged (0 in the queue)`]);
		expect(lines(debug.mock.calls)).toEqual([`BOOTSTRAP Bootstrap pass over ${recording.apiURL}: drained after ${String(recording.pages.length - requests)} requests, 0 staples added, 0 held already, 0 queued for retry, 0 staged (0 in the queue)`]);
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
		const middle = Math.floor(reached + (end - reached) / 2);
		expect(logged.filter(function(line): boolean {
			return(line.includes('Bootstrap pass over'));
		})).toEqual([`BOOTSTRAP Bootstrap pass over ${first.apiURL}: read the range from ${new Date(reached - 61_000).toISOString()} to ${new Date(middle).toISOString()} after 2 requests, 0 staples added, 0 held already, 0 queued for retry, 6 staged (0 in the queue)`]);
		const splits = logged.filter(function(line): boolean {
			return(line.includes('takes on the range'));
		});
		expect(splits.length).toBeGreaterThan(0);
		for (const split of splits) {
			expect(split).toMatch(/^BOOTSTRAP Bootstrap from http:\/\/127\.0\.0\.1:\d+\/api: takes on the range from \S+Z to \S+Z, the later part of the one http:\/\/127\.0\.0\.1:\d+\/api reads, which reached \S+Z and now ends at \S+Z$/u);
		}
		expect(await client.update()).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
	});

	test('adds the staples staged in its store in the order of their votes, as a restage leaves them, before it reads its peers on from where it reached', async function() {
		const peer = await representative();
		const sends = await sendsFrom(peer.network, 0, 4);
		await addAll(peer.node, sends);
		const recording = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [recording.apiURL] });
		const storage = late.node.config.ledger.storageDriver;
		if (!(storage instanceof LedgerStorageDriverBase)) {
			throw(new Error('the node\'s ledger is not on a driver of this node'));
		}
		// Each send follows the one before, and genesis gives the voters weight: added in any order but theirs, one is refused.
		const staged = [...sends].reverse().concat([peer.network.genesis]).map(stagedOf);
		await storage.bootstrapStage().put(staged);
		const info = vi.spyOn(late.node.log, 'info');
		const client = clientOf(late.node);

		expect(await client.update()).toEqual({ complete: true });

		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
		expect(await storage.bootstrapStage().counts()).toEqual({ staples: 0, bytes: 0 });
		const logged = info.mock.calls.map(function(call): string {
			return(call.map(String).join(' '));
		});
		expect(logged).toContainEqual(expect.stringContaining('Bootstrap: added 5 staged staples, by their votes, of every staple; 0 staples (0 MiB) remain staged'));
		// What the stage held, or the ledger once it was added, the filters named, so the peer sent none of it.
		expect(new Set(servedCounts(recording.pages))).toEqual(new Set([0]));
	});

	test('runs the ledger\'s garbage collection after each update, which applies staples deferred past the replay window, in short slices until it reports nothing left, and none once stopped', async function() {
		const peer = await representative();
		await addAll(peer.node, await sendsFrom(peer.network, 0, 2));
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		const client = clientOf(late.node);
		const collect = vi.spyOn(late.node.ledger, 'gc');

		collect.mockResolvedValue(false);
		await client.update();
		expect(collect.mock.calls).toEqual([[2000]]);

		// A chain of deferred staples longer than a few slices apply is applied whole before the next update adds more.
		collect.mockClear();
		let slices = 0;
		collect.mockImplementation(function() {
			slices++;
			return(Promise.resolve(slices < 12));
		});
		await client.update();
		expect(collect.mock.calls.length).toBe(12);

		// A stop asked for while it runs ends it after the slice.
		collect.mockClear();
		slices = 0;
		let stopping: Promise<void> = Promise.resolve();
		collect.mockImplementation(function() {
			slices++;
			if (slices === 3) {
				stopping = client.stop();
			}
			return(Promise.resolve(true));
		});
		await client.update();
		await stopping;
		expect(collect.mock.calls.length).toBe(3);

		collect.mockClear();
		await client.update();
		expect(collect).not.toHaveBeenCalled();
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
		// A request that fails other than as a page is passed on as it failed.
		expect(warnings()).toContainEqual(expect.stringContaining('connect ECONNREFUSED'));
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
		const warnings = warningsOf(late.node);
		const debug = linesOf(late.node, 'debug');

		const updating = client.update();
		await silent.requested;
		const before = { reads: reads.mock.calls.length, adds: adds.mock.calls.length };
		const stopping = performance.now();
		await client.stop();
		const stoppedIn = performance.now() - stopping;

		expect(await updating).toEqual({ complete: false });
		expect({ reads: reads.mock.calls.length, adds: adds.mock.calls.length, requests: serving.pages.length - requested }).toEqual({ ...before, requests: 0 });
		expect(stoppedIn).toBeLessThan(STOP_BOUND_MILLISECONDS);
		// The pass over the next peer was not begun, so it recorded no progress on it.
		expect(await kv.list(BOOTSTRAP_CURSOR_ARENA)).toEqual([silent.apiURL]);
		expect(warnings()).toEqual([]);
		expect(debug()).toContain(`BOOTSTRAP Stopped bootstrapping from ${silent.apiURL}`);
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

	test('leaves no record of its transactions on the node however long it catches up, while a request still times its own', async function() {
		const peer = await representative();
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		const client = clientOf(late.node);
		const staples = await sendsFrom(peer.network, 0, 24);
		const recorded: number[] = [];
		for (let added = 0; added < staples.length; added += 6) {
			await addAll(peer.node, staples.slice(added, added + 6));
			advanceClock(1000);
			expect(await client.update(2)).toEqual({ complete: true });
			recorded.push(timedSections(late.node), timedSections(peer.node));
		}

		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
		expect(recorded).toEqual(new Array<number>(8).fill(0));
		const copies: Node[] = [];
		const copy = peer.node.copy.bind(peer.node);
		vi.spyOn(peer.node, 'copy').mockImplementation(function(): Node {
			const made = copy();
			copies.push(made);
			return(made);
		});
		// The statistics route reads the ledger, whose work the request's copy times.
		expect((await request(peer, '/node/stats')).status).toBe(200);
		expect(copies).toHaveLength(1);
		expect(timedSections(requireAt(copies, 0))).toBeGreaterThan(0);
	});
});

describe('a bootstrap client at the edges of what it accepts and meets', function() {
	test('refuses a timeout or a period that is no positive number of milliseconds, and a page of no whole number of staples from 1 to 1000', async function() {
		const late = await joiner();
		for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(function() {
				return(new BootstrapClient(late.node, { timeout }));
			}).toThrow(new RangeError(`the bootstrap timeout must be a positive number of milliseconds (it is ${String(timeout)})`));
		}
		expect(function() {
			return(new BootstrapClient(late.node, { period: 0 }));
		}).toThrow(new RangeError('the bootstrap period must be a positive number of milliseconds (it is 0)'));
		const client = clientOf(late.node);
		for (const limit of [0, 1.5, 1001]) {
			await expect(client.update(limit)).rejects.toThrow(new RangeError(`a bootstrap page holds from 1 to 1000 staples (${String(limit)} were asked for)`));
		}

		expect(await client.update(1)).toEqual({ complete: true });
		expect(clientOf(late.node, { timeout: 1 }).timeout).toBe(1);
	});

	test('staggers the first deep re-scan of each peer by the share of a period its endpoint names', async function() {
		const peer = await representative();
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		const began = Date.now();

		await clientOf(late.node, { kv }).update();

		const stagger = createHash('sha256').update(peer.apiURL).digest().readUInt32BE(0) % DEEP_SCAN_PERIOD_MILLISECONDS;
		expect((await new BootstrapCursors(kv).read(peer.apiURL))?.nextDeepScan).toEqual(new Date(began + DEEP_SCAN_PERIOD_MILLISECONDS + stagger));
	});

	test('keeps the horizon of the latest pass that completed, from which it reads a peer it has no progress on', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		await clientOf(late.node, { kv }).update();
		const horizon = Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS;
		expect(await kv.get(BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY)).toBe(horizon);
		advanceClock(1000);

		bootstrapFrom(late.node.config, [peer.apiURL, recording.apiURL]);
		await clientOf(late.node, { kv }).update();

		expect(recording.pages[0]?.start).toBe(new Date(horizon).toISOString());
	});

	test('fails no update, but logs it and records it incomplete, when it cannot find the peers to bootstrap from', async function() {
		const running = await representative();
		const client = clientOf(running.node);
		expect(await client.update()).toEqual({ complete: true });
		const warnings = warningsOf(running.node);
		vi.spyOn(running.node.switch, 'peers').mockRejectedValue(new Error('the switch is gone'));

		expect(await client.update()).toEqual({ complete: false });

		expect(warnings()).toEqual(['BOOTSTRAP Finding the peers to bootstrap from failed; they are looked for again on the next update: Error: the switch is gone']);
		expect(await client.stats()).toEqual({ lastUpdate: new Date(), completeCount: 0 });
	});

	test('records no update and asks no peer once stopped', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [recording.apiURL] });
		const client = clientOf(late.node);

		await client.stop();

		expect(await client.update()).toEqual({ complete: false });
		expect(await client.stats()).toEqual({ lastUpdate: undefined, completeCount: 0 });
		expect(recording.pages).toEqual([]);
	});

	test('queues a staple the ledger refuses under the code of the refusal, or else what the error says, at most 200 characters of it', async function() {
		const peer = await representative();
		const sends = await sendsFrom(peer.network, 0, 5);
		const serving = await startServingPeer();
		serving.apply([...sends, peer.network.genesis]);
		const late = await joiner({ bootstrapFrom: [serving.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		const set = vi.spyOn(kv, 'set');
		const named = new Error('n'.repeat(300));
		named.name = 'Unnamed';
		const silent = new Error('');
		silent.name = 'Silent';
		const numbered = Object.assign(new Error('numbered'), { code: 5 });
		vi.spyOn(late.node.ledger, 'add').mockRejectedValueOnce(named).mockRejectedValueOnce('t'.repeat(300)).mockRejectedValueOnce(silent).mockRejectedValueOnce(numbered).mockRejectedValueOnce({ code: 'NOT_AN_ERROR' });
		const info = linesOf(late.node, 'info');

		expect(await clientOf(late.node, { kv }).update(1)).toEqual({ complete: true });

		// A pass that queued staples is logged though it completed.
		expect(info()).toContainEqual(expect.stringMatching(/ staples added, 0 held already, [1-9]\d* queued for retry, 0 staged \(0 in the queue\)$/u));

		expect(set.mock.calls.filter(function([arena, , value]): boolean {
			return(arena === BOOTSTRAP_RETRY_ARENA && value !== undefined);
		}).map(function([, , value]): unknown {
			return(Reflect.get(Object(value), 'code'));
		})).toEqual([`Unnamed: ${'n'.repeat(191)}`, 't'.repeat(200), 'Silent: ', 'Error: numbered', '[object Object]']);
		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([peer.network.genesis, ...sends]));
	});

	test('fails a pass over a peer that answers with no page, or is no HTTP endpoint, naming why', async function() {
		const failing = await startFailingPeer();
		const malformed = await startAnsweringPeer(200, 'not JSON');
		const late = await joiner({ bootstrapFrom: [failing.apiURL, malformed.apiURL, 'ftp://127.0.0.1/api'] });
		const warnings = warningsOf(late.node);

		expect(await clientOf(late.node).update()).toEqual({ complete: false });

		const failed = 'failed; it is tried again on the next update: PageError:';
		expect(warnings()).toEqual([
			`BOOTSTRAP Bootstrapping from ${failing.apiURL} ${failed} ${failing.apiURL} answered 500: An internal error occurred`,
			`BOOTSTRAP Bootstrapping from ${malformed.apiURL} ${failed} ${malformed.apiURL} answered with no page of staples: the body is no JSON`,
			`BOOTSTRAP Bootstrapping from ftp://127.0.0.1/api ${failed} ftp://127.0.0.1/api is no http:// or https:// URL`
		]);
	});

	test('names fewer of the staples it holds in each pass after a peer gives up on a request that carried them, across updates', async function() {
		const peer = await representative();
		await addAll(peer.node, await sendsFrom(peer.network, 0, 2));
		const gateway = await startRecordingPeer(peer.apiURL, { filter: 'gives-up' });
		const late = await joiner({ bootstrapFrom: [gateway.apiURL] });
		const warnings = warningsOf(late.node);
		const client = clientOf(late.node);

		for (let update = 0; update < 3; update++) {
			expect(await client.update()).toEqual({ complete: false });
		}

		expect(warnings()).toEqual([64, 32, 16].map(function(size): string {
			return(`BOOTSTRAP Bootstrapping from ${gateway.apiURL} failed; it is tried again on the next update: Error: PageError: ${gateway.apiURL} answered 504; the next pass names at most ${String(size)} staples the node holds ahead of its start`);
		}));
	});

	test('warns, once, of a peer it has seen key votes both by when they were made and later than that', async function() {
		const peer = await representative();
		const genesis = Buffer.from(peer.network.genesis.toBytes()).toString('base64');
		const late = await startAnsweringPeer(200, JSON.stringify({ voteStaples: [{ $binary: genesis }] }));
		const joining = await joiner({ bootstrapFrom: [late.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		// Long after genesis was voted on.
		advanceClock(60 * 60_000);
		const start = new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS);
		await new BootstrapCursors(kv).write(late.apiURL, { reached: start, caughtUp: true, deepScanFrom: start, nextDeepScan: new Date(Date.now() + DEEP_SCAN_PERIOD_MILLISECONDS), deepScan: undefined, keying: 'votes' });
		const warnings = warningsOf(joining.node);

		expect(await clientOf(joining.node, { kv }).update()).toEqual({ complete: false });

		expect(warnings()[0]).toBe(`BOOTSTRAP Bootstrap from ${late.apiURL}: the peer lists staples twice, as one keyed by votes does, and listed from ${start.toISOString()} staple ${peer.network.genesis.blocksHash.toString()}, none of whose votes was made within 1000 ms before it or later: it keys votes later than they were made, and passes over it now move on only by what holds whatever later moment it keys them at`);
		expect(warnings()).toHaveLength(2);
		expect((await new BootstrapCursors(kv).read(late.apiURL))?.keying).toBe('late-votes');
	});

	test('resumes the ranges its store keeps rather than lay them out again', async function() {
		const peer = await representative();
		await addAll(peer.node, await sendsFrom(peer.network, 0, 2));
		const recording = await startRecordingPeer(peer.apiURL);
		const other = await startRecordingPeer(peer.apiURL);
		const late = await joiner({ bootstrapFrom: [recording.apiURL, other.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		advanceClock(2 * 24 * 60 * 60_000);
		const end = new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS);
		const reached = new Date(GENESIS_MOMENT.getTime() - 60_000);
		await new BootstrapCursors(kv).writeLayout({ from: GENESIS_MOMENT, end, deepScanPeer: recording.apiURL, ranges: [{ id: 0, reached, end, peer: recording.apiURL, pace: { spent: 0, advanced: 0 } }], standings: {}, fullQueueUpdates: 0, nextID: 1 });
		const info = linesOf(late.node, 'info');

		expect(await clientOf(late.node, { kv }).update()).toEqual({ complete: false });

		expect(recording.pages[0]?.start).toBe(reached.toISOString());
		expect(info().filter(function(line): boolean {
			return(line.includes('in as many ranges'));
		})).toEqual([]);
		expect(await new BootstrapCursors(kv).readLayout()).toBeUndefined();
		expect(await heldBlocksHashes(late.node)).toEqual(await heldBlocksHashes(peer.node));
	});

	test('logs a pass over a range that fails, naming the range, and one stopped only at debug level', async function() {
		const failing = await startFailingPeer();
		const silent = await startSilentAPIPeer();
		const late = await joiner({ bootstrapFrom: [failing.apiURL, silent.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		advanceClock(2 * 24 * 60 * 60_000);
		const end = new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS);
		const middle = new Date(GENESIS_MOMENT.getTime() + 24 * 60 * 60_000);
		await new BootstrapCursors(kv).writeLayout({ from: GENESIS_MOMENT, end, deepScanPeer: failing.apiURL, ranges: [
			{ id: 0, reached: GENESIS_MOMENT, end: middle, peer: failing.apiURL, pace: { spent: 0, advanced: 0 } },
			{ id: 1, reached: middle, end, peer: silent.apiURL, pace: { spent: 0, advanced: 0 } }
		], standings: { [failing.apiURL]: { failures: 2, benchedUntil: undefined } }, fullQueueUpdates: 0, nextID: 2 });
		const warnings: string[] = [];
		const warned = new Promise<void>(function(resolve) {
			vi.spyOn(late.node.log, 'warn').mockImplementation(function(...line: unknown[]): void {
				warnings.push(line.map(String).join(' '));
				resolve();
			});
		});
		const debug = linesOf(late.node, 'debug');
		const client = clientOf(late.node, { kv });

		const updating = client.update();
		await Promise.all([silent.requested, warned]);
		await client.stop();

		expect(await updating).toEqual({ complete: false });
		const benchedUntil = new Date(Date.now() + 30 * 60_000);
		expect(warnings).toEqual([
			`BOOTSTRAP Bootstrapping from ${failing.apiURL} in the range from ${GENESIS_MOMENT.toISOString()} to ${middle.toISOString()} failed; it is tried again on the next update: PageError: ${failing.apiURL} answered 500: An internal error occurred`,
			`BOOTSTRAP Bootstrap from ${failing.apiURL}: its passes over a range failed too often in a row, so another peer reads the range, and it reads none until ${benchedUntil.toISOString()}`
		]);
		expect(debug()).toContain(`BOOTSTRAP Stopped bootstrapping from ${silent.apiURL}`);
		// A stopped pass counts neither for its peer nor against it.
		expect((await new BootstrapCursors(kv).readLayout())?.standings).toEqual({ [failing.apiURL]: { failures: 0, benchedUntil }, [silent.apiURL]: { failures: 0, benchedUntil: undefined } });
	});

	test('logs a pass that finds the node has reached the moment it began as caught up, at debug level, and logs no staged staples it did not add', async function() {
		const peer = await representative();
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		const ahead = new Date(Date.now() + 1000);
		await new BootstrapCursors(kv).write(peer.apiURL, { reached: ahead, caughtUp: true, deepScanFrom: ahead, nextDeepScan: new Date(Date.now() + DEEP_SCAN_PERIOD_MILLISECONDS), deepScan: undefined, keying: 'votes' });
		const debug = linesOf(late.node, 'debug');
		const info = linesOf(late.node, 'info');

		expect(await clientOf(late.node, { kv }).update()).toEqual({ complete: true });

		expect(debug()).toContain(`BOOTSTRAP Bootstrap pass over ${peer.apiURL}: caught up after 0 requests, 0 staples added, 0 held already, 0 queued for retry, 0 staged (0 in the queue)`);
		expect(info()).toEqual([]);
	});

	test('logs a pass over a peer that reached its bound with where it reached, as it does one over a range', async function() {
		const peer = await representative();
		await addAll(peer.node, await sendsFrom(peer.network, 0, 2));
		let answered = 0;
		const slow = await startRecordingPeer(peer.apiURL, { beforeAnswer: function(): void {
			answered++;
			// The first page takes all the time a pass has.
			if (answered === 1) {
				advanceClock(MAX_PASS_MILLISECONDS);
			}
		} });
		const late = await joiner({ bootstrapFrom: [slow.apiURL] });
		const info = linesOf(late.node, 'info');

		expect(await clientOf(late.node).update(1)).toEqual({ complete: false });

		expect(info()).toContainEqual(`BOOTSTRAP Bootstrap pass over ${slow.apiURL}: reached ${EPOCH} within this update's bound (it continues on the next update) after 1 requests, 1 staples added, 0 held already, 0 queued for retry, 0 staged (0 in the queue)`);

		const ranged = await joiner({ bootstrapFrom: [slow.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		advanceClock(2 * 24 * 60 * 60_000);
		const end = new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS);
		await new BootstrapCursors(kv).writeLayout({ from: GENESIS_MOMENT, end, deepScanPeer: slow.apiURL, ranges: [{ id: 0, reached: GENESIS_MOMENT, end, peer: slow.apiURL, pace: { spent: 0, advanced: 0 } }], standings: {}, fullQueueUpdates: 0, nextID: 1 });
		const rangedInfo = linesOf(ranged.node, 'info');
		answered = 0;

		expect(await clientOf(ranged.node, { kv }).update(1)).toEqual({ complete: false });

		expect(rangedInfo()).toContainEqual(expect.stringMatching(new RegExp(`^BOOTSTRAP Bootstrap pass over ${slow.apiURL}: reached \\S+ within this update's bound \\(it continues on the next update\\), in the range from ${GENESIS_MOMENT.toISOString()} to ${end.toISOString()} after 1 requests, 0 staples added, 0 held already, 0 queued for retry, 1 staged \\(0 in the queue\\)$`, 'u')));
	});

	test('stages a staple on blocks the ledger holds with other votes as held, while it adds what it staged', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const holder = await joiner({ genesis: 'held', bootstrapFrom: [recording.apiURL] });
		const [first, second] = await sendsFrom(peer.network, 0, 2);
		if (first === undefined || second === undefined) {
			throw(new Error('no staples were made'));
		}
		await addAll(peer.node, [first, second]);
		await holder.node.ledger.add(await confirmedStaple(first.blocks, peer.network.representatives, { voteDelays: [1, 1] }));
		const storage = holder.node.config.ledger.storageDriver;
		if (!(storage instanceof LedgerStorageDriverBase)) {
			throw(new Error('the node\'s ledger is not on a driver of this node'));
		}
		// What a restage leaves, so that the pass stages what it is sent.
		await storage.bootstrapStage().put([stagedOf(second)]);
		const debug = linesOf(holder.node, 'debug');

		expect(await clientOf(holder.node).update()).toEqual({ complete: true });

		expect(debug()).toContainEqual(expect.stringMatching(new RegExp(`^BOOTSTRAP Bootstrap pass over ${recording.apiURL}: drained after \\d+ requests, 0 staples added, 1 held already, 0 queued for retry, 0 staged \\(0 in the queue\\)$`, 'u')));
		expect(await heldBlocksHashes(holder.node)).toEqual(await heldBlocksHashes(peer.node));
	});

	test('keeps what it stages in memory on a ledger whose driver is not of this node, and reads no stranded staple there', async function() {
		const peer = await representative();
		const late = await joiner();
		const { log, config, ledger } = late.node;
		const driver = config.ledger.storageDriver;
		if (!(driver instanceof LedgerStorageDriverBase)) {
			throw(new Error('the node\'s storage is no driver of this node'));
		}
		const read = vi.spyOn(driver, 'listStrandedDeferredStaples');
		// The driver as seen through a proxy that is no instance of this node's drivers.
		const foreign = new Proxy(config.ledger.storageDriver, {
			getPrototypeOf(): object | null {
				return(Object.prototype);
			}
		});
		expect(foreign instanceof LedgerStorageDriverBase).toBe(false);

		const foreignConfig = { ...config, ledger: { ...config.ledger, storageDriver: foreign } };
		bootstrapFrom(foreignConfig, [peer.apiURL]);
		const client = new BootstrapClient({ log, config: foreignConfig, ledger });

		expect(await client.update()).toEqual({ complete: true });
		await client.stop();
		expect(read).not.toHaveBeenCalled();
		expect(await heldBlocksHashes(late.node)).toEqual(blocksHashesOf([peer.network.genesis]));
	});

	describe('adding what it staged', function() {
		/** A node joining late whose stage holds what a restage leaves of the peer's genesis and sends, and the peer, which holds them. */
		async function stagedJoiner(sends: number): Promise<{ readonly late: CreatedLocalNode; readonly stage: ReturnType<LedgerStorageDriverBase['bootstrapStage']>; readonly staples: number }> {
			const peer = await representative();
			const late = await joiner({ bootstrapFrom: [peer.apiURL] });
			const staples = [peer.network.genesis, ...await sendsFrom(peer.network, 0, sends)];
			await addAll(peer.node, staples.slice(1));
			const storage = late.node.config.ledger.storageDriver;
			if (!(storage instanceof LedgerStorageDriverBase)) {
				throw(new Error('the node\'s ledger is not on a driver of this node'));
			}
			const stage = storage.bootstrapStage();
			await stage.put(staples.map(stagedOf));
			return({ late, stage, staples: staples.length });
		}

		test('adds every staple staged before the frontier in the update, batch after batch, after the passes ended', async function() {
			const { late, stage, staples } = await stagedJoiner(70);
			// With no peer to read, the passes end at once, and only the adding is left.
			bootstrapFrom(late.node.config, []);

			expect(await clientOf(late.node).update()).toEqual({ complete: true });

			expect(await stage.counts()).toEqual({ staples: 0, bytes: 0 });
			expect(await heldBlocksHashes(late.node)).toHaveLength(staples);
		});

		test('leaves what it staged for the next update once the update\'s time is up, and says so', async function() {
			const { late, stage, staples } = await stagedJoiner(70);
			const add = late.node.ledger.add.bind(late.node.ledger);
			let first = true;
			vi.spyOn(late.node.ledger, 'add').mockImplementation(function(...args: Parameters<typeof add>): Promise<VoteStaple[]> {
				if (first) {
					first = false;
					advanceClock(MAX_PASS_MILLISECONDS);
				}
				return(add(...args));
			});
			const info = linesOf(late.node, 'info');

			expect(await clientOf(late.node).update()).toEqual({ complete: false });

			const left = await stage.counts();
			expect(left.staples).toBe(staples - 64);
			expect(info()).toContainEqual(`BOOTSTRAP Bootstrap: added 64 staged staples, by their votes, of every staple; more of those are left to add; ${String(left.staples)} staples (0 MiB) remain staged`);
		});

		test('says up to where it added what it staged while ranges are left to read', async function() {
			const peer = await representative();
			const recording = await startRecordingPeer(peer.apiURL);
			const failing = await startFailingPeer();
			const late = await joiner({ genesis: 'held', bootstrapFrom: [recording.apiURL, failing.apiURL] });
			await addAll(peer.node, await sendsFrom(peer.network, 0, 3));
			const kv = new KVInternals.KVStorageProviderMemory();
			advanceClock(2 * 24 * 60 * 60_000);
			const end = new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS);
			const later = new Date(GENESIS_MOMENT.getTime() + 60 * 60_000);
			await new BootstrapCursors(kv).writeLayout({ from: GENESIS_MOMENT, end, deepScanPeer: recording.apiURL, ranges: [
				{ id: 0, reached: new Date(GENESIS_MOMENT.getTime() - 61_000), end: later, peer: recording.apiURL, pace: { spent: 0, advanced: 0 } },
				{ id: 1, reached: later, end, peer: failing.apiURL, pace: { spent: 0, advanced: 0 } }
			], standings: {}, fullQueueUpdates: 0, nextID: 2 });
			const info = linesOf(late.node, 'info');

			expect(await clientOf(late.node, { kv }).update()).toEqual({ complete: false });

			expect(info()).toContainEqual(`BOOTSTRAP Bootstrap: added 3 staged staples, by their votes, of those whose earliest vote was made before ${new Date(later.getTime() - 61_000).toISOString()}; 0 staples (0 MiB) remain staged`);
		});

		test('logs a pass over a range it has read to its end as read', async function() {
			const peer = await representative();
			const late = await joiner({ bootstrapFrom: [peer.apiURL] });
			const kv = new KVInternals.KVStorageProviderMemory();
			advanceClock(2 * 24 * 60 * 60_000);
			const end = new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS);
			await new BootstrapCursors(kv).writeLayout({ from: GENESIS_MOMENT, end, deepScanPeer: peer.apiURL, ranges: [{ id: 0, reached: end, end, peer: peer.apiURL, pace: { spent: 0, advanced: 0 } }], standings: {}, fullQueueUpdates: 0, nextID: 1 });
			const debug = linesOf(late.node, 'debug');

			await clientOf(late.node, { kv }).update();

			expect(debug()).toContain(`BOOTSTRAP Bootstrap pass over ${peer.apiURL}: read the range from ${end.toISOString()} to ${end.toISOString()} after 0 requests, 0 staples added, 0 held already, 0 queued for retry, 0 staged (0 in the queue)`);
		});

		test('stops adding what it staged once stopped, and leaves the rest staged', async function() {
			const { late, stage, staples } = await stagedJoiner(5);
			const client = clientOf(late.node);
			const add = late.node.ledger.add.bind(late.node.ledger);
			let stopped: Promise<void> | undefined;
			vi.spyOn(late.node.ledger, 'add').mockImplementation(function(...args: Parameters<typeof add>): Promise<VoteStaple[]> {
				stopped ??= client.stop();
				return(add(...args));
			});

			expect(await client.update()).toEqual({ complete: false });
			await stopped;

			expect(await stage.counts()).toMatchObject({ staples: staples - 1 });
		});
	});

	test('offers the ledger no staple once stopped, though the stop came while it read whether it held it, and queues none it refused as it stopped', async function() {
		const peer = await representative();
		await addAll(peer.node, await sendsFrom(peer.network, 0, 2));
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		const client = clientOf(late.node);
		const read = late.node.ledger.getVoteStaple.bind(late.node.ledger);
		let stopped: Promise<void> | undefined;
		vi.spyOn(late.node.ledger, 'getVoteStaple').mockImplementation(function(...args: Parameters<typeof read>): ReturnType<typeof read> {
			stopped ??= client.stop();
			return(read(...args));
		});
		const adds = vi.spyOn(late.node.ledger, 'add');

		expect(await client.update()).toEqual({ complete: false });
		await stopped;
		expect(adds).not.toHaveBeenCalled();

		const refusing = await joiner({ bootstrapFrom: [peer.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		const refusingClient = clientOf(refusing.node, { kv });
		let stoppedAgain: Promise<void> | undefined;
		vi.spyOn(refusing.node.ledger, 'add').mockImplementation(function(): Promise<VoteStaple[]> {
			stoppedAgain ??= refusingClient.stop();
			return(Promise.reject(new Error('refused as the node stops')));
		});

		expect(await refusingClient.update()).toEqual({ complete: false });
		await stoppedAgain;
		expect(await kv.list(BOOTSTRAP_RETRY_ARENA)).toEqual([]);
	});

	test('stages nothing more of a page once stopped', async function() {
		const peer = await representative();
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		await addAll(peer.node, await sendsFrom(peer.network, 0, 3));
		const storage = late.node.config.ledger.storageDriver;
		if (!(storage instanceof LedgerStorageDriverBase)) {
			throw(new Error('the node\'s ledger is not on a driver of this node'));
		}
		const stage = storage.bootstrapStage();
		// What a restage leaves, so that the pass stages what it is sent.
		await stage.put([stagedOf(peer.network.genesis)]);
		const client = clientOf(late.node);
		const put = stage.put.bind(stage);
		let stopped: Promise<void> | undefined;
		const puts = vi.spyOn(stage, 'put').mockImplementation(function(...args: Parameters<typeof put>): ReturnType<typeof put> {
			stopped ??= client.stop();
			return(put(...args));
		});

		expect(await client.update()).toEqual({ complete: false });
		await stopped;

		expect(puts).toHaveBeenCalledTimes(1);
	});

	test('logs a pass that queued what it was sent and added nothing, though it completed', async function() {
		const peer = await representative();
		const serving = await startServingPeer();
		serving.apply(await sendsFrom(peer.network, 0, 2));
		const late = await joiner({ bootstrapFrom: [serving.apiURL] });
		const info = linesOf(late.node, 'info');

		expect(await clientOf(late.node).update()).toEqual({ complete: true });

		expect(info()).toEqual([expect.stringMatching(new RegExp(`^BOOTSTRAP Bootstrap pass over ${serving.apiURL}: drained after \\d+ requests, 0 staples added, 0 held already, 2 queued for retry, 0 staged \\(2 in the queue\\)$`, 'u'))]);
	});

	test('once a full queue stops a pass from where the last reached, stages what it is sent while ranges are laid out, begins a deep re-scan at once, and yields every fifth update to the peers', async function() {
		const peer = await representative();
		const serving = await startServingPeer();
		// Without genesis, which gives their voters weight, the ledger refuses them.
		serving.apply(await sendsFrom(peer.network, 0, 2));
		const late = await joiner({ bootstrapFrom: [serving.apiURL] });
		const kv = new KVInternals.KVStorageProviderMemory();
		// As many as a pass from where the last reached may fill, a tenth of the queue's bound being the deep re-scans' share.
		for (let index = 0; index < 900; index++) {
			await kv.set(BOOTSTRAP_RETRY_ARENA, `queued-${String(index)}`, { staple: 'AA==', queuedAt: Date.now(), code: 'LEDGER_OTHER', reported: false });
		}
		const client = clientOf(late.node, { kv });
		expect(await client.update()).toEqual({ complete: false });
		const cursors = new BootstrapCursors(kv);
		expect((await cursors.read(serving.apiURL))?.deepScan).toBeUndefined();
		advanceClock(2 * 24 * 60 * 60_000);
		const end = new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS);
		const range = { id: 0, reached: GENESIS_MOMENT, end, peer: serving.apiURL, pace: { spent: 0, advanced: 0 } };
		await cursors.writeLayout({ from: GENESIS_MOMENT, end, deepScanPeer: serving.apiURL, ranges: [range], standings: {}, fullQueueUpdates: 4, nextID: 1 });
		const logged = [linesOf(late.node, 'info'), linesOf(late.node, 'debug')];

		expect(await client.update()).toEqual({ complete: false });

		expect(await cursors.readLayout()).toMatchObject({ ranges: [range], fullQueueUpdates: 0 });
		// The deep re-scan began with the update, and ran alongside it.
		expect((await cursors.read(serving.apiURL))?.nextDeepScan).toEqual(new Date(Date.now() + DEEP_SCAN_PERIOD_MILLISECONDS));
		const passes = logged.flatMap(function(lines): string[] {
			return(lines());
		}).filter(function(line): boolean {
			return(line.includes('Bootstrap pass over'));
		});
		expect(passes).toHaveLength(1);
		expect(passes[0]).toMatch(/, 0 staples added, \d+ held already, 0 queued for retry, 2 staged \(900 in the queue\)$/u);
	});

	test('offers the ledger no queued staple while it reads ranges, though the staple\'s voters have the weight, until it adds what it staged before', async function() {
		const peer = await representative();
		const recording = await startRecordingPeer(peer.apiURL);
		const failing = await startFailingPeer();
		const late = await joiner({ genesis: 'held', bootstrapFrom: [recording.apiURL, failing.apiURL] });
		const sends = await sendsFrom(peer.network, 0, 3);
		await addAll(peer.node, sends);
		const [queued] = sends;
		if (queued === undefined) {
			throw(new Error('no staples were made'));
		}
		const kv = new KVInternals.KVStorageProviderMemory();
		const awaited = awaitedOf(queued, 'LEDGER_INSUFFICIENT_VOTING_WEIGHT');
		if (awaited.kind !== 'weight') {
			throw(new Error('the staple awaits no weight'));
		}
		await kv.set(BOOTSTRAP_RETRY_ARENA, queued.blocksHash.toString(), { staple: Buffer.from(queued.toBytes()).toString('base64'), queuedAt: Date.now(), code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT', reported: false, awaited: { kind: awaited.kind, voters: [...awaited.voters] } });
		advanceClock(2 * 24 * 60 * 60_000);
		const end = new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS);
		const before = new Date(GENESIS_MOMENT.getTime() - 61_000);
		// The range of the failing peer stays unread, so nothing staged is added in this update.
		await new BootstrapCursors(kv).writeLayout({ from: GENESIS_MOMENT, end, deepScanPeer: recording.apiURL, ranges: [
			{ id: 0, reached: before, end: new Date(GENESIS_MOMENT.getTime() + 60 * 60_000), peer: failing.apiURL, pace: { spent: 0, advanced: 0 } },
			{ id: 1, reached: before, end, peer: recording.apiURL, pace: { spent: 0, advanced: 0 } }
		], standings: {}, fullQueueUpdates: 0, nextID: 2 });

		expect(await clientOf(late.node, { kv }).update()).toEqual({ complete: false });

		expect(await kv.list(BOOTSTRAP_RETRY_ARENA)).toEqual([queued.blocksHash.toString()]);
		expect(await late.node.ledger.getVoteStaple(queued.blocksHash, 'main')).toBeNull();
	});

	test('names in its first filter of a pass as many staples as the window allows: those queued first, then those staged, then those the ledger holds', async function() {
		const peer = await representative();
		const sends = await sendsFrom(peer.network, 0, 31);
		await addAll(peer.node, sends);
		const window = 128;

		/** How many of the junk queued and of the staples given the first request's filter names. */
		async function firstNamed(queuedCount: number, holding: 'ledger' | 'stage'): Promise<{ readonly queued: number; readonly held: number }> {
			const recording = await startRecordingPeer(peer.apiURL);
			const late = await joiner({ genesis: 'held', bootstrapFrom: [recording.apiURL] });
			const storage = late.node.config.ledger.storageDriver;
			if (!(storage instanceof LedgerStorageDriverBase)) {
				throw(new Error('the node\'s ledger is not on a driver of this node'));
			}
			switch (holding) {
				case 'ledger':
					await addAll(late.node, sends);
					break;
				case 'stage':
					await storage.bootstrapStage().put(sends.map(stagedOf));
					break;
				default:
					assertNever(holding);
			}
			const kv = new KVInternals.KVStorageProviderMemory();
			const junk = Array.from({ length: queuedCount }, function(_ignored, index): Buffer {
				return(Buffer.from(`queued ${String(index)}`));
			});
			for (const [index, bytes] of junk.entries()) {
				await kv.set(BOOTSTRAP_RETRY_ARENA, `queued-${String(index)}`, { staple: bytes.toString('base64'), queuedAt: Date.now(), code: 'LEDGER_OTHER', reported: false });
			}
			await clientOf(late.node, { kv }).update();
			const filter = recording.pages[0]?.bloomFilter;
			if (filter === undefined) {
				throw(new Error('the first request carried no filter'));
			}
			const named = function(bytes: ArrayBuffer): boolean {
				return(filter.has(bytes));
			};
			return({
				queued: junk.map(function(bytes): ArrayBuffer {
					return(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
				}).filter(named).length,
				held: [peer.network.genesis, ...sends].map(function(staple): ArrayBuffer {
					return(staple.toBytes());
				}).filter(named).length
			});
		}

		expect(await firstNamed(window + 2, 'ledger')).toEqual({ queued: window, held: 0 });
		expect(await firstNamed(window - 28, 'ledger')).toEqual({ queued: window - 28, held: 28 });
		expect(await firstNamed(window - 28, 'stage')).toEqual({ queued: window - 28, held: 28 });
	});

	test('logs a callback that fails, and goes on, and calls none when it was given none', async function() {
		const peer = await representative();
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		const errors = linesOf(late.node, 'error');

		expect(await clientOf(late.node, { callback: function(): Promise<void> {
			return(Promise.reject(new Error('the callback failed')));
		} }).update()).toEqual({ complete: true });

		expect(errors()).toEqual([`BOOTSTRAP The bootstrap callback failed for staple ${peer.network.genesis.blocksHash.toString()}: Error: the callback failed`]);
		const other = await joiner({ bootstrapFrom: [peer.apiURL] });
		const otherErrors = linesOf(other.node, 'error');
		expect(await clientOf(other.node).update()).toEqual({ complete: true });
		expect(otherErrors()).toEqual([]);
	});

	test('logs the ledger\'s garbage collection when it fails, and completes the update all the same', async function() {
		const peer = await representative();
		const late = await joiner({ bootstrapFrom: [peer.apiURL] });
		const warnings = warningsOf(late.node);
		vi.spyOn(late.node.ledger, 'gc').mockRejectedValue(new Error('the collection failed'));

		expect(await clientOf(late.node).update()).toEqual({ complete: true });

		expect(warnings()).toEqual(['BOOTSTRAP The ledger\'s garbage collection after a bootstrap update failed; it runs again after the next: Error: the collection failed']);
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

	test('bootstraps from each endpoint once, but its own, and from no manual peer that is no representative', async function() {
		const running = await nodes.start({ representativeWeights: WEIGHTS });
		const own = running.node.config.endpoints?.api;
		if (own === undefined) {
			throw(new Error('the node serves no API'));
		}
		const [first] = running.network.representatives;
		if (first === undefined) {
			throw(new Error('the network has no representative'));
		}
		const participant: P2PPeer = { kind: lib.Node.Kind.PARTICIPANT, id: 'listener' };
		running.node.config.manualPeers = [verifiedPeer(first, 8), participant];
		bootstrapFrom(running.node.config, [apiOf(7), apiOf(7), own]);
		const peers = vi.spyOn(running.node.switch, 'peers').mockResolvedValue([participant]);

		expect(await bootstrapSources(running.node)).toEqual([apiOf(7), apiOf(8)]);
		// A representative it has not heard from lately is the one that has most to catch it up on.
		expect(peers).toHaveBeenCalledWith({ includeStale: true });
	});

	test('asks its switch for no peers while it represents with an endpoint missing, and only for those holding weight while the ledger holds none', async function() {
		const running = await nodes.start({ representativeWeights: WEIGHTS });
		const [, second] = running.network.representatives;
		if (second === undefined) {
			throw(new Error('the network has two representatives'));
		}
		const peers = vi.spyOn(running.node.switch, 'peers').mockResolvedValue([verifiedPeer(second, 1)]);
		const api = running.node.config.endpoints?.api;
		if (api === undefined) {
			throw(new Error('the node serves no API'));
		}
		running.node.config.endpoints = { api };

		expect(await bootstrapSources(running.node)).toEqual([]);
		expect(peers).not.toHaveBeenCalled();

		running.node.config.kind = lib.Node.Kind.PARTICIPANT;
		expect(await bootstrapSources(running.node)).toEqual([apiOf(1)]);
		vi.spyOn(running.node.ledger, 'votingPower').mockResolvedValue(0n);
		expect(await bootstrapSources(running.node)).toEqual([]);
	});

	test('bootstraps, as a node with no switch, from the endpoints it was given alone, and from none when it was given none', async function() {
		const running = await nodes.start({ representativeWeights: WEIGHTS });
		bootstrapFrom(running.node.config, [apiOf(7)]);
		const { log, config, ledger } = running.node;

		expect(await bootstrapSources({ log, config, ledger })).toEqual([apiOf(7)]);
		// A configuration bootstrapFrom was never given.
		expect(bootstrapEndpointsOf({ ...config })).toEqual([]);
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
