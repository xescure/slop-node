import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import pg from 'pg';
import { readCapture } from '../conformance/api/captures.js';
import type { Capture } from '../conformance/api/captures.js';
import { APIDocument, isJSONObject } from '../conformance/api/document.js';
import { routeOfRequest } from '../conformance/api/routes.js';
import { CONFLICT_MESSAGE, mapDatabaseError } from '../ledger/storage/postgres/errors.js';
import { driverUnderTestNamed } from '../ledger/storage/suite/drivers.js';
import { requireAt } from '../ledger/storage/suite/support.js';
import type { DriverUnderTest } from '../ledger/storage/suite/types.js';
import { base64, keyOf, populate } from '../testing/api-network.js';
import type { PopulatedNode } from '../testing/api-network.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { postJSON, request, useLocalNodes } from '../testing/local-node.js';
import type { HTTPAnswer, LocalNodeOptions, RunningLocalNode } from '../testing/local-node.js';

const lib = KeetaNet.lib;

const api = new APIDocument();

const nodes = useLocalNodes();

const SECRET = 'postgres://slop:hunter2@db.invalid/ledger';

const PEER_CAPTURE = new URL('../../conformance/api/mainnet/node-peers.json', import.meta.url);

async function populated(driver?: DriverUnderTest): Promise<PopulatedNode> {
	const options: LocalNodeOptions = { fee: { kind: 'flat', amount: 1n } };
	if (driver === undefined) {
		return(await populate(await nodes.start(options)));
	}
	return(await populate(await nodes.start({ ...options, driver })));
}

function field(body: unknown, name: string): unknown {
	if (!isJSONObject(body)) {
		throw(new Error(`the body is not an object: ${JSON.stringify(body)}`));
	}
	return(body[name]);
}

function list(body: unknown, name: string): readonly unknown[] {
	const value = field(body, name);
	if (!Array.isArray(value)) {
		throw(new Error(`"${name}" is not a list`));
	}
	return(value);
}

function text(body: unknown, name: string): string {
	const value = field(body, name);
	if (typeof value !== 'string') {
		throw(new Error(`"${name}" is not a string`));
	}
	return(value);
}

function queryOf(capture: Capture, name: string): string {
	const value = capture.request.query[name];
	if (value === undefined) {
		throw(new Error(`the capture has no "${name}" parameter`));
	}
	return(value);
}

/** The answer validates against the document for the route the request reaches. */
function expectDocumented(method: 'GET' | 'POST', path: string, answer: HTTPAnswer): void {
	const route = routeOfRequest(api.routes, method, `/api${path.split('?')[0] ?? ''}`);
	expect(api.responseViolations(route, answer.status, answer.body)).toEqual([]);
}

function expectRefusal(answer: HTTPAnswer, code: string, message?: string): void {
	expect(answer.status).toBe(500);
	expect(api.schemaViolations('ErrorRefusal', answer.body)).toEqual([]);
	expect(field(answer.body, 'code')).toBe(code);
	if (message !== undefined) {
		expect(field(answer.body, 'message')).toBe(message);
	}
}

function expectInternal(answer: HTTPAnswer): void {
	expect(answer.status).toBe(500);
	expect(api.schemaViolations('ErrorInternal', answer.body)).toEqual([]);
}

function ids(body: unknown): readonly string[] {
	return(list(body, 'history').map(function(entry): string {
		return(text(entry, '$id'));
	}));
}

function blockHashes(body: unknown): readonly string[] {
	return(list(body, 'blocks').map(function(entry): string {
		return(new lib.Block(Buffer.from(text(field(entry, 'block'), '$binary'), 'base64')).hash.toString());
	}));
}

/**
 * Every page of a history, following nextKey from the first page until an
 * empty page, as the client pages [Keeta TS] index.js:58969-58996.
 */
async function allPages(node: RunningLocalNode, path: string, limit: number): Promise<readonly (readonly string[])[]> {
	const pages: (readonly string[])[] = [];
	let start: string | null = null;
	for (;;) {
		let query = `limit=${String(limit)}`;
		if (start !== null) {
			query = `${query}&start=${start}`;
		}
		const answer = await request(node, `${path}?${query}`);
		expect(answer.status).toBe(200);
		const page = ids(answer.body);
		expect(field(answer.body, 'nextKey')).toBe(page.at(-1) ?? start);
		if (page.length === 0) {
			return(pages);
		}
		pages.push(page);
		start = text(answer.body, 'nextKey');
	}
}

describe('history', function() {
	test('pages continue after the staple named by start, nextKey names the page\'s last staple, and an empty page ends the history', async function() {
		const node = await populated();
		const user = keyOf(node.user);
		const whole = ids((await request(node, `/node/ledger/account/${user}/history?limit=200`)).body);
		const pages = await allPages(node, `/node/ledger/account/${user}/history`, 2);

		expect(whole.length).toBeGreaterThan(2);
		expect(pages.flat()).toEqual(whole);
		expect(pages.slice(0, -1).every(function(page): boolean {
			return(page.length === 2);
		})).toBe(true);
		expect((await allPages(node, '/node/ledger/history', 3)).flat()).toEqual(ids((await request(node, '/node/ledger/history?limit=200')).body));
	});

	test('the staple to continue after may be named in the path instead', async function() {
		const node = await populated();
		const user = keyOf(node.user);
		const first = await request(node, `/node/ledger/account/${user}/history?limit=1`);
		const start = text(first.body, 'nextKey');
		const fromQuery = await request(node, `/node/ledger/account/${user}/history?limit=2&start=${start}`);
		const fromPath = await request(node, `/node/ledger/account/${user}/history/start/${start}?limit=2`);

		expect(fromPath.status).toBe(200);
		expect(fromPath.body).toEqual(fromQuery.body);
		expect(ids(fromPath.body)).not.toContain(start);
	});

	test('a page holds 25 staples unless asked for fewer, and 200 at most', async function() {
		const node = await populated();
		const pageSizes = vi.spyOn(lib.Ledger.prototype, 'getHistory');
		const asked = async function(query: string): Promise<unknown> {
			pageSizes.mockClear();
			expect((await request(node, `/node/ledger/history${query}`)).status).toBe(200);
			return(pageSizes.mock.calls[0]?.[2]);
		};

		expect(await asked('')).toBe(25);
		expect(await asked('?limit=7')).toBe(7);
		expect(await asked('?limit=200')).toBe(200);
		expect(await asked('?limit=1e3')).toBe(200);
	});

	/*
	 * Mainnet answered limit=1.5 on an account's history with one staple and
	 * the last staple's $id as nextKey (ledger-account-history-limit-fractional.json),
	 * so a fractional limit rounds down. Only the count and the nextKey rule
	 * are compared: the staples themselves are the user's later activity.
	 */
	test('limit=1.5 on an account history holds as many staples as mainnet\'s capture and names the last as nextKey', async function() {
		const capture = readCapture('ledger-account-history-limit-fractional.json');
		const captured = list(capture.body, 'history');
		const node = await populated();
		const answer = await request(node, `/node/ledger/account/${keyOf(node.user)}/history?limit=${queryOf(capture, 'limit')}`);

		expect(captured).toHaveLength(1);
		expect(field(capture.body, 'nextKey')).toBe(text(captured.at(-1), '$id'));
		expect(answer.status).toBe(capture.status);
		expect(list(answer.body, 'history')).toHaveLength(captured.length);
		expect(field(answer.body, 'nextKey')).toBe(ids(answer.body).at(-1));
	});

	test.each([
		{ limit: '1.5', entries: 1 },
		{ limit: '2.9', entries: 2 },
		{ limit: '0.5', entries: 0 }
	])('limit=$limit holds the $entries whole staples it allows', async function({ limit, entries }) {
		const node = await populated();
		const answer = await request(node, `/node/ledger/history?limit=${limit}`);

		expect(answer.status).toBe(200);
		expect(list(answer.body, 'history')).toHaveLength(entries);
		expect(field(answer.body, 'nextKey')).toBe(ids(answer.body).at(-1) ?? null);
		expectDocumented('GET', '/node/ledger/history', answer);
	});

	test('the last page names its last staple, and the empty page after it the staple it started after', async function() {
		const node = await populated();
		const whole = ids((await request(node, '/node/ledger/history?limit=200')).body);
		const oldest = whole.at(-1);
		const beforeOldest = whole.at(-2);
		if (oldest === undefined || beforeOldest === undefined) {
			throw(new Error('the ledger holds fewer than two staples'));
		}
		const last = await request(node, `/node/ledger/history?start=${beforeOldest}`);
		const after = await request(node, `/node/ledger/history?start=${oldest}`);

		expect(last.body).toMatchObject({ nextKey: oldest });
		expect(ids(last.body)).toEqual([oldest]);
		expect(after.body).toEqual({ history: [], nextKey: oldest });
		expectDocumented('GET', '/node/ledger/history', after);
	});

	test('an entry\'s time is this node\'s own vote for the staple, as the staple\'s timestamp prefers it', async function() {
		const node = await nodes.start({ representativeWeights: [500n, 500n] });
		const [representative, other] = node.network.representatives;
		const user = requireAt(node.network.users, 0);
		if (representative === undefined || other === undefined) {
			throw(new Error('the network has two representatives'));
		}
		const previous = node.network.genesis.blocks.filter(function(block): boolean {
			return(block.account.comparePublicKey(user));
		}).at(-1);
		const send = await sendBlock({ from: user, to: other, amount: 1n, token: node.network.baseToken, previous: previous?.hash ?? null, network: node.network.network });
		const staple = await confirmedStaple([send], [representative, other], { voteDelays: [0, 1000] });
		expect((await postJSON(node, '/node/publish', { votesAndBlocks: base64(staple.toBytes()) })).body).toEqual({ publish: true });

		const [entry] = list((await request(node, '/node/ledger/history?limit=1')).body, 'history');

		expect(staple.timestamp(representative).getTime()).not.toBe(staple.timestamp().getTime());
		expect(field(entry, '$timestamp')).toBe(staple.timestamp(representative).toISOString());
	});

	test.each([
		{ limit: 'abc', code: 'API_LIMIT_NOT_NUMBER', message: 'Limit must be a number' },
		{ limit: '', code: 'API_LIMIT_NOT_GREATER_THAN_ZERO', message: 'Limit must be greater than 0' },
		{ limit: '0', code: 'API_LIMIT_NOT_GREATER_THAN_ZERO', message: 'Limit must be greater than 0' },
		{ limit: '-3', code: 'API_LIMIT_NOT_GREATER_THAN_ZERO', message: 'Limit must be greater than 0' }
	])('limit=$limit is refused with $code', async function({ limit, code, message }) {
		const node = await nodes.start();
		const answer = await request(node, `/node/ledger/history?limit=${limit}`);
		expectRefusal(answer, code, message);
		expectDocumented('GET', '/node/ledger/history', answer);
	});
});

describe('the chain', function() {
	test('pages run from the block named by start, which is included, to the account\'s first block', async function() {
		const node = await populated();
		const user = keyOf(node.user);
		const whole = blockHashes((await request(node, `/node/ledger/account/${user}/chain?limit=200`)).body);
		const first = await request(node, `/node/ledger/account/${user}/chain?limit=2`);
		const nextKey = text(first.body, 'nextKey');
		const rest = await request(node, `/node/ledger/account/${user}/chain?limit=200&start=${nextKey}`);

		expect(whole.length).toBeGreaterThan(3);
		expect(blockHashes(first.body)).toEqual(whole.slice(0, 2));
		expect(nextKey).toBe(whole[2]);
		expect([...blockHashes(first.body), ...blockHashes(rest.body)]).toEqual(whole);
		expect(field(rest.body, 'nextKey')).toBeNull();
	});

	test('a page ends with the block named by end', async function() {
		const node = await populated();
		const user = keyOf(node.user);
		const whole = blockHashes((await request(node, `/node/ledger/account/${user}/chain`)).body);
		const answer = await request(node, `/node/ledger/account/${user}/chain?start=${whole[1] ?? ''}&end=${whole[3] ?? ''}`);

		expect(blockHashes(answer.body)).toEqual(whole.slice(1, 4));
		expect(field(answer.body, 'nextKey')).toBeNull();
	});

	test('a full page that stops right above end names end as the next page', async function() {
		const node = await populated();
		const user = keyOf(node.user);
		const whole = blockHashes((await request(node, `/node/ledger/account/${user}/chain`)).body);
		const answer = await request(node, `/node/ledger/account/${user}/chain?limit=2&end=${whole[2] ?? ''}`);

		expect(blockHashes(answer.body)).toEqual(whole.slice(0, 2));
		expect(field(answer.body, 'nextKey')).toBe(whole[2]);

		const throughEnd = await request(node, `/node/ledger/account/${user}/chain?limit=3&end=${whole[2] ?? ''}`);
		expect(blockHashes(throughEnd.body)).toEqual(whole.slice(0, 3));
		expect(field(throughEnd.body, 'nextKey')).toBeNull();
	});

	test.each([
		{ limit: '1.5', blocks: 2 },
		{ limit: '0.5', blocks: 1 }
	])('limit=$limit holds blocks until their count reaches it, $blocks', async function({ limit, blocks }) {
		const node = await populated();
		const user = keyOf(node.user);
		const whole = blockHashes((await request(node, `/node/ledger/account/${user}/chain`)).body);
		const answer = await request(node, `/node/ledger/account/${user}/chain?limit=${limit}`);

		expect(answer.status).toBe(200);
		expect(blockHashes(answer.body)).toEqual(whole.slice(0, blocks));
		expect(field(answer.body, 'nextKey')).toBe(whole[blocks]);
	});

	test('limit=1e3 is read as the number it writes, a thousand, and holds the whole chain', async function() {
		const node = await populated();
		const user = keyOf(node.user);
		const whole = await request(node, `/node/ledger/account/${user}/chain`);

		expect((await request(node, `/node/ledger/account/${user}/chain?limit=1e3`)).body).toEqual(whole.body);
	});

	test('a start that is no block of the account starts no page', async function() {
		const node = await populated();
		const other = keyOf(node.other);
		const answer = await request(node, `/node/ledger/account/${other}/chain?start=${node.keyedSend.hash.toString()}`);

		expect(answer.body).toEqual({ account: other, blocks: [], nextKey: null });
	});
});

describe('requests a representative answers without a failure', function() {
	test('a malformed account in a list is answered with its error in place of its state', async function() {
		const node = await populated();
		const user = keyOf(node.user);
		const answer = await request(node, `/node/ledger/accounts/${encodeURIComponent(`${user},keeta_not-an-account`)}`);

		expect(answer.status).toBe(200);
		expect(Array.isArray(answer.body) && answer.body.map(function(state: unknown): unknown {
			return(field(state, 'account'));
		})).toEqual([user, 'keeta_not-an-account']);
		expect(Array.isArray(answer.body) && answer.body[1]).toEqual({ account: 'keeta_not-an-account', error: 'Error: Key is the wrong length (14)' });
	});

	test('an empty entity list, as the client sends one, lists the permissions on every entity', async function() {
		const node = await populated();
		const user = keyOf(node.user);
		// The client joins no entities into an empty path segment [Keeta TS] index.js:58588-58597, 59958-59960.
		const everyEntity = await request(node, `/node/ledger/account/${user}/acl/`);
		const withInfo = await request(node, `/node/ledger/account/${user}/acl/additional/`);

		expect(everyEntity.body).toEqual((await request(node, `/node/ledger/account/${user}/acl`)).body);
		expect(list(everyEntity.body, 'permissions').length).toBeGreaterThan(1);
		expect(withInfo.body).toEqual((await request(node, `/node/ledger/account/${user}/acl/additional`)).body);
		expect(list(withInfo.body, 'access').map(function(entry): unknown {
			return(field(entry, 'entity'));
		})).toEqual(expect.arrayContaining([keyOf(node.token), keyOf(node.multisig)]));
	});

	test('a pending block is the side block after the account\'s main head', async function() {
		const node = await populated();
		const pending = await request(node, `/node/ledger/account/${keyOf(node.user)}/pending`);
		const none = await request(node, `/node/ledger/account/${keyOf(node.other)}/pending`);

		expect(text(field(pending.body, 'block'), '$binary')).toBe(base64(node.pending.toBytes()));
		expect(field(none.body, 'block')).toBeNull();
	});

	test('a block is found on either ledger when both are asked, as the client asks for the blocks of an account it recovers', async function() {
		const node = await populated();
		// [Keeta TS] index.js:59349-59351
		function blockAt(hash: string, side: string): Promise<HTTPAnswer> {
			return(request(node, `/node/ledger/block/${hash}?side=${side}`));
		}
		const pending = node.pending.hash.toString();
		const confirmed = node.keyedSend.hash.toString();

		expect(text(field((await blockAt(pending, 'both')).body, 'block'), '$binary')).toBe(base64(node.pending.toBytes()));
		expect(text(field((await blockAt(confirmed, 'both')).body, 'block'), '$binary')).toBe(base64(node.keyedSend.toBytes()));
		expect((await blockAt(pending, 'main')).body).toEqual({ blockhash: pending, block: null });
		expectDocumented('GET', `/node/ledger/block/${pending}?side=both`, await blockAt(pending, 'both'));
	});

	test('a block named by its idempotent key is found on the ledger asked', async function() {
		const node = await populated();
		const path = `/node/ledger/account/${keyOf(node.user)}/idempotent/${encodeURIComponent(node.idempotentKey)}`;

		expect(text(field((await request(node, path)).body, 'block'), '$binary')).toBe(base64(node.keyedSend.toBytes()));
		expect((await request(node, `${path}?side=side`)).body).toEqual({ block: null });
	});

	test('the representatives include ones not reached, or not seen lately, each once', async function() {
		const node = await populated();
		const capture: unknown = JSON.parse(readFileSync(PEER_CAPTURE, 'utf8'));
		const captured = list(field(capture, 'body'), 'peers')[0];
		const endpoints = field(captured, 'endpoints');
		const peer = {
			kind: lib.Node.Kind.REPRESENTATIVE,
			key: text(captured, 'key'),
			endpoints: { api: text(endpoints, 'api'), p2p: text(endpoints, 'p2p') },
			preferUpdates: text(captured, 'preferUpdates'),
			signature: text(captured, 'signature')
		};
		// A peer that greets the node before the node has reached it is kept here [Keeta TS] index.js:73563-73567.
		await node.node.switch.config.kv.set('potentialPeers', peer.key, peer);
		// Seen once, long ago; a peer never seen is listed nowhere [Keeta TS] index.js:72593-72597.
		await node.node.switch.config.kv.set('lastSeenPeers', peer.key, '0');

		const answer = await request(node, '/node/ledger/representatives');

		expect((await request(node, '/node/peers')).body).toEqual({ peers: [] });
		expect(list(answer.body, 'representatives').map(function(entry): unknown {
			return(field(entry, 'representative'));
		})).toEqual([keyOf(node.representative), peer.key]);
		expect(list(answer.body, 'representatives')[1]).toEqual({ representative: peer.key, weight: '0x0', endpoints: peer.endpoints });
		expectDocumented('GET', '/node/ledger/representatives', answer);
	});

	/*
	 * Mainnet answered limit=1.5 with two staples (node-bootstrap-votes-fractional-limit.json),
	 * so a fractional limit rounds up. Only the count is compared: which
	 * staples come first follows when their votes were made.
	 */
	test('limit=1.5 holds as many staples as mainnet\'s capture', async function() {
		const capture = readCapture('node-bootstrap-votes-fractional-limit.json');
		const node = await populated();
		const answer = await request(node, `/node/bootstrap/votes?start=${encodeURIComponent(queryOf(capture, 'start'))}&limit=${queryOf(capture, 'limit')}`);

		expect(answer.status).toBe(capture.status);
		expect(list(capture.body, 'voteStaples')).toHaveLength(2);
		expect(list(answer.body, 'voteStaples')).toHaveLength(list(capture.body, 'voteStaples').length);
	});

	test.each(['1.03', '2.01'])('a bootstrap limit of %s is answered alike by both drivers', async function(limit) {
		const path = `/node/bootstrap/votes?start=1970-01-01T00%3A00%3A00.000Z&limit=${limit}`;
		const inMemory = await request(await populated(driverUnderTestNamed('memory')), path);
		const inPostgres = await request(await populated(driverUnderTestNamed('postgres')), path);

		expect(inMemory.status).toBe(200);
		expect(inPostgres).toEqual(inMemory);
	});

	test.each([
		{ limit: '1.5', staples: 2 },
		{ limit: '0.5', staples: 1 }
	])('a bootstrap limit of $limit holds staples until their count reaches it: $staples', async function({ limit, staples }) {
		const node = await populated();
		const answer = await request(node, `/node/bootstrap/votes?start=1970-01-01T00%3A00%3A00.000Z&limit=${limit}`);

		expect(answer.status).toBe(200);
		expect(list(answer.body, 'voteStaples')).toHaveLength(staples);
		expectDocumented('GET', '/node/bootstrap/votes', answer);
	});

	test('a bootstrap page leaves out the staples the bloom filter holds', async function() {
		const node = await populated();
		const everything = list((await request(node, '/node/bootstrap/votes?start=1970-01-01T00%3A00%3A00.000Z')).body, 'voteStaples');
		const genesis = base64(node.network.genesis.toBytes());
		const filter = lib.Utils.Bloom.BloomFilter.create(16, 0.001);
		// The ledger asks the filter about the staple's bytes [Keeta TS] index.js:69687-69689.
		filter.add(node.network.genesis.toBytes());
		const serialized = lib.Utils.Bloom.serializeBloomFilter(filter);

		const filtered = list((await request(node, `/node/bootstrap/votes?start=1970-01-01T00%3A00%3A00.000Z&bloomFilter=${encodeURIComponent(serialized)}`)).body, 'voteStaples');

		expect(everything.map(function(staple): unknown {
			return(field(staple, '$binary'));
		})).toContain(genesis);
		expect(filtered).toHaveLength(everything.length - 1);
		expect(filtered.map(function(staple): unknown {
			return(field(staple, '$binary'));
		})).not.toContain(genesis);
	});
});

function texts(entries: readonly unknown[], name: string): readonly string[] {
	return(entries.map(function(entry): string {
		return(text(entry, name));
	}));
}

/** The texts in the order a representative lists them: by their characters' codes, as strings compare. */
function ordered(values: readonly string[]): readonly string[] {
	return([...values].sort());
}

describe('lists, in the order a representative gives them', function() {
	test('permissions are listed by entity, and the permissions on an entity by principal', async function() {
		const node = await populated();
		const user = keyOf(node.user);
		const byPrincipal = list((await request(node, `/node/ledger/account/${user}/acl`)).body, 'permissions');
		const byEntity = list((await request(node, `/node/ledger/account/${keyOf(node.multisig)}/acl/granted`)).body, 'permissions');
		const access = list((await request(node, `/node/ledger/account/${user}/acl/additional`)).body, 'access');

		expect(byPrincipal.length).toBeGreaterThan(1);
		expect(texts(byPrincipal, 'entity')).toEqual(ordered(texts(byPrincipal, 'entity')));
		expect(byEntity.length).toBeGreaterThan(1);
		expect(texts(byEntity, 'principal')).toEqual(ordered(texts(byEntity, 'principal')));
		expect(texts(access, 'entity')).toEqual(ordered(texts(access, 'entity')));
		for (const entry of access) {
			expect(texts(list(entry, 'principals'), 'principal')).toEqual(ordered(texts(list(entry, 'principals'), 'principal')));
			expect(texts(list(entry, 'balances'), 'token')).toEqual(ordered(texts(list(entry, 'balances'), 'token')));
		}
	});

	test('balances are listed by token', async function() {
		const node = await populated();
		const other = keyOf(node.other);
		const balances = list((await request(node, `/node/ledger/account/${other}/balance`)).body, 'balances');
		const state = list((await request(node, `/node/ledger/account/${other}`)).body, 'balances');

		expect(balances.length).toBeGreaterThan(1);
		expect(texts(balances, 'token')).toEqual(ordered(texts(balances, 'token')));
		expect(state).toEqual(balances);
	});

	test('the votes for a block are listed by their ID, whatever their order in the staple', async function() {
		const node = await nodes.start({ representativeWeights: [500n, 500n] });
		const user = requireAt(node.network.users, 0);
		const previous = node.network.genesis.blocks.filter(function(block): boolean {
			return(block.account.comparePublicKey(user));
		}).at(-1);
		const send = await sendBlock({ from: user, to: requireAt(node.network.representatives, 1), amount: 1n, token: node.network.baseToken, previous: previous?.hash ?? null, network: node.network.network });
		const representatives = [...node.network.representatives];
		let staple = await confirmedStaple([send], representatives);
		const idsOf = function(votes: readonly { readonly $id: string }[]): readonly string[] {
			return(votes.map(function(vote): string {
				return(vote.$id);
			}));
		};
		if (idsOf(staple.votes).join() === ordered(idsOf(staple.votes)).join()) {
			staple = await confirmedStaple([send], representatives.reverse());
		}
		expect(idsOf(staple.votes)).not.toEqual(ordered(idsOf(staple.votes)));
		expect((await postJSON(node, '/node/publish', { votesAndBlocks: base64(staple.toBytes()) })).body).toEqual({ publish: true });

		const votes = list((await request(node, `/vote/${send.hash.toString()}`)).body, 'votes');

		expect(texts(votes, '$id')).toEqual(ordered(idsOf(staple.votes)));
	});
});

describe('requests a representative refuses', function() {
	test.each([
		{ path: '/node/bootstrap/votes', code: 'API_START_MISSING', message: '"start" parameter must be supplied' },
		{ path: '/vote/E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855?side=both', code: 'API_INVALID_SIDE', message: 'Invalid side: both' },
		{ path: '/node/ledger/block/E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855?side=', code: 'API_INVALID_SIDE', message: 'Invalid side: ' }
	])('$path is refused with $code', async function({ path, code, message }) {
		const node = await nodes.start();
		const answer = await request(node, path);
		expectRefusal(answer, code, message);
		expectDocumented('GET', path, answer);
	});

	test.each([
		'/node/bootstrap/votes?start=yesterday',
		'/node/ledger/block/not-a-hash',
		'/vote/not-a-hash',
		'/node/ledger/account/keeta_not-an-account/balance',
		'/node/ledger/account/keeta_aabx4z7qrrsongdomou3l6vcyuaovnfo6s3wlm4v3vub6zu4xhte5ntk6qifixa/idempotent/%2A%2A%2A'
	])('%s fails as an internal error, naming only an error ID', async function(path) {
		const answer = await request(await nodes.start(), path);
		expectInternal(answer);
		expectDocumented('GET', path, answer);
	});

	test('a staple published twice is refused the second time with the ledger\'s code', async function() {
		const node = await populated();
		const staple = requireAt(node.published, 0);
		const answer = await postJSON(node, '/node/publish', { votesAndBlocks: base64(staple.toBytes()) });

		expect(answer.status).toBe(500);
		expect(api.schemaViolations('ErrorRefusal', answer.body)).toEqual([]);
		expect(field(answer.body, 'type')).toBe('LEDGER');
		expectDocumented('POST', '/node/publish', answer);
	});
});

describe('a request body', function() {
	test.each([
		{ path: '/vote', body: '{"blocks": [' },
		{ path: '/vote/quote', body: 'blocks' },
		{ path: '/node/publish', body: '' },
		{ path: '/p2p/message', body: '[1, 2' }
	])('that is no JSON fails at $path as an internal error', async function({ path, body }) {
		const node = await nodes.start();
		const answer = await request(node, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
		expectInternal(answer);
		expectDocumented('POST', path, answer);
	});

	test.each([
		{ path: '/vote', body: { votes: [] } },
		{ path: '/vote', body: { blocks: [1] } },
		{ path: '/vote/quote', body: [] },
		{ path: '/node/publish', body: { votesAndBlocks: 7 } },
		{ path: '/p2p/message', body: { message: 'hello' } }
	])('without the fields $path reads fails as an internal error', async function({ path, body }) {
		const node = await nodes.start();
		const answer = await postJSON(node, path, body);
		expectInternal(answer);
		expectDocumented('POST', path, answer);
	});

	test('of a peer-to-peer message the switch cannot read is not accepted, whatever other fields it has', async function() {
		const node = await nodes.start();
		const greeting = await node.node.switch.getOutgoingGreetingInfo();
		const answer = await postJSON(node, '/p2p/message', { message: '{}', greeting, sentBy: 'a newer client' });

		expect(answer.status).toBe(200);
		expect(answer.body).toEqual({ success: false });
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

// The memory driver runs one transaction at a time, so only Postgres can hold two open together.
describe('concurrent requests on the postgres driver', function() {
	test('each read the ledger in a transaction of their own request\'s copy of the node', async function() {
		const node = await populated(driverUnderTestNamed('postgres'));
		const copies: Node[] = [];
		const copy = node.node.copy.bind(node.node);
		vi.spyOn(node.node, 'copy').mockImplementation(function(): Node {
			const made = copy();
			copies.push(made);
			return(made);
		});
		const transactions = vi.spyOn(node.storage, 'beginTransaction');
		// Both requests are held inside their transactions until both are inside.
		const bothInside = barrier(2);
		const readBalances = node.storage.getAllBalances.bind(node.storage);
		vi.spyOn(node.storage, 'getAllBalances').mockImplementation(async function(...input) {
			await bothInside();
			return(await readBalances(...input));
		});
		const synced = vi.spyOn(lib.Node.prototype, 'sync');

		const answers = await Promise.all([
			request(node, `/node/ledger/account/${keyOf(node.user)}`),
			request(node, `/node/ledger/account/${keyOf(node.other)}/acl/additional`)
		]);

		expect(answers.map(function(answer): number {
			return(answer.status);
		})).toEqual([200, 200]);
		expect(new Set(copies).size).toBe(2);
		expect(copies).not.toContain(node.node);
		const transactionNodes = transactions.mock.calls.map(function([options]): unknown {
			return(options.node);
		});
		expect(transactionNodes).toHaveLength(2);
		expect(new Set(transactionNodes)).toEqual(new Set(copies));
		const opened = await Promise.all(transactions.mock.results.map(function(result): unknown {
			return(result.value);
		}));
		expect(new Set(opened).size).toBe(2);
		expect(new Set(synced.mock.contexts)).toEqual(new Set(copies));
	});

	test('each vote in a transaction of their own request\'s copy of the node', async function() {
		const node = await populated(driverUnderTestNamed('postgres'));
		const ledgers = vi.spyOn(lib.Ledger.prototype, 'quote');
		const transactions = vi.spyOn(node.storage, 'beginTransaction');
		const bothInside = barrier(2);
		const nextSerial = node.storage.getNextSerialNumber.bind(node.storage);
		vi.spyOn(node.storage, 'getNextSerialNumber').mockImplementation(async function(...input) {
			await bothInside();
			return(await nextSerial(...input));
		});
		const blocks = { blocks: [base64(node.pending.toBytes())] };

		const answers = await Promise.all([postJSON(node, '/vote/quote', blocks), postJSON(node, '/vote/quote', blocks)]);

		expect(answers.map(function(answer): number {
			return(answer.status);
		})).toEqual([200, 200]);
		const quoting = ledgers.mock.contexts.filter(function(context): context is Ledger {
			return(context instanceof lib.Ledger);
		});
		expect(new Set(quoting).size).toBe(2);
		expect(quoting).not.toContain(node.node.ledger);
		const transactionNodes = new Set(transactions.mock.calls.map(function([options]): unknown {
			return(options.node);
		}));
		expect(transactionNodes).toEqual(new Set(quoting.map(function(ledger): unknown {
			return(ledger.node);
		})));
		const [first, second] = answers;
		expect(field(first.body, 'quote')).not.toEqual(field(second.body, 'quote'));
	});
});

describe('a transaction that keeps conflicting', function() {
	test('is refused once its retries run out, without the database\'s text', async function() {
		const node = await nodes.start({ driver: driverUnderTestNamed('postgres') });
		const conflict = new pg.DatabaseError(`could not serialize access due to concurrent update on ${SECRET}`, 0, 'error');
		conflict.code = '40001';
		const mapped = mapDatabaseError(conflict, { kind: 'before-commit', connectionLost: false });
		if (mapped.kind !== 'conflict') {
			throw(new Error('a serialization failure is a conflict'));
		}
		const balances = vi.spyOn(node.storage, 'getAllBalances').mockRejectedValue(mapped.error);

		const answer = await request(node, `/node/ledger/account/${keyOf(requireAt(node.network.users, 0))}`);

		expect(balances.mock.calls.length).toBeGreaterThan(1);
		expectRefusal(answer, 'LEDGER_TRANSACTION_ABORTED', CONFLICT_MESSAGE);
		expect(answer.text).not.toContain('hunter2');
		expect(answer.text).not.toContain('serialize');
		expectDocumented('GET', '/node/ledger/account/x', answer);
	});
});
