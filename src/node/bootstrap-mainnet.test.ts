import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { startServingPeer } from '../testing/bootstrap-peers.js';
import { TEST_NETWORK_SEEDS } from '../testing/network.js';
import { STORAGES_UNDER_TEST, useSDKNodes } from '../testing/sdk.js';
import type { StorageUnderTest } from '../testing/sdk.js';
import { assertNever } from '../util/assert-never.js';
import type { BootstrapClient } from './bootstrap.js';
import { BOOTSTRAP_MARGIN_MILLISECONDS } from './bootstrap-window.js';
import type { Environment } from './config.js';

const lib = KeetaNet.lib;

const sdkNodes = useSDKNodes();

/**
 * The first staples of the first page the main network's first
 * representative served from the beginning of time, their bytes in the
 * order served: the genesis staple comes fifth, after four staples whose
 * voters only it gives weight [Keeta TS] index.js:69740-69752.
 */
const FIXTURE = new URL('../testing/fixtures/mainnet-rep1-epoch-page.json', import.meta.url);

const GENESIS_BLOCKS_HASH = '8E007DDC76554D1BFE13E0A6AD38FD78E1505BAE3E420A9D82F2D34FCB1A6D85';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

async function servedPage(): Promise<VoteStaple[]> {
	const parsed: unknown = JSON.parse(await readFile(FIXTURE, 'utf8'));
	if (!isRecord(parsed) || !Array.isArray(parsed['voteStaples'])) {
		throw(new Error('the fixture holds no staples'));
	}
	return(parsed['voteStaples'].map(function(encoded: unknown): VoteStaple {
		if (typeof encoded !== 'string') {
			throw(new Error('a staple of the fixture is no base64 string'));
		}
		return(new lib.Vote.Staple(encoded));
	}));
}

function clientOf(client: BootstrapClient | undefined): BootstrapClient {
	if (client === undefined) {
		throw(new Error('the node has no bootstrap client'));
	}
	return(client);
}

/** A node that follows the main network from the peer only, keeping its ledger in a store of that kind. */
async function followerOf(storage: StorageUnderTest, peer: string): Promise<Environment> {
	const environment: Environment = {
		KEETANET_LOCAL_NODE_NETWORK: 'main',
		KEETANET_LOCAL_NODE_SEED: TEST_NETWORK_SEEDS.representative,
		KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'bootstrap-only',
		KEETANET_LOCAL_NODE_LISTEN_IP: '127.0.0.1',
		KEETANET_LOCAL_NODE_LISTEN_PORT: '0',
		KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: peer,
		KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: '0'
	};
	switch (storage) {
		case 'memory':
			return(environment);
		case 'postgres':
			return({ ...environment, KEETANET_LOCAL_NODE_POSTGRES_URL: (await sdkNodes.database()).connectionString });
		default:
			return(assertNever(storage));
	}
}

function base64Of(staple: VoteStaple): string {
	return(Buffer.from(staple.toBytes()).toString('base64'));
}

describe('a node following the main network', function() {
	test('applies every staple of the first page its first representative serves, in the order it serves them', async function() {
		const staples = await servedPage();
		expect(staples.findIndex(function(staple): boolean {
			return(staple.blocksHash.toString() === GENESIS_BLOCKS_HASH);
		})).toBe(4);
		const serving = await startServingPeer();
		// Applied long before the node begins, so that one pass reads them all.
		serving.apply(staples, new Date(Date.now() - 2 * BOOTSTRAP_MARGIN_MILLISECONDS));
		const follower = await sdkNodes.start(await followerOf('memory', serving.apiURL));

		// The update the node ran as it started is ahead of this one in the queue.
		expect(await clientOf(follower.node.bootstrap).update()).toEqual({ complete: true });

		const missing: string[] = [];
		for (const staple of staples) {
			if (await follower.node.ledger.getVoteStaple(staple.blocksHash, 'main') === null) {
				missing.push(staple.blocksHash.toString());
			}
		}
		expect(missing).toEqual([]);
	});

	/*
	 * A representative leaves out each staple whose bytes, as it holds them,
	 * the filter names [Keeta TS] index.js:69686-69690. Those of the main
	 * network were compressed by whoever made them, and no rebuild from their
	 * votes and blocks gives the same bytes, so the node names what it holds
	 * by the bytes it received.
	 */
	test.each(STORAGES_UNDER_TEST)('names the staples it holds by the bytes the representative serves, so that reading them again downloads none of them (%s)', async function(storage: StorageUnderTest) {
		const staples = await servedPage();
		const serving = await startServingPeer();
		// Within the margin, which the next update reads again.
		serving.apply(staples, new Date(Date.now() - BOOTSTRAP_MARGIN_MILLISECONDS / 2));
		const follower = await sdkNodes.start(await followerOf(storage, serving.apiURL));
		const client = clientOf(follower.node.bootstrap);
		expect(await client.update()).toEqual({ complete: true });
		const distinct = new Set(staples.map(base64Of));
		const rebuilt = staples.filter(function(staple): boolean {
			return(distinct.has(base64Of(lib.Vote.Staple.fromVotesAndBlocks(staple.votes, staple.blocks))));
		});
		const held = (await follower.node.ledger.getVoteStaplesAfter(new Date(0), 1000)).map(base64Of);

		const afterCatchUp = serving.served();
		expect(await client.update()).toEqual({ complete: true });
		const afterMargin = serving.served();
		await client.resetKV();
		expect(await client.update()).toEqual({ complete: true });

		expect(rebuilt).toEqual([]);
		expect({
			heldAsServed: held.filter(function(bytes): boolean {
				return(distinct.has(bytes));
			}).length,
			downloadedAgainOverTheMargin: afterMargin - afterCatchUp,
			downloadedAgainFromTheBeginning: serving.served() - afterMargin
		}).toEqual({ heldAsServed: distinct.size, downloadedAgainOverTheMargin: 0, downloadedAgainFromTheBeginning: 0 });
	});
});
