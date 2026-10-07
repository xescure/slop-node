import { describe, expect, test } from 'vitest';
import { documentPathOf } from '../conformance/api/routes.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { DEFAULT_PEER_LIMITS } from '../node/peer-limits.js';
import { createTestNetwork } from '../testing/network.js';
import { defineGET, definePOST, invokeRoute, routeTable } from './index.js';
import type { APIRequest, Route } from './index.js';

async function requestWith(parts: Pick<APIRequest, 'params' | 'payload'>): Promise<APIRequest> {
	const network = await createTestNetwork({ representativeWeights: [1n] });
	const representative = network.representatives[0];
	if (representative === undefined) {
		throw(new Error('the network has no representative'));
	}
	return({
		node: network.createNode(new MemoryLedgerStorage(), representative),
		query: {},
		peerLimits: DEFAULT_PEER_LIMITS,
		header: {
			get: function(): undefined {
				return(undefined);
			}
		},
		...parts
	});
}

function spelled(route: Route): string {
	return(`${route.method} ${route.path}`);
}

describe('a route definition', function() {
	test('a GET handler gets the path parameters in path order', async function() {
		const route = defineGET('/node/ledger/account/:account/acl/:entityList', function(_request, account, entityList) {
			return(Promise.resolve({ account, entityList }));
		});
		expect(route.parameterNames).toEqual(['account', 'entityList']);
		const request = await requestWith({ params: { entityList: 'B,C', account: 'A' }, payload: undefined });
		expect(await invokeRoute(route, request)).toEqual({ account: 'A', entityList: 'B,C' });
	});

	test('a POST handler gets the body, then the path parameters', async function() {
		const route = definePOST('/vote/:blockhash', function(_request, payload, blockhash) {
			return(Promise.resolve({ payload, blockhash }));
		});
		const request = await requestWith({ params: { blockhash: 'AB' }, payload: { blocks: [] } });
		expect(await invokeRoute(route, request)).toEqual({ payload: { blocks: [] }, blockhash: 'AB' });
	});

	test('a request without a parameter its route names is refused before the handler runs', async function() {
		let ran = false;
		const route = defineGET('/vote/:blockhash', function() {
			ran = true;
			return(Promise.resolve({}));
		});
		await expect(invokeRoute(route, await requestWith({ params: {}, payload: undefined }))).rejects.toThrow('blockhash');
		expect(ran).toBe(false);
	});
});

describe('the route table', function() {
	const respond = function(): Promise<object> {
		return(Promise.resolve({}));
	};

	test('a fixed segment is matched before a parameter in the same place', function() {
		const table = routeTable([
			[defineGET('/node/ledger/account/:account/acl/:entityList', respond)],
			[defineGET('/node/ledger/account/:account/acl/granted', respond), defineGET('/node/ledger/account/:account', respond)]
		]);
		expect(table.map(spelled)).toEqual([
			'GET /node/ledger/account/:account',
			'GET /node/ledger/account/:account/acl/granted',
			'GET /node/ledger/account/:account/acl/:entityList'
		]);
	});

	test('a route listed twice is refused', function() {
		expect(function() {
			return(routeTable([[defineGET('/node/version', respond)], [defineGET('/node/version', respond)]]));
		}).toThrow('GET /node/version');
	});

	test('two routes that differ only in a parameter name are refused', function() {
		expect(function() {
			return(routeTable([[defineGET('/vote/:blockhash', respond), defineGET('/vote/:hash', respond)]]));
		}).toThrow('/vote/:hash');
	});

	test('a route path is written in the document with its parameters in braces, below /api', function() {
		expect(documentPathOf('/node/ledger/account/:account/balance/:token')).toBe('/api/node/ledger/account/{account}/balance/{token}');
	});
});
