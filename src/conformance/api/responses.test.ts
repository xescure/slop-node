import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import { MemoryLedgerStorage } from '../../ledger/storage/memory/driver.js';
import { confirmedStaple, sendBlock } from '../../testing/blocks.js';
import { createTestNetwork, freezeClock } from '../../testing/network.js';
import type { TestNetwork } from '../../testing/network.js';
import { APIDocument, isJSONObject } from './document.js';
import { routeOfRequest } from './routes.js';
import type { Route } from './routes.js';

const lib = KeetaNet.lib;

const CAPTURE_DIRECTORY = new URL('../../../conformance/api/mainnet/', import.meta.url);
const FIXTURE_DIRECTORY = new URL('../../../conformance/api/fixtures/', import.meta.url);

const api = new APIDocument();

/** A GET that clears the representative's statistics changes its state, so the capture leaves it out. */
const UNCAPTURED_ROUTES: ReadonlySet<string> = new Set(['GET /api/node/ledger/clearstats']);

/** The route each fixture was served by, all with status 200. */
const FIXTURE_ROUTES: Readonly<Record<string, string>> = {
	'account_base_token.json': '/api/node/ledger/account/{account}',
	'account_storage.json': '/api/node/ledger/account/{account}',
	'account_with_representative.json': '/api/node/ledger/account/{account}',
	'acl_granted_base_token.json': '/api/node/ledger/account/{account}/acl/granted',
	'balance.json': '/api/node/ledger/account/{account}/balance',
	'head_base_token.json': '/api/node/ledger/account/{account}/head',
	'head_no_chain.json': '/api/node/ledger/account/{account}/head',
	'representatives.json': '/api/node/ledger/representatives'
};

type Capture = {
	readonly request: { readonly method: 'GET'; readonly path: string; readonly query: Readonly<Record<string, string>> };
	readonly status: number;
	readonly contentType: string | null;
	readonly body: unknown;
};

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
	return(isJSONObject(value) && Object.values(value).every(function(entry): boolean {
		return(typeof entry === 'string');
	}));
}

function readJSON(file: URL): unknown {
	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
	return(parsed);
}

function readCapture(name: string): Capture {
	const parsed = readJSON(new URL(name, CAPTURE_DIRECTORY));
	if (!isJSONObject(parsed) || !isJSONObject(parsed['request']) || !isJSONObject(parsed['headers'])) {
		throw(new Error(`${name}: not a capture`));
	}
	const { request, headers, status } = parsed;
	const { method, path, query } = request;
	const contentType = headers['content-type'];
	if (method !== 'GET' || typeof path !== 'string' || !isStringRecord(query) || typeof status !== 'number' || (typeof contentType !== 'string' && contentType !== null)) {
		throw(new Error(`${name}: not a GET capture`));
	}
	return({ request: { method, path, query }, status, contentType, body: parsed['body'] });
}

function jsonFiles(directory: URL): readonly string[] {
	return(readdirSync(directory).filter(function(name): boolean {
		return(name.endsWith('.json'));
	}).sort());
}

function spelled(route: Route): string {
	return(`${route.method} ${route.path}`);
}

function documentRoute(method: Route['method'], path: string): Route {
	const route = api.routes.find(function(candidate): boolean {
		return(candidate.method === method && candidate.path === path);
	});
	if (route === undefined) {
		throw(new Error(`the document has no ${method} ${path}`));
	}
	return(route);
}

function routeOfCapture(capture: Capture): Route {
	return(routeOfRequest(api.routes, capture.request.method, capture.request.path));
}

/** Serialized for a response as the client expects to decode it, binary encoding included. */
function serialized(value: unknown): unknown {
	return(lib.Utils.Conversion.toJSONSerializable(value, { addBinary: true }));
}

function decodeStaple(binary: string): InstanceType<typeof lib.Vote.Staple> {
	return(new lib.Vote.Staple(Buffer.from(binary, 'base64')));
}

/** The library value a JSON object with "$binary" encodes, told apart by the fields only that kind of value has. */
function decodeBinary(json: Readonly<Record<string, unknown>>, binary: string): unknown {
	if ('votes' in json && 'blocks' in json) {
		return(decodeStaple(binary));
	}
	if ('issuer' in json) {
		return(new lib.Vote(Buffer.from(binary, 'base64')));
	}
	if ('operations' in json) {
		return(new lib.Block(Buffer.from(binary, 'base64')));
	}
	return(undefined);
}

type BinaryValue = {
	readonly json: Readonly<Record<string, unknown>>;
	readonly decoded: unknown;
};

/** Every staple, vote and block in a body that carries its binary encoding; a certificate's PEM "$binary" is not one. */
function binaryValues(value: unknown): readonly BinaryValue[] {
	if (Array.isArray(value)) {
		return(value.flatMap(binaryValues));
	}
	if (!isJSONObject(value)) {
		return([]);
	}
	const binary = value['$binary'];
	if (typeof binary === 'string') {
		const decoded = decodeBinary(value, binary);
		if (decoded !== undefined) {
			return([{ json: value, decoded }]);
		}
	}
	return(Object.values(value).flatMap(binaryValues));
}

type HistoryEntry = {
	readonly id: unknown;
	readonly stapleBinary: string;
};

function historyPage(body: unknown): { readonly entries: readonly HistoryEntry[]; readonly nextKey: unknown } {
	if (!isJSONObject(body) || !Array.isArray(body['history'])) {
		throw(new Error('a history page without "history"'));
	}
	const entries = body['history'].map(function(entry: unknown): HistoryEntry {
		if (!isJSONObject(entry) || !isJSONObject(entry['voteStaple']) || typeof entry['voteStaple']['$binary'] !== 'string') {
			throw(new Error('a history entry without a staple'));
		}
		return({ id: entry['$id'], stapleBinary: entry['voteStaple']['$binary'] });
	});
	return({ entries, nextKey: body['nextKey'] });
}

const captures = jsonFiles(CAPTURE_DIRECTORY);

describe('responses a mainnet representative gave', function() {
	test.each(captures)('%s validates against the document', function(name) {
		const capture = readCapture(name);

		expect(capture.contentType).toMatch(/^application\/json(?:;|$)/);
		expect(api.responseViolations(routeOfCapture(capture), capture.status, capture.body)).toEqual([]);
	});

	test('every GET route of the document is captured, but the one that changes state', function() {
		const captured = new Set(captures.map(function(name): string {
			return(spelled(routeOfCapture(readCapture(name))));
		}));
		const expected = api.routes.filter(function(route): boolean {
			return(route.method === 'GET' && !UNCAPTURED_ROUTES.has(spelled(route)));
		}).map(spelled);

		expect([...captured].sort()).toEqual(expected);
	});

	test('a representative answers with 200 or, on any failure, 500, and every operation documents both', function() {
		const statuses = new Set(captures.map(function(name): number {
			return(readCapture(name).status);
		}));

		expect([...statuses].sort()).toEqual([200, 500]);
		for (const route of api.routes) {
			expect(api.statuses(route)).toEqual(['200', '500']);
		}
	});

	test('the "$id" of a history entry is the hash of the blocks of its staple, and "nextKey" the last "$id" of the page', function() {
		const pages = captures.map(readCapture).filter(function(capture): boolean {
			return(capture.status === 200 && routeOfCapture(capture).path.includes('/history'));
		}).map(function(capture) {
			return(historyPage(capture.body));
		});

		expect(pages.length).toBeGreaterThan(0);
		for (const { entries, nextKey } of pages) {
			const ids = entries.map(function({ id }): unknown {
				return(id);
			});
			const blocksHashes = entries.map(function({ stapleBinary }): string {
				return(decodeStaple(stapleBinary).blocksHash.toString());
			});
			expect(ids).toEqual(blocksHashes);
			expect(nextKey).toBe(ids.at(-1) ?? null);
		}
	});
});

describe('responses carried over from an independent implementation', function() {
	test('every fixture has its route', function() {
		expect(jsonFiles(FIXTURE_DIRECTORY)).toEqual(Object.keys(FIXTURE_ROUTES).sort());
	});

	test.each(Object.entries(FIXTURE_ROUTES))('%s validates against the document', function(name, path) {
		expect(api.responseViolations(documentRoute('GET', path), 200, readJSON(new URL(name, FIXTURE_DIRECTORY)))).toEqual([]);
	});
});

describe('the values the responses carry', function() {
	test('every staple, vote and block is exactly the library serialization of its "$binary"', function() {
		const bodies = [
			...captures.map(function(name): unknown {
				return(readCapture(name).body);
			}),
			...jsonFiles(FIXTURE_DIRECTORY).map(function(name): unknown {
				return(readJSON(new URL(name, FIXTURE_DIRECTORY)));
			})
		];
		const values = bodies.flatMap(binaryValues);

		expect(values.length).toBeGreaterThan(0);
		for (const { json, decoded } of values) {
			expect(serialized(decoded)).toEqual(json);
		}
	});

	test('the document refuses a body that breaks it', function() {
		const route = documentRoute('GET', '/api/node/ledger/account/{account}/head');
		const head = { account: 'keeta_aabx4z7qrrsongdomou3l6vcyuaovnfo6s3wlm4v3vub6zu4xhte5ntk6qifixa', block: null, height: null };

		expect(api.responseViolations(route, 200, head)).toEqual([]);
		expect(api.responseViolations(route, 200, { ...head, height: '0x01' })).not.toEqual([]);
		expect(api.responseViolations(route, 200, { ...head, extra: true })).not.toEqual([]);
		expect(api.responseViolations(route, 500, { error: true })).not.toEqual([]);
		expect(api.responseViolations(route, 404, head)).toEqual(['GET /api/node/ledger/account/{account}/head documents no 404 response']);
	});
});

const START = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/** Where the local representative says it serves; nothing is ever sent there. */
const LOCAL_ENDPOINTS = { api: 'https://representative.invalid/api', p2p: 'wss://representative.invalid/p2p' } as const;

/** A staple travels between peers with this many hops left [Keeta TS] index.js:71404. */
const ADD_MESSAGE_TTL = 30;

/** The client sends every block, vote, quote and staple as the base64 of its bytes. */
function base64(bytes: ArrayBuffer): string {
	return(Buffer.from(bytes).toString('base64'));
}

type LocalNetwork = {
	readonly network: TestNetwork;
	readonly representative: Account;
	readonly other: Account;
	/** The representative's ledger, which charges a fee so its quotes and votes carry one. */
	readonly ledger: Ledger;
	readonly block: Block;
};

/** A send by user 0, after its previous block, or after its genesis head when none is given. */
async function sendFromUser(network: TestNetwork, previous?: Block): Promise<Block> {
	const [user, other] = network.users;
	const head = network.genesis.blocks.filter(function(block): boolean {
		return(user !== undefined && block.account.comparePublicKey(user));
	}).at(-1);
	if (user === undefined || other === undefined || head === undefined) {
		throw(new Error('the network has no users'));
	}
	return(await sendBlock({ from: user, to: other, amount: 1n, token: network.baseToken, previous: (previous ?? head).hash, network: network.network }));
}

async function localNetwork(): Promise<LocalNetwork> {
	freezeClock(START);
	const network = await createTestNetwork({ representativeWeights: [100n, 100n] });
	const [representative, other] = network.representatives;
	if (representative === undefined || other === undefined) {
		throw(new Error('the network has no representatives'));
	}
	const ledger = network.createLedger(new MemoryLedgerStorage(), representative, { fee: { kind: 'flat', amount: 1n } });
	await ledger.add(network.genesis);
	return({ network, representative, other, ledger, block: await sendFromUser(network) });
}

describe('requests and responses of the POST routes, built locally', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('a quote request and the quote', async function() {
		const { ledger, block } = await localNetwork();
		const route = documentRoute('POST', '/api/vote/quote');
		// [Keeta TS] index.js:59844-59849
		const request = { blocks: [base64(block.toBytes())] };
		const quote = await ledger.quote([block]);

		expect(api.requestViolations(route, request)).toEqual([]);
		expect(api.responseViolations(route, 200, { quote: serialized(quote) })).toEqual([]);
	});

	test('a vote request with another representative\'s vote and a quote, and the vote', async function() {
		const { network, other, ledger, block } = await localNetwork();
		const route = documentRoute('POST', '/api/vote');
		const quote = await ledger.quote([block]);
		const otherLedger = network.createLedger(new MemoryLedgerStorage(), other);
		await otherLedger.add(network.genesis);
		const otherVote = await otherLedger.vote([block]);
		// [Keeta TS] index.js:59852-59866, 59775
		const request = { blocks: [base64(block.toBytes())], votes: [base64(otherVote.toBytes())], quote: base64(quote.toBytes()) };
		const vote = await ledger.vote([block], undefined, quote);

		expect(api.requestViolations(route, request)).toEqual([]);
		expect(api.responseViolations(route, 200, { vote: serialized(vote) })).toEqual([]);
	});

	test('a refused vote, in the envelope every captured failure has', async function() {
		const { network, ledger } = await localNetwork();
		const route = documentRoute('POST', '/api/vote');
		const notSuccessor = await sendFromUser(network, await sendFromUser(network));
		const refusal: unknown = await ledger.vote([notSuccessor]).then(function(): never {
			throw(new Error('a block that is no successor was voted for'));
		}, function(error: unknown): unknown {
			return(error);
		});
		if (!lib.Error.isInstance(refusal)) {
			throw(refusal);
		}

		expect(api.responseViolations(route, 500, { error: true, ...refusal.toJSON() })).toEqual([]);
	});

	test('a publish request and its answer', async function() {
		const { representative, block } = await localNetwork();
		const route = documentRoute('POST', '/api/node/publish');
		const staple = await confirmedStaple([block], [representative]);
		// [Keeta TS] index.js:58481-58485
		const request = { votesAndBlocks: base64(staple.toBytes()) };

		expect(api.requestViolations(route, request)).toEqual([]);
		expect(api.responseViolations(route, 200, { publish: true })).toEqual([]);
	});

	test('a peer message delivered over HTTP and its answer', async function() {
		const { network, representative, block } = await localNetwork();
		const route = documentRoute('POST', '/api/p2p/message');
		const node = new lib.Node({
			kind: lib.Node.Kind.REPRESENTATIVE,
			log: new lib.Log(),
			initialTrustedAccount: network.trustedRoot,
			ledgerPrivateKey: representative,
			network: network.network,
			networkAlias: 'test',
			endpoints: LOCAL_ENDPOINTS,
			ledger: {
				storageDriver: new MemoryLedgerStorage(),
				computeFeeFromBlocks: function() {
					return(null);
				}
			},
			stats: { kv: null }
		});
		const staple = await confirmedStaple([block], [representative]);
		// [Keeta TS] index.js:71402-71404, 73043-73047
		const message = JSON.stringify({ id: staple.blocksHash.toString(), add: base64(staple.toBytes()), ttl: ADD_MESSAGE_TTL });
		// [Keeta TS] index.js:72200-72212
		const request = { message, greeting: await node.switch.getOutgoingGreetingInfo() };

		expect(lib.P2P.parseJSONMessage(Buffer.from(message))).toMatchObject({ valid: true, type: 'add' });
		expect(api.requestViolations(route, request)).toEqual([]);
		expect(api.responseViolations(route, 200, { success: true })).toEqual([]);
	});
});
