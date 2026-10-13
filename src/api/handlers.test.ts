import { afterEach, describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Node, NodeConfig } from '@keetanetwork/keetanet-client/lib/node/index.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { requireAt } from '../ledger/storage/suite/support.js';
import { DEFAULT_PEER_LIMITS } from '../node/peer-limits.js';
import { createTestNetwork } from '../testing/network.js';
import type { TestNetwork } from '../testing/network.js';
import { assertNever } from '../util/assert-never.js';
import { API_ROUTES, defineGET, invokeRoute } from './index.js';
import type { APIRequest, Route, RoutePath } from './index.js';

const lib = KeetaNet.lib;

afterEach(function() {
	vi.restoreAllMocks();
});

const ENDPOINTS = { api: 'https://rep.invalid/api', p2p: 'wss://rep.invalid/p2p' };

/**
 * How a node is configured to name itself to clients. A representative
 * node's switch fails to list peers without both endpoints and a key
 * [Keeta TS] index.js:74644-74664, so only a participant can lack one.
 */
type Identity =
	| { readonly kind: 'representative' }
	| { readonly kind: 'participant'; readonly key: 'held' | 'none'; readonly endpoints: NodeConfig['endpoints'] };

/**
 * A node of the network that is never run, configured with the identity
 * given. The node is built with a key, as this upstream builds every node's
 * ledger as a representative's, which refuses to exist without one, until it
 * computes the ledger kind from the node kind [Keeta TS] index.js:72462-72474,
 * 71281-71284; a participant without a key has it taken from its
 * configuration afterwards.
 */
function nodeWith(network: TestNetwork, identity: Identity): Node {
	const config: NodeConfig = { ...network.nodeConfig(new MemoryLedgerStorage(), requireAt(network.representatives, 0)), endpoints: ENDPOINTS };
	switch (identity.kind) {
		case 'representative':
			return(new lib.Node(config));
		case 'participant': {
			config.kind = lib.Node.Kind.PARTICIPANT;
			delete config.endpoints;
			if (identity.endpoints !== undefined) {
				config.endpoints = identity.endpoints;
			}
			const node = new lib.Node(config);
			if (identity.key === 'none') {
				const keyless: NodeConfig = { ...config };
				delete keyless.ledgerPrivateKey;
				node.config = keyless;
			}
			return(node);
		}
		default:
			return(assertNever(identity));
	}
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
		{ name: 'a participant with no key', identity: { kind: 'participant', key: 'none', endpoints: ENDPOINTS }, listed: false },
		{ name: 'a participant with no endpoints', identity: { kind: 'participant', key: 'held', endpoints: undefined }, listed: false },
		{ name: 'a participant with only an API endpoint', identity: { kind: 'participant', key: 'held', endpoints: { api: ENDPOINTS.api } }, listed: false },
		{ name: 'a participant with only a peer-to-peer endpoint', identity: { kind: 'participant', key: 'held', endpoints: { p2p: ENDPOINTS.p2p } }, listed: false }
	] satisfies readonly { readonly name: string; readonly identity: Identity; readonly listed: boolean }[])('include itself only with a key and both endpoints: $name', async function({ identity, listed }) {
		const network = await createTestNetwork({ representativeWeights: [1n] });
		const answer = await invokeRoute(routeAt('/node/ledger/representatives'), requestTo(nodeWith(network, identity)));

		const representatives: unknown[] = [];
		if (listed) {
			representatives.push({ representative: requireAt(network.representatives, 0).publicKeyString.get(), weight: 0n, endpoints: ENDPOINTS });
		}
		expect(answer).toEqual({ representatives });
	});
});

describe('the node\'s own representative', function() {
	test('is refused when the node has no key', async function() {
		const network = await createTestNetwork({ representativeWeights: [1n] });
		const answer = invokeRoute(routeAt('/node/ledger/representative'), requestTo(nodeWith(network, { kind: 'participant', key: 'none', endpoints: ENDPOINTS })));

		await expect(answer).rejects.toMatchObject({ type: 'API', code: 'API_REP_MISSING', message: 'This node has no representative' });
	});
});

describe('a handler', function() {
	test('is refused a parameter count other than its path names', async function() {
		const network = await createTestNetwork({ representativeWeights: [1n] });
		const route = defineGET('/vote/:blockhash', function() {
			return(Promise.resolve({}));
		});

		if (route.method !== 'GET') {
			throw(new Error('the route is a GET'));
		}
		const request = requestTo(nodeWith(network, { kind: 'representative' }));

		expect(function() {
			return(route.handler(request, []));
		}).toThrow('/vote/:blockhash names 1 parameters, not 0');
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
