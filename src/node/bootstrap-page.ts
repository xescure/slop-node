import http from 'node:http';
import https from 'node:https';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Vote, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { P2PInternals } from '../upstream/internals.js';
import { assertNever } from '../util/assert-never.js';
import { NODE_VERSION } from '../version.js';

const lib = KeetaNet.lib;

/** The route a representative serves its staples on, below its API endpoint [Keeta TS] index.js:59175. */
const BOOTSTRAP_ROUTE = '/node/bootstrap/votes';

/** Where a representative answers the votes it holds on a block [Keeta TS] index.js:59900. */
const VOTES_ROUTE = '/vote';

/** Where a representative answers a block it holds [Keeta TS] index.js:58782. */
const BLOCK_ROUTE = '/node/ledger/block';

const SUCCESS_STATUS = 200;

/**
 * Bounds what a peer can make the node hold for one page of several
 * staples. A full page of ordinary staples is a fraction of this; an answer
 * beyond it makes the pass ask for half as many.
 */
export const MAX_PAGE_BYTES: number = 4 * 1024 * 1024;

/**
 * A page of one staple may hold the largest staple a peer accepts over P2P,
 * written as JSON with its bytes beside it, which about quadruples it.
 */
export const MAX_SINGLE_STAPLE_PAGE_BYTES: number = 4 * P2PInternals.P2P_WEBSOCKET_MAX_PAYLOAD_BYTES;

function maxPageBytes(limit: number): number {
	if (limit === 1) {
		return(MAX_SINGLE_STAPLE_PAGE_BYTES);
	}
	return(MAX_PAGE_BYTES);
}

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
	/** With how long the peer asked the node to wait before asking again, when it answered so (statusErrorOf). */
	| { readonly kind: 'status'; readonly status: number; readonly message: string | undefined; readonly retryAfterMilliseconds?: number }
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

type Answer = { readonly status: number; readonly body: string; readonly retryAfter: string | undefined };

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
 * How long a Retry-After header asks the client to wait: a number of seconds,
 * or the moment to wait until (RFC 9110, section 10.2.3); nothing when it
 * says neither.
 */
export function retryAfterMillisecondsOf(header: string | undefined, now: number): number | undefined {
	if (header === undefined) {
		return(undefined);
	}
	const text = header.trim();
	if (/^\d+$/u.test(text)) {
		return(Number(text) * 1000);
	}
	const until = Date.parse(text);
	if (Number.isNaN(until)) {
		return(undefined);
	}
	return(Math.max(0, until - now));
}

/** The failure an answer of a status other than success is, with the wait the peer asked for, if it did. */
function statusErrorOf(endpoint: string, answer: Answer): PageError {
	const problem: PageProblem = { kind: 'status', status: answer.status, message: errorMessageOf(answer.body) };
	const retryAfterMilliseconds = retryAfterMillisecondsOf(answer.retryAfter, Date.now());
	if (retryAfterMilliseconds === undefined) {
		return(new PageError(endpoint, problem));
	}
	return(new PageError(endpoint, { ...problem, retryAfterMilliseconds }));
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
		throw(statusErrorOf(endpoint, answer));
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

/** Sends one request to a peer when the peer's pacing lets it. */
export type Pace = <Result>(request: () => Promise<Result>) => Promise<Result>;

/** The votes a representative answers it holds on a block, none when it holds none [Keeta TS] index.js:59900-59933. */
function votesOf(endpoint: string, parsed: unknown): Vote[] {
	if (!isRecord(parsed) || !('votes' in parsed)) {
		throw(new PageError(endpoint, { kind: 'malformed', detail: 'it holds no votes' }));
	}
	const written = parsed['votes'];
	if (written === null) {
		return([]);
	}
	if (!Array.isArray(written)) {
		throw(new PageError(endpoint, { kind: 'malformed', detail: 'its votes are no list' }));
	}
	return(written.map(function(vote: unknown): Vote {
		const encoded = stapleBytesOf(vote);
		if (encoded === undefined) {
			throw(new PageError(endpoint, { kind: 'malformed', detail: 'a vote carries no bytes' }));
		}
		try {
			return(new lib.Vote(Buffer.from(encoded, 'base64')));
		} catch (error: unknown) {
			throw(new PageError(endpoint, { kind: 'malformed', detail: 'a vote cannot be read' }, { cause: error }));
		}
	}));
}

/** The block a representative answers it holds, nothing when it holds none [Keeta TS] index.js:58778-58796. */
function blockOf(endpoint: string, parsed: unknown): Block | undefined {
	if (!isRecord(parsed) || !('block' in parsed)) {
		throw(new PageError(endpoint, { kind: 'malformed', detail: 'it holds no block' }));
	}
	const written = parsed['block'];
	if (written === null) {
		return(undefined);
	}
	const encoded = stapleBytesOf(written);
	if (encoded === undefined) {
		throw(new PageError(endpoint, { kind: 'malformed', detail: 'a block carries no bytes' }));
	}
	try {
		return(new lib.Block(Buffer.from(encoded, 'base64')));
	} catch (error: unknown) {
		throw(new PageError(endpoint, { kind: 'malformed', detail: 'a block cannot be read' }, { cause: error }));
	}
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
			return(staplesOf(request.endpoint, await this.#get(request.endpoint, url, maxPageBytes(request.limit), AbortSignal.any([stopped, timer.signal]))));
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

	/**
	 * The staple on the main ledger that holds the block, as the peer holds
	 * it, or nothing when the peer holds no such staple: its votes on the
	 * block, then each block they cover, as the client builds a staple
	 * [Keeta TS] index.js:58802-58842, 59887-59933, 58778-58796, each request
	 * sent as the pacing lets it. A PageError
	 * as for a page: a timeout once that many milliseconds have passed for a
	 * request, or a stop once the signal is aborted.
	 */
	async stapleHolding(endpoint: string, block: BlockHash, timeoutMilliseconds: number, stopped: AbortSignal, pace: Pace): Promise<VoteStaple | undefined> {
		const read = (url: URL): Promise<unknown> => {
			return(pace(() => {
				return(this.#read(endpoint, url, timeoutMilliseconds, stopped));
			}));
		};
		const votes = votesOf(endpoint, await read(new URL(`${endpoint}${VOTES_ROUTE}/${block.toString()}?side=main`)));
		const [sample] = votes;
		if (sample === undefined) {
			return(undefined);
		}
		const blocks: Block[] = [];
		for (const covered of sample.blocks) {
			const found = blockOf(endpoint, await read(new URL(`${endpoint}${BLOCK_ROUTE}/${covered.toString()}?side=main`)));
			if (found === undefined) {
				return(undefined);
			}
			blocks.push(found);
		}
		let staple: VoteStaple;
		try {
			staple = lib.Vote.Staple.fromVotesAndBlocks(votes, blocks);
		} catch (error: unknown) {
			throw(new PageError(endpoint, { kind: 'malformed', detail: 'its votes and blocks make no staple' }, { cause: error }));
		}
		if (!staple.blocks.some(function(held): boolean {
			return(held.hash.compare(block));
		})) {
			throw(new PageError(endpoint, { kind: 'malformed', detail: `the staple it holds for block ${block.toString()} lacks it` }));
		}
		return(staple);
	}

	async #read(endpoint: string, url: URL, timeoutMilliseconds: number, stopped: AbortSignal): Promise<unknown> {
		const timer = new AbortController();
		const timeout = setTimeout(function(): void {
			timer.abort();
		}, timeoutMilliseconds);
		try {
			const answer = await this.#get(endpoint, url, MAX_SINGLE_STAPLE_PAGE_BYTES, AbortSignal.any([stopped, timer.signal]));
			if (answer.status !== SUCCESS_STATUS) {
				throw(statusErrorOf(endpoint, answer));
			}
			return(parseJSON(endpoint, answer.body));
		} catch (error: unknown) {
			if (stopped.aborted) {
				throw(new PageError(endpoint, { kind: 'stopped' }, { cause: error }));
			}
			if (timer.signal.aborted) {
				throw(new PageError(endpoint, { kind: 'timeout', milliseconds: timeoutMilliseconds }, { cause: error }));
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

	#get(endpoint: string, url: URL, limitBytes: number, signal: AbortSignal): Promise<Answer> {
		const options = { signal, headers: { accept: 'application/json', 'user-agent': `slop-node/${NODE_VERSION}` } };
		return(new Promise<Answer>((resolve, reject): void => {
			const answer = function(response: http.IncomingMessage): void {
				const chunks: Buffer[] = [];
				let length = 0;
				response.on('data', function(chunk: Buffer): void {
					length += chunk.length;
					if (length > limitBytes) {
						response.destroy(new PageError(endpoint, { kind: 'too-large', limitBytes }));
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
					resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), retryAfter: response.headers['retry-after'] });
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
