import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startFakeAPI } from '../testing/fake-api.js';
import type { FakeAPI } from '../testing/fake-api.js';
import { httpSource } from './api-source.js';
import type { FollowerProgress, KnownAccount } from './follower-store.js';
import { ParityLog } from './log.js';
import type { SweepRecord } from './log.js';
import { recordsOf } from './report.js';
import { firstDifference, QUIET_MARGIN_MILLISECONDS, readSweepCursor, sweepAccounts } from './sweep.js';
import type { SweepStore } from './sweep.js';

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
 * given or, by default, quiet since long before the follower's reach.
 */
function memoryStore(histories: Readonly<Record<string, readonly string[]>>, progress: FollowerProgress = { completedPass: undefined, heldBefore: HELD_BEFORE, staged: 0 }, newest: Readonly<Record<string, Date>> = {}): SweepStore {
	const known: KnownAccount[] = Object.entries(histories).map(function([account, staples], index): KnownAccount {
		let newestStaple: Date | undefined;
		if (staples.length > 0) {
			newestStaple = newest[account] ?? new Date('2025-06-01T00:00:00.000Z');
		}
		return({ rowID: String(index + 1), account, newestStaple });
	});
	return({
		progress(): Promise<FollowerProgress> {
			return(Promise.resolve(progress));
		},
		accountsAfter(rowID: string, count: number): Promise<readonly KnownAccount[]> {
			return(Promise.resolve(known.filter(function(entry): boolean {
				return(BigInt(entry.rowID) > BigInt(rowID));
			}).slice(0, count)));
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
	readonly cursorPath: string;
};

async function setup(representativeCount = 1): Promise<Running> {
	const directory = await mkdtemp(join(tmpdir(), 'slop-parity-sweep-'));
	directories.push(directory);
	const representatives: FakeAPI[] = [];
	for (let index = 0; index < representativeCount; index++) {
		representatives.push(await startFakeAPI());
	}
	return({ follower: await startFakeAPI(), representatives, log: new ParityLog(join(directory, 'parity.jsonl')), cursorPath: join(directory, 'parity-sweep.json') });
}

/** Serves the account's state on both sides, and its newest staple on every representative. */
function serveAccount(running: Running, account: string, follower: readonly unknown[], representative: unknown, newest: unknown): void {
	running.follower.serve(`/node/ledger/account/${account}`, ...follower);
	for (const api of running.representatives) {
		api.serve(`/node/ledger/account/${account}`, representative);
		api.serve(`/node/ledger/account/${account}/history?limit=1`, newest);
	}
}

async function sweep(running: Running, store: SweepStore, accounts: number) {
	return(await sweepAccounts({
		follower: httpSource(running.follower.endpoint),
		representatives: running.representatives.map(function(api) {
			return(httpSource(api.endpoint));
		}),
		store,
		log: running.log,
		cursorPath: running.cursorPath,
		accounts,
		stopped: new AbortController().signal
	}));
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
			representative: state(account, '0x11')
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

	test('asks nothing about an account, and records nothing, while the follower holds no history yet', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		serveAccount(running, account, [state(account, '0x10')], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));

		const summary = await sweep(running, memoryStore({ [account]: [STAPLE] }, { completedPass: undefined, heldBefore: undefined, staged: 0 }), 1);

		expect(summary).toMatchObject({ walked: 1, movingOnFollower: 1, compared: 0, skipped: 0 });
		expect(await outcomes(running)).toEqual([]);
		expect([...running.follower.requests, ...(running.representatives[0]?.requests ?? [])]).toEqual([]);
	});

	test('asks nothing about an account, and records nothing, when the follower itself holds a staple of it from within the margin', async function() {
		const running = await setup();
		const [quiet, moving] = ACCOUNTS;
		for (const account of [quiet, moving]) {
			serveAccount(running, account, [state(account, '0x10')], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));
		}

		const summary = await sweep(running, memoryStore({ [quiet]: [STAPLE], [moving]: [STAPLE] }, undefined, { [quiet]: QUIET_VOTE, [moving]: RECENT_VOTE }), 2);

		expect(summary).toMatchObject({ walked: 2, movingOnFollower: 1, compared: 1, matched: 1 });
		expect((await running.log.read()).records.map(function(record) {
			return(record.kind === 'sweep' && record.account);
		})).toEqual([quiet]);
		expect(running.follower.requests.join()).not.toContain(moving);
	});

	test('records a quiet account the follower fails to answer for as diverging in its status', async function() {
		const running = await setup();
		const account = ACCOUNTS[0];
		const failure = { error: true, message: 'Internal error occurred (error ID: x)' };
		serveAccount(running, account, [], state(account, '0x10'), history(STAPLE, [QUIET_VOTE]));
		running.follower.answer(`/node/ledger/account/${account}`, { status: 500, body: failure });

		await sweep(running, memoryStore({ [account]: [STAPLE] }), 1);

		expect(await outcomes(running)).toEqual([{ kind: 'diverged', divergence: { account, field: 'status', staple: STAPLE }, follower: { status: 500, body: failure }, representative: state(account, '0x10') }]);
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
		expect(await readSweepCursor(running.cursorPath)).toEqual({ lap: 0, afterRowID: '2' });
		const second = await sweep(running, store, 2);
		expect(second.cursor).toEqual({ lap: 1, afterRowID: '1' });
		expect(JSON.parse(await readFile(running.cursorPath, 'utf8'))).toEqual({ lap: 1, afterRowID: '1' });

		const records = (await running.log.read()).records.flatMap(function(record) {
			if (record.kind !== 'sweep') {
				return([]);
			}
			return([[record.lap, record.account]]);
		});
		expect(records).toEqual([[0, ACCOUNTS[0]], [0, ACCOUNTS[1]], [0, ACCOUNTS[2]], [1, ACCOUNTS[0]]]);
	});
});
