import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { sendBlock, setRepresentativeBlock } from '../testing/blocks.js';
import { startFakeAPI } from '../testing/fake-api.js';
import type { FakeAPI } from '../testing/fake-api.js';
import { accountRequests, behaviorsOf, blockRequests, capturedBehaviors, GET_ROUTES, getRoutesOf, operationsOf, routeOf, sampleAPI, shuffled } from './api-diff.js';
import type { APIDiffStore } from './api-diff.js';
import { httpSource } from './api-source.js';
import type { AccountCandidate, AccountKind, FollowerProgress, HeldBlock } from './follower-store.js';
import { ParityLog } from './log.js';
import type { APIDiffRecord } from './log.js';
import { recordsOf } from './report.js';
import { OPERATION_NAMES } from './strata.js';

const lib = KeetaNet.lib;

const NETWORK = 0x5382n;

const owner = lib.Account.fromSeed('8f1b3c5d7e9fa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182930', 0);
const other = lib.Account.fromSeed('8f1b3c5d7e9fa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182930', 1);
const token: TokenAddress = owner.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);
const TOKEN = token.publicKeyString.get();
const OWNER = owner.publicKeyString.get();
const OTHER = other.publicKeyString.get();

const HELD_BEFORE = new Date('2025-12-31T00:00:00.000Z');

const PROGRESS: FollowerProgress = { completedPass: undefined, heldBefore: HELD_BEFORE };

/** A send that names an idempotent key, as a held block. */
async function heldSend(): Promise<HeldBlock> {
	const block = await sendBlock({ from: owner, to: other, amount: 5n, token, previous: null, network: NETWORK, idempotent: 'c2xvcC1ub2Rl', date: new Date('2025-11-01T00:00:00.000Z') });
	return({ hash: block.hash.toString(), account: OWNER, bytes: Buffer.from(block.toBytes()) });
}

describe('the routes the API diff samples', function() {
	test('are every GET route of the document, each sampled or left out with its reason', async function() {
		const document: unknown = JSON.parse(await readFile(new URL('../../api/openapi.json', import.meta.url), 'utf8'));
		expect(Object.keys(GET_ROUTES).sort()).toEqual(getRoutesOf(document));
	});

	test('are found for a request below the API\'s root, with their decoded parameters', function() {
		expect(routeOf(`/node/ledger/account/${OWNER}/balance/${TOKEN}`)).toEqual({ route: '/api/node/ledger/account/{account}/balance/{token}', parameters: { account: OWNER, token: TOKEN } });
		expect(routeOf(`/node/ledger/account/${OWNER}/acl/granted`)?.route).toBe('/api/node/ledger/account/{account}/acl/granted');
		expect(routeOf(`/node/ledger/account/${OWNER}/history?limit=1`)?.route).toBe('/api/node/ledger/account/{account}/history');
		expect(routeOf(`/node/ledger/accounts/${encodeURIComponent(`${OWNER},${OTHER}`)}`)?.parameters).toEqual({ accounts: `${OWNER},${OTHER}` });
		expect(routeOf('/node/nothing')).toBeUndefined();
	});

	test('the operation names are the client\'s', function() {
		expect(OPERATION_NAMES.map(function(name) {
			return(lib.Block.OperationType[name]);
		})).toEqual(OPERATION_NAMES.map(function(_name, index) {
			return(index);
		}));
	});
});

describe('the requests drawn', function() {
	test('about a held block, which never change but for its successor, and its idempotent key', async function() {
		const block = await heldSend();
		const requests = blockRequests('operation:SEND', block);
		expect(requests.map(function(request) {
			return([request.route, request.path, request.quiet]);
		})).toEqual([
			['/api/node/ledger/block/{blockhash}', `/node/ledger/block/${block.hash}`, []],
			['/api/vote/{blockhash}', `/vote/${block.hash}`, []],
			['/api/node/ledger/account/{account}/chain', `/node/ledger/account/${OWNER}/chain?start=${block.hash}&limit=2`, []],
			['/api/node/ledger/block/{blockhash}/successor', `/node/ledger/block/${block.hash}/successor`, [OWNER]],
			['/api/node/ledger/account/{account}/idempotent/{idempotent}', `/node/ledger/account/${OWNER}/idempotent/c2xvcC1ub2Rl`, []]
		]);
		expect(operationsOf(block)).toEqual(['SEND']);
	});

	test('about a quiet account, each needing the accounts it reads quiet', function() {
		const candidate: AccountCandidate = { account: TOKEN, tokens: [TOKEN], certificates: ['AB'.repeat(32)], entities: [OTHER], chain: [], history: ['CD'.repeat(32)] };
		const requests = accountRequests('token', candidate, OWNER);
		const byRoute = new Map(requests.map(function(request) {
			return([request.route, request]);
		}));
		expect(new Set(byRoute.keys())).toEqual(new Set(Object.entries(GET_ROUTES).filter(function([route, use]) {
			return(use.kind === 'sampled' && !route.includes('{blockhash}') && !route.includes('{idempotent}') && route !== '/api/vote/{blockhash}');
		}).map(function([route]) {
			return(route);
		})));
		expect(byRoute.get('/api/node/ledger/account/{account}/acl')).toMatchObject({ quiet: [TOKEN], listsEntities: true });
		expect(byRoute.get('/api/node/ledger/account/{account}/acl/{entityList}')).toMatchObject({ path: `/node/ledger/account/${TOKEN}/acl/${OTHER}`, quiet: [TOKEN, OTHER], listsEntities: false });
		expect(byRoute.get('/api/node/ledger/accounts/{accounts}')).toMatchObject({ path: `/node/ledger/accounts/${TOKEN}%2C${OWNER}`, quiet: [TOKEN, OWNER] });
		expect(byRoute.get('/api/node/ledger/account/{account}/history/start/{block}')?.path).toBe(`/node/ledger/account/${TOKEN}/history/start/${'CD'.repeat(32)}?limit=1`);
	});

	test('in an order the seed fixes', function() {
		const items = ['a', 'b', 'c', 'd', 'e', 'f'];
		const identity = function(item: string): string {
			return(item);
		};
		expect(shuffled(items, identity, 'one')).toEqual(shuffled([...items].reverse(), identity, 'one'));
		expect(shuffled(items, identity, 'one')).not.toEqual(shuffled(items, identity, 'two'));
	});
});

describe('the behavior of an answer', function() {
	test('is its route with its status and error code, the kind of account it is about, and each operation it serves', async function() {
		const block = await heldSend();
		const served = { status: 200, body: { blockhash: block.hash, block: { operations: [{ type: 0 }, { type: 7 }] } } };
		expect(behaviorsOf(`/node/ledger/block/${block.hash}`, served)).toEqual(['/api/node/ledger/block/{blockhash} 200 error=-', 'operation=RECEIVE', 'operation=SEND']);
		expect(behaviorsOf(`/node/ledger/account/${TOKEN}/acl/granted`, { status: 500, body: { error: true, code: 'API_INVALID_SIDE' } })).toEqual(['/api/node/ledger/account/{account}/acl/granted 500 error=API_INVALID_SIDE', 'account=TOKEN']);
		expect(behaviorsOf('/node/ledger/account/keeta_not-an-account', { status: 500, body: { error: true } })).toEqual(['/api/node/ledger/account/{account} 500 error=internal', 'account=malformed']);
		expect(behaviorsOf('/elsewhere', { status: 404, body: 'Cannot GET /elsewhere' })).toEqual([]);
	});

	test('of every capture is known, and covers several routes', async function() {
		const known = await capturedBehaviors(fileURLToPath(new URL('../../conformance/api/mainnet/', import.meta.url)));
		expect(known.size).toBeGreaterThan(20);
		expect(known).toContain('account=MULTISIG');
		expect(known).toContain('operation=SEND');
	});
});

const directories: string[] = [];

afterEach(async function() {
	await Promise.all(directories.splice(0).map(function(directory) {
		return(rm(directory, { recursive: true, force: true }));
	}));
});

type StoreContents = {
	readonly candidates?: Partial<Readonly<Record<AccountKind, readonly AccountCandidate[]>>>;
	readonly blocks?: readonly HeldBlock[];
	readonly newest?: ReadonlyMap<string, Date>;
};

function memoryStore(contents: StoreContents): APIDiffStore {
	return({
		progress: () => Promise.resolve(PROGRESS),
		quietAccounts: (kind) => Promise.resolve(contents.candidates?.[kind] ?? []),
		heldBlocks: (fromHash) => Promise.resolve((contents.blocks ?? []).filter(function(block) {
			return(block.hash >= fromHash);
		})),
		heldBlocksOfStaples: () => Promise.resolve([]),
		newestStaples: () => Promise.resolve(contents.newest ?? new Map())
	});
}

const STATE = { account: TOKEN, balances: [], currentHeadBlock: null, currentHeadBlockHeight: null, info: {}, representative: null };

const QUIET_HISTORY = { history: [], nextKey: null };

function recentHistory(account: string): unknown {
	return({ history: [{ $id: 'EF'.repeat(32), voteStaple: { votes: [{ validityFrom: '2026-10-01T00:00:00.000Z' }] } }], nextKey: null, account });
}

type Running = { readonly follower: FakeAPI; readonly representative: FakeAPI; readonly log: ParityLog };

async function running(): Promise<Running> {
	const directory = await mkdtemp(join(tmpdir(), 'slop-api-diff-'));
	directories.push(directory);
	return({ follower: await startFakeAPI(), representative: await startFakeAPI(), log: new ParityLog(join(directory, 'parity.jsonl')) });
}

async function sample(setup: Running, store: APIDiffStore, samplesPerStratum: number, knownBehaviors: ReadonlySet<string> = new Set()) {
	const summary = await sampleAPI({
		follower: httpSource(setup.follower.endpoint),
		representatives: [httpSource(setup.representative.endpoint)],
		store,
		log: setup.log,
		samplesPerStratum,
		seed: 'test',
		edgeCaseStaples: [],
		knownBehaviors,
		stopped: new AbortController().signal
	});
	return({ summary, records: recordsOf((await setup.log.read()).records, 'api-diff') });
}

function byPath(records: readonly APIDiffRecord[], path: string): APIDiffRecord | undefined {
	return(records.find(function(record) {
		return(record.path === path);
	}));
}

const CANDIDATE: AccountCandidate = { account: TOKEN, tokens: [], certificates: [], entities: [], chain: [], history: [] };

describe('sampling the API', function() {
	test('compares a quiet account\'s answers once normalized, and records a divergence with both answers', async function() {
		const setup = await running();
		setup.representative.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, QUIET_HISTORY);
		setup.follower.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, QUIET_HISTORY);
		for (const api of [setup.follower, setup.representative]) {
			api.serve(`/node/ledger/account/${TOKEN}`, STATE);
		}
		setup.follower.answer(`/node/ledger/account/${TOKEN}/head`, { status: 500, body: { error: true, message: 'Internal error occurred (error ID: 00000000-0000-0000-0000-000000000001)' } });
		setup.representative.answer(`/node/ledger/account/${TOKEN}/head`, { status: 500, body: { error: true, message: 'Internal error occurred (error ID: 00000000-0000-0000-0000-000000000002)' } });
		setup.follower.serve(`/node/ledger/account/${TOKEN}/balance`, { balances: [{ token: TOKEN, balance: '0x1' }] });
		setup.representative.serve(`/node/ledger/account/${TOKEN}/balance`, { balances: [{ token: TOKEN, balance: '0x2' }] });

		const { summary, records } = await sample(setup, memoryStore({ candidates: { token: [CANDIDATE] } }), 100);

		expect(byPath(records, `/node/ledger/account/${TOKEN}`)?.outcome).toEqual({ kind: 'match' });
		expect(byPath(records, `/node/ledger/account/${TOKEN}/head`)?.outcome).toEqual({ kind: 'match' });
		expect(byPath(records, `/node/ledger/account/${TOKEN}/balance`)?.outcome).toMatchObject({ kind: 'diverged', field: 'body.balances[0].balance', follower: { status: 200 }, representative: { status: 200 } });
		expect(summary.strata.find(function(stratum) {
			return(stratum.stratum === 'token');
		})).toMatchObject({ compared: records.length, diverged: 1 });
		// Only GETs, and the representative is asked about the account's history once for the whole run.
		expect(setup.representative.requests.filter(function(request) {
			return(request.endsWith('/history?limit=1'));
		})).toHaveLength(2);
		expect([...setup.follower.requests, ...setup.representative.requests].every(function(request) {
			return(request.startsWith('GET '));
		})).toBe(true);
	});

	test('skips an account the representative holds a recent staple of, or the follower does, without asking about it', async function() {
		const setup = await running();
		setup.representative.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, recentHistory(TOKEN));

		const { records } = await sample(setup, memoryStore({ candidates: { token: [CANDIDATE] } }), 5);
		expect(records[0]?.outcome).toMatchObject({ kind: 'skipped', reason: 'moving', side: 'representative' });
		expect(setup.representative.requests).toEqual([`GET /node/ledger/account/${TOKEN}/history?limit=1`]);

		const onFollower = await running();
		const followerMoving = await sample(onFollower, memoryStore({ candidates: { token: [CANDIDATE] }, newest: new Map([[TOKEN, new Date('2026-01-01T00:00:00.000Z')]]) }), 5);
		expect(followerMoving.records[0]?.outcome).toMatchObject({ kind: 'skipped', reason: 'moving', side: 'follower' });
		expect(onFollower.representative.requests).toEqual([]);
	});

	test('skips a principal\'s listing that names an entity which is not quiet', async function() {
		const setup = await running();
		setup.representative.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, QUIET_HISTORY);
		setup.representative.serve(`/node/ledger/account/${OTHER}/history?limit=1`, recentHistory(OTHER));
		for (const api of [setup.follower, setup.representative]) {
			api.serve(`/node/ledger/account/${TOKEN}/acl`, { permissions: [{ entity: OTHER, principal: TOKEN, target: OTHER, permissions: ['0x1', '0x0'], principalType: 'ACCOUNT' }] });
		}

		const { records } = await sample(setup, memoryStore({ candidates: { token: [CANDIDATE] } }), 100);
		expect(byPath(records, `/node/ledger/account/${TOKEN}/acl`)?.outcome).toMatchObject({ kind: 'skipped', reason: 'moving', side: 'representative' });
	});

	test('counts a gateway\'s answer in place of the representative\'s as unanswered', async function() {
		const setup = await running();
		setup.representative.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, QUIET_HISTORY);
		setup.representative.answer(`/node/ledger/account/${TOKEN}`, { status: 504, body: 'gateway timeout' });

		const { records } = await sample(setup, memoryStore({ candidates: { token: [CANDIDATE] } }), 100);
		expect(byPath(records, `/node/ledger/account/${TOKEN}`)?.outcome).toMatchObject({ kind: 'skipped', reason: 'unanswered' });
	});

	test('draws blocks by the operations they carry, and reports answers of a kind the capture set lacks', async function() {
		const setup = await running();
		const send = await heldSend();
		const setRepresentative = await setRepresentativeBlock({ account: other, representative: owner, previous: null, network: NETWORK, date: new Date('2025-11-01T00:00:00.000Z') });
		const held = [send, { hash: setRepresentative.hash.toString(), account: OTHER, bytes: Buffer.from(setRepresentative.toBytes()) }];
		for (const api of [setup.follower, setup.representative]) {
			api.serve(`/node/ledger/block/${send.hash}`, { blockhash: send.hash, block: { operations: [{ type: 0 }] } });
		}

		const known = new Set(['/api/node/ledger/block/{blockhash} 200 error=-', 'operation=SET_REP']);
		const { summary, records } = await sample(setup, memoryStore({ blocks: held }), 100, known);

		expect(new Set(records.map(function(record) {
			return(record.stratum);
		}))).toEqual(new Set(['operation:SEND', 'operation:SET_REP']));
		expect(summary.newBehaviors).toContainEqual({ behavior: 'operation=SEND', path: `/node/ledger/block/${send.hash}` });
		expect(summary.newBehaviors.map(function(found) {
			return(found.behavior);
		})).not.toContain('operation=SET_REP');
	});
});
