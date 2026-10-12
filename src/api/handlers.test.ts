import { afterEach, describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Node, NodeConfig } from '@keetanetwork/keetanet-client/lib/node/index.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { requireAt } from '../ledger/storage/suite/support.js';
import { DEFAULT_PEER_LIMITS } from '../node/peer-limits.js';
import { createTestNetwork } from '../testing/network.js';
import type { TestNetwork } from '../testing/network.js';
import { assertNever } from '../util/assert-never.js';
import { API_ROUTES, invokeRoute } from './index.js';
import type { APIRequest, Route, RoutePath } from './index.js';

const lib = KeetaNet.lib;

afterEach(function() {
	vi.restoreAllMocks();
});

const ENDPOINTS = { api: 'https://rep.invalid/api', p2p: 'wss://rep.invalid/p2p' };

/**
 * How a node is configured to name itself to clients. Every node holds a key,
 * as its ledger is always a representative's [Keeta TS] index.js:71334-71346,
 * 70245-70248, and a representative node's switch fails to list peers
 * without both endpoints [Keeta TS] index.js:73496-73513, so only a
 * participant can lack either endpoint.
 */
type Identity =
	| { readonly kind: 'representative' }
	| { readonly kind: 'participant'; readonly endpoints: NodeConfig['endpoints'] };

/** A node of the network that is never run, configured with the identity given. */
function nodeWith(network: TestNetwork, identity: Identity): Node {
	const config: NodeConfig = { ...network.nodeConfig(new MemoryLedgerStorage(), requireAt(network.representatives, 0)), endpoints: ENDPOINTS };
	switch (identity.kind) {
		case 'representative':
			break;
		case 'participant':
			config.kind = lib.Node.Kind.PARTICIPANT;
			delete config.endpoints;
			if (identity.endpoints !== undefined) {
				config.endpoints = identity.endpoints;
			}
			break;
		default:
			assertNever(identity);
	}
	return(new lib.Node(config));
}

function requestTo(node: Node, query: APIRequest['query'] = {}): APIRequest {
	return({
		node,
		params: {},
		query,
		payload: undefined,
		peerLimits: DEFAULT_PEER_LIMITS,
		header: {
			get: function(): undefined {
				return(undefined);
			}
		}
	});
}

function routeAt(path: RoutePath): Route {
	const route = API_ROUTES.find(function(candidate): boolean {
		return(candidate.method === 'GET' && candidate.path === path);
	});
	if (route === undefined) {
		throw(new Error(`no route serves GET ${path}`));
	}
	return(route);
}

describe('the representatives a node names', function() {
	test.each([
		{ name: 'a representative', identity: { kind: 'representative' }, listed: true },
		{ name: 'a participant with both endpoints', identity: { kind: 'participant', endpoints: ENDPOINTS }, listed: true },
		{ name: 'a participant with no endpoints', identity: { kind: 'participant', endpoints: undefined }, listed: false },
		{ name: 'a participant with only an API endpoint', identity: { kind: 'participant', endpoints: { api: ENDPOINTS.api } }, listed: false },
		{ name: 'a participant with only a peer-to-peer endpoint', identity: { kind: 'participant', endpoints: { p2p: ENDPOINTS.p2p } }, listed: false }
	] satisfies readonly { readonly name: string; readonly identity: Identity; readonly listed: boolean }[])('include itself only with both endpoints to be reached at: $name', async function({ identity, listed }) {
		const network = await createTestNetwork({ representativeWeights: [1n] });
		const answer = await invokeRoute(routeAt('/node/ledger/representatives'), requestTo(nodeWith(network, identity)));

		const representatives: unknown[] = [];
		if (listed) {
			representatives.push({ representative: requireAt(network.representatives, 0).publicKeyString.get(), weight: 0n, endpoints: ENDPOINTS });
		}
		expect(answer).toEqual({ representatives });
	});
});

describe('a bootstrap page', function() {
	test('from a moment no date is read from fails, naming the text', async function() {
		const network = await createTestNetwork({ representativeWeights: [1n] });
		const answer = invokeRoute(routeAt('/node/bootstrap/votes'), requestTo(nodeWith(network, { kind: 'representative' }), { start: 'yesterday' }));

		await expect(answer).rejects.toThrow('Invalid start: yesterday');
	});
});

describe('the peers a node lists', function() {
	test('a representative peer whose signature is empty fails, naming what it lacks', async function() {
		const network = await createTestNetwork({ representativeWeights: [1n] });
		const node = nodeWith(network, { kind: 'representative' });
		vi.spyOn(node.switch, 'peers').mockResolvedValue([{ kind: lib.Node.Kind.REPRESENTATIVE, key: requireAt(network.representatives, 0), endpoints: ENDPOINTS, preferUpdates: 'http', signature: new ArrayBuffer(0) }]);

		await expect(invokeRoute(routeAt('/node/peers'), requestTo(node))).rejects.toThrow('internal error: signature is required');
	});
});
