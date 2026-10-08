import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { startServingPeer } from '../testing/bootstrap-peers.js';
import { TEST_NETWORK_SEEDS } from '../testing/network.js';
import { useSDKNodes } from '../testing/sdk.js';
import type { BootstrapClient } from './bootstrap.js';
import { BOOTSTRAP_MARGIN_MILLISECONDS } from './bootstrap-window.js';

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

describe('a node following the main network', function() {
	test('applies every staple of the first page its first representative serves, in the order it serves them', async function() {
		const staples = await servedPage();
		expect(staples.findIndex(function(staple): boolean {
			return(staple.blocksHash.toString() === GENESIS_BLOCKS_HASH);
		})).toBe(4);
		const serving = await startServingPeer();
		// Applied long before the node begins, so that one pass reads them all.
		serving.apply(staples, new Date(Date.now() - 2 * BOOTSTRAP_MARGIN_MILLISECONDS));
		const follower = await sdkNodes.start({
			KEETANET_LOCAL_NODE_NETWORK: 'main',
			KEETANET_LOCAL_NODE_SEED: TEST_NETWORK_SEEDS.representative,
			KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'bootstrap-only',
			KEETANET_LOCAL_NODE_LISTEN_IP: '127.0.0.1',
			KEETANET_LOCAL_NODE_LISTEN_PORT: '0',
			KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: serving.apiURL,
			KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: '0'
		});

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
});
