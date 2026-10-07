import ts from 'typescript';

/** The methods a handler mapping may name [Keeta TS] api/index.d.ts (HandlerMapping). */
const HTTP_METHODS = ['GET', 'PUT', 'POST', 'DELETE'] as const;

export type HTTPMethod = typeof HTTP_METHODS[number];

/** One route the node serves: a method on a path, with parameters spelled {name}. */
export type Route = {
	readonly method: HTTPMethod;
	readonly path: string;
};

/** Every route is served below this path [Keeta TS] index.js:61390. */
const API_BASE = '/api';

/** The tree key that stands for the subtree's own path rather than a segment of it. */
const OWN_PATH_KEY = '_root';

/** The keys of an OpenAPI path item that name operations; the rest describe the path. */
const OPENAPI_OPERATION_KEYS: ReadonlySet<string> = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function asHTTPMethod(name: string): HTTPMethod | undefined {
	return(HTTP_METHODS.find(function(method): boolean {
		return(method === name);
	}));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** Orders by UTF-16 code units, so the order does not depend on the locale. */
function compareText(left: string, right: string): number {
	if (left < right) {
		return(-1);
	}
	if (left > right) {
		return(1);
	}
	return(0);
}

function compareRoutes(left: Route, right: Route): number {
	const byPath = compareText(left.path, right.path);
	if (byPath !== 0) {
		return(byPath);
	}
	return(compareText(left.method, right.method));
}

/** Routes in one canonical order, refusing a route listed twice. */
function canonicalRoutes(routes: readonly Route[]): readonly Route[] {
	const sorted = [...routes].sort(compareRoutes);
	for (const [index, route] of sorted.entries()) {
		const previous = sorted[index - 1];
		if (previous !== undefined && compareRoutes(previous, route) === 0) {
			throw(new Error(`${route.method} ${route.path} is listed twice`));
		}
	}
	return(sorted);
}

function propertyName(name: ts.PropertyName): string {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
		return(name.text);
	}
	throw(new Error(`unexpected property name ${name.getText()}`));
}

function childPath(path: string, key: string): string {
	if (key === OWN_PATH_KEY) {
		return(path);
	}
	if (key.startsWith(':')) {
		return(`${path}/{${key.slice(1)}}`);
	}
	return(`${path}/${key}`);
}

function collectRoutes(tree: ts.TypeLiteralNode, path: string, routes: Route[]): void {
	for (const member of tree.members) {
		if (!ts.isPropertySignature(member) || member.type === undefined) {
			throw(new Error(`${path}: unexpected member ${member.getText()}`));
		}
		const key = propertyName(member.name);
		const method = asHTTPMethod(key);
		if (method !== undefined && ts.isFunctionTypeNode(member.type)) {
			routes.push({ method, path });
			continue;
		}
		if (method !== undefined || !ts.isTypeLiteralNode(member.type)) {
			throw(new Error(`${path}: ${key} is neither an HTTP method nor a subtree`));
		}
		collectRoutes(member.type, childPath(path, key), routes);
	}
}

function rootTreeType(source: ts.SourceFile): ts.TypeLiteralNode {
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) {
			continue;
		}
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'rootTree') {
				continue;
			}
			if (declaration.type === undefined || !ts.isTypeLiteralNode(declaration.type)) {
				throw(new Error('rootTree is not declared with an object type'));
			}
			return(declaration.type);
		}
	}
	throw(new Error('no rootTree declaration'));
}

/**
 * The routes of the "rootTree" declared by upstream's API typings
 * (api/index.d.ts), read from the declaration's syntax: the tree is declared
 * with its literal type, so no type checking is needed to walk it.
 */
export function routesOfTypings(typings: string): readonly Route[] {
	const source = ts.createSourceFile('index.d.ts', typings, ts.ScriptTarget.Latest, true);
	const routes: Route[] = [];
	collectRoutes(rootTreeType(source), API_BASE, routes);
	return(canonicalRoutes(routes));
}

function isParameterSegment(segment: string): boolean {
	return(segment.startsWith('{') && segment.endsWith('}'));
}

/** How many literal segments of the route match the path's, or undefined when the route does not serve the path. */
function literalMatches(route: Route, segments: readonly string[]): number | undefined {
	const template = route.path.split('/');
	if (template.length !== segments.length) {
		return(undefined);
	}
	let literals = 0;
	for (const [index, part] of template.entries()) {
		const segment = segments[index];
		if (segment === undefined) {
			return(undefined);
		}
		if (isParameterSegment(part)) {
			if (segment === '') {
				return(undefined);
			}
			continue;
		}
		if (part !== segment) {
			return(undefined);
		}
		literals++;
	}
	return(literals);
}

/**
 * The route that serves a request path, with parameters still encoded. Where
 * a literal segment and a parameter both fit, as "granted" and {entityList}
 * do, the literal wins, as in a router that tries fixed paths first.
 */
export function routeOfRequest(routes: readonly Route[], method: HTTPMethod, path: string): Route {
	const segments = path.split('/');
	let best: { readonly route: Route; readonly literals: number } | undefined;
	let tied: Route | undefined;
	for (const route of canonicalRoutes(routes)) {
		if (route.method !== method) {
			continue;
		}
		const literals = literalMatches(route, segments);
		if (literals === undefined) {
			continue;
		}
		if (best === undefined || literals > best.literals) {
			best = { route, literals };
			tied = undefined;
		} else if (literals === best.literals) {
			tied = route;
		}
	}
	if (best === undefined) {
		throw(new Error(`no route serves ${method} ${path}`));
	}
	if (tied !== undefined) {
		throw(new Error(`${method} ${path} is served by both ${best.route.path} and ${tied.path}`));
	}
	return(best.route);
}

/** The routes an OpenAPI document describes, from its operations under "paths". */
export function documentRoutes(document: unknown): readonly Route[] {
	if (!isRecord(document) || !isRecord(document['paths'])) {
		throw(new Error('the document has no "paths" object'));
	}
	const routes: Route[] = [];
	for (const [path, item] of Object.entries(document['paths'])) {
		if (!isRecord(item)) {
			throw(new Error(`${path}: the path item is not an object`));
		}
		for (const key of Object.keys(item).filter(function(name): boolean {
			return(OPENAPI_OPERATION_KEYS.has(name));
		})) {
			const method = asHTTPMethod(key.toUpperCase());
			if (method === undefined) {
				throw(new Error(`${path}: the node API has no ${key.toUpperCase()} method`));
			}
			routes.push({ method, path });
		}
	}
	return(canonicalRoutes(routes));
}
