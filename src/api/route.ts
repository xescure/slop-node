import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { PeerLimits } from '../node/peer-limits.js';
import { assertNever } from '../util/assert-never.js';
import { compareText } from '../util/compare-text.js';

/**
 * One request as a handler sees it: the node it runs on, its path and query
 * parameters, its parsed body and its headers. The shape is upstream's
 * APIRequest (api/index.d.ts), with the body unknown until a handler checks it,
 * and with the limits of the node that serves it, which the copy of the node a
 * request runs on does not carry.
 * [node-lite] adapted from its APIRequest.
 */
export type APIRequest = {
	readonly node: Node;
	readonly params: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string>>;
	readonly payload: unknown;
	readonly header: {
		get(name: string): string | undefined;
	};
	readonly peerLimits: PeerLimits;
};

/** A path below the API prefix, with each path parameter written ":name". */
export type RoutePath = `/${string}`;

/** One string per path parameter, in path order. */
export type ParameterValues<Path extends string> =
	Path extends `${string}/:${string}/${infer Rest}` ? [string, ...ParameterValues<`/${Rest}`>] :
		Path extends `${string}/:${string}` ? [string] : [];

/** The methods the API document uses; upstream's typings also allow PUT and DELETE, which no route has. */
export type RouteMethod = 'GET' | 'POST';

/**
 * Whether the node a request ran on is synced before the request is
 * answered. A route that peers post to is not: syncing waits for the node's
 * pending sends to peers [Keeta TS] index.js:72505-72511, 73825-73831, among
 * them its own posts to the peer that is waiting for this answer, so two
 * nodes posting to each other would each wait for the other.
 */
export type RouteSync = 'before-answer' | 'none';

/**
 * A route as the table dispatches it. GET handlers get the path parameters in
 * path order, and POST handlers the body first (api/index.d.ts, rootTree).
 */
export type Route =
	| {
		readonly method: 'GET';
		readonly path: RoutePath;
		readonly parameterNames: readonly string[];
		readonly sync: RouteSync;
		readonly handler: (request: APIRequest, parameters: readonly string[]) => Promise<unknown>;
	}
	| {
		readonly method: 'POST';
		readonly path: RoutePath;
		readonly parameterNames: readonly string[];
		readonly sync: RouteSync;
		readonly handler: (request: APIRequest, payload: unknown, parameters: readonly string[]) => Promise<unknown>;
	};

function isParameterSegment(segment: string): boolean {
	return(segment.startsWith(':'));
}

function parameterNamesOf(path: RoutePath): readonly string[] {
	return(path.split('/').filter(isParameterSegment).map(function(segment): string {
		return(segment.slice(1));
	}));
}

/**
 * The values of the path's parameters, as the handler's type counts them from
 * the same path.
 */
function valuesFor<const Path extends RoutePath>(path: Path, values: readonly string[]): ParameterValues<Path> {
	const names = parameterNamesOf(path);
	if (values.length !== names.length) {
		throw(new Error(`${path} names ${String(names.length)} parameters, not ${String(values.length)}`));
	}
	// The type counts the parameters from the same path that the length was just checked against.
	return([...values] as ParameterValues<Path>);
}

/** A GET route, its handler typed by the parameters its path names. */
export function defineGET<const Path extends RoutePath>(path: Path, handler: (request: APIRequest, ...parameters: ParameterValues<Path>) => Promise<unknown>): Route {
	return({
		method: 'GET',
		path,
		parameterNames: parameterNamesOf(path),
		sync: 'before-answer',
		handler: function(request, parameters) {
			return(handler(request, ...valuesFor(path, parameters)));
		}
	});
}

/** A POST route, its handler typed by the parameters its path names. */
export function definePOST<const Path extends RoutePath>(path: Path, handler: (request: APIRequest, payload: unknown, ...parameters: ParameterValues<Path>) => Promise<unknown>, sync: RouteSync = 'before-answer'): Route {
	return({
		method: 'POST',
		path,
		parameterNames: parameterNamesOf(path),
		sync,
		handler: function(request, payload, parameters) {
			return(handler(request, payload, ...valuesFor(path, parameters)));
		}
	});
}

function parameterValues(route: Route, request: APIRequest): string[] {
	return(route.parameterNames.map(function(name): string {
		const value = request.params[name];
		if (value === undefined) {
			throw(new Error(`${route.method} ${route.path} was dispatched without its "${name}" parameter`));
		}
		return(value);
	}));
}

/** Runs the route's handler with the arguments its method gives it. [node-lite] adapted from its dispatch. */
export async function invokeRoute(route: Route, request: APIRequest): Promise<unknown> {
	const parameters = parameterValues(route, request);
	switch (route.method) {
		case 'GET':
			return(await route.handler(request, parameters));
		case 'POST':
			return(await route.handler(request, request.payload, parameters));
		default:
			return(assertNever(route));
	}
}

/** How a segment sorts for matching: a fixed segment before any parameter. */
function segmentRank(segment: string): readonly [number, string] {
	if (isParameterSegment(segment)) {
		return([1, '']);
	}
	return([0, segment]);
}

/**
 * Orders paths so that, of two that can both serve a request, the one with a
 * fixed segment where the other has a parameter comes first; the router tries
 * routes in the order they are added.
 */
function compareForMatching(left: Route, right: Route): number {
	const leftSegments = left.path.split('/');
	const rightSegments = right.path.split('/');
	const shared = Math.min(leftSegments.length, rightSegments.length);
	for (let index = 0; index < shared; index++) {
		const [leftKind, leftText] = segmentRank(leftSegments[index] ?? '');
		const [rightKind, rightText] = segmentRank(rightSegments[index] ?? '');
		if (leftKind !== rightKind) {
			return(leftKind - rightKind);
		}
		const byText = compareText(leftText, rightText);
		if (byText !== 0) {
			return(byText);
		}
	}
	if (leftSegments.length !== rightSegments.length) {
		return(leftSegments.length - rightSegments.length);
	}
	return(compareText(left.method, right.method));
}

/** The method and path a route matches, whatever its parameters are named. */
function matchKey(route: Route): string {
	return(`${route.method} ${route.path.split('/').map(function(segment): string {
		return(segmentRank(segment).join(':'));
	}).join('/')}`);
}

/**
 * A colon that no backslash escapes, which the router Express uses reads as
 * the start of a parameter wherever it stands in a segment.
 */
const UNESCAPED_COLON = /(?:^|[^\\])(?:\\\\)*:/;

/** Whether a segment holds a parameter that does not start it, which the table could not rank as one. */
function holdsInnerParameter(segment: string): boolean {
	let rest = segment;
	if (isParameterSegment(segment)) {
		rest = segment.slice(1);
	}
	return(UNESCAPED_COLON.test(rest));
}

/**
 * The routes of every group, in the order they are to be added to the router,
 * refusing a route with a parameter inside a segment, and two routes that
 * match the same requests.
 */
export function routeTable(groups: readonly (readonly Route[])[]): readonly Route[] {
	const routes = groups.flat().sort(compareForMatching);
	const seen = new Map<string, Route>();
	for (const route of routes) {
		const inner = route.path.split('/').find(holdsInnerParameter);
		if (inner !== undefined) {
			throw(new Error(`${route.method} ${route.path} has a parameter inside its segment "${inner}"`));
		}
		const key = matchKey(route);
		const earlier = seen.get(key);
		if (earlier !== undefined) {
			throw(new Error(`${route.method} ${route.path} matches the same requests as ${earlier.method} ${earlier.path}`));
		}
		seen.set(key, route);
	}
	return(routes);
}
