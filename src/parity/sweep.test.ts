import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startFakeAPI } from '../testing/fake-api.js';
import type { FakeAPI } from '../testing/fake-api.js';
import { httpSource } from './api-source.js';
import type { FollowerProgress, KnownAccount } from './follower-store.js';
import { ParityLog } from './log.js';
import type { SweepBatchRecord, SweepRecord, SweepWalk } from './log.js';
import { recordsOf } from './report.js';
import { firstDifference, QUIET_MARGIN_MILLISECONDS, readSweepCursor, recheckDivergences, sweepAccounts, sweepCursorPaths } from './sweep.js';
import type { SweepCursorPaths, SweepStore, SweepSummary, WalkSummary } from './sweep.js';

const ACCOUNTS = [
	'keeta_aabiko2lb4klv75vi72jxkgaotfravn7p4clfko4lcw7vywrzfznrvemqxb5iai',
	'keeta_aabk62tezl4whordlviamlx3zrdgux6lk63cghay45vkzdatyemzvqqjuj5resa',
	'keeta_aabwip6zeo2fnzfxp5hssrrqtascs2277w2zk7vqd6d3k3m4dkt2flcbca2mqki'
] as const;

const TOKEN = 'keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg';
const DELEGATE = 'keeta_aabvmwxttv4q56gbfveighwfwp3yvitlrdfsacic3ckqc7lqelsspvmhc7oldmq';

const HEAD = '96'.repeat(32);
const STAPLE = 'A0'.repeat(32);

/** Where the follower holds every staple before. */
const HELD_BEFORE = new Date('2025-12-31T00:00:00.000Z');

/** Long enough before the follower's reach that the account counts as quiet. */
const QUIET_VOTE = new Date(HELD_BEFORE.getTime() - QUIET_MARGIN_MILLISECONDS - 1);

/** Within the margin before the follower's reach, where it may still lack an earlier staple of the account. */
const RECENT_VOTE = new Date(HELD_BEFORE.getTime() - QUIET_MARGIN_MILLISECONDS);

function state(account: string, balance: string, head: string | null = HEAD): unknown {
	return({
		account,
		balances: [{ balance, token: TOKEN }],
		currentHeadBlock: head,
		currentHeadBlockHeight: '0x8A',
		info: { account, description: '', metadata: '', name: '' },
		representative: DELEGATE
	});
}

function history(staple: string, votedAt: readonly Date[]): unknown {
	return({
		history: [{
			$id: staple,
			$timestamp: '2026-10-09T00:00:00.000Z',
			voteStaple: {
				$binary: 'eJ',
				blocks: [],
				votes: votedAt.map(function(moment) {
					return({ issuer: DELEGATE, validityFrom: moment.toISOString(), validityTo: '3027-01-31T00:00:00.000Z' });
				})
			}
		}],
		nextKey: staple
	});
}

/**
 * The follower's store, held in memory: every account given, each holding
 * in its history the staples listed, the newest of them from the moment
 * given or, by default, quiet since long before the follower's reach; the
 * accounts named passive have no chain, the rest have one.
 */
function memoryStore(histories: Readonly<Record<string, readonly string[]>>, progress: FollowerProgress = { completedPass: undefined, heldBefore: HELD_BEFORE, staged: 0 }, newest: Readonly<Record<string, Date>> = {}, passive: readonly string[] = []): SweepStore {
	const known: KnownAccount[] = Object.entries(histories).map(function([account, staples], index): KnownAccount {
		let newestStaple: Date | undefined;
		if (staples.length > 0) {
			newestStaple = newest[account] ?? new Date('2025-06-01T00:00:00.000Z');
		}
		return({ rowID: String(index + 1), account, newestStaple });
	});
	const after = function(chain: boolean, rowID: string, count: number): Promise<readonly KnownAccount[]> {
		return(Promise.resolve(known.filter(function(entry): boolean {
			return(BigInt(entry.rowID) > BigInt(rowID) && passive.includes(entry.account) !== chain);
		}).slice(0, count)));
	};
	return({
		progress(): Promise<FollowerProgress> {
			return(Promise.resolve(progress));
		},
		chainAccountsAfter(rowID: string, count: number): Promise<readonly KnownAccount[]> {
			return(after(true, rowID, count));
		},
		passiveAccountsAfter(rowID: string, count: number): Promise<readonly KnownAccount[]> {
			return(after(false, rowID, count));
		},
		historyHolds(account: string, blocksHash: string): Promise<boolean> {
			return(Promise.resolve(histories[account]?.includes(blocksHash) ?? false));
		}
	});
}

const directories: string[] = [];

afterEach(async function() {
	await Promise.all(directories.splice(0).map(function(directory) {
		return(rm(directory, { recursive: true, force: true }));
	}));
});

type Running = {
	readonly follower: FakeAPI;
	readonly representatives: readonly FakeAPI[];
	readonly log: ParityLog;
	readonly cursorPaths: SweepCursorPaths;
};

async function setup(representativeCount = 1): Promise<Running> {
	const directory = await mkdtemp(join(tmpdir(), 'slop-parity-sweep-'));
	directories.push(directory);
	const representatives: FakeAPI[] = [];
	for (let index = 0; index < representativeCount; index++) {
		representatives.push(await startFakeAPI());
	}
	return({ follower: await startFakeAPI(), representatives, log: new ParityLog(join(directory, 'parity.jsonl')), cursorPaths: sweepCursorPaths(directory) });
}

/** Serves the account's state on both sides, and its newest staple on every representative. */
function serveAccount(running: Running, account: string, follower: readonly unknown[], representative: unknown, newest: unknown): void {
	running.follower.serve(`/node/ledger/account/${account}`, ...follower);
	for (const api of running.representatives) {
		api.serve(`/node/ledger/account/${account}`, representative);
		api.serve(`/node/ledger/account/${account}/history?limit=1`, newest);
	}
}

function statesPath(accounts: readonly string[]): string {
	return(`/node/ledger/accounts/${accounts.join(',')}`);
}

/** Serves the states of the accounts, in one request, on the follower and on every representative. */
function serveStates(running: Running, accounts: readonly string[], follower: readonly unknown[], representative: readonly unknown[]): void {
	running.follower.serve(statesPath(accounts), follower);
	for (const api of running.representatives) {
		api.serve(statesPath(accounts), representative);
	}
}

async function sweepWalks(running: Running, store: SweepStore, accounts: Partial<Record<SweepWalk, number>>, toLapEnd = false): Promise<SweepSummary> {
	return(await sweepAccounts({
		follower: httpSource(running.follower.endpoint),
		representatives: running.representatives.map(function(api) {
			return(httpSource(api.endpoint));
		}),
		store,
		log: running.log,
		cursorPaths: running.cursorPaths,
		accounts: { chain: accounts.chain ?? 0, passive: accounts.passive ?? 0 },
		toLapEnd,
		stopped: new AbortController().signal
	}));
}

async function sweep(running: Running, store: SweepStore, accounts: number): Promise<WalkSummary> {
	return((await sweepWalks(running, store, { chain: accounts })).chain);
}

async function outcomes(running: Running): Promise<readonly SweepRecord['outcome'][]> {
	return((await running.log.read()).records.flatMap(function(record) {
		if (record.kind !== 'sweep') {
			return([]);
		}
		return([record.outcome]);
	}));
}

describe('the first difference between two bodies', function() {
	test('is named by its path', function() {
		expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe('a[1].b');
		expect(firstDifference({ a: 1 }, { a: 1, c: null })).toBe('c');
		expect(firstDifference({ a: [1] }, { a: [1, 2] })).toBe('a[1]');
		expect(firstDifference(null, { a: 1 })).toBe('(body)');
		expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeUndefined();
	});
});

describe('the sweep over the follower\'s accounts', function() {
	test('matches an account both hold alike that has been quiet since before the follower\'s reach', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		serveAccount(running, account, [state(account, '0x10')], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));

		const summary = await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toEqual([{ kind: 'match', head: HEAD, staple: STAPLE }]);
		expect(summary).toMatchObject({ compared: 1, matched: 1, diverged: 0, skipped: 0 });
		// The follower is read on both sides of the representative's two answers, the state before the history.
		expect(running.follower.requests).toEqual([`GET /node/ledger/account/${account}`, `GET /node/ledger/account/${account}`]);
		expect(running.representatives[0]?.requests).toEqual([`GET /node/ledger/account/${account}`, `GET /node/ledger/account/${account}/history?limit=1`]);
	});

	test('records a diverging account with the field, the staple to bisect from, and both bodies', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		serveAccount(running, account, [state(account, '0x10')], state(account, '0x11'), history(STAPLE, [QUIET_VOTE]));

		await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toEqual([{
			kind: 'diverged',
			divergence: { account, field: 'balances[0].balance', staple: STAPLE },
			follower: state(account, '0x10'),
			representative: state(account, '0x11'),
			readings: []
		}]);
	});

	test('records a quiet account whose head differs as diverging, since nothing after the follower\'s reach can explain it', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		serveAccount(running, account, [state(account, '0x10', null)], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));

		await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toMatchObject([{ kind: 'diverged', divergence: { account, field: 'currentHeadBlock', staple: STAPLE } }]);
	});

	test('records a quiet account whose newest staple the follower lacks as diverging in its history', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		serveAccount(running, account, [state(account, '0x10')], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));

		await sweep(running, memoryStore({ [account]: [] }), 1);

		expect(await outcomes(running)).toMatchObject([{ kind: 'diverged', divergence: { account, field: 'history', staple: STAPLE } }]);
	});

	test('skips an account with a staple voted on within the margin of the follower\'s reach, as moving', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		serveAccount(running, account, [state(account, '0x10')], state(account, '0x11'), history(STAPLE, [QUIET_VOTE, RECENT_VOTE]));

		const summary = await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toMatchObject([{ kind: 'skipped', reason: 'moving', side: 'representative' }]);
		expect(summary).toMatchObject({ compared: 0, skipped: 1 });
	});

	test('walks past nothing, and asks nothing, while the follower holds no history yet', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		serveAccount(running, account, [state(account, '0x10')], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));

		const summary = await sweep(running, memoryStore({ [account]: [STAPLE] }, { completedPass: undefined, heldBefore: undefined, staged: 0 }), 1);

		expect(summary).toMatchObject({ walked: 0, compared: 0, skipped: 0, cursor: { lap: 0, afterRowID: '0' } });
		expect(await outcomes(running)).toEqual([]);
		expect([...running.follower.requests, ...(running.representatives[0]?.requests ?? [])]).toEqual([]);
	});

	test('asks nothing about an account the follower itself holds a staple of from within the margin, and records it as moving', async function() {
		const running = await setup();
		const [quiet, moving] = ACCOUNTS;
		for (const account of [quiet, moving]) {
			serveAccount(running, account, [state(account, '0x10')], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));
		}

		const summary = await sweep(running, memoryStore({ [quiet]: [STAPLE], [moving]: [STAPLE] }, undefined, { [quiet]: QUIET_VOTE, [moving]: RECENT_VOTE }), 2);

		expect(summary).toMatchObject({ walked: 2, compared: 1, matched: 1, skipped: 1 });
		expect(recordsOf((await running.log.read()).records, 'sweep').map(function(record) {
			return([record.account, record.walk, record.outcome.kind]);
		})).toEqual([[quiet, 'chain', 'match'], [moving, 'chain', 'skipped']]);
		expect(await outcomes(running)).toMatchObject([{ kind: 'match' }, { kind: 'skipped', reason: 'moving', side: 'follower' }]);
		expect([...running.follower.requests, ...(running.representatives[0]?.requests ?? [])].join()).not.toContain(moving);
	});

	test('records a quiet account the follower fails to answer for as diverging in its status', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		const failure = { error: true, message: 'Internal error occurred (error ID: x)' };
		serveAccount(running, account, [], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));
		running.follower.answer(`/node/ledger/account/${account}`, { status: 500, body: failure });

		await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toEqual([{ kind: 'diverged', divergence: { account, field: 'status', staple: STAPLE }, follower: { status: 500, body: failure }, representative: state(account, '0x10'), readings: [] }]);
	});

	test('skips an account the follower fails to answer for while the representative shows it moving', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		serveAccount(running, account, [], state(account, '0x10'), history(STAPLE, [RECENT_VOTE]));
		running.follower.answer(`/node/ledger/account/${account}`, { status: 500, body: { error: true } });

		await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toMatchObject([{ kind: 'skipped', reason: 'moving', side: 'representative' }]);
	});

	test('skips an account whose state the follower changed while it was compared, as moving', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		serveAccount(running, account, [state(account, '0x10'), state(account, '0x11')], state(account, '0x11'), history(STAPLE, [QUIET_VOTE]));

		await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toMatchObject([{ kind: 'skipped', reason: 'moving', side: 'follower' }]);
	});

	test('skips an account a representative does not answer for', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		serveAccount(running, account, [state(account, '0x10')], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));
		running.representatives[0]?.answer(`/node/ledger/account/${account}`, { status: 500, body: { error: true } });

		await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toMatchObject([{ kind: 'skipped', reason: 'unanswered' }]);
	});

	test('compares each account with one representative, spreading them over all', async function() {
		const running = await setup(2);
		for (const account of ACCOUNTS.slice(0, 2)) {
			serveAccount(running, account, [state(account, '0x10')], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));
		}

		await sweep(running, memoryStore({ [ACCOUNTS[0]]: [STAPLE], [ACCOUNTS[1]]: [STAPLE] }), 2);

		const records = (await running.log.read()).records;
		expect(recordsOf(records, 'sweep').map(function(record) {
			return(record.representative);
		}).sort()).toEqual(running.representatives.map(function(api) {
			return(api.endpoint);
		}).sort());
		for (const api of running.representatives) {
			expect(api.requests).toHaveLength(2);
		}
	});

	test('resumes after the last account it compared, and starts a new lap after the last', async function() {
		const running = await setup();
		const histories: Record<string, readonly string[]> = {};
		for (const account of ACCOUNTS) {
			serveAccount(running, account, [state(account, '0x10')], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));
			histories[account] = [STAPLE];
		}
		const store = memoryStore(histories);

		await sweep(running, store, 2);
		expect(await readSweepCursor(running.cursorPaths.chain)).toEqual({ lap: 0, afterRowID: '2' });
		const second = await sweep(running, store, 2);
		expect(second.cursor).toEqual({ lap: 1, afterRowID: '1' });
		expect(JSON.parse(await readFile(running.cursorPaths.chain, 'utf8'))).toEqual({ lap: 1, afterRowID: '1' });

		const records = (await running.log.read()).records.flatMap(function(record) {
			if (record.kind !== 'sweep') {
				return([]);
			}
			return([[record.lap, record.account]]);
		});
		expect(records).toEqual([[0, ACCOUNTS[0]], [0, ACCOUNTS[1]], [0, ACCOUNTS[2]], [1, ACCOUNTS[0]]]);
	});
});

/** The states of the accounts, each holding the balance. */
function states(accounts: readonly string[], balance: string): readonly unknown[] {
	return(accounts.map(function(account) {
		return(state(account, balance, null));
	}));
}

/** Every account given is passive, quiet since long before the follower's reach unless a newest moment is given. */
function passiveStore(accounts: readonly string[], newest: Readonly<Record<string, Date>> = {}): SweepStore {
	const histories: Record<string, readonly string[]> = {};
	for (const account of accounts) {
		histories[account] = [STAPLE];
	}
	return(memoryStore(histories, undefined, newest, accounts));
}

async function batches(running: Running): Promise<readonly SweepBatchRecord[]> {
	return(recordsOf((await running.log.read()).records, 'sweep-batch'));
}

describe('the sweep over the follower\'s passive accounts', function() {
	test('asks for the states of a batch in one request on each side, and counts those answered alike', async function() {
		const running = await setup();
		serveStates(running, ACCOUNTS, states(ACCOUNTS, '0x10'), states(ACCOUNTS, '0x10'));

		const summary = await sweepWalks(running, passiveStore(ACCOUNTS), { passive: 3 });

		expect(summary.passive).toMatchObject({ walked: 3, compared: 3, matched: 3, diverged: 0, skipped: 0, cursor: { lap: 0, afterRowID: '3' } });
		expect(await batches(running)).toMatchObject([{ representative: running.representatives[0]?.endpoint, lap: 0, afterRowID: '0', throughRowID: '3', accounts: 3, matched: 3, skipped: [], unanswered: null }]);
		expect(await outcomes(running)).toEqual([]);
		expect(running.follower.requests).toEqual([`GET ${statesPath(ACCOUNTS)}`]);
		expect(running.representatives[0]?.requests).toEqual([`GET ${statesPath(ACCOUNTS)}`]);
	});

	test('compares an account answered apart by itself, as a chain account is compared, and records it diverging when its newest staple is quiet', async function() {
		const running = await setup();
		const [first, second, third] = ACCOUNTS;
		serveStates(running, ACCOUNTS, states(ACCOUNTS, '0x10'), [state(first, '0x10', null), state(second, '0x11', null), state(third, '0x10', null)]);
		serveAccount(running, second, [state(second, '0x10', null)], state(second, '0x11', null), history(STAPLE, [QUIET_VOTE]));

		const summary = await sweepWalks(running, passiveStore(ACCOUNTS), { passive: 3 });

		expect(summary.passive).toMatchObject({ walked: 3, compared: 3, matched: 2, diverged: 1, skipped: 0 });
		expect(recordsOf((await running.log.read()).records, 'sweep')).toMatchObject([{ account: second, walk: 'passive', outcome: { kind: 'diverged', divergence: { account: second, field: 'balances[0].balance', staple: STAPLE } } }]);
		expect(await batches(running)).toMatchObject([{ accounts: 3, matched: 2, skipped: [] }]);
		expect(running.representatives[0]?.requests).toEqual([`GET ${statesPath(ACCOUNTS)}`, `GET /node/ledger/account/${second}`, `GET /node/ledger/account/${second}/history?limit=1`]);
	});

	test('skips an account answered apart whose newest staple on the representative is recent, as moving, and names it in the batch', async function() {
		const running = await setup();
		const [first, second] = ACCOUNTS;
		const accounts = [first, second];
		serveStates(running, accounts, states(accounts, '0x10'), [state(first, '0x10', null), state(second, '0x11', null)]);
		serveAccount(running, second, [state(second, '0x10', null)], state(second, '0x11', null), history(STAPLE, [RECENT_VOTE]));

		const summary = await sweepWalks(running, passiveStore(accounts), { passive: 2 });

		expect(summary.passive).toMatchObject({ walked: 2, compared: 1, matched: 1, skipped: 1 });
		expect(await outcomes(running)).toMatchObject([{ kind: 'skipped', reason: 'moving', side: 'representative' }]);
		expect(await batches(running)).toMatchObject([{ accounts: 2, matched: 1, skipped: [second] }]);
	});

	test('skips an account answered apart that the follower holds a staple of from within the margin, without asking about it by itself', async function() {
		const running = await setup();
		const [first, second] = ACCOUNTS;
		const accounts = [first, second];
		serveStates(running, accounts, states(accounts, '0x10'), [state(first, '0x10', null), state(second, '0x11', null)]);

		await sweepWalks(running, passiveStore(accounts, { [second]: RECENT_VOTE }), { passive: 2 });

		expect(await outcomes(running)).toMatchObject([{ kind: 'skipped', reason: 'moving', side: 'follower' }]);
		expect(await batches(running)).toMatchObject([{ matched: 1, skipped: [second] }]);
		expect(running.representatives[0]?.requests).toEqual([`GET ${statesPath(accounts)}`]);
	});

	test('counts accounts answered alike even when the follower holds a staple of them from within the margin', async function() {
		const running = await setup();
		serveStates(running, ACCOUNTS, states(ACCOUNTS, '0x10'), states(ACCOUNTS, '0x10'));

		const summary = await sweepWalks(running, passiveStore(ACCOUNTS, { [ACCOUNTS[0]]: RECENT_VOTE }), { passive: 3 });

		expect(summary.passive).toMatchObject({ compared: 3, matched: 3, skipped: 0 });
	});

	test('names every account of a batch the representative does not answer as not compared, without asking about any by itself', async function() {
		const running = await setup();
		serveStates(running, ACCOUNTS, states(ACCOUNTS, '0x10'), states(ACCOUNTS, '0x10'));
		running.representatives[0]?.answer(statesPath(ACCOUNTS), { status: 504, body: { error: true } });

		const summary = await sweepWalks(running, passiveStore(ACCOUNTS), { passive: 3 });

		expect(summary.passive).toMatchObject({ walked: 3, compared: 0, skipped: 3, cursor: { lap: 0, afterRowID: '3' } });
		const [batch] = await batches(running);
		expect(batch).toMatchObject({ accounts: 3, matched: 0, skipped: ACCOUNTS });
		expect(batch?.unanswered).toContain('answered 504');
		expect(await outcomes(running)).toEqual([]);
	});

	test('names every account of a batch as not compared when the representative answers it with a list that is not their states', async function() {
		const running = await setup();
		const [first, second] = ACCOUNTS;
		const accounts = [first, second];
		serveStates(running, accounts, states(accounts, '0x10'), states([second, first], '0x10'));

		await sweepWalks(running, passiveStore(accounts), { passive: 2 });

		expect(await batches(running)).toMatchObject([{ matched: 0, skipped: accounts }]);
		expect((await batches(running))[0]?.unanswered).toContain('not the state of each account requested');
	});

	test('compares each account of a batch by itself when the follower does not answer the batch with their states', async function() {
		const running = await setup();
		const [first, second] = ACCOUNTS;
		const accounts = [first, second];
		serveStates(running, accounts, [], states(accounts, '0x10'));
		running.follower.answer(statesPath(accounts), { status: 500, body: { error: true } });
		for (const account of accounts) {
			serveAccount(running, account, [state(account, '0x10', null)], state(account, '0x10', null), history(STAPLE, [QUIET_VOTE]));
		}

		const summary = await sweepWalks(running, passiveStore(accounts), { passive: 2 });

		expect(summary.passive).toMatchObject({ compared: 2, matched: 2 });
		expect(await outcomes(running)).toMatchObject([{ kind: 'match' }, { kind: 'match' }]);
		expect(await batches(running)).toMatchObject([{ matched: 0, skipped: [] }]);
	});

	test('asks each representative for at most a hundred accounts at a time, in batches of consecutive rows', async function() {
		const running = await setup(2);
		const accounts = Array.from({ length: 150 }, function(_, index): string {
			return(`keeta_passive${String(index).padStart(3, '0')}`);
		});
		const [front, back] = [accounts.slice(0, 100), accounts.slice(100)];
		serveStates(running, front, states(front, '0x10'), states(front, '0x10'));
		serveStates(running, back, states(back, '0x10'), states(back, '0x10'));

		const summary = await sweepWalks(running, passiveStore(accounts), { passive: 150 });

		expect(summary.passive).toMatchObject({ walked: 150, matched: 150, cursor: { lap: 0, afterRowID: '150' } });
		expect((await batches(running)).map(function(batch) {
			return([batch.representative, batch.afterRowID, batch.throughRowID, batch.accounts]);
		})).toEqual([[running.representatives[0]?.endpoint, '0', '100', 100], [running.representatives[1]?.endpoint, '100', '150', 50]]);
		expect(running.representatives[0]?.requests).toEqual([`GET ${statesPath(front)}`]);
		expect(running.representatives[1]?.requests).toEqual([`GET ${statesPath(back)}`]);
	});
});

describe('the two walks of the sweep', function() {
	test('walk apart, each from its own cursor, and each stops at the end of its lap when asked', async function() {
		const running = await setup();
		const [chain, first, second] = ACCOUNTS;
		const passive = [first, second];
		serveAccount(running, chain, [state(chain, '0x10')], state(chain, '0x10'), history(STAPLE, [QUIET_VOTE]));
		serveStates(running, passive, states(passive, '0x10'), states(passive, '0x10'));
		const store = memoryStore({ [chain]: [STAPLE], [first]: [STAPLE], [second]: [STAPLE] }, undefined, {}, passive);

		const summary = await sweepWalks(running, store, { chain: Number.MAX_SAFE_INTEGER, passive: Number.MAX_SAFE_INTEGER }, true);

		expect(summary.chain).toMatchObject({ walked: 1, matched: 1, cursor: { lap: 1, afterRowID: '0' } });
		expect(summary.passive).toMatchObject({ walked: 2, matched: 2, cursor: { lap: 1, afterRowID: '0' } });
		expect(await readSweepCursor(running.cursorPaths.chain)).toEqual({ lap: 1, afterRowID: '0' });
		expect(await readSweepCursor(running.cursorPaths.passive)).toEqual({ lap: 1, afterRowID: '0' });
		expect(recordsOf((await running.log.read()).records, 'sweep').map(function(record) {
			return([record.account, record.walk]);
		})).toEqual([[chain, 'chain']]);
	});
});

/** Serves the account on the follower, and on each representative in turn the balance given, with a quiet newest staple; an undefined balance is a failure. */
function serveSplit(running: Running, account: string, follower: string, representatives: readonly (string | undefined)[]): void {
	running.follower.serve(`/node/ledger/account/${account}`, state(account, follower));
	for (const [index, api] of running.representatives.entries()) {
		const balance = representatives[index];
		if (balance === undefined) {
			api.answer(`/node/ledger/account/${account}`, { status: 504, body: { error: true } });
		} else {
			api.serve(`/node/ledger/account/${account}`, state(account, balance));
		}
		api.serve(`/node/ledger/account/${account}/history?limit=1`, history(STAPLE, [QUIET_VOTE]));
	}
}

describe('a divergence from one representative', function() {
	test('is that representative\'s own when the follower agrees with most of the others, and is recorded with every one\'s reading', async function() {
		const running = await setup(3);
		const account = ACCOUNTS[0];
		serveSplit(running, account, '0x10', ['0x11', '0x10', '0x10']);

		const summary = await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(summary).toMatchObject({ compared: 1, diverged: 0, representativeLocal: 1 });
		const [record] = recordsOf((await running.log.read()).records, 'sweep');
		expect(record).toMatchObject({ representative: running.representatives[0]?.endpoint, outcome: { kind: 'representative-local', divergence: { field: 'balances[0].balance' }, representative: state(account, '0x11') } });
		expect(record?.outcome.kind === 'representative-local' && record.outcome.readings).toEqual([
			{ representative: running.representatives[1]?.endpoint, kind: 'agrees', state: state(account, '0x10'), staple: STAPLE },
			{ representative: running.representatives[2]?.endpoint, kind: 'agrees', state: state(account, '0x10'), staple: STAPLE }
		]);
	});

	test('is the follower\'s when the others agree with that representative', async function() {
		const running = await setup(3);
		const account = ACCOUNTS[0];
		serveSplit(running, account, '0x10', ['0x11', '0x11', '0x11']);

		await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toMatchObject([{ kind: 'diverged', readings: [{ kind: 'disagrees' }, { kind: 'disagrees' }] }]);
	});

	test('stays unresolved when the follower agrees with only one other representative that answered', async function() {
		const running = await setup(3);
		const account = ACCOUNTS[0];
		serveSplit(running, account, '0x10', ['0x11', '0x10', undefined]);

		await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toMatchObject([{ kind: 'unresolved', readings: [{ kind: 'agrees' }, { kind: 'unanswered' }] }]);
	});

	test('is unresolved when the representatives split evenly', async function() {
		const running = await setup(4);
		const account = ACCOUNTS[0];
		serveSplit(running, account, '0x10', ['0x11', '0x10', '0x10', '0x12']);

		const summary = await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toMatchObject([{ kind: 'unresolved' }]);
		expect(summary).toMatchObject({ diverged: 1, representativeLocal: 0 });
	});

	test('does not count the reading of a representative that shows the account moving', async function() {
		const running = await setup(3);
		const account = ACCOUNTS[0];
		serveSplit(running, account, '0x10', ['0x11', '0x10', '0x10']);
		running.representatives[2]?.serve(`/node/ledger/account/${account}/history?limit=1`, history(STAPLE, [RECENT_VOTE]));

		await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toMatchObject([{ kind: 'unresolved', readings: [{ kind: 'agrees' }, { kind: 'moving' }] }]);
	});

	test('found in the passive walk is read again in the same way', async function() {
		const running = await setup(3);
		const [first, second] = ACCOUNTS;
		const accounts = [first, second];
		running.follower.serve(statesPath(accounts), states(accounts, '0x10'));
		running.representatives[0]?.serve(statesPath(accounts), [state(first, '0x10', null), state(second, '0x11', null)]);
		serveSplit(running, second, '0x10', ['0x11', '0x10', '0x10']);

		const summary = await sweepWalks(running, passiveStore(accounts), { passive: 2 });

		expect(summary.passive).toMatchObject({ compared: 2, matched: 1, representativeLocal: 1, diverged: 0 });
		expect(await outcomes(running)).toMatchObject([{ kind: 'representative-local' }]);
	});

	test('recorded before is compared again with that representative, and read again from the others, when asked', async function() {
		const running = await setup(3);
		const account = ACCOUNTS[0];
		serveSplit(running, account, '0x10', ['0x11', '0x10', '0x10']);
		const older: SweepRecord = { kind: 'sweep', at: '2026-10-11T12:34:11.610Z', representative: running.representatives[0]?.endpoint ?? '', account, lap: 0, walk: 'passive', outcome: { kind: 'diverged', divergence: { account, field: 'balances[0].balance', staple: STAPLE }, follower: {}, representative: {}, readings: [] } };
		await running.log.append([older, { ...older, account: ACCOUNTS[1], representative: 'https://elsewhere.example/api' }]);

		const summary = await recheckDivergences({
			follower: httpSource(running.follower.endpoint),
			representatives: running.representatives.map(function(api) {
				return(httpSource(api.endpoint));
			}),
			store: memoryStore({ [account]: [STAPLE] }),
			log: running.log,
			stopped: new AbortController().signal
		});

		expect(summary).toEqual({ 'representative-local': 1 });
		expect(recordsOf((await running.log.read()).records, 'sweep').at(-1)).toMatchObject({ account, lap: 0, walk: 'passive', representative: running.representatives[0]?.endpoint, outcome: { kind: 'representative-local' } });
	});
});
