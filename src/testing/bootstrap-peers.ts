import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BloomFilter } from '@keetanetwork/keetanet-client/lib/utils/bloom.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { MAX_PAGE_BYTES } from '../node/bootstrap-page.js';
import { assertNever } from '../util/assert-never.js';

/**
 * Whether a recording peer passes the filter a request carries on, drops it,
 * as a representative that ignores it would, or gives up on a request that
 * carries one, as a gateway in front of a representative that reads too long
 * past the staples a filter names does.
 */
export type FilterHandling = 'passed-on' | 'dropped' | 'gives-up';

/** What a gateway answers when what stands behind it took too long. */
const GATEWAY_TIMEOUT_STATUS = 504;

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
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return([]);
	}
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
		case 'gives-up':
			if (url.searchParams.has('bloomFilter')) {
				return(Promise.resolve({ status: GATEWAY_TIMEOUT_STATUS, contentType: 'text/html', body: '<html>504 Gateway Time-out</html>' }));
			}
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
	/** Runs as each answer is about to be sent, as the time a slow representative takes would pass. */
	readonly beforeAnswer?: () => void;
	/**
	 * Leaves out of every page of staples those whose bytes, in base64, it
	 * names, as a main network representative leaves out a vote made a
	 * millisecond or less after the last vote of one of its reads, while its
	 * other routes still answer for the staple.
	 */
	readonly leavesOut?: (staple: string) => boolean;
};

const PAGE_ROUTE = '/node/bootstrap/votes';

/** The answer with the staples named left out of a page of them; any other answer as it was. */
function withLeftOut(path: string, body: string, leavesOut: ((staple: string) => boolean) | undefined): string {
	if (leavesOut === undefined || !path.endsWith(PAGE_ROUTE)) {
		return(body);
	}
	const parsed: unknown = JSON.parse(body);
	if (!isRecord(parsed) || !Array.isArray(parsed['voteStaples'])) {
		return(body);
	}
	return(JSON.stringify({ ...parsed, voteStaples: parsed['voteStaples'].filter(function(staple: unknown): boolean {
		return(!isRecord(staple) || typeof staple['$binary'] !== 'string' || !leavesOut(staple['$binary']));
	}) }));
}

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
			const url = new URL(request.url ?? '/', target);
			const query = url.searchParams;
			const body = withLeftOut(url.pathname, answer.body, options.leavesOut);
			options.beforeAnswer?.();
			response.writeHead(answer.status, { 'content-type': answer.contentType ?? 'application/json' });
			response.end(body + padding(query, options.padAboveLimit));
			pages.push({ start: query.get('start'), limit: query.get('limit'), bloomFilter: bloomFilterOf(query), status: answer.status, served: servedStaples(body), received, answered: performance.now() });
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

/** A peer that answers every request with the status, body and headers given, counting the requests. */
export async function startAnsweringPeer(status: number, body: string, headers: Readonly<Record<string, string>> = {}): Promise<TestPeer & { readonly requests: () => number }> {
	let requests = 0;
	const server = http.createServer(function(_ignoredRequest, response): void {
		requests++;
		response.writeHead(status, { 'content-type': 'application/json', ...headers });
		response.end(body);
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
	/** Applies the staples, in that order, after those it applied already. */
	readonly apply: (staples: readonly ServedStaple[]) => void;
	/** The staples it has sent in all, its answers to probes included. */
	readonly served: () => number;
};

/** The moment the staple's last vote was made, which a peer keyed by votes lists it from at the latest. */
function lastVoteOf(bytes: Buffer): number {
	return(Math.max(...new KeetaNet.lib.Vote.Staple(bytes.toString('base64')).votes.map(function(vote): number {
		return(vote.validityFrom.getTime());
	})));
}

/**
 * A representative that applied the staples it is given in the order given,
 * whatever they depend on, and pages them as the main network's
 * representatives do: it keys each vote at the moment it was made, and lists
 * from a start each staple with a vote made at or after it, leaving out
 * those the filter names, up to the limit [Keeta TS] index.js:70669-70738,
 * as one read of its votes, in no order of its own: the order applied.
 */
export async function startServingPeer(): Promise<ServingPeer> {
	const applied: { readonly bytes: Buffer; readonly lastVote: number }[] = [];
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
			if (staple.lastVote < start || filter?.has(bytes) === true) {
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
		apply: function(staples: readonly ServedStaple[]): void {
			for (const staple of staples) {
				const bytes = bytesOf(staple);
				applied.push({ bytes, lastVote: lastVoteOf(bytes) });
			}
		},
		served: function(): number {
			return(served);
		}
	});
}

export type ReadingPeer = ServingPeer & {
	/** The blocks it was asked for the votes on, by hash, in the order asked. */
	readonly askedFor: readonly string[];
	/** Answers no votes on the blocks named from now on, as a representative that holds no staple of theirs. */
	readonly holdsNot: (block: string) => void;
	/** Answers 429, asking for a minute's wait, every request for a page whose start and limit, as the query spells them, the test picks. */
	readonly throttlesPages: (picks: (start: string | null, limit: string | null) => boolean) => void;
	/** Leaves the staple of those blocks out of every page whose start and limit the test picks, as if it held none. */
	readonly leavesOut: (blocksHash: string, picks: (start: string | null, limit: string | null) => boolean) => void;
	/** Answers 429, asking for a minute's wait, every request for the votes on a block. */
	readonly throttlesVotes: () => void;
};

/**
 * How a main network representative reads its votes for a page: so many at
 * a time, from the first keyed at or after the start, each read after the
 * first beginning past the key of the read before's last vote by
 * resumesPast, so that a vote keyed that close after it is in no read. It
 * keys each vote keyOffset after the moment it was made, 0 unless given, as
 * a representative may key one a little off, and answers at most
 * answersAtMost staples a page, as one whose time for a request runs out.
 */
export type ReadingRule = { readonly votesPerRead: number; readonly resumesPast: number; readonly keyOffset?: number; readonly answersAtMost?: number };

/**
 * A representative keyed by votes that reads them as the rule says, lists
 * each read's staples but those the filter names, up to the limit, and
 * answers for a block the votes on it and each block they cover, as the
 * client asks for a block's staple [Keeta TS] index.js:59799-59839,
 * 60878-60923, 59775-59793.
 */
export async function startReadingPeer(rule: ReadingRule): Promise<ReadingPeer> {
	const applied: VoteStaple[] = [];
	const pages: RecordedPage[] = [];
	const askedFor: string[] = [];
	const heldNot = new Set<string>();
	let throttled = function(_start: string | null, _limit: string | null): boolean {
		return(false);
	};
	const leftOut = new Map<string, (start: string | null, limit: string | null) => boolean>();
	let votesThrottled = false;
	let served = 0;
	const holding = function(block: string): VoteStaple | undefined {
		if (heldNot.has(block)) {
			return(undefined);
		}
		return(applied.find(function(staple): boolean {
			return(staple.blocks.some(function(held): boolean {
				return(held.hash.toString() === block);
			}));
		}));
	};
	const answer = function(response: http.ServerResponse, body: unknown): void {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify(body));
	};
	const server = http.createServer(function(request, response): void {
		const received = performance.now();
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		const [, route, ...rest] = url.pathname.split('/api/');
		const path = [route, ...rest].join('/api/');
		if (path.startsWith('vote/')) {
			const block = path.slice('vote/'.length).toUpperCase();
			askedFor.push(block);
			if (votesThrottled) {
				response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
				response.end(JSON.stringify({ error: true, message: 'Too many requests' }));
				return;
			}
			const staple = holding(block);
			answer(response, { blockhash: block, votes: staple?.votes.map(function(vote): { readonly $binary: string } {
				return({ $binary: Buffer.from(vote.toBytes()).toString('base64') });
			}) ?? null });
			return;
		}
		if (path.startsWith('node/ledger/block/')) {
			const block = path.slice('node/ledger/block/'.length).toUpperCase();
			const found = holding(block)?.blocks.find(function(held): boolean {
				return(held.hash.toString() === block);
			});
			let written: { readonly $binary: string } | null = null;
			if (found !== undefined) {
				written = { $binary: Buffer.from(found.toBytes()).toString('base64') };
			}
			answer(response, { blockhash: block, block: written });
			return;
		}
		const query = url.searchParams;
		if (throttled(query.get('start'), query.get('limit'))) {
			response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
			response.end(JSON.stringify({ error: true, message: 'Too many requests' }));
			pages.push({ start: query.get('start'), limit: query.get('limit'), bloomFilter: bloomFilterOf(query), status: 429, served: [], received, answered: performance.now() });
			return;
		}
		const start = Date.parse(query.get('start') ?? '');
		const limit = Math.min(Number(query.get('limit') ?? '1000'), rule.answersAtMost ?? Number.POSITIVE_INFINITY);
		const filter = bloomFilterOf(query);
		const votes = applied.flatMap(function(staple): { readonly staple: VoteStaple; readonly made: number }[] {
			return(staple.votes.map(function(vote): { readonly staple: VoteStaple; readonly made: number } {
				return({ staple, made: vote.validityFrom.getTime() + (rule.keyOffset ?? 0) });
			}));
		}).sort(function(left, right): number {
			return(left.made - right.made);
		});
		const page: string[] = [];
		let at = votes.findIndex(function(vote): boolean {
			return(vote.made >= start);
		});
		while (at >= 0 && at < votes.length && page.length < limit) {
			const read = votes.slice(at, at + rule.votesPerRead);
			at += read.length;
			const lastKey = read.at(-1)?.made ?? Number.POSITIVE_INFINITY;
			while ((votes[at]?.made ?? Number.POSITIVE_INFINITY) <= lastKey + rule.resumesPast) {
				at++;
			}
			for (const staple of new Set(read.map(function(vote): VoteStaple {
				return(vote.staple);
			}))) {
				if (page.length >= limit) {
					break;
				}
				const hidden = leftOut.get(staple.blocksHash.toString())?.(query.get('start'), query.get('limit')) === true;
				if (!hidden && filter?.has(staple.toBytes()) !== true) {
					page.push(Buffer.from(staple.toBytes()).toString('base64'));
				}
			}
		}
		served += page.length;
		answer(response, { voteStaples: page.map(function(binary): { readonly $binary: string } {
			return({ $binary: binary });
		}) });
		pages.push({ start: query.get('start'), limit: query.get('limit'), bloomFilter: filter, status: 200, served: page, received, answered: performance.now() });
	});
	return({
		apiURL: await listenUntilTestEnds(server),
		pages,
		askedFor,
		holdsNot: function(block: string): void {
			heldNot.add(block);
		},
		throttlesPages: function(picks): void {
			throttled = picks;
		},
		leavesOut: function(blocksHash, picks): void {
			leftOut.set(blocksHash, picks);
		},
		throttlesVotes: function(): void {
			votesThrottled = true;
		},
		apply: function(staples: readonly ServedStaple[]): void {
			for (const staple of staples) {
				applied.push(new KeetaNet.lib.Vote.Staple(bytesOf(staple).toString('base64')));
			}
		},
		served: function(): number {
			return(served);
		}
	});
}

/** The most votes upstream's catch-up reads at a time [Keeta TS] index.js:70689-70692. */
export const VOTES_PER_READ = 200;

/** A staple as the catch-up reads it: its blocks hash and when its votes were made. */
type VotedStaple = { readonly blocksHash: { toString(): string }; readonly votes: readonly { readonly validityFrom: Date }[] };

/**
 * What a node's catch-up lists from the moment, as upstream's loop reads its
 * storage keyed by votes (CONTRACT D8), over staples none of which has a vote
 * made in the same millisecond as another staple's: the votes made at or
 * after the moment, by when they were made, read VOTES_PER_READ at a time,
 * and each read's staples once, in the order their votes come
 * [Keeta TS] index.js:70669-70738.
 */
export function listedByVotes(staples: readonly VotedStaple[], from: Date): string[] {
	const votes = staples.flatMap(function(staple): { readonly staple: string; readonly made: number }[] {
		return(staple.votes.map(function(vote): { readonly staple: string; readonly made: number } {
			return({ staple: staple.blocksHash.toString(), made: vote.validityFrom.getTime() });
		}));
	}).filter(function(vote): boolean {
		return(vote.made >= from.getTime());
	}).sort(function(left, right): number {
		return(left.made - right.made);
	});
	const listed: string[] = [];
	for (let first = 0; first < votes.length; first += VOTES_PER_READ) {
		listed.push(...new Set(votes.slice(first, first + VOTES_PER_READ).map(function(vote): string {
			return(vote.staple);
		})));
	}
	return(listed);
}

/** The blocks hashes of the staples of a page the API answers from the moment, in the order listed. */
export async function pageFrom(apiURL: string, start: Date): Promise<string[]> {
	const response = await fetch(`${apiURL}/node/bootstrap/votes?start=${encodeURIComponent(start.toISOString())}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body['voteStaples'])) {
		throw(new Error(`no page of staples: ${JSON.stringify(body)}`));
	}
	return(body['voteStaples'].map(function(staple: unknown): string {
		if (!isRecord(staple) || typeof staple['$binary'] !== 'string') {
			throw(new Error('a staple was served without its bytes'));
		}
		return(new KeetaNet.lib.Vote.Staple(staple['$binary']).blocksHash.toString());
	}));
}
