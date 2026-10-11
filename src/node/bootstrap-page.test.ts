import { readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, onTestFinished, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { P2PInternals } from '../upstream/internals.js';
import { NODE_VERSION } from '../version.js';
import { MAX_PAGE_BYTES, MAX_SINGLE_STAPLE_PAGE_BYTES, PageError, PageFetcher } from './bootstrap-page.js';
import type { PageProblem, PageRequest } from './bootstrap-page.js';

const lib = KeetaNet.lib;

/** A staple a main network representative served, as its bytes in base64. */
async function servedStaple(): Promise<string> {
	const parsed: unknown = JSON.parse(await readFile(new URL('../testing/fixtures/mainnet-rep1-epoch-page.json', import.meta.url), 'utf8'));
	if (typeof parsed !== 'object' || parsed === null || !('voteStaples' in parsed) || !Array.isArray(parsed.voteStaples) || typeof parsed.voteStaples[0] !== 'string') {
		throw(new Error('the fixture holds no staple'));
	}
	return(parsed.voteStaples[0]);
}

const START = new Date('2026-10-07T12:00:00.000Z');

function portOf(server: net.Server): number {
	const address: AddressInfo | string | null = server.address();
	if (address === null || typeof address === 'string') {
		throw(new Error('the server has no port'));
	}
	return(address.port);
}

/** Listens until the test ends, when the connections still open are ended first, as the server waits for them to close. */
async function listening(server: net.Server, endConnections: () => void): Promise<number> {
	await new Promise<void>(function(resolve, reject) {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	onTestFinished(async function() {
		endConnections();
		await new Promise<void>(function(resolve) {
			server.close(function() {
				resolve();
			});
		});
	});
	return(portOf(server));
}

type Received = { readonly url: string; readonly headers: http.IncomingHttpHeaders };

/** A peer whose every answer the test writes, recording each request and how many connections it was sent on. */
async function peerAnswering(answer: (response: http.ServerResponse) => void): Promise<{ readonly endpoint: string; readonly received: Received[]; readonly connections: () => number }> {
	const received: Received[] = [];
	let connections = 0;
	const server = http.createServer(function(request, response): void {
		received.push({ url: request.url ?? '', headers: request.headers });
		answer(response);
	});
	server.on('connection', function(): void {
		connections++;
	});
	return({ endpoint: `http://127.0.0.1:${String(await listening(server, function(): void {
		server.closeAllConnections();
	}))}/api`, received, connections: function(): number {
		return(connections);
	} });
}

/** A peer that accepts connections and never writes to them, so that not even a TLS handshake completes. */
async function mutePeer(): Promise<{ readonly port: number; readonly connected: Promise<void> }> {
	const sockets: net.Socket[] = [];
	let markConnected: (() => void) | undefined;
	const connected = new Promise<void>(function(resolve) {
		markConnected = resolve;
	});
	const server = net.createServer(function(socket): void {
		sockets.push(socket);
		markConnected?.();
	});
	return({ port: await listening(server, function(): void {
		for (const socket of sockets) {
			socket.destroy();
		}
	}), connected });
}

function answerWith(status: number, body: string): (response: http.ServerResponse) => void {
	return(function(response): void {
		response.writeHead(status, { 'content-type': 'application/json' });
		response.end(body);
	});
}

function requestOf(endpoint: string, limit = 2): PageRequest {
	return({ endpoint, start: START, limit, bloomFilter: undefined });
}

function fetcher(): PageFetcher {
	const made = new PageFetcher();
	onTestFinished(function() {
		made.close();
	});
	return(made);
}

const NOT_STOPPED = new AbortController().signal;

/** The PageError the page fails with. */
async function problemOf(page: Promise<unknown>): Promise<PageError> {
	const error = await page.then(function(): never {
		throw(new Error('expected the page to fail'));
	}, function(failure: unknown): unknown {
		return(failure);
	});
	if (!(error instanceof PageError)) {
		throw(new Error(`expected a PageError, not ${String(error)}`, { cause: error }));
	}
	return(error);
}

describe('a page of a peer\'s staples', function() {
	test('is asked for below the endpoint with the start, the limit and the filter, as JSON, by this node, over one connection', async function() {
		const staple = await servedStaple();
		const peer = await peerAnswering(answerWith(200, JSON.stringify({ voteStaples: [{ $binary: staple, blocks: [] }, staple] })));
		const pages = fetcher();

		const first = await pages.page({ ...requestOf(peer.endpoint, 7), bloomFilter: 'AAAA' }, 30_000, NOT_STOPPED);
		await pages.page(requestOf(peer.endpoint), 30_000, NOT_STOPPED);

		expect(first.map(function(each): string {
			return(Buffer.from(each.toBytes()).toString('base64'));
		})).toEqual([staple, staple]);
		expect(first[0]).toBeInstanceOf(lib.Vote.Staple);
		expect(peer.received.map(function({ url }): string {
			return(url);
		})).toEqual([
			`/api/node/bootstrap/votes?start=${encodeURIComponent(START.toISOString())}&limit=7&bloomFilter=AAAA`,
			`/api/node/bootstrap/votes?start=${encodeURIComponent(START.toISOString())}&limit=2`
		]);
		expect(peer.received[0]?.headers).toMatchObject({ accept: 'application/json', 'user-agent': `slop-node/${NODE_VERSION}` });
		// Kept alive between pages.
		expect(peer.connections()).toBe(1);
	});

	test.each<[string, number, string, PageProblem, string]>([
		['a status with the message of the peer\'s error', 500, JSON.stringify({ error: true, message: 'An internal error occurred' }), { kind: 'status', status: 500, message: 'An internal error occurred' }, 'answered 500: An internal error occurred'],
		['a status alone when the peer\'s error has no message', 503, 'Service Unavailable', { kind: 'status', status: 503, message: undefined }, 'answered 503'],
		['a status alone when the message is not text', 502, JSON.stringify({ message: 5 }), { kind: 'status', status: 502, message: undefined }, 'answered 502'],
		['a status alone when the error is no object', 502, JSON.stringify(['message']), { kind: 'status', status: 502, message: undefined }, 'answered 502'],
		['at most 200 characters of the peer\'s message', 500, JSON.stringify({ message: 'x'.repeat(300) }), { kind: 'status', status: 500, message: 'x'.repeat(200) }, `answered 500: ${'x'.repeat(200)}`],
		['a body that is no JSON', 200, 'not JSON', { kind: 'malformed', detail: 'the body is no JSON' }, 'answered with no page of staples: the body is no JSON'],
		['a body of null', 200, 'null', { kind: 'malformed', detail: 'it holds no voteStaples list' }, 'answered with no page of staples: it holds no voteStaples list'],
		['a body with no list of staples', 200, JSON.stringify({ voteStaples: {} }), { kind: 'malformed', detail: 'it holds no voteStaples list' }, 'answered with no page of staples: it holds no voteStaples list'],
		['a staple written with no bytes', 200, JSON.stringify({ voteStaples: [{ blocks: [] }] }), { kind: 'malformed', detail: 'a staple carries no bytes' }, 'answered with no page of staples: a staple carries no bytes'],
		['a staple written as a number', 200, JSON.stringify({ voteStaples: [5] }), { kind: 'malformed', detail: 'a staple carries no bytes' }, 'answered with no page of staples: a staple carries no bytes'],
		['a staple written as null', 200, JSON.stringify({ voteStaples: [null] }), { kind: 'malformed', detail: 'a staple carries no bytes' }, 'answered with no page of staples: a staple carries no bytes'],
		['a staple whose bytes are no text', 200, JSON.stringify({ voteStaples: [{ $binary: 5 }] }), { kind: 'malformed', detail: 'a staple carries no bytes' }, 'answered with no page of staples: a staple carries no bytes'],
		['bytes that are no staple', 200, JSON.stringify({ voteStaples: ['AAAA'] }), { kind: 'malformed', detail: 'a staple cannot be read' }, 'answered with no page of staples: a staple cannot be read']
	])('fails, naming the peer, on %s', async function(_ignored: string, status: number, body: string, problem: PageProblem, message: string) {
		const peer = await peerAnswering(answerWith(status, body));

		const error = await problemOf(fetcher().page(requestOf(peer.endpoint), 30_000, NOT_STOPPED));

		expect(error.problem).toEqual(problem);
		expect(error.message).toBe(`${peer.endpoint} ${message}`);
		expect(error.name).toBe('PageError');
	});

	test('keeps what made a staple or a body unreadable as the cause', async function() {
		const unreadable = await peerAnswering(answerWith(200, JSON.stringify({ voteStaples: ['AAAA'] })));
		const noJSON = await peerAnswering(answerWith(200, '{'));

		expect((await problemOf(fetcher().page(requestOf(unreadable.endpoint), 30_000, NOT_STOPPED))).cause).toBeInstanceOf(Error);
		expect((await problemOf(fetcher().page(requestOf(noJSON.endpoint), 30_000, NOT_STOPPED))).cause).toBeInstanceOf(SyntaxError);
	});

	test('of several staples holds at most MAX_PAGE_BYTES, and of one the largest staple a peer accepts written as JSON', async function() {
		const padded = function(bytes: number): string {
			const body = JSON.stringify({ voteStaples: [] });
			return(body + ' '.repeat(bytes - body.length));
		};
		const atBound = await peerAnswering(answerWith(200, padded(MAX_PAGE_BYTES)));
		const pastBound = await peerAnswering(answerWith(200, padded(MAX_PAGE_BYTES + 1)));

		expect(await fetcher().page(requestOf(atBound.endpoint), 30_000, NOT_STOPPED)).toEqual([]);
		const error = await problemOf(fetcher().page(requestOf(pastBound.endpoint), 30_000, NOT_STOPPED));
		expect(error.problem).toEqual({ kind: 'too-large', limitBytes: MAX_PAGE_BYTES });
		expect(error.message).toBe(`${pastBound.endpoint} answered with more than ${String(MAX_PAGE_BYTES)} bytes`);
		expect(MAX_SINGLE_STAPLE_PAGE_BYTES).toBe(4 * P2PInternals.P2P_WEBSOCKET_MAX_PAYLOAD_BYTES);
		expect(await fetcher().page(requestOf(pastBound.endpoint, 1), 30_000, NOT_STOPPED)).toEqual([]);
	});

	test.each(['http', 'https'])('fails over %s once the timeout passes, naming it, or once stopped', async function(protocol: string) {
		const endpoint = `${protocol}://127.0.0.1:${String((await mutePeer()).port)}/api`;

		const timedOut = await problemOf(fetcher().page(requestOf(endpoint), 50, NOT_STOPPED));
		expect(timedOut.problem).toEqual({ kind: 'timeout', milliseconds: 50 });
		expect(timedOut.message).toBe(`${endpoint} did not answer within 50 ms`);
		expect(timedOut.cause).toBeInstanceOf(Error);

		const stopping = new AbortController();
		const page = fetcher().page(requestOf(endpoint), 30_000, stopping.signal);
		stopping.abort();
		const stopped = await problemOf(page);
		expect(stopped.problem).toEqual({ kind: 'stopped' });
		expect(stopped.message).toBe(`the request to ${endpoint} was stopped`);
		expect(stopped.cause).toBeInstanceOf(Error);
	});

	test.each(['http', 'https'])('ends with the fetcher\'s connections over %s, failing a page under way', async function(protocol: string) {
		const peer = await mutePeer();
		const endpoint = `${protocol}://127.0.0.1:${String(peer.port)}/api`;
		const pages = new PageFetcher();
		// Longer than the test may run, so that only the close ends the page.
		const page = pages.page(requestOf(endpoint), 10 * 60_000, NOT_STOPPED);
		await peer.connected;

		pages.close();

		await expect(page).rejects.toThrow();
	});

	test('fails a page whose answer ends before its length', async function() {
		const peer = await peerAnswering(function(response): void {
			response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
			response.write('{"voteStaples":[');
			response.socket?.destroy();
		});

		await expect(fetcher().page(requestOf(peer.endpoint), 10 * 60_000, NOT_STOPPED)).rejects.toThrow();
	});

	test('fails at once for an endpoint that is no http:// or https:// URL', async function() {
		const error = await problemOf(fetcher().page(requestOf('ftp://127.0.0.1/api'), 30_000, NOT_STOPPED));

		expect(error.problem).toEqual({ kind: 'protocol' });
		expect(error.message).toBe('ftp://127.0.0.1/api is no http:// or https:// URL');
	});
});

describe('the staple holding a block, as a peer holds it', function() {
	/** A peer answering for the fixture's staple: its votes on any of its blocks, and each of its blocks, as the routes the client asks. */
	async function holder(options: { readonly votes?: 'none'; readonly missingBlock?: boolean; readonly status?: number } = {}): Promise<{ readonly endpoint: string; readonly received: Received[]; readonly staple: InstanceType<typeof lib.Vote.Staple> }> {
		const staple = new lib.Vote.Staple(await servedStaple());
		const peer = await peerAnswering(function(response): void {
			const url = peer.received.at(-1)?.url ?? '';
			if (options.status !== undefined) {
				answerWith(options.status, JSON.stringify({ error: true, message: 'An internal error occurred' }))(response);
				return;
			}
			if (url.includes('/vote/')) {
				let votes: { readonly $binary: string }[] | null = staple.votes.map(function(vote): { readonly $binary: string } {
					return({ $binary: Buffer.from(vote.toBytes()).toString('base64') });
				});
				if (options.votes === 'none') {
					votes = null;
				}
				answerWith(200, JSON.stringify({ blockhash: 'x', votes }))(response);
				return;
			}
			const block = staple.blocks.find(function(held): boolean {
				return(url.includes(held.hash.toString()));
			});
			let written: { readonly $binary: string } | null = null;
			if (block !== undefined && options.missingBlock !== true) {
				written = { $binary: Buffer.from(block.toBytes()).toString('base64') };
			}
			answerWith(200, JSON.stringify({ blockhash: 'x', block: written }))(response);
		});
		return({ ...peer, staple });
	}

	function counting(): { readonly pace: <Result>(request: () => Promise<Result>) => Promise<Result>; readonly paced: () => number } {
		let paced = 0;
		return({ pace: function<Result>(request: () => Promise<Result>): Promise<Result> {
			paced++;
			return(request());
		}, paced: function(): number {
			return(paced);
		} });
	}

	test('is built from the votes on the block and each block they cover, each request paced, as the client builds it', async function() {
		const { endpoint, received, staple } = await holder();
		const [block] = staple.blocks;
		if (block === undefined) {
			throw(new Error('the fixture staple holds no block'));
		}
		const { pace, paced } = counting();

		const found = await fetcher().stapleHolding(endpoint, block.hash, 1000, NOT_STOPPED, pace);

		expect(found?.blocksHash.toString()).toBe(staple.blocksHash.toString());
		expect(received.map(function({ url }): string {
			return(url);
		})).toEqual([`/api/vote/${block.hash.toString()}?side=main`, ...staple.blocks.map(function(held): string {
			return(`/api/node/ledger/block/${held.hash.toString()}?side=main`);
		})]);
		expect(paced()).toBe(received.length);
	});

	test('is none when the peer holds no votes on the block, or lacks a block they cover', async function() {
		const none = await holder({ votes: 'none' });
		const missing = await holder({ missingBlock: true });
		const [block] = none.staple.blocks;
		if (block === undefined) {
			throw(new Error('the fixture staple holds no block'));
		}

		expect(await fetcher().stapleHolding(none.endpoint, block.hash, 1000, NOT_STOPPED, counting().pace)).toBeUndefined();
		expect(none.received).toHaveLength(1);
		expect(await fetcher().stapleHolding(missing.endpoint, block.hash, 1000, NOT_STOPPED, counting().pace)).toBeUndefined();
	});

	test('fails on an answer of another status, on a staple that lacks the block, and once the timeout passes', async function() {
		const failing = await holder({ status: 500 });
		const other = await holder();
		const [block] = failing.staple.blocks;
		if (block === undefined) {
			throw(new Error('the fixture staple holds no block'));
		}
		const outside = new lib.Block.Hash(Buffer.alloc(32, 7));

		expect((await problemOf(fetcher().stapleHolding(failing.endpoint, block.hash, 1000, NOT_STOPPED, counting().pace))).problem).toEqual({ kind: 'status', status: 500, message: 'An internal error occurred' });
		expect((await problemOf(fetcher().stapleHolding(other.endpoint, outside, 1000, NOT_STOPPED, counting().pace))).problem).toEqual({ kind: 'malformed', detail: `the staple it holds for block ${outside.toString()} lacks it` });
		const endpoint = `http://127.0.0.1:${String((await mutePeer()).port)}/api`;
		const timedOut = await problemOf(fetcher().stapleHolding(endpoint, block.hash, 50, NOT_STOPPED, counting().pace));
		expect(timedOut.problem).toEqual({ kind: 'timeout', milliseconds: 50 });
		expect(timedOut.cause).toBeInstanceOf(Error);
	});

	test('fails once stopped, keeping what stopped it as the cause', async function() {
		const peer = await mutePeer();
		const endpoint = `http://127.0.0.1:${String(peer.port)}/api`;
		const stopping = new AbortController();
		const asked = fetcher().stapleHolding(endpoint, new lib.Block.Hash(Buffer.alloc(32, 7)), 30_000, stopping.signal, counting().pace);
		await peer.connected;
		stopping.abort();

		const stopped = await problemOf(asked);

		expect(stopped.problem).toEqual({ kind: 'stopped' });
		expect(stopped.cause).toBeInstanceOf(Error);
	});

	test('leaves no timer running once it has its answers', async function() {
		const { endpoint, staple } = await holder();
		const [block] = staple.blocks;
		if (block === undefined) {
			throw(new Error('the fixture staple holds no block'));
		}
		const timers = function(): number {
			return(process.getActiveResourcesInfo().filter(function(resource): boolean {
				return(resource === 'Timeout');
			}).length);
		};
		const before = timers();

		await fetcher().stapleHolding(endpoint, block.hash, 30_000, NOT_STOPPED, counting().pace);

		expect(timers()).toBe(before);
	});

	/** A peer answering the votes route and the block route with the bodies given, and otherwise as the fixture's staple's holder does. */
	async function answering(votes: unknown, block: unknown): Promise<{ readonly endpoint: string; readonly hash: InstanceType<typeof lib.Block.Hash> }> {
		const staple = new lib.Vote.Staple(await servedStaple());
		const peer = await peerAnswering(function(response): void {
			const url = peer.received.at(-1)?.url ?? '';
			let body = block;
			if (url.includes('/vote/')) {
				body = votes;
			}
			answerWith(200, JSON.stringify(body))(response);
		});
		const [first] = staple.blocks;
		if (first === undefined) {
			throw(new Error('the fixture staple holds no block'));
		}
		return({ endpoint: peer.endpoint, hash: first.hash });
	}

	test.each<[string, unknown, unknown, PageProblem]>([
		['votes that are no record', [], {}, { kind: 'malformed', detail: 'it holds no votes' }],
		['no votes', { blockhash: 'x' }, {}, { kind: 'malformed', detail: 'it holds no votes' }],
		['votes that are no list', { votes: 5 }, {}, { kind: 'malformed', detail: 'its votes are no list' }],
		['a vote with no bytes', { votes: [{}] }, {}, { kind: 'malformed', detail: 'a vote carries no bytes' }],
		['a vote that cannot be read', { votes: [{ $binary: 'AAAA' }] }, {}, { kind: 'malformed', detail: 'a vote cannot be read' }],
		['a block answer that is no record', 'votes', [], { kind: 'malformed', detail: 'it holds no block' }],
		['no block', 'votes', { blockhash: 'x' }, { kind: 'malformed', detail: 'it holds no block' }],
		['a block with no bytes', 'votes', { block: {} }, { kind: 'malformed', detail: 'a block carries no bytes' }],
		['a block that cannot be read', 'votes', { block: { $binary: 'AAAA' } }, { kind: 'malformed', detail: 'a block cannot be read' }],
		['a block the votes do not cover', 'votes', 'other block', { kind: 'malformed', detail: 'its votes and blocks make no staple' }]
	])('fails on an answer with %s', async function(_ignored: string, votes: unknown, block: unknown, problem: PageProblem) {
		const page: unknown = JSON.parse(await readFile(new URL('../testing/fixtures/mainnet-rep1-epoch-page.json', import.meta.url), 'utf8'));
		const written = (page as { readonly voteStaples: readonly string[] }).voteStaples;
		const [own, other] = written.map(function(encoded): InstanceType<typeof lib.Vote.Staple> {
			return(new lib.Vote.Staple(encoded));
		});
		if (own === undefined || other === undefined) {
			throw(new Error('the fixture holds fewer than two staples'));
		}
		const binary = function(bytes: ArrayBuffer): { readonly $binary: string } {
			return({ $binary: Buffer.from(bytes).toString('base64') });
		};
		let votesAnswer = votes;
		if (votes === 'votes') {
			votesAnswer = { votes: own.votes.map(function(vote): { readonly $binary: string } {
				return(binary(vote.toBytes()));
			}) };
		}
		let blockAnswer = block;
		if (block === 'other block') {
			blockAnswer = { block: binary(other.blocks[0]?.toBytes() ?? new ArrayBuffer(0)) };
		}
		const { endpoint, hash } = await answering(votesAnswer, blockAnswer);

		const failed = await problemOf(fetcher().stapleHolding(endpoint, hash, 30_000, NOT_STOPPED, counting().pace));

		expect(failed.problem).toEqual(problem);
	});
});
