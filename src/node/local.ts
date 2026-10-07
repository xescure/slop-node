import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Express, NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BootstrapClient } from '@keetanetwork/keetanet-client/lib/bootstrap.js';
import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { LocalNode as DeclaredLocalNode, LocalNodeConfig } from '@keetanetwork/keetanet-client/lib/node/local.js';
import { answerError, ERROR_STATUS, newErrorID } from '../api/errors.js';
import type { ErrorBody } from '../api/errors.js';
import { API_ROUTES, invokeRoute, settleDeliveries } from '../api/index.js';
import type { APIRequest, Route } from '../api/index.js';
import { assertNever } from '../util/assert-never.js';
import type { AssertNever } from '../util/assert-never.js';
import type { ClassSurface } from '../util/class-surface.js';
import { LocalNodeError } from './errors.js';
import { P2P_PATH, PeerServer } from './peers.js';
import { close, listen } from './server.js';
import type { Listening, ListenTarget } from './server.js';

export type { ApiErrorResponse, LocalNodeConfig } from '@keetanetwork/keetanet-client/lib/node/local.js';

const lib = KeetaNet.lib;

/** The node of the client package, typed by its declaration so that the class built on it can be declared without inference. */
const ClientNode: typeof Node = lib.Node;

type RunOptions = Parameters<DeclaredLocalNode['run']>[0];

/** Where the API is served when the node advertises no endpoint of its own. */
const DEFAULT_API_PREFIX = '/api';

const LOG_SOURCE = 'API';

const SUCCESS_STATUS = 200;

/** A preflight is answered with headers alone, and with the status live representatives give it. */
const PREFLIGHT_STATUS = 200;

/**
 * Twice the largest message a peer may send over the WebSocket
 * [Keeta TS] index.js:71812, leaving room for the escaping of a message that
 * a peer posts over HTTP inside a JSON string.
 */
const REQUEST_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Browsers read a response from another origin only with these headers, and
 * send a preflight before any JSON POST.
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
	'access-control-allow-headers': 'content-type, user-agent, accept',
	'access-control-max-age': '86400'
};

/** Addresses that stand for every interface, which peers cannot be sent to. */
const UNSPECIFIED_ADDRESSES: ReadonlySet<string> = new Set(['0.0.0.0', '::', '']);

type Answer = { readonly status: number; readonly body: unknown };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/**
 * The first string of each query parameter; a parameter repeated or written
 * with brackets carries no further meaning to any route.
 * [node-lite] adapted from queryStrings.
 */
const BODY_PARSE_FAILED = 'entity.parse.failed';

/**
 * The body is attached to the error body-parser raises for text that is no
 * JSON, and V8's message may quote the start of it, so neither is logged: the
 * log records how long the body was and what the parser expected.
 */
function bodyParseFailure(error: unknown): Error | undefined {
	if (!(error instanceof Error) || !('type' in error) || error.type !== BODY_PARSE_FAILED || !('body' in error) || typeof error.body !== 'string') {
		return(undefined);
	}
	const expectation = error.message.replace(/(?:, )?".*" is not valid JSON/s, 'the body is not valid JSON');
	return(new SyntaxError(`a request body of ${String(error.body.length)} characters is no JSON: ${expectation}`));
}

function queryStrings(query: unknown): Readonly<Record<string, string>> {
	const strings: Record<string, string> = {};
	if (!isRecord(query)) {
		return(strings);
	}
	for (const [name, value] of Object.entries(query)) {
		if (typeof value === 'string') {
			strings[name] = value;
		} else if (Array.isArray(value) && typeof value[0] === 'string') {
			strings[name] = value[0];
		}
	}
	return(strings);
}

/** [node-lite] adapted from paramStrings. */
function parameterStrings(params: unknown): Readonly<Record<string, string>> {
	const strings: Record<string, string> = {};
	if (!isRecord(params)) {
		return(strings);
	}
	for (const [name, value] of Object.entries(params)) {
		if (typeof value === 'string') {
			strings[name] = value;
		}
	}
	return(strings);
}

function apiRequest(node: Node, request: ExpressRequest): APIRequest {
	const payload: unknown = request.body;
	return({
		node,
		params: parameterStrings(request.params),
		query: queryStrings(request.query),
		payload,
		header: {
			get: function(name: string): string | undefined {
				return(request.get(name));
			}
		}
	});
}

function parseEndpoint(endpoint: string): URL {
	try {
		return(new URL(endpoint));
	} catch (error) {
		throw(new LocalNodeError({ kind: 'invalid-endpoint', endpoint }, { cause: error }));
	}
}

function trimTrailingSlashes(path: string): string {
	return(path.replace(/\/+$/, ''));
}

/** A prefix as the router mounts it: "/" for the root, otherwise without a trailing slash. */
function normalizePrefix(prefix: string): string {
	const trimmed = trimTrailingSlashes(prefix);
	if (trimmed === '') {
		return('/');
	}
	return(trimmed);
}

/**
 * The client requests a route at the advertised API endpoint followed by the
 * route's path [Keeta TS] index.js:59584-59585, so the routes are served below
 * the endpoint's own path.
 */
function advertisedPrefix(apiEndpoint: string | undefined): string {
	if (apiEndpoint === undefined) {
		return(DEFAULT_API_PREFIX);
	}
	return(normalizePrefix(parseEndpoint(apiEndpoint).pathname));
}

function listenTarget(config: LocalNodeConfig): ListenTarget | undefined {
	const port = config.nodeOptions?.listenPort;
	if (port === undefined) {
		return(undefined);
	}
	return({ host: config.nodeOptions?.listenIP, port });
}

function isUnspecifiedAddress(host: string | undefined): boolean {
	return(host === undefined || UNSPECIFIED_ADDRESSES.has(host));
}

function needsAdvertising(config: LocalNodeConfig): boolean {
	return(config.endpoints?.api === undefined || config.endpoints.p2p === undefined);
}

function hostInURL(host: string): string {
	if (host.includes(':')) {
		return(`[${host}]`);
	}
	return(host);
}

/**
 * A representative that serves the node HTTP API, as declared by upstream's
 * typings (lib/node/local.d.ts) over the Node of the client package.
 * [node-lite] adapted from its LocalNode.
 */
export class LocalNode extends ClientNode {
	static override isInstance: (obj: unknown, strict?: boolean) => obj is LocalNode = lib.Utils.Helper.checkableGenerator(LocalNode);

	override config: LocalNodeConfig;
	readonly #app: Express = express();
	#mountedPrefix: string | undefined;
	#listening: Listening | undefined;
	#peers: PeerServer | undefined;
	#running = false;

	constructor(config: LocalNodeConfig) {
		super(config);
		this.config = config;
		// Outside production Express answers a failure that escapes every handler with its stack.
		this.#app.set('env', 'production');
	}

	setCorsHeaders(response: ExpressResponse): void {
		response.set(CORS_HEADERS);
	}

	/** Serves every route of the API below the prefix, once. */
	addRoutes(prefix: string = DEFAULT_API_PREFIX): void {
		const normalized = normalizePrefix(prefix);
		if (this.#mountedPrefix !== undefined) {
			if (this.#mountedPrefix === normalized) {
				return;
			}
			throw(new LocalNodeError({ kind: 'routes-already-mounted', mountedPrefix: this.#mountedPrefix, requestedPrefix: normalized }));
		}
		const router = express.Router();
		for (const route of API_ROUTES) {
			this.#addRoute(router, route);
		}
		// A body the parser refuses fails before any route runs.
		router.use((error: unknown, _ignoredRequest: ExpressRequest, response: ExpressResponse, _ignoredNext: NextFunction): void => {
			this.#send(response, this.#failure(bodyParseFailure(error) ?? error));
		});
		this.#app.use(normalized, router);
		this.#mountedPrefix = normalized;
	}

	#addRoute(router: express.Router, route: Route): void {
		const serve = (request: ExpressRequest, response: ExpressResponse): Promise<void> => {
			return(this.#serve(route, request, response));
		};
		router.options(route.path, (_ignoredRequest: ExpressRequest, response: ExpressResponse): void => {
			this.setCorsHeaders(response);
			response.status(PREFLIGHT_STATUS).end();
		});
		switch (route.method) {
			case 'GET':
				router.get(route.path, serve);
				return;
			case 'POST':
				router.post(route.path, express.json({ limit: REQUEST_BODY_LIMIT_BYTES }), serve);
				return;
			default:
				assertNever(route);
		}
	}

	/**
	 * Each request runs on a copy of the node, so that it has a ledger and
	 * request timing of its own, and the copy is synced afterwards, unless the
	 * node is told not to, so that the statistics and logs the request
	 * produced are written out before it is answered.
	 */
	async #serve(route: Route, request: ExpressRequest, response: ExpressResponse): Promise<void> {
		const node = this.copy();
		let answer: Answer;
		try {
			const result = await invokeRoute(route, apiRequest(node, request));
			answer = { status: SUCCESS_STATUS, body: lib.Utils.Conversion.toJSONSerializable(result, { addBinary: true }) };
		} catch (error) {
			answer = this.#failure(error);
		}
		if (this.#syncsBeforeAnswering(route)) {
			await this.#syncAfter(node);
		}
		this.#send(response, answer);
	}

	#syncsBeforeAnswering(route: Route): boolean {
		switch (route.sync) {
			case 'before-answer':
				return(this.config.nodeOptions?.noSyncAfterEachRoute !== true);
			case 'none':
				return(false);
			default:
				return(assertNever(route.sync));
		}
	}

	/** The request's own work is done by now, so a failure to sync is recorded without changing its answer. */
	async #syncAfter(node: Node): Promise<void> {
		try {
			await node.sync();
		} catch (error) {
			const errorID = newErrorID();
			this.log.error({ currentRequestInfo: { id: errorID } }, LOG_SOURCE, `Syncing after a request failed (error ID: ${errorID})`, error);
		}
	}

	/** An internal failure is logged in full under the error ID that its answer names. */
	#failure(error: unknown): Answer & { readonly body: ErrorBody } {
		const answer = answerError(error);
		switch (answer.kind) {
			case 'refusal':
				return({ status: ERROR_STATUS, body: answer.body });
			case 'internal':
				this.log.error({ currentRequestInfo: { id: answer.errorID } }, LOG_SOURCE, answer.body.message, error);
				return({ status: ERROR_STATUS, body: answer.body });
			default:
				return(assertNever(answer));
		}
	}

	#send(response: ExpressResponse, answer: Answer): void {
		this.setCorsHeaders(response);
		response.status(answer.status).json(answer.body);
	}

	get _app(): Express {
		return(this.#app);
	}

	/**
	 * Mounts the routes, listens, advertises where it listens if no endpoints
	 * are configured, so that the node describes itself to peers correctly,
	 * and then serves peers on "/p2p" unless told not to. The bootstrap client
	 * is not started yet.
	 */
	override async run(options?: RunOptions): Promise<void> {
		if (this.#running) {
			throw(new LocalNodeError({ kind: 'already-running' }));
		}
		this.#running = true;
		try {
			await super.run();
			const target = listenTarget(this.config);
			if (target !== undefined && needsAdvertising(this.config) && isUnspecifiedAddress(target.host)) {
				throw(new LocalNodeError({ kind: 'no-address-to-advertise', listenIP: target.host }));
			}
			if (this.#mountedPrefix === undefined) {
				this.addRoutes(advertisedPrefix(this.config.endpoints?.api));
			}
			if (target !== undefined) {
				this.#listening = await listen(this.#app, target);
				this.#advertise(target, this.#listening.address);
				if (options?.startWebSocketServer !== false) {
					this.#peers = new PeerServer(this.#listening.server, this.switch, this.log);
				}
			}
		} catch (error) {
			this.#running = false;
			throw(error);
		}
	}

	#advertise(target: ListenTarget, address: AddressInfo): void {
		if (!needsAdvertising(this.config) || target.host === undefined) {
			return;
		}
		const origin = `${hostInURL(target.host)}:${String(address.port)}`;
		const prefix = trimTrailingSlashes(this.#mountedPrefix ?? DEFAULT_API_PREFIX);
		this.config.endpoints = {
			api: this.config.endpoints?.api ?? `http://${origin}${prefix}`,
			p2p: this.config.endpoints?.p2p ?? `ws://${origin}${P2P_PATH}`
		};
	}

	/**
	 * Unlike Node.main, success does not end the process: run returns once the
	 * node listens, and the node then serves until it is stopped. A failure to
	 * start ends the process as Node.main does [Keeta TS] index.js:71301-71309.
	 */
	static override main(config: LocalNodeConfig): void {
		const node = new LocalNode(config);
		node.run().catch(function(error: unknown): void {
			console.error(error);
			process.exit(1);
		});
	}

	/**
	 * Stops serving peers and requests, waiting for the requests in flight
	 * and the messages peers posted, and then stops the node.
	 */
	override async stop(): Promise<void> {
		const peers = this.#peers;
		this.#peers = undefined;
		if (peers !== undefined) {
			await peers.close();
		}
		const listening = this.#listening;
		this.#listening = undefined;
		if (listening !== undefined) {
			await close(listening.server);
		}
		await settleDeliveries(this.switch);
		this.#running = false;
		await super.stop();
	}

	/** Bootstrapping from peers is not offered yet. */
	get bootstrap(): BootstrapClient | undefined {
		return(undefined);
	}
}

export default LocalNode;

type DeclaredLocalModule = typeof import('@keetanetwork/keetanet-client/lib/node/local.js');
type LocalModule = typeof import('./local.js');

type _HasEveryDeclaredMember = AssertNever<ClassSurface<typeof LocalNode> extends ClassSurface<typeof DeclaredLocalNode> ? never : ClassSurface<typeof LocalNode>>;
type _HasNoUndeclaredMember = AssertNever<ClassSurface<typeof DeclaredLocalNode> extends ClassSurface<typeof LocalNode> ? never : ClassSurface<typeof DeclaredLocalNode>>;
type _ExportsNoUndeclaredValue = AssertNever<Exclude<keyof LocalModule, keyof DeclaredLocalModule>>;
type _ExportsEveryDeclaredValue = AssertNever<Exclude<keyof DeclaredLocalModule, keyof LocalModule>>;
