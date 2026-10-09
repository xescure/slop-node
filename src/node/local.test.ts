import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import { APIDocument, isJSONObject } from '../conformance/api/document.js';
import { documentPathOf } from '../conformance/api/routes.js';
import type { Route as DocumentRoute } from '../conformance/api/routes.js';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { createLedgerError } from '../ledger/storage/errors.js';
import { driversUnderTest } from '../ledger/storage/suite/drivers.js';
import { checksumOf, requireAt } from '../ledger/storage/suite/support.js';
import { request, useLocalNodes } from '../testing/local-node.js';
import type { HTTPAnswer } from '../testing/local-node.js';
import { NODE_VERSION } from '../version.js';
import { LocalNodeError } from './errors.js';
import { SHUTDOWN_GRACE_MILLISECONDS } from './server.js';

const lib = KeetaNet.lib;

const api = new APIDocument();

const LOOPBACK = '127.0.0.1';

const SECRET = 'postgres://slop:hunter2@db.invalid/ledger';

const PEER_CAPTURE = new URL('../../conformance/api/mainnet/node-peers.json', import.meta.url);

const nodes = useLocalNodes();

function documentRoute(path: string): DocumentRoute {
	return({ method: 'GET', path: documentPathOf(path) });
}

function expectDocumented(path: string, answer: HTTPAnswer): void {
	expect(answer.contentType).toBe('application/json; charset=utf-8');
	expect(api.responseViolations(documentRoute(path), answer.status, answer.body)).toEqual([]);
}

function field(body: unknown, name: string): unknown {
	if (!isJSONObject(body)) {
		throw(new Error('the body is not an object'));
	}
	return(body[name]);
}

type CapturedPeer = {
	kind: number;
	key: string;
	endpoints: { api: string; p2p: string };
	preferUpdates: string;
	signature: string;
};

/** The first peer a live representative listed, exactly as it served it. */
function capturedPeer(): CapturedPeer {
	const capture: unknown = JSON.parse(readFileSync(PEER_CAPTURE, 'utf8'));
	const peers = field(field(capture, 'body'), 'peers');
	if (!Array.isArray(peers)) {
		throw(new Error('the capture lists no peers'));
	}
	const peer: unknown = peers[0];
	const kind = field(peer, 'kind');
	const key = field(peer, 'key');
	const endpoints = field(peer, 'endpoints');
	const preferUpdates = field(peer, 'preferUpdates');
	const signature = field(peer, 'signature');
	const api = field(endpoints, 'api');
	const p2p = field(endpoints, 'p2p');
	if (typeof kind !== 'number' || typeof key !== 'string' || typeof preferUpdates !== 'string' || typeof signature !== 'string' || typeof api !== 'string' || typeof p2p !== 'string') {
		throw(new Error('the first captured peer is not a signed representative'));
	}
	expect(Object.keys(peer ?? {}).sort()).toEqual(['endpoints', 'key', 'kind', 'preferUpdates', 'signature']);
	return({ kind, key, endpoints: { api, p2p }, preferUpdates, signature });
}

const NODE_GROUP = ['/node/version', '/node/stats', '/node/peers', '/node/ledger/checksum', '/node/ledger/clearstats'] as const;

describe.each(driversUnderTest)('the node group on the $name driver', function(driver) {
	test('every response validates against the document', async function() {
		const running = await nodes.start({ driver });
		for (const path of NODE_GROUP) {
			const answer = await request(running, path);
			expect(answer.status, path).toBe(200);
			expectDocumented(path, answer);
		}
	});

	test('the checksum covers every block the ledger holds', async function() {
		const running = await nodes.start({ driver });
		const answer = await request(running, '/node/ledger/checksum');
		expect(field(answer.body, 'checksum')).toBe(`0x${checksumOf([running.network.genesis]).toString(16).toUpperCase()}`);
	});
});

describe('the node group', function() {
	test('the version names the KeetaNet release the node speaks', async function() {
		const answer = await request(await nodes.start(), '/node/version');
		expect(answer.body).toEqual({ node: NODE_VERSION });
	});

	test('statistics are never cleared over the API', async function() {
		const answer = await request(await nodes.start(), '/node/ledger/clearstats');
		expect(answer.body).toEqual({ clearStats: false });
	});

	test('the statistics count the ledger', async function() {
		const running = await nodes.start();
		const answer = await request(running, '/node/stats');
		expect(field(field(answer.body, 'ledger'), 'blockCount')).toBe(running.network.genesis.blocks.length);
	});

	test('a peer is listed as the representative advertised itself', async function() {
		const running = await nodes.start();
		const peer = capturedPeer();
		await running.node.switch.config.kv.set('knownPeers', peer.key, peer);
		await running.node.switch.config.kv.set('lastSeenPeers', peer.key, String(Date.now()));
		const answer = await request(running, '/node/peers');
		expectDocumented('/node/peers', answer);
		expect(answer.body).toEqual({ peers: [peer] });
	});

	test('a node with no peers lists none, and not itself', async function() {
		const answer = await request(await nodes.start(), '/node/peers');
		expect(answer.body).toEqual({ peers: [] });
	});
});

describe('a failed request', function() {
	function failStatistics(storage: LedgerStorageDriverBase, error: unknown): void {
		vi.spyOn(storage, 'stats').mockRejectedValue(error);
	}

	test('a KeetaNet error is answered with status 500 as a refusal', async function() {
		const running = await nodes.start();
		failStatistics(running.storage, createLedgerError('LEDGER_INVALID_BALANCE', 'Balance would go negative'));
		const answer = await request(running, '/node/stats');
		expect(answer.status).toBe(500);
		expectDocumented('/node/stats', answer);
		expect(answer.body).toEqual({ error: true, type: 'LEDGER', code: 'LEDGER_INVALID_BALANCE', message: 'Balance would go negative' });
		expect(api.schemaViolations('ErrorRefusal', answer.body)).toEqual([]);
	});

	const hidden: readonly { readonly name: string; readonly error: unknown }[] = [
		{ name: 'a ledger error a driver wrapped', error: createLedgerError('LEDGER_OTHER', `connect ECONNREFUSED ${SECRET}`) },
		{ name: 'a plain Error', error: new Error(`could not reach ${SECRET}`) }
	];

	test.each(hidden)('$name is answered with status 500 and only an error ID, which the log records it under', async function({ error }) {
		const running = await nodes.start();
		failStatistics(running.storage, error);
		const answer = await request(running, '/node/stats');
		expect(answer.status).toBe(500);
		expectDocumented('/node/stats', answer);
		expect(api.schemaViolations('ErrorInternal', answer.body)).toEqual([]);
		expect(answer.text).not.toContain('hunter2');
		const message = field(answer.body, 'message');
		const errorID = /\(error ID: ([0-9a-f-]{36})\)$/.exec(String(message))?.[1];
		expect(errorID).toBeDefined();
		const recorded = running.logs.filter(function(entry): boolean {
			return(entry.options.currentRequestInfo?.id === errorID);
		});
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.level).toBe('ERROR');
		expect(recorded[0]?.args).toContain(error);
	});
});

describe('a request body that is no JSON', function() {
	test.each([
		'{"password": "hunter2',
		'hunter2 is no JSON',
		'"hunter2"x'
	])('is logged by its length and the parse error, never by its text (%j)', async function(body) {
		const running = await nodes.start();
		const answer = await request(running, '/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain('hunter2');
		// A body the parser refuses never reaches a route, which would sync the log after the request.
		await running.node.log.sync();
		const recorded = running.logs.filter(function(entry): boolean {
			return(entry.level === 'ERROR');
		});
		expect(recorded).toHaveLength(1);
		const written = inspect(recorded, { depth: 8 });
		expect(written).not.toContain('hunter2');
		expect(written).toContain(`a request body of ${String(body.length)} characters is no JSON`);
	});
});

/** Lets callers through only once the given number of them are waiting. */
function barrier(parties: number): () => Promise<void> {
	let arrived = 0;
	let release: () => void = function() {
		throw(new Error('released before anyone arrived'));
	};
	const released = new Promise<void>(function(resolve) {
		release = resolve;
	});
	return(function(): Promise<void> {
		arrived++;
		if (arrived === parties) {
			release();
		}
		return(released);
	});
}

describe('each request', function() {
	test('runs on a copy of its own, with a ledger of its own, and is synced after it', async function() {
		const running = await nodes.start();
		const copies: Node[] = [];
		const copy = running.node.copy.bind(running.node);
		vi.spyOn(running.node, 'copy').mockImplementation(function(): Node {
			const made = copy();
			copies.push(made);
			return(made);
		});
		const ledgerStatistics = vi.spyOn(lib.Ledger.prototype, 'stats');
		// Both requests are held inside the ledger until both have reached it.
		const bothInside = barrier(2);
		const countLedger = running.storage.stats.bind(running.storage);
		vi.spyOn(running.storage, 'stats').mockImplementation(async function() {
			await bothInside();
			return(await countLedger());
		});
		const synced = vi.spyOn(lib.Node.prototype, 'sync');

		const answers = await Promise.all([request(running, '/node/stats'), request(running, '/node/stats')]);
		expect(answers.map(function(answer): number {
			return(answer.status);
		})).toEqual([200, 200]);

		expect(copies).toHaveLength(2);
		expect(new Set(copies).size).toBe(2);
		expect(copies).not.toContain(running.node);
		const ledgers = ledgerStatistics.mock.contexts.filter(function(context): context is Ledger {
			return(context instanceof lib.Ledger);
		});
		expect(ledgerStatistics.mock.contexts).toHaveLength(2);
		expect(ledgers).toHaveLength(2);
		expect(new Set(ledgers).size).toBe(2);
		expect(ledgers).not.toContain(running.node.ledger);
		expect(new Set(ledgers.map(function(ledger): unknown {
			return(ledger.node);
		}))).toEqual(new Set(copies));
		expect(synced.mock.contexts).toHaveLength(2);
		expect(new Set(synced.mock.contexts)).toEqual(new Set(copies));

		// A request's ledger opens its transactions for that request's copy alone.
		const transactions = vi.spyOn(running.storage, 'beginTransaction');
		const representative = requireAt(running.network.representatives, 0);
		await Promise.all(ledgers.map(function(ledger): Promise<bigint> {
			return(ledger.votingPower(representative));
		}));
		const transactionNodes = transactions.mock.calls.map(function([options]): unknown {
			return(options.node);
		});
		expect(new Set(transactionNodes)).toEqual(new Set(copies));
		expect(new Set(transactions.mock.results).size).toBe(2);
	});

	test('is not synced when the node is told not to', async function() {
		const running = await nodes.start({ nodeOptions: { noSyncAfterEachRoute: true } });
		const synced = vi.spyOn(lib.Node.prototype, 'sync');
		expect((await request(running, '/node/version')).status).toBe(200);
		expect(synced).not.toHaveBeenCalled();
	});

	test('is answered with the headers a browser needs to read it', async function() {
		const running = await nodes.start();
		const answer = await fetch(`${running.apiURL}/node/version`);
		expect(answer.headers.get('access-control-allow-origin')).toBe('*');
		const preflight = await fetch(`${running.apiURL}/node/version`, {
			method: 'OPTIONS',
			headers: { origin: 'https://wallet.invalid', 'access-control-request-method': 'GET' }
		});
		expect(preflight.status).toBe(200);
		expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
		expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, PUT, POST, OPTIONS');
		expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type, user-agent, accept');
	});

	test('for a path the API does not have is not found, in the HTTP server\'s own words', async function() {
		const answer = await request(await nodes.start(), '/node/nothing');
		expect(answer.status).toBe(404);
		expect(answer.contentType).toBe('text/html; charset=utf-8');
		expect(answer.text).toContain('<pre>Cannot GET /api/node/nothing</pre>');
	});

	test('that fails outside every route is answered without the failure\'s details', async function() {
		const running = await nodes.start();
		running.node._app.get('/outside', function(): never {
			throw(new Error(`could not reach ${SECRET}`));
		});
		const answer = await fetch(new URL('/outside', running.apiURL));
		const text = await answer.text();
		expect(answer.status).toBe(500);
		expect(text).not.toContain('hunter2');
		expect(text).not.toMatch(/\bat /);
	});
});

describe('the lifecycle', function() {
	test('a node without endpoints advertises where it listens', async function() {
		const running = await nodes.start();
		const { port } = new URL(running.apiURL);
		expect(running.node.config.endpoints).toEqual({
			api: `http://${LOOPBACK}:${port}/api`,
			p2p: `ws://${LOOPBACK}:${port}/p2p`
		});
	});

	test('the API is served below the path of the configured endpoint', async function() {
		const port = await unusedPort();
		const endpoints = { api: `http://${LOOPBACK}:${String(port)}/keeta/api`, p2p: `ws://${LOOPBACK}:${String(port)}/keeta/p2p` };
		const running = await nodes.start({ endpoints, nodeOptions: { listenPort: port } });
		expect(running.node.config.endpoints).toEqual(endpoints);
		expect((await request(running, '/node/version')).status).toBe(200);
	});

	test('stopping releases the port', async function() {
		const running = await nodes.start();
		await running.node.stop();
		await expect(request(running, '/node/version')).rejects.toThrow();
		await listenAndClose(Number(new URL(running.apiURL).port));
	});

	test('stopping waits for a request in flight only for the grace period', async function() {
		const running = await nodes.start();
		const inside = barrier(2);
		const neverAnswered = new Promise<never>(function() {
			// The request is held until the server drops its connection.
		});
		vi.spyOn(running.storage, 'stats').mockImplementation(async function() {
			await inside();
			return(await neverAnswered);
		});
		const held = request(running, '/node/stats').then(function(): string {
			return('answered');
		}, function(): string {
			return('dropped');
		});
		await inside();
		// Only the grace timer is faked; the clock freezeClock set is released with it.
		vi.useRealTimers();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		let stoppedYet = false;
		const stopped = running.node.stop().then(function(): void {
			stoppedYet = true;
		});
		await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MILLISECONDS - 1);
		expect(stoppedYet).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		vi.useRealTimers();
		await stopped;
		expect(await held).toBe('dropped');
	});

	test('a node listening on every interface needs endpoints to advertise', async function() {
		const created = await nodes.create({ nodeOptions: { listenIP: '0.0.0.0', listenPort: 0 } });
		await expect(created.node.run()).rejects.toBeInstanceOf(LocalNodeError);
	});

	test('a running node cannot be run again', async function() {
		const running = await nodes.start();
		await expect(running.node.run()).rejects.toThrow(LocalNodeError);
	});
});

function listenAndClose(port: number): Promise<number> {
	const server = createServer();
	return(new Promise<number>(function(resolve, reject) {
		server.once('error', reject);
		server.listen(port, LOOPBACK, function() {
			const address = server.address();
			server.close(function() {
				if (address === null || typeof address === 'string') {
					reject(new Error('the server has no port'));
					return;
				}
				resolve(address.port);
			});
		});
	}));
}

/** A port nothing listens on, found by letting the system choose one and releasing it. */
function unusedPort(): Promise<number> {
	return(listenAndClose(0));
}
