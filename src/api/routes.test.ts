import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { documentRoutes, routesOfTypings } from './routes.js';
import type { Route } from './routes.js';

const TYPINGS_FILE = createRequire(import.meta.url).resolve('@keetanetwork/keetanet-client/api/index.d.ts');
const DOCUMENT_FILE = new URL('../../api/openapi.json', import.meta.url);

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

describe('the API document', function() {
	test('the document covers exactly the routes of the typings', function() {
		const typed = spelled(routesOfTypings(readFileSync(TYPINGS_FILE, 'utf8')));
		const documented = spelled(documentRoutes(JSON.parse(readFileSync(DOCUMENT_FILE, 'utf8'))));

		expect(typed.length).toBeGreaterThan(0);
		expect(documented).toEqual(typed);
	});
});
