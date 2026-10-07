import http from 'node:http';
import https from 'node:https';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { assertNever } from '../util/assert-never.js';
import { NODE_VERSION } from '../version.js';

const lib = KeetaNet.lib;

/** The route a representative serves its staples on, below its API endpoint [Keeta TS] index.js:59175. */
const BOOTSTRAP_ROUTE = '/node/bootstrap/votes';

const SUCCESS_STATUS = 200;

/** Bounds what a misbehaving peer can make the node hold for one page. */
const MAX_PAGE_BYTES = 256 * 1024 * 1024;

/** What one page of a peer's staples asks for [Keeta TS] index.js:59166-59174. */
export type PageRequest = {
	/** The peer's API endpoint, as the client prefixes each route with it [Keeta TS] index.js:59584-59585. */
	readonly endpoint: string;
	readonly start: Date;
	readonly limit: number;
	/** A serialized filter of the staples the peer may leave out. */
	readonly bloomFilter: string | undefined;
};

/** Why a page of a peer's staples could not be had. */
export type PageProblem =
	| { readonly kind: 'status'; readonly status: number; readonly message: string | undefined }
	| { readonly kind: 'protocol' }
	| { readonly kind: 'malformed'; readonly detail: string }
	| { readonly kind: 'too-large'; readonly limitBytes: number }
	| { readonly kind: 'timeout'; readonly milliseconds: number }
	| { readonly kind: 'stopped' };

function describeProblem(endpoint: string, problem: PageProblem): string {
	switch (problem.kind) {
		case 'status':
			if (problem.message === undefined) {
				return(`${endpoint} answered ${String(problem.status)}`);
			}
			return(`${endpoint} answered ${String(problem.status)}: ${problem.message}`);
		case 'protocol':
			return(`${endpoint} is no http:// or https:// URL`);
		case 'malformed':
			return(`${endpoint} answered with no page of staples: ${problem.detail}`);
		case 'too-large':
			return(`${endpoint} answered with more than ${String(problem.limitBytes)} bytes`);
		case 'timeout':
			return(`${endpoint} did not answer within ${String(problem.milliseconds)} ms`);
		case 'stopped':
			return(`the request to ${endpoint} was stopped`);
		default:
			return(assertNever(problem));
	}
}

export class PageError extends Error {
	readonly problem: PageProblem;

	constructor(endpoint: string, problem: PageProblem, options?: ErrorOptions) {
		super(describeProblem(endpoint, problem), options);
		this.name = 'PageError';
		this.problem = problem;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** The URL the client requests a page at [Keeta TS] index.js:59584-59613. */
export function pageURL(request: PageRequest): URL {
	const query = new URLSearchParams({ start: request.start.toISOString(), limit: String(request.limit) });
	if (request.bloomFilter !== undefined) {
		query.set('bloomFilter', request.bloomFilter);
	}
	return(new URL(`${request.endpoint}${BOOTSTRAP_ROUTE}?${query.toString()}`));
}

type Answer = { readonly status: number; readonly body: string };

function parseJSON(endpoint: string, body: string): unknown {
	try {
		return(JSON.parse(body));
	} catch (error: unknown) {
		throw(new PageError(endpoint, { kind: 'malformed', detail: 'the body is no JSON' }, { cause: error }));
	}
}

/** The most of a peer's error message the node repeats in its log. */
const MAX_MESSAGE_LENGTH = 200;

/** A representative's error names what went wrong in its message [Keeta TS] index.js:59629-59633. */
function errorMessageOf(body: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(body);
		if (isRecord(parsed) && typeof parsed['message'] === 'string') {
			return(parsed['message'].slice(0, MAX_MESSAGE_LENGTH));
		}
	} catch {
		// The status alone then says what went wrong.
	}
	return(undefined);
}

/**
 * A staple's bytes in base64: a representative writes each staple as JSON
 * with its bytes beside it [Keeta TS] index.js:81088-81092, which the
 * node reads rather than rebuild the staple from the JSON as the client does
 * [Keeta TS] index.js:59179-59182, 80926-80928, so that it holds exactly the
 * staple the peer sent; a bare base64 string is read alike.
 */
function stapleBytesOf(written: unknown): string | undefined {
	if (typeof written === 'string') {
		return(written);
	}
	if (isRecord(written) && typeof written['$binary'] === 'string') {
		return(written['$binary']);
	}
	return(undefined);
}

/** The staples of an answer, read as the client reads them [Keeta TS] index.js:59175-59182. */
function staplesOf(endpoint: string, answer: Answer): VoteStaple[] {
	if (answer.status !== SUCCESS_STATUS) {
		throw(new PageError(endpoint, { kind: 'status', status: answer.status, message: errorMessageOf(answer.body) }));
	}
	const parsed = parseJSON(endpoint, answer.body);
	if (!isRecord(parsed) || !Array.isArray(parsed['voteStaples'])) {
		throw(new PageError(endpoint, { kind: 'malformed', detail: 'it holds no voteStaples list' }));
	}
	return(parsed['voteStaples'].map(function(written: unknown): VoteStaple {
		const encoded = stapleBytesOf(written);
		if (encoded === undefined) {
			throw(new PageError(endpoint, { kind: 'malformed', detail: 'a staple carries no bytes' }));
		}
		try {
			return(new lib.Vote.Staple(encoded));
		} catch (error: unknown) {
			throw(new PageError(endpoint, { kind: 'malformed', detail: 'a staple cannot be read' }, { cause: error }));
		}
	}));
}

/**
 * Requests pages of peers' staples over HTTP, reusing connections until it
 * is closed, which ends every connection it opened.
 */
export class PageFetcher {
	readonly #httpAgent = new http.Agent({ keepAlive: true });
	readonly #httpsAgent = new https.Agent({ keepAlive: true });

	/**
	 * The page, or a PageError: a timeout once that many milliseconds have
	 * passed, or a stop once the signal is aborted.
	 */
	async page(request: PageRequest, timeoutMilliseconds: number, stopped: AbortSignal): Promise<VoteStaple[]> {
		const url = pageURL(request);
		const timer = new AbortController();
		const timeout = setTimeout(function(): void {
			timer.abort();
		}, timeoutMilliseconds);
		try {
			return(staplesOf(request.endpoint, await this.#get(request.endpoint, url, AbortSignal.any([stopped, timer.signal]))));
		} catch (error: unknown) {
			if (stopped.aborted) {
				throw(new PageError(request.endpoint, { kind: 'stopped' }, { cause: error }));
			}
			if (timer.signal.aborted) {
				throw(new PageError(request.endpoint, { kind: 'timeout', milliseconds: timeoutMilliseconds }, { cause: error }));
			}
			throw(error);
		} finally {
			clearTimeout(timeout);
		}
	}

	close(): void {
		this.#httpAgent.destroy();
		this.#httpsAgent.destroy();
	}

	#get(endpoint: string, url: URL, signal: AbortSignal): Promise<Answer> {
		const options = { signal, headers: { accept: 'application/json', 'user-agent': `slop-node/${NODE_VERSION}` } };
		return(new Promise<Answer>((resolve, reject): void => {
			const answer = function(response: http.IncomingMessage): void {
				const chunks: Buffer[] = [];
				let length = 0;
				response.on('data', function(chunk: Buffer): void {
					length += chunk.length;
					if (length > MAX_PAGE_BYTES) {
						response.destroy(new PageError(endpoint, { kind: 'too-large', limitBytes: MAX_PAGE_BYTES }));
						return;
					}
					chunks.push(chunk);
				});
				response.on('error', reject);
				response.on('close', function(): void {
					if (!response.complete) {
						reject(new PageError(endpoint, { kind: 'malformed', detail: 'the answer ended early' }));
					}
				});
				response.on('end', function(): void {
					resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
				});
			};
			let request: http.ClientRequest;
			switch (url.protocol) {
				case 'http:':
					request = http.get(url, { ...options, agent: this.#httpAgent }, answer);
					break;
				case 'https:':
					request = https.get(url, { ...options, agent: this.#httpsAgent }, answer);
					break;
				default:
					reject(new PageError(endpoint, { kind: 'protocol' }));
					return;
			}
			request.on('error', reject);
		}));
	}
}
