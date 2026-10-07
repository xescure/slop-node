import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { documentRoutes, routeOfRequest, routesOfTypings } from './routes.js';
import type { Route } from './routes.js';

const TYPINGS_FILE = createRequire(import.meta.url).resolve('@keetanetwork/keetanet-client/api/index.d.ts');
const DOCUMENT_FILE = new URL('../../../api/openapi.json', import.meta.url);

function spelled(routes: readonly Route[]): readonly string[] {
	return(routes.map(function({ method, path }): string {
		return(`${method} ${path}`);
	}));
}

describe('the route-tree extractor', function() {
	test('maps _root to its parent, :name segments to {name} and keeps methods beside children', function() {
		const typings = `
			declare const rootTree: {
				vote: {
					_root: { POST: (request: APIRequest) => Promise<object>; };
					':blockhash': { GET: (request: APIRequest, blockhash: string) => Promise<object>; };
				};
				node: {
					acl: {
						GET: (request: APIRequest) => Promise<object>;
						':entityList': { GET: (request: APIRequest) => Promise<object>; };
					};
				};
			};
		`;

		expect(spelled(routesOfTypings(typings))).toEqual([
			'GET /api/node/acl',
			'GET /api/node/acl/{entityList}',
			'POST /api/vote',
			'GET /api/vote/{blockhash}'
		]);
	});

	test('refuses a leaf that is neither a method nor a subtree', function() {
		const typings = 'declare const rootTree: { node: { PATCH: () => Promise<object>; }; };';

		expect(function() {
			return(routesOfTypings(typings));
		}).toThrow('/api/node: PATCH is neither an HTTP method nor a subtree');
	});

	test('refuses a route reached both through _root and directly', function() {
		const typings = `
			declare const rootTree: {
				node: {
					GET: (request: APIRequest) => Promise<object>;
					_root: { GET: (request: APIRequest) => Promise<object>; };
				};
			};
		`;

		expect(function() {
			return(routesOfTypings(typings));
		}).toThrow('GET /api/node is listed twice');
	});

	test('refuses typings without the route tree', function() {
		expect(function() {
			return(routesOfTypings('declare const otherTree: {};'));
		}).toThrow('no rootTree declaration');
	});
});

describe('the route of a request path', function() {
	const routes: readonly Route[] = [
		{ method: 'GET', path: '/api/node/ledger/account/{account}/acl/{entityList}' },
		{ method: 'GET', path: '/api/node/ledger/account/{account}/acl/granted' },
		{ method: 'GET', path: '/api/node/ledger/account/{account}' },
		{ method: 'POST', path: '/api/vote' },
		{ method: 'GET', path: '/api/vote/{blockhash}' }
	];

	test('fills a parameter with any segment', function() {
		expect(routeOfRequest(routes, 'GET', '/api/node/ledger/account/keeta_x')).toEqual(routes[2]);
	});

	test('prefers a literal segment to a parameter, as a router does', function() {
		expect(routeOfRequest(routes, 'GET', '/api/node/ledger/account/keeta_x/acl/granted')).toEqual(routes[1]);
		expect(routeOfRequest(routes, 'GET', '/api/node/ledger/account/keeta_x/acl/keeta_y')).toEqual(routes[0]);
	});

	test('refuses a path that no route of the method serves', function() {
		expect(function() {
			return(routeOfRequest(routes, 'GET', '/api/vote'));
		}).toThrow('no route serves GET /api/vote');
		expect(function() {
			return(routeOfRequest(routes, 'GET', '/api/node/ledger/account/'));
		}).toThrow('no route serves GET /api/node/ledger/account/');
	});

	test('refuses a path two routes serve equally well', function() {
		const ambiguous: readonly Route[] = [
			{ method: 'GET', path: '/api/{a}/x' },
			{ method: 'GET', path: '/api/x/{b}' }
		];

		expect(function() {
			return(routeOfRequest(ambiguous, 'GET', '/api/x/x'));
		}).toThrow('GET /api/x/x is served by both /api/x/{b} and /api/{a}/x');
	});
});

describe('the API document', function() {
	test('the document covers exactly the routes of the typings', function() {
		const typed = spelled(routesOfTypings(readFileSync(TYPINGS_FILE, 'utf8')));
		const documented = spelled(documentRoutes(JSON.parse(readFileSync(DOCUMENT_FILE, 'utf8'))));

		expect(typed.length).toBeGreaterThan(0);
		expect(documented).toEqual(typed);
	});
});
