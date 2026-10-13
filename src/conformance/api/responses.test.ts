import { afterEach, describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import { MemoryLedgerStorage } from '../../ledger/storage/memory/driver.js';
import { confirmedStaple, manageCertificateBlock, sendBlock } from '../../testing/blocks.js';
import { createTestNetwork, freezeClock } from '../../testing/network.js';
import type { TestNetwork } from '../../testing/network.js';
import { CAPTURE_DIRECTORY, jsonFiles, readCapture, readJSON } from './captures.js';
import type { Capture } from './captures.js';
import { APIDocument, isJSONObject } from './document.js';
import { pathParameters, routeOfRequest } from './routes.js';
import type { Route } from './routes.js';

const lib = KeetaNet.lib;

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

/**
 * The captures that send a value outside the operation's parameters on
 * purpose, to record how a representative answers it, and the one parameter
 * each breaks.
 */
const MALFORMED_PARAMETER_CAPTURES: Readonly<Record<string, string>> = {
	'ledger-account-chain-fractional-limit.json': 'query limit',
	'ledger-account-history-limit-below-one.json': 'query limit',
	'ledger-account-history-limit-empty.json': 'query limit',
	'ledger-account-history-limit-fractional.json': 'query limit',
	'ledger-account-history-limit-negative.json': 'query limit',
	'ledger-account-history-limit-not-a-number.json': 'query limit',
	'ledger-account-history-limit-zero.json': 'query limit',
	'ledger-account-malformed.json': 'path account',
	'ledger-accounts-malformed.json': 'path accounts',
	'ledger-block-empty-side.json': 'query side',
	'ledger-block-invalid-side.json': 'query side',
	'ledger-block-malformed.json': 'path blockhash',
	'ledger-history-limit-zero.json': 'query limit',
	'node-bootstrap-votes-fractional-limit.json': 'query limit',
	'node-bootstrap-votes-malformed-start.json': 'query start',
	'node-bootstrap-votes-without-start.json': 'query start',
	'vote-malformed.json': 'path blockhash'
};

/** Where the local representative says it serves; nothing is ever sent there. */
const LOCAL_ENDPOINTS = { api: 'https://representative.invalid/api', p2p: 'wss://representative.invalid/p2p' } as const;

function captureBody(name: string): Readonly<Record<string, unknown>> {
	const { body } = readCapture(name);
	if (!isJSONObject(body)) {
		throw(new Error(`${name}: the body is not an object`));
	}
	return(body);
}

/** Every string in a value, at any depth. */
function strings(value: unknown): readonly string[] {
	if (typeof value === 'string') {
		return([value]);
	}
	if (Array.isArray(value)) {
		return(value.flatMap(strings));
	}
	if (isJSONObject(value)) {
		return(Object.values(value).flatMap(strings));
	}
	return([]);
}

/** The object without the named field. */
function without(object: unknown, name: string): Readonly<Record<string, unknown>> {
	if (!isJSONObject(object)) {
		throw(new Error('not an object'));
	}
	return(Object.fromEntries(Object.entries(object).filter(function([key]): boolean {
		return(key !== name);
	})));
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

	test('every capture sends parameters the operation has, with values its schemas allow, but the deliberately malformed ones', function() {
		for (const name of captures) {
			const capture = readCapture(name);
			const route = routeOfCapture(capture);
			const violations = api.parameterViolations(route, { path: pathParameters(route, capture.request.path), query: capture.request.query });
			const broken = [...new Set(violations.map(function(violation): string {
				return(violation.slice(0, violation.indexOf(':')));
			}))];
			const malformed = Object.entries(MALFORMED_PARAMETER_CAPTURES).filter(function([capture]): boolean {
				return(capture === name);
			}).map(function([, parameter]): string {
				return(parameter);
			});

			expect({ name, broken }).toEqual({ name, broken: malformed });
		}
		expect(captures).toEqual(expect.arrayContaining(Object.keys(MALFORMED_PARAMETER_CAPTURES)));
	});

	test('the document refuses parameters the client never sends', function() {
		const bootstrap = documentRoute('GET', '/api/node/bootstrap/votes');
		const history = documentRoute('GET', '/api/node/ledger/history');

		expect(api.parameterViolations(bootstrap, { path: {}, query: { start: '1970-01-01T00:00:00.000Z' } })).toEqual([]);
		expect(api.parameterViolations(bootstrap, { path: {}, query: { start: '1970-01-01' } })).not.toEqual([]);
		expect(api.parameterViolations(history, { path: {}, query: { limit: '2' } })).toEqual([]);
		expect(api.parameterViolations(history, { path: {}, query: { limit: '2', offset: '1' } })).toEqual(['query offset: not a parameter of the operation']);
	});

	test('an account\'s history from a staple is the same page whether the staple is named in the path or in "start"', function() {
		const fromPath = readCapture('ledger-account-history-start.json');
		const fromQuery = readCapture('ledger-account-history-from-start.json');

		expect(fromPath.status).toBe(200);
		expect(fromPath.body).toEqual(fromQuery.body);
	});

	test('every failure a representative reported is a refusal or an internal failure, and it reported both', function() {
		const forms = captures.map(readCapture).filter(function(capture): boolean {
			return(capture.status !== 200);
		}).map(function(capture): readonly string[] {
			return(['ErrorRefusal', 'ErrorInternal'].filter(function(form): boolean {
				return(api.schemaViolations(form, capture.body).length === 0);
			}));
		});

		expect(forms).not.toHaveLength(0);
		for (const matched of forms) {
			expect(matched).toHaveLength(1);
		}
		expect([...new Set(forms.flat())].sort()).toEqual(['ErrorInternal', 'ErrorRefusal']);

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

	test('the "$id" of a history entry is the hash of the blocks of its staple, and "nextKey" the last "$id" of the page, or of an empty page its start', function() {
		const pages = captures.map(readCapture).filter(function(capture): boolean {
			return(capture.status === 200 && routeOfCapture(capture).path.includes('/history'));
		}).map(function(capture) {
			const start = pathParameters(routeOfCapture(capture), capture.request.path)['block'] ?? capture.request.query['start'] ?? null;
			return({ ...historyPage(capture.body), start });
		});

		expect(pages.length).toBeGreaterThan(0);
		expect(pages.some(function({ entries, start }): boolean {
			return(entries.length === 0 && start !== null);
		})).toBe(true);
		for (const { entries, nextKey, start } of pages) {
			const ids = entries.map(function({ id }): unknown {
				return(id);
			});
			const blocksHashes = entries.map(function({ stapleBinary }): string {
				return(decodeStaple(stapleBinary).blocksHash.toString());
			});
			expect(ids).toEqual(blocksHashes);
			expect(nextKey).toBe(ids.at(-1) ?? start);
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

	test('a refusal names its type and code, and an internal failure carries only a message naming an error ID', function() {
		const refusal = captureBody('ledger-history-limit-zero.json');
		const refusalRoute = routeOfCapture(readCapture('ledger-history-limit-zero.json'));
		const internal = captureBody('vote-malformed.json');
		const internalRoute = routeOfCapture(readCapture('vote-malformed.json'));

		expect(api.responseViolations(refusalRoute, 500, refusal)).toEqual([]);
		for (const field of ['type', 'code', 'message']) {
			expect(api.responseViolations(refusalRoute, 500, without(refusal, field))).not.toEqual([]);
		}
		expect(api.responseViolations(internalRoute, 500, internal)).toEqual([]);
		expect(api.responseViolations(internalRoute, 500, { ...internal, message: 'Internal error occurred' })).not.toEqual([]);
		expect(api.responseViolations(internalRoute, 500, { ...internal, code: 'API_INVALID_SIDE' })).not.toEqual([]);
		expect(api.responseViolations(internalRoute, 500, { ...internal, error: false })).not.toEqual([]);
	});

	test('the document refuses endpoints without their scheme and peer records of kinds that are not serialized', function() {
		expect(api.schemaViolations('Endpoints', LOCAL_ENDPOINTS)).toEqual([]);
		expect(api.schemaViolations('Endpoints', { ...LOCAL_ENDPOINTS, api: 'representative.invalid/api' })).not.toEqual([]);
		expect(api.schemaViolations('Endpoints', { ...LOCAL_ENDPOINTS, p2p: 'https://representative.invalid/p2p' })).not.toEqual([]);
		expect(api.schemaViolations('Peer', { kind: 0 })).toEqual([]);
		for (const kind of [2, 3]) {
			expect(api.schemaViolations('Peer', { kind })).not.toEqual([]);
		}
	});
});

const START = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/** A staple travels between peers with this many hops left [Keeta TS] index.js:72532. */
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

/** The last block genesis gives the account. */
function genesisHead(network: TestNetwork, account: Account): Block {
	const head = network.genesis.blocks.filter(function(block): boolean {
		return(block.account.comparePublicKey(account));
	}).at(-1);
	if (head === undefined) {
		throw(new Error('genesis gives the account no block'));
	}
	return(head);
}

/** A send by user 0, after its previous block, or after its genesis head when none is given. */
async function sendFromUser(network: TestNetwork, previous?: Block): Promise<Block> {
	const [user, other] = network.users;
	if (user === undefined || other === undefined) {
		throw(new Error('the network has no users'));
	}
	return(await sendBlock({ from: user, to: other, amount: 1n, token: network.baseToken, previous: (previous ?? genesisHead(network, user)).hash, network: network.network }));
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
		// [Keeta TS] index.js:60835-60840
		const request = { blocks: [base64(block.toBytes())] };
		const quote = await ledger.quote([block]);

		expect(api.requestViolations(route, request)).toEqual([]);
		expect(api.responseViolations(route, 200, { quote: serialized(quote) })).toEqual([]);
		expect(api.schemaViolations('Vote', serialized(quote))).not.toEqual([]);
		expect(api.schemaViolations('VoteQuote', without(serialized(quote), 'fee'))).not.toEqual([]);
	});

	test('a vote request with another representative\'s vote and a quote, and the vote', async function() {
		const { network, other, ledger, block } = await localNetwork();
		const route = documentRoute('POST', '/api/vote');
		const quote = await ledger.quote([block]);
		const otherLedger = network.createLedger(new MemoryLedgerStorage(), other);
		await otherLedger.add(network.genesis);
		const otherVote = await otherLedger.vote([block]);
		// [Keeta TS] index.js:60843-60857, 60768
		const request = { blocks: [base64(block.toBytes())], votes: [base64(otherVote.toBytes())], quote: base64(quote.toBytes()) };
		const vote = await ledger.vote([block], undefined, quote);

		expect(api.requestViolations(route, request)).toEqual([]);
		expect(api.responseViolations(route, 200, { vote: serialized(vote) })).toEqual([]);
		expect(api.schemaViolations('VoteQuote', serialized(vote))).not.toEqual([]);
		expect(api.schemaViolations('Vote', without(serialized(vote), 'quote'))).not.toEqual([]);
		expect(api.schemaViolations('Vote', without(without(serialized(vote), 'quote'), 'fee'))).toEqual([]);
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

		expect(refusal.code).toBe('LEDGER_NOT_SUCCESSOR');
		expect(api.responseViolations(route, 500, { error: true, ...refusal.toJSON() })).toEqual([]);
		expect(api.schemaViolations('ErrorRefusal', { error: true, ...refusal.toJSON() })).toEqual([]);
	});

	test('a publish request and its answer', async function() {
		const { representative, block } = await localNetwork();
		const route = documentRoute('POST', '/api/node/publish');
		const staple = await confirmedStaple([block], [representative]);
		// [Keeta TS] index.js:59478-59482
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
		// [Keeta TS] index.js:72530-72532, 74191-74195
		const message = JSON.stringify({ id: staple.blocksHash.toString(), add: base64(staple.toBytes()), ttl: ADD_MESSAGE_TTL });
		// [Keeta TS] index.js:73348-73360
		const request = { message, greeting: await node.switch.getOutgoingGreetingInfo() };

		expect(lib.P2P.parseJSONMessage(Buffer.from(message))).toMatchObject({ valid: true, type: 'add' });
		expect(api.requestViolations(route, request)).toEqual([]);
		expect(api.responseViolations(route, 200, { success: true })).toEqual([]);
	});
});

describe('certificates', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('every certificate a representative served is PEM text, and parses into the fields the document lists', function() {
		const texts = strings(captureBody('ledger-account-certificates.json')['certificates']);

		expect(texts.length).toBeGreaterThan(1);
		for (const pem of texts) {
			expect(api.schemaViolations('PEMCertificate', pem)).toEqual([]);
			expect(api.schemaViolations('Certificate', serialized(new lib.Utils.Certificate.Certificate(pem, { moment: null })))).toEqual([]);
		}
		expect(api.schemaViolations('PEMCertificate', texts[0]?.replace('-----BEGIN CERTIFICATE-----', ''))).not.toEqual([]);
	});

	test('a block that adds a certificate authority\'s certificate serializes as the document says', async function() {
		const { network } = await localNetwork();
		const [user] = network.users;
		if (user === undefined) {
			throw(new Error('the network has no users'));
		}
		const certificate = await new lib.Utils.Certificate.CertificateBuilder({
			issuer: user,
			validFrom: new Date(START.getTime() - 1000),
			validTo: new Date(START.getTime() + 1000),
			serial: 1,
			isCA: true
		}).build({ subjectPublicKey: user });
		const block = await manageCertificateBlock({ account: user, method: lib.Block.AdjustMethod.ADD, certificateOrHash: certificate, previous: genesisHead(network, user).hash, network: network.network });

		expect(serialized(certificate)).toHaveProperty('baseExtensions.basicConstraints');
		expect(api.schemaViolations('Block', serialized(block))).toEqual([]);
	});
});
