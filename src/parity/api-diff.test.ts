import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { loadMainnetFixture } from '../conformance/mainnet/fixture.js';
import { feeBlock, multisigSendBlock, sendBlock, setRepresentativeBlock } from '../testing/blocks.js';
import { startFakeAPI } from '../testing/fake-api.js';
import type { FakeAPI } from '../testing/fake-api.js';
import { accountRequests, behaviorsOf, blockRequests, capturedBehaviors, GET_ROUTES, getRoutesOf, operationsOf, recheckAPIDivergences, routeOf, sampleAPI, shuffled } from './api-diff.js';
import type { APIDiffStore } from './api-diff.js';
import { httpSource } from './api-source.js';
import type { AccountCandidate, AccountKind, FollowerProgress, HeldBlock } from './follower-store.js';
import { ParityLog } from './log.js';
import type { APIDiffOutcome, APIDiffPlanRecord, APIDiffRecord } from './log.js';
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

const PROGRESS: FollowerProgress = { completedPass: undefined, heldBefore: HELD_BEFORE, staged: 0 };

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

describe('the operations of a block', function() {
	function decodedOperations(bytes: Buffer): readonly string[] {
		const types = new Set(new lib.Block(bytes).operations.map(function(operation): number {
			return(operation.type);
		}));
		return(OPERATION_NAMES.filter(function(name): boolean {
			return(types.has(lib.Block.OperationType[name]));
		}));
	}

	test('are read from its encoding as the client decodes them, for every block of the main network fixtures and each form of block', async function() {
		const staples = [...await loadMainnetFixture('head'), ...await loadMainnetFixture('edge-cases')];
		const multisig = await multisigSendBlock({ from: owner, signer: [owner.generateIdentifier(lib.Account.AccountKeyAlgorithm.MULTISIG, undefined, 1), [owner, other]], to: other, amount: 1n, token, previous: null, network: NETWORK, date: new Date('2025-11-01T00:00:00.000Z') });
		const fee = await feeBlock({ from: owner, payments: [{ to: other, token, amount: 1n }], previous: null, network: NETWORK, date: new Date('2025-11-01T00:00:00.000Z') });
		const blocks = [...staples.flatMap(function(staple) {
			return(staple.blocks);
		}), multisig, fee];
		expect(blocks.length).toBeGreaterThan(4000);
		for (const block of blocks) {
			const bytes = Buffer.from(block.toBytes());
			expect(operationsOf({ hash: block.hash.toString(), account: block.account.publicKeyString.get(), bytes })).toEqual(decodedOperations(bytes));
		}
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

type Representatives = { readonly follower: FakeAPI; readonly representatives: readonly FakeAPI[]; readonly log: ParityLog };

async function runningWith(count: number): Promise<Representatives> {
	const directory = await mkdtemp(join(tmpdir(), 'slop-api-diff-'));
	directories.push(directory);
	const representatives: FakeAPI[] = [];
	for (let index = 0; index < count; index++) {
		representatives.push(await startFakeAPI());
	}
	return({ follower: await startFakeAPI(), representatives, log: new ParityLog(join(directory, 'parity.jsonl')) });
}

const BALANCE = `/node/ledger/account/${TOKEN}/balance`;

function balanceOf(amount: string): unknown {
	return({ balances: [{ token: TOKEN, balance: amount }] });
}

/** The follower's balance, and each representative's, every account quiet on each of them. */
function servingBalances(setup: Representatives, follower: string, representatives: readonly (string | undefined)[]): void {
	setup.follower.serve(BALANCE, balanceOf(follower));
	setup.representatives.forEach(function(representative, index) {
		representative.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, QUIET_HISTORY);
		const amount = representatives[index];
		if (amount === undefined) {
			representative.answer(BALANCE, { status: 504, body: 'gateway timeout' });
			return;
		}
		representative.serve(BALANCE, balanceOf(amount));
	});
}

function sources(setup: Representatives) {
	return({
		follower: httpSource(setup.follower.endpoint),
		representatives: setup.representatives.map(function(representative) {
			return(httpSource(representative.endpoint));
		}),
		log: setup.log,
		stopped: new AbortController().signal
	});
}

const RECORDED_DIVERGENCE: APIDiffOutcome = { kind: 'diverged', field: 'body.balances[0].balance', follower: { status: 200, body: balanceOf('0x1') }, representative: { status: 200, body: balanceOf('0x2') }, readings: [] };

/** Compares again a divergence recorded with the first representative. */
async function recheck(setup: Representatives, store: APIDiffStore = memoryStore({})) {
	const first = setup.representatives[0];
	if (first === undefined) {
		throw(new Error('no representative'));
	}
	const recorded: APIDiffRecord = { kind: 'api-diff', at: '2026-10-09T08:40:00.000Z', representative: first.endpoint, stratum: 'token', route: '/api/node/ledger/account/{account}/balance', path: BALANCE, behaviors: [], outcome: RECORDED_DIVERGENCE };
	await setup.log.append([recorded]);
	const summary = await recheckAPIDivergences({ ...sources(setup), store });
	const records = recordsOf((await setup.log.read()).records, 'api-diff');
	return({ summary, recorded, latest: records.at(-1) });
}

describe('a divergence of the API', function() {
	test('is read again from every other representative, and is the follower\'s when they answer as the one compared with', async function() {
		const setup = await runningWith(3);
		servingBalances(setup, '0x1', ['0x2', '0x2', '0x2']);

		await sampleAPI({ ...sources(setup), store: memoryStore({ candidates: { token: [CANDIDATE] } }), samplesPerStratum: 100, seed: 'test', edgeCaseStaples: [], knownBehaviors: new Set() });

		const records = recordsOf((await setup.log.read()).records, 'api-diff');
		const outcome = byPath(records, BALANCE)?.outcome;
		expect(outcome).toMatchObject({ kind: 'diverged', field: 'body.balances[0].balance' });
		expect(outcome?.kind === 'diverged' && outcome.readings.map(function(reading) {
			return(reading.kind);
		})).toEqual(['disagrees', 'disagrees']);
	});

	test('is compared again with the representative it was recorded with, and is that representative\'s own when two others answer as the follower', async function() {
		const setup = await runningWith(3);
		servingBalances(setup, '0x1', ['0x2', '0x1', '0x1']);

		const { summary, latest } = await recheck(setup);

		expect(summary).toEqual({ 'representative-local': 1 });
		expect(latest).toMatchObject({ representative: setup.representatives[0]?.endpoint, stratum: 'token', path: BALANCE, outcome: { kind: 'representative-local', field: 'body.balances[0].balance' } });
		expect(latest?.outcome.kind === 'representative-local' && latest.outcome.readings).toEqual([
			{ representative: setup.representatives[1]?.endpoint, kind: 'agrees', answer: { status: 200, body: balanceOf('0x1') } },
			{ representative: setup.representatives[2]?.endpoint, kind: 'agrees', answer: { status: 200, body: balanceOf('0x1') } }
		]);
		expect(setup.representatives[0]?.requests).toEqual([`GET /node/ledger/account/${TOKEN}/history?limit=1`, `GET ${BALANCE}`]);
	});

	test('is unresolved when no side has most of the representatives that answered', async function() {
		const setup = await runningWith(3);
		servingBalances(setup, '0x1', ['0x2', '0x1', undefined]);

		const { summary, latest } = await recheck(setup);

		expect(summary).toEqual({ unresolved: 1 });
		expect(latest?.outcome.kind === 'unresolved' && latest.outcome.readings.map(function(reading) {
			return(reading.kind);
		})).toEqual(['agrees', 'unanswered']);
	});

	test('counts no reading from a representative on which an account the answer reads is not quiet', async function() {
		const setup = await runningWith(3);
		servingBalances(setup, '0x1', ['0x2', '0x1', '0x1']);
		setup.representatives[2]?.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, recentHistory(TOKEN));

		const { latest } = await recheck(setup);

		expect(latest?.outcome).toMatchObject({ kind: 'unresolved', readings: [{ kind: 'agrees' }, { kind: 'moving' }] });
		expect(setup.representatives[2]?.requests).toEqual([`GET /node/ledger/account/${TOKEN}/history?limit=1`]);
	});

	test('is superseded by a match when the follower answers as the representative now', async function() {
		const setup = await runningWith(2);
		servingBalances(setup, '0x2', ['0x2', '0x2']);

		const { summary, latest } = await recheck(setup);

		expect(summary).toEqual({ match: 1 });
		expect(latest?.outcome).toEqual({ kind: 'match' });
		expect(setup.representatives[1]?.requests).toEqual([]);
	});

	test('of a block\'s successor needs the block\'s account quiet when compared again', async function() {
		const setup = await runningWith(1);
		const block = await heldSend();
		const path = `/node/ledger/block/${block.hash}/successor`;
		setup.follower.serve(path, { block: null });
		setup.representatives[0]?.serve(path, { block: null });
		setup.representatives[0]?.serve(`/node/ledger/account/${OWNER}/history?limit=1`, QUIET_HISTORY);
		const recorded: APIDiffRecord = { kind: 'api-diff', at: '2026-10-09T08:40:00.000Z', representative: setup.representatives[0]?.endpoint ?? '', stratum: 'operation:SEND', route: '/api/node/ledger/block/{blockhash}/successor', path, behaviors: [], outcome: { ...RECORDED_DIVERGENCE, field: 'body.block' } };
		await setup.log.append([recorded]);

		expect(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({ blocks: [block] }) })).toEqual({ match: 1 });
		expect(setup.representatives[0]?.requests).toEqual([`GET /node/ledger/account/${OWNER}/history?limit=1`, `GET ${path}`]);
	});
});

describe('the plan of a run', function() {
	async function planned(store: APIDiffStore, samplesPerStratum: number, edgeCaseStaples: readonly string[] = []): Promise<{ readonly plan: APIDiffPlanRecord | undefined; readonly records: readonly APIDiffRecord[] }> {
		const setup = await runningWith(1);
		setup.representatives[0]?.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, QUIET_HISTORY);
		setup.representatives[0]?.serve(`/node/ledger/account/${OWNER}/history?limit=1`, QUIET_HISTORY);
		await sampleAPI({ ...sources(setup), store, samplesPerStratum, seed: 'test', edgeCaseStaples, knownBehaviors: new Set() });
		const { records } = await setup.log.read();
		return({ plan: recordsOf(records, 'api-diff-plan')[0], records: recordsOf(records, 'api-diff') });
	}

	function populationOf(plan: APIDiffPlanRecord | undefined, stratum: string) {
		return(plan?.strata.find(function(planned) {
			return(planned.stratum === stratum);
		})?.population);
	}

	test('is recorded before its comparisons, as a census of each stratum whose every request is fewer than it compares', async function() {
		const { plan, records } = await planned(memoryStore({ candidates: { multisig: [CANDIDATE] } }), 100);

		const census = populationOf(plan, 'multisig');
		expect(census?.kind).toBe('census');
		const requested = records.filter(function(record) {
			return(record.stratum === 'multisig');
		}).map(function(record) {
			return(record.path);
		});
		expect(census?.kind === 'census' && [...census.requests].sort()).toEqual([...requested].sort());
		expect(populationOf(plan, 'storage')).toEqual({ kind: 'census', requests: [] });
		expect(plan).toMatchObject({ samplesPerStratum: 100, quietBefore: '2025-12-30T23:00:00.000Z' });
	});

	test('is a sample of a stratum with as many accounts as it asked for, which more may follow', async function() {
		const { plan } = await planned(memoryStore({ candidates: { token: [CANDIDATE] } }), 1);

		expect(populationOf(plan, 'token')).toMatchObject({ kind: 'sample', whole: false });
	});

	test('reads every held block once for the operations it lacks, so that a rare operation\'s every block is drawn, each request once', async function() {
		const send = await heldSend();
		const setRepresentative = await setRepresentativeBlock({ account: other, representative: owner, previous: null, network: NETWORK, date: new Date('2025-11-01T00:00:00.000Z') });
		const blocks = [send, { hash: setRepresentative.hash.toString(), account: OTHER, bytes: Buffer.from(setRepresentative.toBytes()) }];

		const { plan, records } = await planned(memoryStore({ blocks }), 100);

		const sendPopulation = populationOf(plan, 'operation:SEND');
		expect(sendPopulation?.kind === 'census' && sendPopulation.requests).toHaveLength(5);
		expect(populationOf(plan, 'operation:TOKEN_ADMIN_MODIFY_BALANCE')).toEqual({ kind: 'census', requests: [] });
		const paths = records.map(function(record) {
			return(`${record.stratum} ${record.path}`);
		});
		expect(new Set(paths).size).toBe(paths.length);
		expect(paths).toHaveLength(9);
	});
});
