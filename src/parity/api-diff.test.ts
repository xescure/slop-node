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
import type { FakeAnswer, FakeAPI } from '../testing/fake-api.js';
import { accountRequests, answerDigest, API_DIFF_SAMPLES_TARGET, explainDivergence, requestStandings, standingCensuses, behaviorsOf, blockRequests, capturedBehaviors, GET_ROUTES, getRoutesOf, operationsOf, recheckAPIDivergences, routeAttemptsOf, routeOf, routeUncovered, sampleAPI, shuffled } from './api-diff.js';
import type { APIDiffStore } from './api-diff.js';
import { httpSource } from './api-source.js';
import type { AccountCandidate, AccountKind, FollowerProgress, HeldBlock } from './follower-store.js';
import { ParityLog } from './log.js';
import type { APIDiffExplainedRecord, APIDiffOutcome, APIDiffPlanRecord, APIDiffRecord } from './log.js';
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
	}, 120_000);
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
	/** Staples, by the hash of their blocks, the follower holds in the history of every account. */
	readonly held?: readonly string[];
};

function memoryStore(contents: StoreContents): APIDiffStore {
	return({
		progress: () => Promise.resolve(PROGRESS),
		quietAccounts: (kind) => Promise.resolve(contents.candidates?.[kind] ?? []),
		heldBlocks: (fromHash) => Promise.resolve((contents.blocks ?? []).filter(function(block) {
			return(block.hash >= fromHash);
		})),
		// Each block on a page of its own, in the order given.
		blockPages: () => Promise.resolve(contents.blocks?.length ?? 0),
		heldBlocksInPages: (fromPage, toPage) => Promise.resolve((contents.blocks ?? []).slice(fromPage, toPage)),
		heldBlocksOfStaples: () => Promise.resolve([]),
		newestStaples: () => Promise.resolve(contents.newest ?? new Map()),
		historyHolds: (_account, staple) => Promise.resolve(contents.held?.includes(staple) ?? false)
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

		expect(byPath(records, `/node/ledger/account/${TOKEN}`)?.outcome).toMatchObject({ kind: 'match' });
		expect(byPath(records, `/node/ledger/account/${TOKEN}/head`)?.outcome).toMatchObject({ kind: 'skipped', reason: 'unanswered' });
		expect(byPath(records, `/node/ledger/account/${TOKEN}/balance`)?.outcome).toMatchObject({ kind: 'diverged', field: 'body.balances[0].balance', follower: { status: 200 }, representative: { status: 200 } });
		expect(summary.strata.find(function(stratum) {
			return(stratum.stratum === 'token');
		})).toMatchObject({ compared: records.length - 1, diverged: 1, skipped: 1 });
		// Only GETs; the representative is asked about the account's history once for the whole run, and again after the divergence.
		expect(setup.representative.requests.filter(function(request) {
			return(request.endsWith('/history?limit=1'));
		})).toHaveLength(3);
		expect([...setup.follower.requests, ...setup.representative.requests].every(function(request) {
			return(request.startsWith('GET '));
		})).toBe(true);
	});

	test('counts answers alike as a match however the accounts they read move, and skips answers apart about an account the representative holds a recent staple of, or the follower does', async function() {
		const setup = await running();
		setup.representative.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, recentHistory(TOKEN));
		setup.follower.serve(BALANCE, balanceOf('0x1'));
		setup.representative.serve(BALANCE, balanceOf('0x2'));

		const { records } = await sample(setup, memoryStore({ candidates: { token: [CANDIDATE] } }), 100);
		expect(byPath(records, BALANCE)?.outcome).toMatchObject({ kind: 'skipped', reason: 'moving', side: 'representative' });
		expect(byPath(records, `/node/ledger/account/${TOKEN}/head`)?.outcome).toMatchObject({ kind: 'match' });

		const onFollower = await running();
		onFollower.follower.serve(BALANCE, balanceOf('0x1'));
		onFollower.representative.serve(BALANCE, balanceOf('0x2'));
		const followerMoving = await sample(onFollower, memoryStore({ candidates: { token: [CANDIDATE] }, newest: new Map([[TOKEN, new Date('2026-01-01T00:00:00.000Z')]]) }), 100);
		expect(byPath(followerMoving.records, BALANCE)?.outcome).toMatchObject({ kind: 'skipped', reason: 'moving', side: 'follower' });
		// Only the sampled requests: the follower's own staple decides before the representative is asked about its history.
		expect(onFollower.representative.requests.filter(function(request) {
			return(request.endsWith('/history?limit=1'));
		})).toHaveLength(1);
	});

	test('records nothing of a request a stop cut short while it read the follower\'s database', async function() {
		const setup = await running();
		setup.follower.serve(BALANCE, balanceOf('0x1'));
		setup.representative.serve(BALANCE, balanceOf('0x2'));
		const stopping = new AbortController();
		const store: APIDiffStore = {
			...memoryStore({ candidates: { token: [CANDIDATE] } }),
			newestStaples(): Promise<ReadonlyMap<string, Date>> {
				stopping.abort();
				return(Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })));
			}
		};

		await sampleAPI({ follower: httpSource(setup.follower.endpoint), representatives: [httpSource(setup.representative.endpoint)], store, log: setup.log, samplesPerStratum: 100, seed: 'test', edgeCaseStaples: [], knownBehaviors: new Set(), stopped: stopping.signal });

		expect(stopping.signal.aborted).toBe(true);
		expect(byPath(recordsOf((await setup.log.read()).records, 'api-diff'), BALANCE)).toBeUndefined();
	});

	test('skips a principal\'s listing answered apart that names an entity which is not quiet', async function() {
		const setup = await running();
		setup.representative.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, QUIET_HISTORY);
		setup.representative.serve(`/node/ledger/account/${OTHER}/history?limit=1`, recentHistory(OTHER));
		setup.follower.serve(`/node/ledger/account/${TOKEN}/acl`, { permissions: [{ entity: OTHER, principal: TOKEN, target: OTHER, permissions: ['0x1', '0x0'], principalType: 'ACCOUNT' }] });
		setup.representative.serve(`/node/ledger/account/${TOKEN}/acl`, { permissions: [{ entity: OTHER, principal: TOKEN, target: OTHER, permissions: ['0x3', '0x0'], principalType: 'ACCOUNT' }] });

		const { records } = await sample(setup, memoryStore({ candidates: { token: [CANDIDATE] } }), 100);
		expect(byPath(records, `/node/ledger/account/${TOKEN}/acl`)?.outcome).toMatchObject({ kind: 'skipped', reason: 'moving', side: 'representative' });
	});

	test('compares an internal failure the follower answers twice with a different error ID as one answer, which a node serves anew for each request, but counts one both answer as no answer', async function() {
		const setup = await running();
		setup.representative.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, QUIET_HISTORY);
		const failure = function(id: string) {
			return({ status: 500, body: { error: true, message: `Internal error occurred (error ID: 00000000-0000-0000-0000-00000000000${id})` } });
		};
		setup.follower.answer(`/node/ledger/account/${TOKEN}/head`, failure('1'), failure('2'));
		setup.representative.answer(`/node/ledger/account/${TOKEN}/head`, failure('3'));
		setup.follower.answer(`/node/ledger/account/${TOKEN}`, failure('4'), failure('5'));
		setup.representative.serve(`/node/ledger/account/${TOKEN}`, STATE);

		const { records } = await sample(setup, memoryStore({ candidates: { token: [CANDIDATE] } }), 100);

		// Two internal failures that name no code of the API may have any two causes, so they show nothing alike.
		expect(byPath(records, `/node/ledger/account/${TOKEN}/head`)?.outcome).toMatchObject({ kind: 'skipped', reason: 'unanswered' });
		expect(byPath(records, `/node/ledger/account/${TOKEN}`)?.outcome).toMatchObject({ kind: 'diverged', field: 'body.account' });
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
		// Asked about the account's history once its answer differs, so that a staple added meanwhile shows as newest, and again for the newest it holds as the difference is judged.
		expect(setup.representatives[0]?.requests).toEqual([`GET ${BALANCE}`, `GET /node/ledger/account/${TOKEN}/history?limit=1`, `GET /node/ledger/account/${TOKEN}/history?limit=1`]);
	});

	test('is the own of the representatives answering apart when two answer as the follower and each other answers a value of its own', async function() {
		const setup = await runningWith(4);
		servingBalances(setup, '0x1', ['0x2', '0x1', '0x1', '0x3']);

		const { summary } = await recheck(setup);

		expect(summary).toEqual({ 'representative-local': 1 });
	});

	test('is never the own of the representatives answering apart when the follower lacks the newest staple one of them holds of the account', async function() {
		const setup = await runningWith(4);
		servingBalances(setup, '0x1', ['0x2', '0x1', '0x1', '0x3']);
		const lacked = 'EF'.repeat(32);
		setup.representatives[0]?.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, { history: [{ $id: lacked, voteStaple: { votes: [{ validityFrom: '2025-01-01T00:00:00.000Z' }] } }], nextKey: lacked });

		const { summary } = await recheck(setup);

		expect(summary).toEqual({ unresolved: 1 });
	});

	test('of a principal\'s permissions is never the own of the representatives answering apart when the follower lacks the newest staple one of them holds of an entity listed', async function() {
		const setup = await runningWith(4);
		const path = `/node/ledger/account/${TOKEN}/acl`;
		const listing = function(permission: string): unknown {
			return({ permissions: [{ entity: OTHER, principal: TOKEN, target: OTHER, permissions: [permission, '0x0'], principalType: 'ACCOUNT' }] });
		};
		const quietPage = function(staple: string): unknown {
			return({ history: [{ $id: staple, voteStaple: { votes: [{ validityFrom: '2025-01-01T00:00:00.000Z' }] } }], nextKey: staple });
		};
		setup.follower.serve(path, listing('0x1'));
		const answers = ['0x2', '0x1', '0x1', '0x3'];
		setup.representatives.forEach(function(representative, index) {
			representative.serve(path, listing(answers[index] ?? '0x1'));
			representative.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, QUIET_HISTORY);
			representative.serve(`/node/ledger/account/${OTHER}/history?limit=1`, QUIET_HISTORY);
		});
		setup.representatives[0]?.serve(`/node/ledger/account/${OTHER}/history?limit=1`, quietPage('EF'.repeat(32)));
		const first = setup.representatives[0]?.endpoint ?? '';
		await setup.log.append([{ kind: 'api-diff', at: '2026-10-11T14:00:00.000Z', representative: first, stratum: 'permissions', route: '/api/node/ledger/account/{account}/acl', path, behaviors: [], outcome: { ...RECORDED_DIVERGENCE, field: 'body.permissions[0].permissions[0]' } }]);

		expect(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({}) })).toEqual({ unresolved: 1 });
	});

	test('reads again, after their answers, the newest staple each representative answering apart holds, as one it added since its account was found quiet', async function() {
		const setup = await runningWith(4);
		servingBalances(setup, '0x1', ['0x2', '0x1', '0x1', '0x3']);
		const quietPage = function(staple: string): unknown {
			return({ history: [{ $id: staple, voteStaple: { votes: [{ validityFrom: '2025-01-01T00:00:00.000Z' }] } }], nextKey: staple });
		};
		const held = 'CD'.repeat(32);
		setup.representatives[0]?.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, quietPage(held), quietPage('EF'.repeat(32)));

		const { summary } = await recheck(setup, memoryStore({ held: [held] }));

		expect(summary).toEqual({ unresolved: 1 });
	});

	test('counts the newest staple a representative answering apart holds as no evidence when it was voted within the margin, the follower holding it or not', async function() {
		const setup = await runningWith(4);
		servingBalances(setup, '0x1', ['0x2', '0x1', '0x1', '0x3']);
		const held = 'CD'.repeat(32);
		const page = function(validityFrom: string): unknown {
			return({ history: [{ $id: held, voteStaple: { votes: [{ validityFrom }] } }], nextKey: held });
		};
		setup.representatives[0]?.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, page('2025-01-01T00:00:00.000Z'), page('2026-01-01T00:00:00.000Z'));

		const { summary } = await recheck(setup, memoryStore({ held: [held] }));

		expect(summary).toEqual({ unresolved: 1 });
	});

	test('is unresolved when two answer as the follower and two answer one failure, told apart only by its error ID', async function() {
		const setup = await runningWith(4);
		servingBalances(setup, '0x1', ['0x2', '0x1', '0x1', '0x2']);
		const failure = function(id: string) {
			return({ status: 500, body: { error: true, message: `Internal error occurred (error ID: 00000000-0000-0000-0000-00000000000${id})` } });
		};
		setup.representatives[0]?.answer(BALANCE, failure('1'));
		setup.representatives[3]?.answer(BALANCE, failure('2'));

		const { summary } = await recheck(setup);

		expect(summary).toEqual({ unresolved: 1 });
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

	test('counts no reading from a representative that answers apart while an account the answer reads is not quiet on it', async function() {
		const setup = await runningWith(3);
		servingBalances(setup, '0x1', ['0x2', '0x1', '0x3']);
		setup.representatives[2]?.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, recentHistory(TOKEN));

		const { latest } = await recheck(setup);

		expect(latest?.outcome).toMatchObject({ kind: 'unresolved', readings: [{ kind: 'agrees' }, { kind: 'moving' }] });
		expect(setup.representatives[2]?.requests).toEqual([`GET ${BALANCE}`, `GET /node/ledger/account/${TOKEN}/history?limit=1`]);
	});

	test('of a page of history is never one representative\'s own, as the others order an account\'s history by their own votes', async function() {
		const setup = await runningWith(3);
		const path = `/node/ledger/account/${TOKEN}/history?limit=1`;
		const page = function(staple: string): unknown {
			return({ history: [{ $id: staple, voteStaple: { votes: [{ validityFrom: '2025-01-01T00:00:00.000Z' }] } }], nextKey: staple });
		};
		const [lacked, held] = ['AB'.repeat(32), 'CD'.repeat(32)];
		setup.follower.serve(path, page(held));
		setup.representatives[0]?.serve(path, page(lacked));
		setup.representatives[1]?.serve(path, page(held));
		setup.representatives[2]?.serve(path, page(held));
		const first = setup.representatives[0]?.endpoint ?? '';
		await setup.log.append([{ kind: 'api-diff', at: '2026-10-11T14:00:00.000Z', representative: first, stratum: 'token', route: '/api/node/ledger/account/{account}/history', path, behaviors: [], outcome: { ...RECORDED_DIVERGENCE, field: 'body.history[0].$id' } }]);

		expect(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({}) })).toEqual({ unresolved: 1 });
	});

	test('of a page of history the representative failed to serve is sent again later, unless most representatives answer apart from the follower, failing or serving another page', async function() {
		const path = `/node/ledger/account/${TOKEN}/history/start/${'AB'.repeat(32)}?limit=1`;
		const page = { status: 200, body: { history: [{ $id: 'CD'.repeat(32), voteStaple: { votes: [{ validityFrom: '2025-01-01T00:00:00.000Z' }] } }], nextKey: 'CD'.repeat(32) } };
		const failure = { status: 500, body: { error: true, message: 'Internal error occurred (error ID: 00000000-0000-0000-0000-000000000001)' } };
		const recheckWith = async function(others: readonly FakeAnswer[]) {
			const setup = await runningWith(3);
			setup.follower.answer(path, page);
			setup.representatives.forEach(function(representative, index) {
				representative.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, QUIET_HISTORY);
				representative.answer(path, others[index - 1] ?? failure);
			});
			const first = setup.representatives[0]?.endpoint ?? '';
			await setup.log.append([{ kind: 'api-diff', at: '2026-10-11T14:00:00.000Z', representative: first, stratum: 'token', route: '/api/node/ledger/account/{account}/history/start/{block}', path, behaviors: [], outcome: { ...RECORDED_DIVERGENCE, field: 'body.error' } }]);
			return(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({}) }));
		};

		const anotherPage = { status: 200, body: { ...page.body, nextKey: 'EF'.repeat(32) } };
		expect(await recheckWith([page, page])).toEqual({ skipped: 1 });
		expect(await recheckWith([failure, failure])).toEqual({ diverged: 1 });
		expect(await recheckWith([anotherPage, page])).toEqual({ diverged: 1 });
	});

	test('of a follower that fails is never one representative\'s own, even when others fail alike', async function() {
		const setup = await runningWith(3);
		const failure = { status: 500, body: { error: true, message: 'Internal error occurred (error ID: 00000000-0000-0000-0000-000000000001)' } };
		servingBalances(setup, '0x1', ['0x2', '0x2', '0x2']);
		setup.follower.answer(BALANCE, failure);
		setup.representatives[1]?.answer(BALANCE, failure);
		setup.representatives[2]?.answer(BALANCE, failure);

		const { summary, latest } = await recheck(setup);

		expect(summary).toEqual({ diverged: 1 });
		expect(latest?.outcome.kind === 'diverged' && latest.outcome.readings.map(function(reading) {
			return(reading.kind);
		})).toEqual(['disagrees', 'disagrees']);
	});

	test('counts no agreement from a representative on which an account the answer reads is not quiet', async function() {
		const setup = await runningWith(3);
		servingBalances(setup, '0x1', ['0x2', '0x1', '0x1']);
		setup.representatives[2]?.serve(`/node/ledger/account/${TOKEN}/history?limit=1`, recentHistory(TOKEN));

		const { latest } = await recheck(setup);

		expect(latest?.outcome).toMatchObject({ kind: 'unresolved', readings: [{ kind: 'agrees' }, { kind: 'moving' }] });
	});

	test('is sent again while open, though a later comparison found the follower answering as the representative then answered something else', async function() {
		const setup = await runningWith(1);
		servingBalances(setup, '0x3', ['0x3']);
		const first = setup.representatives[0]?.endpoint ?? '';
		const record = function(at: string, outcome: APIDiffOutcome): APIDiffRecord {
			return({ kind: 'api-diff', at, representative: first, stratum: 'token', route: '/api/node/ledger/account/{account}/balance', path: BALANCE, behaviors: [], outcome });
		};
		await setup.log.append([
			record('2026-10-09T08:40:00.000Z', RECORDED_DIVERGENCE),
			record('2026-10-10T08:40:00.000Z', { kind: 'match', digest: answerDigest(BALANCE, { status: 200, body: balanceOf('0x3') }) ?? null })
		]);

		expect(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({}) })).toEqual({ match: 1 });
		expect(setup.representatives[0]?.requests).toEqual([`GET ${BALANCE}`]);
	});

	test('is superseded by a match when the follower answers as the representative now', async function() {
		const setup = await runningWith(2);
		servingBalances(setup, '0x2', ['0x2', '0x2']);

		const { summary, latest } = await recheck(setup);

		expect(summary).toEqual({ match: 1 });
		expect(latest?.outcome).toEqual({ kind: 'match', digest: answerDigest(BALANCE, { status: 200, body: balanceOf('0x2') }) });
		expect(setup.representatives[1]?.requests).toEqual([]);
	});

	test('of a block\'s successor needs the block\'s account quiet when compared again', async function() {
		const setup = await runningWith(1);
		const block = await heldSend();
		const path = `/node/ledger/block/${block.hash}/successor`;
		setup.follower.serve(path, { block: null });
		setup.representatives[0]?.serve(path, { block: 'AB'.repeat(32) });
		setup.representatives[0]?.serve(`/node/ledger/account/${OWNER}/history?limit=1`, QUIET_HISTORY);
		const recorded: APIDiffRecord = { kind: 'api-diff', at: '2026-10-09T08:40:00.000Z', representative: setup.representatives[0]?.endpoint ?? '', stratum: 'operation:SEND', route: '/api/node/ledger/block/{blockhash}/successor', path, behaviors: [], outcome: { ...RECORDED_DIVERGENCE, field: 'body.block' } };
		await setup.log.append([recorded]);

		expect(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({ blocks: [block] }) })).toEqual({ diverged: 1 });
		expect(setup.representatives[0]?.requests).toEqual([`GET ${path}`, `GET /node/ledger/account/${OWNER}/history?limit=1`, `GET /node/ledger/account/${OWNER}/history?limit=1`]);
	});
});

describe('where a request stands', function() {
	const record = function(at: string, outcome: APIDiffOutcome): APIDiffRecord {
		return({ kind: 'api-diff', at, representative: 'https://rep1.example/api', stratum: 'token', route: '/api/node/ledger/account/{account}/balance', path: BALANCE, behaviors: [], outcome });
	};
	const divergence = function(at: string, amount: string): APIDiffRecord {
		return(record(at, { ...RECORDED_DIVERGENCE, representative: { status: 200, body: balanceOf(amount) } }));
	};
	const matching = function(at: string, amount: string): APIDiffRecord {
		return(record(at, { kind: 'match', digest: answerDigest(BALANCE, { status: 200, body: balanceOf(amount) }) ?? null }));
	};

	test('keeps every divergence open that no comparison of its own state settled, though a later one of the request was settled', function() {
		const first = divergence('2026-10-09T00:00:00.000Z', '0x2');
		const second = divergence('2026-10-10T00:00:00.000Z', '0x3');
		const settling = matching('2026-10-11T00:00:00.000Z', '0x3');

		const standing = requestStandings([first, second, settling], []).get(`token ${BALANCE}`);

		expect(standing?.open.map(function({ divergence: open }) {
			return(open.at);
		})).toEqual([first.at]);
		expect(standing?.open[0]?.retestedBy).toEqual(settling);
		expect(standing?.superseded).toEqual([{ divergence: second, by: settling }]);
	});

	test('counts no match recorded of two internal failures naming no code of the API, before such failures were counted as no answer', function() {
		const failed: APIDiffRecord = { ...matching('2026-10-11T00:00:00.000Z', '0x2'), behaviors: ['/api/node/ledger/account/{account}/balance 500 error=internal', 'account=TOKEN'] };
		const refused: APIDiffRecord = { ...failed, behaviors: ['/api/node/ledger/account/{account}/balance 500 error=API_INVALID_SIDE'] };

		expect(requestStandings([failed], []).size).toBe(0);
		expect(requestStandings([refused], []).size).toBe(1);
	});

	test('closes a divergence a triage record explains, listing it apart', function() {
		const open = divergence('2026-10-09T00:00:00.000Z', '0x2');
		const explanation: APIDiffExplainedRecord = { kind: 'api-diff-explained', at: '2026-10-11T00:00:00.000Z', stratum: 'token', path: BALANCE, divergenceAt: open.at, divergence: 'our-bug', reference: 'fixed by 0000000', retest: { kind: 'retested' } };
		const elsewhere: APIDiffExplainedRecord = { ...explanation, divergenceAt: '2026-10-08T00:00:00.000Z' };

		const standing = requestStandings([open, matching('2026-10-10T00:00:00.000Z', '0x9')], [explanation, elsewhere]).get(`token ${BALANCE}`);

		expect(standing?.open).toEqual([]);
		expect(standing?.explained).toEqual([{ divergence: open, explanation }]);
	});
});

describe('a triage of an API divergence', function() {
	test('leaves the request sent again on recheck while its latest comparison is the divergence explained, so that a later comparison shows whether it still diverges', async function() {
		const setup = await runningWith(1);
		servingBalances(setup, '0x3', ['0x3']);
		const divergence: APIDiffRecord = { kind: 'api-diff', at: '2026-10-09T08:40:00.000Z', representative: setup.representatives[0]?.endpoint ?? '', stratum: 'token', route: '/api/node/ledger/account/{account}/balance', path: BALANCE, behaviors: [], outcome: RECORDED_DIVERGENCE };
		const explanation: APIDiffExplainedRecord = { kind: 'api-diff-explained', at: '2026-10-11T00:00:00.000Z', stratum: 'token', path: BALANCE, divergenceAt: divergence.at, divergence: 'our-bug', reference: 'fixed by 0000000', retest: { kind: 'retested' } };
		await setup.log.append([divergence, explanation]);

		expect(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({}) })).toEqual({ match: 1 });
		expect(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({}) })).toEqual({});
	});

	test('is recorded only for a divergence that is open, and closes it', async function() {
		const setup = await runningWith(1);
		const divergence: APIDiffRecord = { kind: 'api-diff', at: '2026-10-09T08:40:00.000Z', representative: 'https://rep1.example/api', stratum: 'token', route: '/api/node/ledger/account/{account}/balance', path: BALANCE, behaviors: [], outcome: RECORDED_DIVERGENCE };
		await setup.log.append([divergence, { ...divergence, at: '2026-10-10T08:40:00.000Z', outcome: { kind: 'match', digest: 'EF'.repeat(32) } }]);
		const triage = { stratum: 'token', path: BALANCE, divergence: 'our-bug', reference: 'fixed by 0000000', untestedBecause: null } as const;

		await expect(explainDivergence(setup.log, { ...triage, divergenceAt: '2026-10-08T00:00:00.000Z' })).rejects.toThrow('no open divergence');
		const explained = await explainDivergence(setup.log, { ...triage, divergenceAt: divergence.at });
		const { untestedBecause, ...recorded } = triage;
		expect(untestedBecause).toBeNull();
		expect(explained).toMatchObject({ kind: 'api-diff-explained', ...recorded, divergenceAt: divergence.at, retest: { kind: 'retested' } });
		await expect(explainDivergence(setup.log, { ...triage, divergenceAt: divergence.at })).rejects.toThrow('no open divergence');
		expect(recordsOf((await setup.log.read()).records, 'api-diff-explained')).toEqual([explained]);
	});

	test('is refused with no reference, or for a divergence no later comparison of its request retested unless forced with the reason, which it records', async function() {
		const setup = await runningWith(1);
		const divergence: APIDiffRecord = { kind: 'api-diff', at: '2026-10-09T08:40:00.000Z', representative: 'https://rep1.example/api', stratum: 'token', route: '/api/node/ledger/account/{account}/balance', path: BALANCE, behaviors: [], outcome: RECORDED_DIVERGENCE };
		const unanswered: APIDiffRecord = { ...divergence, at: '2026-10-10T08:40:00.000Z', outcome: { kind: 'skipped', reason: 'unanswered', detail: 'fetch failed' } };
		await setup.log.append([divergence, unanswered]);
		const triage = { stratum: 'token', path: BALANCE, divergenceAt: divergence.at, divergence: 'our-bug', reference: 'fixed by 0000000', untestedBecause: null } as const;

		await expect(explainDivergence(setup.log, { ...triage, reference: ' ' })).rejects.toThrow('no reference');
		await expect(explainDivergence(setup.log, triage)).rejects.toThrow('retested');
		await expect(explainDivergence(setup.log, { ...triage, untestedBecause: ' ' })).rejects.toThrow('retested');
		const forced = await explainDivergence(setup.log, { ...triage, untestedBecause: 'every node answers the request alike now' });
		expect(forced).toMatchObject({ retest: { kind: 'forced', why: 'every node answers the request alike now' } });
		expect(recordsOf((await setup.log.read()).records, 'api-diff-explained')).toEqual([forced]);
	});

	test('is recorded for a divergence a later attempt found moving, as its state has moved on', async function() {
		const setup = await runningWith(1);
		const divergence: APIDiffRecord = { kind: 'api-diff', at: '2026-10-09T08:40:00.000Z', representative: 'https://rep1.example/api', stratum: 'token', route: '/api/node/ledger/account/{account}/balance', path: BALANCE, behaviors: [], outcome: RECORDED_DIVERGENCE };
		await setup.log.append([divergence, { ...divergence, at: '2026-10-10T08:40:00.000Z', outcome: { kind: 'skipped', reason: 'moving', side: 'representative', detail: 'recent' } }]);

		expect(await explainDivergence(setup.log, { stratum: 'token', path: BALANCE, divergenceAt: divergence.at, divergence: 'our-bug', reference: 'fixed by 0000000', untestedBecause: null })).toMatchObject({ retest: { kind: 'retested' } });
	});
});

describe('a census', function() {
	test('stands on the latest plan that made one, whose grown population an older complete census does not cover, until a later plan draws a sample of the stratum', function() {
		const plan = function(at: string, requests: readonly string[]): APIDiffPlanRecord {
			return({ kind: 'api-diff-plan', at, quietBefore: at, samplesPerStratum: 300, strata: [{ stratum: 'multisig', population: { kind: 'census', requests } }] });
		};
		const older = plan('2026-10-11T14:00:00.000Z', ['/a']);
		const grown = plan('2026-10-12T14:00:00.000Z', ['/a', '/b']);
		const sampled: APIDiffPlanRecord = { ...grown, at: '2026-10-13T14:00:00.000Z', strata: [{ stratum: 'multisig', population: { kind: 'sample', drawn: 2, whole: false } }] };

		expect(standingCensuses([older, grown]).get('multisig')).toEqual({ plan: grown, requests: ['/a', '/b'] });
		expect(standingCensuses([older, grown, sampled]).get('multisig')).toBeUndefined();
	});

	test('is completed on recheck, each request of the latest plan\'s census not compared yet sent to the representative last tried, or the first', async function() {
		const setup = await runningWith(2);
		servingBalances(setup, '0x1', ['0x1', '0x1']);
		const state = `/node/ledger/account/${TOKEN}`;
		setup.follower.serve(state, STATE);
		setup.representatives.forEach(function(representative) {
			representative.serve(state, STATE);
		});
		const second = setup.representatives[1]?.endpoint ?? '';
		const plan: APIDiffPlanRecord = { kind: 'api-diff-plan', at: '2026-10-11T14:00:00.000Z', quietBefore: '2026-10-11T13:00:00.000Z', samplesPerStratum: 300, strata: [{ stratum: 'multisig', population: { kind: 'census', requests: [BALANCE, state] } }] };
		const skipped: APIDiffRecord = { kind: 'api-diff', at: '2026-10-11T14:01:00.000Z', representative: second, stratum: 'multisig', route: '/api/node/ledger/account/{account}/balance', path: BALANCE, behaviors: [], outcome: { kind: 'skipped', reason: 'moving', side: 'follower', detail: 'recent' } };
		await setup.log.append([plan, skipped]);

		expect(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({}) })).toEqual({ match: 2 });

		expect(setup.representatives[1]?.requests).toEqual([`GET ${BALANCE}`]);
		expect(setup.representatives[0]?.requests).toEqual([`GET ${state}`]);
		const records = recordsOf((await setup.log.read()).records, 'api-diff').slice(1);
		expect(records.map(function(record) {
			return([record.stratum, record.path, record.outcome.kind]);
		})).toEqual([['multisig', BALANCE, 'match'], ['multisig', state, 'match']]);
	});
});

describe('a route left uncovered', function() {
	test('has its requests never compared sent again on recheck, oldest first, so that it is covered once they compare, while a covered route\'s are not', async function() {
		const setup = await runningWith(1);
		servingBalances(setup, '0x1', ['0x1']);
		const state = `/node/ledger/account/${TOKEN}`;
		setup.follower.serve(state, STATE);
		setup.representatives[0]?.serve(state, STATE);
		const first = setup.representatives[0]?.endpoint ?? '';
		const attempt = function(at: string, route: APIDiffRecord['route'], path: string, outcome: APIDiffOutcome): APIDiffRecord {
			return({ kind: 'api-diff', at, representative: first, stratum: 'token', route, path, behaviors: [], outcome });
		};
		const moving: APIDiffOutcome = { kind: 'skipped', reason: 'moving', side: 'follower', detail: 'recent' };
		const unanswered: APIDiffOutcome = { kind: 'skipped', reason: 'unanswered', detail: 'answered 502' };
		// Nine compared and one never compared of the chain route: a tenth, which leaves it covered.
		const covered = Array.from({ length: 9 }, function(_, index): APIDiffRecord {
			return(attempt('2026-10-11T14:00:00.000Z', '/api/node/ledger/account/{account}/chain', `/node/ledger/account/${TOKEN}/chain?limit=${String(index + 1)}`, { kind: 'match', digest: 'EF'.repeat(32) }));
		});
		await setup.log.append([
			...covered,
			attempt('2026-10-11T14:00:01.000Z', '/api/node/ledger/account/{account}/chain', `/node/ledger/account/${TOKEN}/chain?limit=10`, unanswered),
			attempt('2026-10-11T14:00:03.000Z', '/api/node/ledger/account/{account}/balance', BALANCE, moving),
			attempt('2026-10-11T14:00:02.000Z', '/api/node/ledger/account/{account}', state, unanswered)
		]);
		const uncovered = async function(): Promise<readonly string[]> {
			const { records } = await setup.log.read();
			const comparisons = recordsOf(records, 'api-diff');
			return(routeAttemptsOf(comparisons, requestStandings(comparisons, [])).filter(routeUncovered).map(function({ route }): string {
				return(route);
			}).sort());
		};
		expect(await uncovered()).toEqual(['/api/node/ledger/account/{account}', '/api/node/ledger/account/{account}/balance']);

		expect(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({}) })).toEqual({ match: 2 });

		expect(setup.representatives[0]?.requests.filter(function(request): boolean {
			return(!request.includes('/history'));
		})).toEqual([`GET ${state}`, `GET ${BALANCE}`]);
		expect(await uncovered()).toEqual([]);
		expect(await recheckAPIDivergences({ ...sources(setup), store: memoryStore({}) })).toEqual({});
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
		const { plan, records } = await planned(memoryStore({ candidates: { multisig: [CANDIDATE] } }), API_DIFF_SAMPLES_TARGET);

		const census = populationOf(plan, 'multisig');
		expect(census?.kind).toBe('census');
		const requested = records.filter(function(record) {
			return(record.stratum === 'multisig');
		}).map(function(record) {
			return(record.path);
		});
		expect(census?.kind === 'census' && [...census.requests].sort()).toEqual([...requested].sort());
		expect(populationOf(plan, 'storage')).toEqual({ kind: 'census', requests: [] });
		expect(plan).toMatchObject({ samplesPerStratum: API_DIFF_SAMPLES_TARGET, quietBefore: '2025-12-30T23:00:00.000Z' });
	});

	test('draws the blocks of an operation the seed puts first, wherever they are stored', async function() {
		const blocks = await Promise.all([1, 2, 3].map(async function(amount): Promise<HeldBlock> {
			const block = await sendBlock({ from: owner, to: other, amount: BigInt(amount), token, previous: null, network: NETWORK, date: new Date('2025-11-01T00:00:00.000Z') });
			return({ hash: block.hash.toString(), account: OWNER, bytes: Buffer.from(block.toBytes()) });
		}));
		const requested = async function(stored: readonly HeldBlock[]) {
			const { records } = await planned(memoryStore({ blocks: stored }), 2);
			return(new Set(records.filter(function(record) {
				return(record.stratum === 'operation:SEND' && record.route === '/api/node/ledger/block/{blockhash}');
			}).map(function(record) {
				return(record.path);
			})));
		};
		expect(await requested([...blocks].reverse())).toEqual(await requested(blocks));
	});

	test('is not made by a run that compares fewer requests of each stratum than the done criterion, which reads a bounded part of the blocks', async function() {
		const setup = await runningWith(1);
		const store = memoryStore({ blocks: [await heldSend()] });
		const read: (readonly [number, number])[] = [];
		await sampleAPI({ ...sources(setup), store: { ...store, blockPages: () => Promise.resolve(1_000_000), heldBlocksInPages: (fromPage, toPage, before) => {
			read.push([fromPage, toPage]);
			return(store.heldBlocksInPages(fromPage, toPage, before));
		} }, samplesPerStratum: 2, seed: 'test', edgeCaseStaples: [], knownBehaviors: new Set() });

		expect(recordsOf((await setup.log.read()).records, 'api-diff-plan')).toEqual([]);
		expect(read.reduce(function(pages, [fromPage, toPage]) {
			return(pages + toPage - fromPage);
		}, 0)).toBeLessThanOrEqual(2000);
	});

	test('is not made, nor any block read, by a run stopped before it', async function() {
		const setup = await runningWith(1);
		const stopping = new AbortController();
		stopping.abort();
		let pagesRead = 0;
		const store = memoryStore({ blocks: [await heldSend()] });

		const summary = await sampleAPI({ ...sources(setup), stopped: stopping.signal, store: { ...store, heldBlocksInPages: (...pages) => {
			pagesRead++;
			return(store.heldBlocksInPages(...pages));
		} }, samplesPerStratum: 100, seed: 'test', edgeCaseStaples: [], knownBehaviors: new Set() });

		expect(pagesRead).toBe(0);
		expect(summary.strata).toEqual([]);
		expect((await setup.log.read()).records).toEqual([]);
	});

	test('is a sample of a stratum with as many accounts as it asked for, which more may follow', async function() {
		const { plan } = await planned(memoryStore({ candidates: { token: Array.from({ length: API_DIFF_SAMPLES_TARGET }, function(): AccountCandidate {
			return(CANDIDATE);
		}) } }), API_DIFF_SAMPLES_TARGET);

		expect(populationOf(plan, 'token')).toMatchObject({ kind: 'sample', whole: false });
	});

	test('reads every held block once for the operations it lacks, so that a rare operation\'s every block is drawn, each request once', async function() {
		const send = await heldSend();
		const setRepresentative = await setRepresentativeBlock({ account: other, representative: owner, previous: null, network: NETWORK, date: new Date('2025-11-01T00:00:00.000Z') });
		const blocks = [send, { hash: setRepresentative.hash.toString(), account: OTHER, bytes: Buffer.from(setRepresentative.toBytes()) }];

		const { plan, records } = await planned(memoryStore({ blocks }), API_DIFF_SAMPLES_TARGET);

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
