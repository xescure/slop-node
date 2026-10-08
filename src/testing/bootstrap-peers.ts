import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BloomFilter } from '@keetanetwork/keetanet-client/lib/utils/bloom.js';
import { MAX_PAGE_BYTES } from '../node/bootstrap-page.js';
import { assertNever } from '../util/assert-never.js';

/** Whether a recording peer passes the filter a request carries on, or drops it, as a representative that ignores it would. */
export type FilterHandling = 'passed-on' | 'dropped';

/** A request for a page of staples, as a peer received it, and how many staples it answered with. */
export type RecordedPage = {
	readonly start: string | null;
	readonly limit: string | null;
	readonly bloomFilter: BloomFilter | undefined;
	readonly status: number;
	/** The staples of the answer, in base64. */
	readonly served: readonly string[];
	/** When the request arrived and when its answer was written, on the monotonic clock, in milliseconds. */
	readonly received: number;
	readonly answered: number;
};

/** An API endpoint on the loopback interface, open until the test ends. */
export type TestPeer = {
	/** Where the API is served, with no trailing slash. */
	readonly apiURL: string;
};

export type RecordingPeer = TestPeer & {
	/** Every page requested so far, in the order the answers were sent. */
	readonly pages: readonly RecordedPage[];
};

function portOf(server: http.Server): number {
	const address: AddressInfo | string | null = server.address();
	if (address === null || typeof address === 'string') {
		throw(new Error('the server has no port'));
	}
	return(address.port);
}

async function listenUntilTestEnds(server: http.Server): Promise<string> {
	await new Promise<void>(function(resolve, reject) {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	onTestFinished(async function() {
		server.closeAllConnections();
		await new Promise<void>(function(resolve) {
			server.close(function() {
				resolve();
			});
		});
	});
	return(`http://127.0.0.1:${String(portOf(server))}/api`);
}

function readBody(message: http.IncomingMessage): Promise<string> {
	return(new Promise<string>(function(resolve, reject) {
		const chunks: Buffer[] = [];
		message.on('data', function(chunk: Buffer): void {
			chunks.push(chunk);
		});
		message.on('end', function(): void {
			resolve(Buffer.concat(chunks).toString('utf8'));
		});
		message.on('error', reject);
	}));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** The bytes of each staple of a page, which a representative writes beside each staple's JSON. */
function servedStaples(body: string): string[] {
	const parsed: unknown = JSON.parse(body);
	if (!isRecord(parsed) || !Array.isArray(parsed['voteStaples'])) {
		return([]);
	}
	return(parsed['voteStaples'].map(function(staple: unknown): string {
		if (!isRecord(staple) || typeof staple['$binary'] !== 'string') {
			throw(new Error('a staple was served without its bytes'));
		}
		return(staple['$binary']);
	}));
}

function bloomFilterOf(query: URLSearchParams): BloomFilter | undefined {
	const serialized = query.get('bloomFilter');
	if (serialized === null) {
		return(undefined);
	}
	return(KeetaNet.lib.Utils.Bloom.deserializeBloomFilter(serialized));
}

/** Forwards a request to the target over a connection of its own, which closes with the answer. */
function forward(target: URL, request: http.IncomingMessage, filter: FilterHandling): Promise<{ readonly status: number; readonly contentType: string | undefined; readonly body: string }> {
	const url = new URL(request.url ?? '/', target);
	switch (filter) {
		case 'passed-on':
			break;
		case 'dropped':
			url.searchParams.delete('bloomFilter');
			break;
		default:
			assertNever(filter);
	}
	return(new Promise(function(resolve, reject) {
		const outgoing = http.get(url, { agent: false }, function(answer): void {
			readBody(answer).then(function(body): void {
				resolve({ status: answer.statusCode ?? 0, contentType: answer.headers['content-type'], body });
			}, reject);
		});
		outgoing.on('error', reject);
	}));
}

export type RecordingPeerOptions = {
	readonly filter?: FilterHandling;
	/** Pads every answer to a request for more staples than this past the size the node accepts for a page. */
	readonly padAboveLimit?: number;
};

function padding(query: URLSearchParams, padAboveLimit: number | undefined): string {
	if (padAboveLimit === undefined || Number(query.get('limit')) <= padAboveLimit) {
		return('');
	}
	return(' '.repeat(MAX_PAGE_BYTES));
}

/**
 * A peer that passes every request on to the representative at the API
 * endpoint, which is served below "/api" as its own is, and records each
 * page of staples it answers.
 */
export async function startRecordingPeer(apiURL: string, options: RecordingPeerOptions = {}): Promise<RecordingPeer> {
	const target = new URL(apiURL);
	const pages: RecordedPage[] = [];
	const server = http.createServer(function(request, response): void {
		const received = performance.now();
		forward(target, request, options.filter ?? 'passed-on').then(function(answer): void {
			const query = new URL(request.url ?? '/', target).searchParams;
			response.writeHead(answer.status, { 'content-type': answer.contentType ?? 'application/json' });
			response.end(answer.body + padding(query, options.padAboveLimit));
			pages.push({ start: query.get('start'), limit: query.get('limit'), bloomFilter: bloomFilterOf(query), status: answer.status, served: servedStaples(answer.body), received, answered: performance.now() });
		}, function(error: unknown): void {
			response.writeHead(502);
			response.end(String(error));
		});
	});
	return({ apiURL: await listenUntilTestEnds(server), pages });
}

/** A representative that fails every request as one does on an internal error. */
export async function startFailingPeer(): Promise<TestPeer & { readonly requests: () => number }> {
	let requests = 0;
	const server = http.createServer(function(_ignoredRequest, response): void {
		requests++;
		response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: true, message: 'An internal error occurred' }));
	});
	return({ apiURL: await listenUntilTestEnds(server), requests: function(): number {
		return(requests);
	} });
}

/** A representative that accepts each request and never answers it. */
export async function startSilentAPIPeer(): Promise<TestPeer & { readonly requested: Promise<void> }> {
	let markRequested: (() => void) | undefined;
	const requested = new Promise<void>(function(resolve) {
		markRequested = resolve;
	});
	const server = http.createServer(function(): void {
		markRequested?.();
	});
	return({ apiURL: await listenUntilTestEnds(server), requested });
}

/** An endpoint on the loopback interface where nothing listens any more. */
export async function unreachableEndpoint(): Promise<string> {
	const server = http.createServer();
	await new Promise<void>(function(resolve, reject) {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const port = portOf(server);
	await new Promise<void>(function(resolve) {
		server.close(function() {
			resolve();
		});
	});
	return(`http://127.0.0.1:${String(port)}/api`);
}

/** A staple's bytes, from the staple or from base64 as a representative writes them. */
export type ServedStaple = { toBytes(): ArrayBuffer } | string;

function bytesOf(staple: ServedStaple): Buffer {
	if (typeof staple === 'string') {
		return(Buffer.from(staple, 'base64'));
	}
	return(Buffer.from(staple.toBytes()));
}

export type ServingPeer = RecordingPeer & {
	/** Applies the staples, in that order, one a millisecond from the moment given, after those it applied already. */
	readonly apply: (staples: readonly ServedStaple[], from: Date) => void;
	/** The staples it has sent in all, its answers to probes included. */
	readonly served: () => number;
};

/**
 * A representative that applied the staples it is given in the order given,
 * whatever they depend on, as the main network's representatives serve
 * their history, and pages them as one does: those applied at or after the
 * start, leaving out those the filter names, up to the limit
 * [Keeta TS] index.js:69633-69702.
 */
export async function startServingPeer(): Promise<ServingPeer> {
	const applied: { readonly bytes: Buffer; readonly moment: number }[] = [];
	const pages: RecordedPage[] = [];
	let served = 0;
	const server = http.createServer(function(request, response): void {
		const received = performance.now();
		const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
		const start = Date.parse(query.get('start') ?? '');
		const limit = Number(query.get('limit') ?? '1000');
		const filter = bloomFilterOf(query);
		const page: string[] = [];
		for (const staple of applied) {
			if (page.length >= limit) {
				break;
			}
			const bytes = staple.bytes.buffer.slice(staple.bytes.byteOffset, staple.bytes.byteOffset + staple.bytes.byteLength);
			if (staple.moment < start || filter?.has(bytes) === true) {
				continue;
			}
			page.push(staple.bytes.toString('base64'));
		}
		served += page.length;
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ voteStaples: page.map(function(binary): { readonly $binary: string } {
			return({ $binary: binary });
		}) }));
		pages.push({ start: query.get('start'), limit: query.get('limit'), bloomFilter: filter, status: 200, served: page, received, answered: performance.now() });
	});
	return({
		apiURL: await listenUntilTestEnds(server),
		pages,
		apply: function(staples: readonly ServedStaple[], from: Date): void {
			staples.forEach(function(staple, index): void {
				applied.push({ bytes: bytesOf(staple), moment: from.getTime() + index });
			});
			// A representative pages in the order it applied, which is the moments' (the sort keeps the order given within one).
			applied.sort(function(left, right): number {
				return(left.moment - right.moment);
			});
		},
		served: function(): number {
			return(served);
		}
	});
}
