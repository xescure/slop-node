import { describe, expect, test } from 'vitest';
import { APIDocument, isJSONObject } from '../conformance/api/document.js';
import { routeOfRequest } from '../conformance/api/routes.js';
import type { Route as DocumentRoute } from '../conformance/api/routes.js';
import { driversUnderTest } from '../ledger/storage/suite/drivers.js';
import { base64, keyOf, populate } from '../testing/api-network.js';
import type { PopulatedNode } from '../testing/api-network.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { postJSON, request, useLocalNodes } from '../testing/local-node.js';
import type { HTTPAnswer } from '../testing/local-node.js';
import { assertNever } from '../util/assert-never.js';

const api = new APIDocument();

const nodes = useLocalNodes();

/** A hash no block, staple or certificate has. */
const UNKNOWN_HASH = 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';

const MALFORMED_ACCOUNT = 'keeta_not-an-account';

type Call = {
	readonly method: 'GET' | 'POST';
	/** Below the API prefix, with each path parameter percent-encoded as the client encodes it [Keeta TS] index.js:59717-59725. */
	readonly path: string;
	readonly body?: unknown;
	readonly status: 200 | 500;
};

function get(path: string, status: 200 | 500 = 200): Call {
	return({ method: 'GET', path, status });
}

function post(path: string, body: unknown): Call {
	return({ method: 'POST', path, body, status: 200 });
}

function field(body: unknown, name: string): unknown {
	if (!isJSONObject(body)) {
		throw(new Error('the body is not an object'));
	}
	return(body[name]);
}

/** The path a document route serves, without the query and with the API prefix. */
function documentRouteOf(call: Call): DocumentRoute {
	const path = `/api${call.path.split('?')[0] ?? ''}`;
	return(routeOfRequest(api.routes, call.method, path));
}

async function answer(node: PopulatedNode, call: Call): Promise<HTTPAnswer> {
	switch (call.method) {
		case 'GET':
			return(await request(node, call.path));
		case 'POST':
			return(await postJSON(node, call.path, call.body));
		default:
			return(assertNever(call.method));
	}
}

/**
 * Every operation of the document, each with the parameters a client sends,
 * and the malformed requests whose answers API.md records.
 */
async function callsFor(node: PopulatedNode): Promise<readonly Call[]> {
	const user = keyOf(node.user);
	const other = keyOf(node.other);
	const token = keyOf(node.token);
	const multisig = keyOf(node.multisig);
	const stranger = keyOf(node.stranger);
	const representative = keyOf(node.representative);
	const sent = node.keyedSend.hash.toString();
	const pending = node.pending.hash.toString();
	const firstHistory = await request(node, `/node/ledger/account/${user}/history?limit=1`);
	const nextKey = field(firstHistory.body, 'nextKey');
	const ledgerHistory = await request(node, '/node/ledger/history?limit=2');
	const ledgerNextKey = field(ledgerHistory.body, 'nextKey');
	if (typeof nextKey !== 'string' || typeof ledgerNextKey !== 'string') {
		throw(new Error('the histories have a single page'));
	}
	// The node has voted for the pending block already, and votes once for one previous.
	const opening = await sendBlock({ from: node.other, to: node.user, amount: 1n, token: node.network.baseToken, previous: null, network: node.network.network });
	const blocks = { blocks: [base64(opening.toBytes())] };
	const peer = await node.node.switch.getOutgoingGreetingInfo();
	return([
		post('/vote/quote', blocks),
		post('/vote', blocks),
		get(`/vote/${sent}`),
		get(`/vote/${pending}?side=side`),
		get(`/vote/${UNKNOWN_HASH}`),
		get('/vote/not-a-hash', 500),
		get('/node/peers'),
		get('/node/stats'),
		get('/node/version'),
		get('/node/bootstrap/votes?start=1970-01-01T00%3A00%3A00.000Z&limit=2'),
		get('/node/bootstrap/votes?limit=1', 500),
		get('/node/ledger/clearstats'),
		get('/node/ledger/checksum'),
		get(`/node/ledger/block/${sent}`),
		get(`/node/ledger/block/${pending}?side=side`),
		get(`/node/ledger/block/${sent}?side=side`),
		get(`/node/ledger/block/${sent}?side=neither`, 500),
		get(`/node/ledger/block/${UNKNOWN_HASH}`),
		get('/node/ledger/block/not-a-hash', 500),
		get(`/node/ledger/block/${node.published[0]?.blocks[0]?.hash.toString() ?? ''}/successor`),
		get(`/node/ledger/block/${UNKNOWN_HASH}/successor`),
		get('/node/ledger/representative'),
		get(`/node/ledger/representative/${representative}`),
		get('/node/ledger/representatives'),
		get('/node/ledger/history?limit=2'),
		get(`/node/ledger/history?limit=2&start=${ledgerNextKey}`),
		get('/node/ledger/history?limit=0', 500),
		get(`/node/ledger/accounts/${encodeURIComponent([user, other, token, stranger].join(','))}`),
		get(`/node/ledger/accounts/${encodeURIComponent([user, MALFORMED_ACCOUNT].join(','))}`),
		get(`/node/ledger/account/${user}`),
		get(`/node/ledger/account/${token}`),
		get(`/node/ledger/account/${multisig}`),
		get(`/node/ledger/account/${keyOf(node.network.networkAddress)}`),
		get(`/node/ledger/account/${stranger}`),
		get(`/node/ledger/account/${MALFORMED_ACCOUNT}`),
		get(`/node/ledger/account/${user}/head`),
		get(`/node/ledger/account/${stranger}/head`),
		get(`/node/ledger/account/${user}/chain?limit=2`),
		get(`/node/ledger/account/${user}/chain?start=${sent}&limit=2`),
		get(`/node/ledger/account/${user}/history?limit=1`),
		get(`/node/ledger/account/${user}/history?limit=1&start=${nextKey}`),
		get(`/node/ledger/account/${user}/history?limit=0`, 500),
		get(`/node/ledger/account/${user}/history/start/${nextKey}?limit=1`),
		get(`/node/ledger/account/${user}/balance`),
		get(`/node/ledger/account/${other}/balance/${token}`),
		get(`/node/ledger/account/${user}/acl`),
		get(`/node/ledger/account/${user}/acl/${encodeURIComponent([token, multisig].join(','))}`),
		get(`/node/ledger/account/${multisig}/acl/granted`),
		get(`/node/ledger/account/${user}/acl/additional`),
		get(`/node/ledger/account/${user}/acl/additional/${multisig}`),
		get(`/node/ledger/account/${user}/certificates`),
		get(`/node/ledger/account/${user}/certificates/${node.certificateHash}`),
		get(`/node/ledger/account/${user}/certificates/${UNKNOWN_HASH}`),
		get(`/node/ledger/account/${user}/pending`),
		get(`/node/ledger/account/${user}/idempotent/${encodeURIComponent(node.idempotentKey)}`),
		get(`/node/ledger/account/${user}/idempotent/${encodeURIComponent(btoa('slop-node/unknown'))}`),
		post('/node/publish', { votesAndBlocks: base64((await confirmedStaple([opening], [node.representative])).toBytes()) }),
		post('/p2p/message', { message: JSON.stringify({ id: 'contract', test: 'hello', ttl: 0 }), greeting: peer })
	]);
}

function spelled(route: DocumentRoute): string {
	return(`${route.method} ${route.path}`);
}

describe.each(driversUnderTest)('a node on the $name driver, holding a populated network', function(driver) {
	test('answers every operation of the document, and every body validates against it', async function() {
		const node = await populate(await nodes.start({ driver, fee: { kind: 'flat', amount: 1n } }));
		const calls = await callsFor(node);
		const answered = new Set<string>();
		for (const call of calls) {
			const route = documentRouteOf(call);
			const response = await answer(node, call);
			expect({ call: `${call.method} ${call.path}`, status: response.status, body: response.body }).toMatchObject({ call: `${call.method} ${call.path}`, status: call.status });
			expect(response.contentType).toBe('application/json; charset=utf-8');
			expect({ call: `${call.method} ${call.path}`, violations: api.responseViolations(route, response.status, response.body) }).toEqual({ call: `${call.method} ${call.path}`, violations: [] });
			answered.add(spelled(route));
		}
		expect([...answered].sort()).toEqual(api.routes.map(spelled).sort());
	});
});
