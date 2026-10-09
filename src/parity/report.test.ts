import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startFakeAPI } from '../testing/fake-api.js';
import { httpSource } from './api-source.js';
import type { FollowerProgress, FollowerStore, KnownAccount } from './follower-store.js';
import { ParityLog } from './log.js';
import type { ChecksumRecord, ChecksumVerdict, ParityRecord, SweepOutcome, SweepRecord } from './log.js';
import { parityReportOf, runParity } from './report.js';

const REPRESENTATIVE = 'https://rep1.example/api';
const OTHER_REPRESENTATIVE = 'https://rep2.example/api';
const ACCOUNT = 'keeta_aabiko2lb4klv75vi72jxkgaotfravn7p4clfko4lcw7vywrzfznrvemqxb5iai';
const OTHER_ACCOUNT = 'keeta_aabk62tezl4whordlviamlx3zrdgux6lk63cghay45vkzdatyemzvqqjuj5resa';
const STAPLE = 'A0'.repeat(32);

const PROGRESS: FollowerProgress = { completedPass: undefined, heldBefore: new Date('2025-12-31T00:00:00.000Z') };

const READ = { kind: 'read', first: { checksum: '0x1', blockCount: 1 }, second: { checksum: '0x1', blockCount: 1 } } as const;

function checksum(at: string, verdict: ChecksumVerdict, representative: string = REPRESENTATIVE): ChecksumRecord {
	return({ kind: 'checksum', at, representative, gapMilliseconds: 10_000, completedPass: null, follower: READ, representativeWindow: READ, verdict });
}

const FAIL: ChecksumVerdict = { kind: 'fail', bisect: { followerBlockCount: 1, representativeBlockCount: 2, sweep: { cursor: null, firstDivergence: { account: ACCOUNT, field: 'balances[0].balance', staple: STAPLE } } } };

function swept(at: string, account: string, outcome: SweepOutcome): SweepRecord {
	return({ kind: 'sweep', at, representative: REPRESENTATIVE, account, lap: 0, outcome });
}

const MATCH: SweepOutcome = { kind: 'match', head: null, staple: STAPLE };
const MOVING: SweepOutcome = { kind: 'skipped', reason: 'moving', side: 'representative', detail: 'recent' };
const UNANSWERED: SweepOutcome = { kind: 'skipped', reason: 'unanswered', detail: '500' };

function diverged(account: string, field: string): SweepOutcome {
	return({ kind: 'diverged', divergence: { account, field, staple: STAPLE }, follower: {}, representative: {} });
}

function report(records: readonly ParityRecord[]) {
	return(parityReportOf({ generatedAt: new Date('2026-10-09T08:00:00.000Z'), progress: PROGRESS, sweep: { knownAccounts: 10, cursor: { lap: 1, afterRowID: '7' }, walkedThisLap: 4 }, log: { records, unreadableLines: 0 } }));
}

describe('the parity report', function() {
	test('has nothing comparable in an empty log, and slots for the signals not implemented', function() {
		const empty = report([]);
		expect(empty).toMatchObject({
			generatedAt: '2026-10-09T08:00:00.000Z',
			follower: { completedPass: null, heldBefore: '2025-12-31T00:00:00.000Z' },
			signals: {
				checksum: { verdict: 'not-comparable-yet', firstDivergence: null },
				sweep: { verdict: 'not-comparable-yet', firstDivergence: null, confidence: { kind: 'none' } },
				apiDiff: { verdict: 'not-implemented' },
				shadowVotes: { verdict: 'not-implemented' }
			}
		});
	});

	test('gives the checksum the verdict of the latest comparison that counted', function() {
		const notYet = checksum('2026-10-09T03:00:00.000Z', { kind: 'not-comparable-yet', reasons: ['no-completed-pass'] });
		const passed = checksum('2026-10-09T02:00:00.000Z', { kind: 'pass' });
		const failed = checksum('2026-10-09T01:00:00.000Z', FAIL);

		expect(report([notYet]).signals.checksum).toMatchObject({ verdict: 'not-comparable-yet', notComparableReasons: ['no-completed-pass'], counts: { comparisons: 1, comparable: 0 } });
		expect(report([failed, passed, notYet]).signals.checksum).toMatchObject({ verdict: 'pass', counts: { comparisons: 3, comparable: 2, matched: 1, mismatched: 1 }, confidence: { kind: 'not-sampled' } });
		expect(report([passed, failed, notYet]).signals.checksum).toMatchObject({
			verdict: 'fail',
			firstDivergence: { at: failed.at, representative: REPRESENTATIVE, account: ACCOUNT, field: 'checksum', staple: STAPLE }
		});
	});

	test('passes the checksum when the follower agrees with any representative compared in the latest run, as theirs differ among themselves', function() {
		const at = '2026-10-09T02:00:00.000Z';
		expect(report([checksum(at, FAIL), checksum(at, { kind: 'pass' }, OTHER_REPRESENTATIVE)]).signals.checksum.verdict).toBe('pass');
		expect(report([checksum(at, FAIL), checksum(at, FAIL, OTHER_REPRESENTATIVE)]).signals.checksum.verdict).toBe('fail');
	});

	test('counts the distinct checksums the representatives that held still served in the latest run', function() {
		const at = '2026-10-09T02:00:00.000Z';
		const other = { kind: 'read', first: { checksum: '0x2', blockCount: 2 }, second: { checksum: '0x02', blockCount: 2 } } as const;
		const records = [checksum(at, FAIL), { ...checksum(at, FAIL, OTHER_REPRESENTATIVE), representativeWindow: other }, { ...checksum(at, FAIL, OTHER_REPRESENTATIVE), representativeWindow: READ }];
		expect(report(records).signals.checksum.representativeChecksums).toBe(2);
	});

	test('passes the sweep with the rule of three over the accounts compared when none diverges', function() {
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, MATCH),
			swept('2026-10-09T01:00:01.000Z', OTHER_ACCOUNT, MOVING),
			swept('2026-10-09T01:00:02.000Z', OTHER_ACCOUNT, MATCH)
		]).signals.sweep;
		expect(sweep).toMatchObject({
			verdict: 'pass',
			counts: { knownAccounts: 10, lap: 1, walkedThisLap: 4, accountsCompared: 2, matched: 2, diverged: 0, skippedMoving: 0, unanswered: 0 },
			confidence: { kind: 'rule-of-three', samples: 2, level: 0.95, divergenceRateBelow: 1.5 },
			firstDivergence: null
		});
	});

	test('fails the sweep while an account\'s latest comparison diverges, naming the first such', function() {
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, MATCH),
			swept('2026-10-09T01:00:01.000Z', OTHER_ACCOUNT, diverged(OTHER_ACCOUNT, 'history')),
			swept('2026-10-09T01:00:02.000Z', ACCOUNT, diverged(ACCOUNT, 'representative'))
		]).signals.sweep;
		expect(sweep).toMatchObject({
			verdict: 'fail',
			counts: { accountsCompared: 2, matched: 0, diverged: 2 },
			confidence: { kind: 'observed', samples: 2, divergences: 2 },
			firstDivergence: { at: '2026-10-09T01:00:01.000Z', account: OTHER_ACCOUNT, field: 'history', staple: STAPLE, representative: REPRESENTATIVE }
		});
	});

	test('counts an account that diverged and later matched as resolved, not as diverging', function() {
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, diverged(ACCOUNT, 'history')),
			swept('2026-10-09T01:00:01.000Z', ACCOUNT, MOVING),
			swept('2026-10-09T01:00:02.000Z', ACCOUNT, MATCH)
		]).signals.sweep;
		expect(sweep).toMatchObject({ verdict: 'pass', counts: { accountsCompared: 1, matched: 1, diverged: 0, resolvedDivergences: 1, divergenceRecords: 1 } });
	});

	test('has nothing comparable in the sweep while every account was skipped', function() {
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, MOVING),
			swept('2026-10-09T01:00:01.000Z', OTHER_ACCOUNT, UNANSWERED)
		]).signals.sweep;
		expect(sweep).toMatchObject({ verdict: 'not-comparable-yet', counts: { accountsCompared: 0, skippedMoving: 1, unanswered: 1 } });
	});
});

const directories: string[] = [];

afterEach(async function() {
	await Promise.all(directories.splice(0).map(function(directory) {
		return(rm(directory, { recursive: true, force: true }));
	}));
});

describe('a parity run', function() {
	test('records a fresh checksum comparison and a sweep sample, then reports on the whole log', async function() {
		const directory = await mkdtemp(join(tmpdir(), 'slop-parity-report-'));
		directories.push(directory);
		const log = new ParityLog(join(directory, 'parity.jsonl'));
		await log.append([swept('2026-10-09T01:00:00.000Z', OTHER_ACCOUNT, MATCH)]);
		const follower = await startFakeAPI();
		const representative = await startFakeAPI();
		for (const api of [follower, representative]) {
			api.serve('/node/ledger/checksum', { moment: '2026-10-09T06:00:00.000Z', momentRange: 1, checksum: '0x1' });
			api.serve('/node/stats', { ledger: { blockCount: 1 } });
			api.serve(`/node/ledger/account/${ACCOUNT}`, { account: ACCOUNT, balances: [], currentHeadBlock: null, currentHeadBlockHeight: null, info: {}, representative: null });
		}
		representative.serve(`/node/ledger/account/${ACCOUNT}/history?limit=1`, { history: [], nextKey: null });
		const known: KnownAccount[] = [{ rowID: '1', account: ACCOUNT, newestStaple: new Date('2025-06-01T00:00:00.000Z') }];
		const store: FollowerStore = {
			progress: () => Promise.resolve(PROGRESS),
			accountsAfter: (rowID) => Promise.resolve(known.filter(function(entry) {
				return(BigInt(entry.rowID) > BigInt(rowID));
			})),
			accountCount: () => Promise.resolve(known.length),
			accountsUpTo: () => Promise.resolve(known.length),
			historyHolds: () => Promise.resolve(false),
			close: () => Promise.resolve()
		};

		const result = await runParity({
			follower: httpSource(follower.endpoint),
			representatives: [httpSource(representative.endpoint)],
			store,
			log,
			cursorPath: join(directory, 'parity-sweep.json'),
			sampleAccounts: 1,
			gapMilliseconds: 10_000,
			wait: () => Promise.resolve(),
			stopped: new AbortController().signal
		});

		expect(result.signals.checksum).toMatchObject({ verdict: 'not-comparable-yet', counts: { comparisons: 1 }, notComparableReasons: ['no-completed-pass'] });
		expect(result.signals.sweep).toMatchObject({ verdict: 'pass', counts: { knownAccounts: 1, lap: 0, walkedThisLap: 1, accountsCompared: 2, matched: 2 } });
		expect((await log.read()).records.map(function(record) {
			return(record.kind);
		})).toEqual(['sweep', 'checksum', 'sweep']);
	});
});
