import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startFakeAPI } from '../testing/fake-api.js';
import { httpSource } from './api-source.js';
import type { FollowerProgress, FollowerStore, KnownAccount } from './follower-store.js';
import { ParityLog } from './log.js';
import type { APIDiffOutcome, APIDiffRecord, BlockCountRecord, BlockCountVerdict, ChecksumRecord, ChecksumVerdict, CrossCheckOutcome, CrossCheckRecord, ParityRecord, ShadowRunRecord, ShadowWindowTally, SweepOutcome, SweepRecord } from './log.js';
import { parityReportOf, runParity } from './report.js';
import type { Stratum } from './strata.js';

const REPRESENTATIVE = 'https://rep1.example/api';
const OTHER_REPRESENTATIVE = 'https://rep2.example/api';
const ACCOUNT = 'keeta_aabiko2lb4klv75vi72jxkgaotfravn7p4clfko4lcw7vywrzfznrvemqxb5iai';
const OTHER_ACCOUNT = 'keeta_aabk62tezl4whordlviamlx3zrdgux6lk63cghay45vkzdatyemzvqqjuj5resa';
const STAPLE = 'A0'.repeat(32);

const PROGRESS: FollowerProgress = { completedPass: undefined, heldBefore: new Date('2025-12-31T00:00:00.000Z'), staged: 0 };

const READ = { kind: 'read', first: { checksum: '0x1', blockCount: 1 }, second: { checksum: '0x1', blockCount: 1 } } as const;

function checksum(at: string, verdict: ChecksumVerdict, representative: string = REPRESENTATIVE): ChecksumRecord {
	return({ kind: 'checksum', at, representative, gapMilliseconds: 10_000, completedPass: null, follower: READ, representativeWindow: READ, verdict });
}

const FAIL: ChecksumVerdict = { kind: 'fail', bisect: { followerBlockCount: 1, representativeBlockCount: 2, sweep: { cursor: null, firstDivergence: { account: ACCOUNT, field: 'balances[0].balance', staple: STAPLE } } } };

function crossCheck(at: string, outcome: CrossCheckOutcome): CrossCheckRecord {
	return({ kind: 'cross-check', at, stored: '0x1', folded: '0x1', mainBlocks: 1, outcome });
}

function blockCount(at: string, verdict: BlockCountVerdict, representative: string = REPRESENTATIVE): BlockCountRecord {
	return({ kind: 'block-count', at, representative, completedPass: null, staged: 0, follower: READ, representativeWindow: READ, toleranceBlocks: 100, verdict });
}

function swept(at: string, account: string, outcome: SweepOutcome): SweepRecord {
	return({ kind: 'sweep', at, representative: REPRESENTATIVE, account, lap: 0, outcome });
}

const MATCH: SweepOutcome = { kind: 'match', head: null, staple: STAPLE };
const MOVING: SweepOutcome = { kind: 'skipped', reason: 'moving', side: 'representative', detail: 'recent' };
const UNANSWERED: SweepOutcome = { kind: 'skipped', reason: 'unanswered', detail: '500' };

function diverged(account: string, field: string): SweepOutcome {
	return({ kind: 'diverged', divergence: { account, field, staple: STAPLE }, follower: {}, representative: {} });
}

const KNOWN_BEHAVIOR = '/api/node/ledger/account/{account} 200 error=-';

function apiDiff(at: string, stratum: Stratum, path: string, outcome: APIDiffOutcome, behaviors: readonly string[] = [KNOWN_BEHAVIOR]): APIDiffRecord {
	return({ kind: 'api-diff', at, representative: REPRESENTATIVE, stratum, route: '/api/node/ledger/account/{account}', path, behaviors, outcome });
}

const TALLY_EMPTY: ShadowWindowTally = { replayed: 0, shadowVoted: 0, voted: 0, explained: {}, unexplained: 0, firstUnexplained: [], votedFrom: null, votedTo: null };

const TALLY_SCOPED: ShadowWindowTally = { replayed: 30_000, shadowVoted: 30_000, voted: 29_990, explained: { 'self-requirement-return': 10 }, unexplained: 0, firstUnexplained: [], votedFrom: '2026-07-24T20:40:00.000Z', votedTo: '2026-10-10T09:00:00.000Z' };

/** A complete run from a snapshot taken before the scoped window, up to a target fixed with the follower caught up. */
function shadowRun(at: string, changes: Partial<ShadowRunRecord>): ShadowRunRecord {
	return({
		kind: 'shadow-run',
		at,
		scope: { release: '0.18.4', from: '2026-07-24T20:33:26.082Z' },
		informationalEvery: 10,
		base: { database: 'follower_snapshot_20261010080000', sequence: '220000', blocksHash: STAPLE, scopedStaples: 0 },
		target: { sequence: '420000', fixedAt: '2026-10-10T10:00:00.000Z', followerCaughtUp: true, heldBefore: '2026-10-10T09:59:00.000Z' },
		reached: { sequence: '420000', blocksHash: STAPLE },
		scoped: TALLY_SCOPED,
		informational: { replayed: 170_000, shadowVoted: 17_000, voted: 16_000, explained: { 'send-recipient-access': 990 }, unexplained: 10, firstUnexplained: [], votedFrom: '2026-05-20T00:00:00.000Z', votedTo: '2026-07-24T20:30:00.000Z' },
		refusedForWeight: 0,
		unapplied: [],
		complete: true,
		cost: { seconds: 3600, staples: 200_000, shadowVotes: 47_000, maxResidentMiB: 900 },
		...changes
	});
}

function report(records: readonly ParityRecord[]) {
	return(parityReportOf({ generatedAt: new Date('2026-10-09T08:00:00.000Z'), progress: PROGRESS, sweep: { knownAccounts: 10, cursor: { lap: 1, afterRowID: '7' }, walkedThisLap: 4 }, log: { records, unreadableLines: 0 }, knownBehaviors: new Set([KNOWN_BEHAVIOR]) }));
}

describe('the parity report', function() {
	test('has nothing comparable in an empty log', function() {
		const empty = report([]);
		expect(empty).toMatchObject({
			generatedAt: '2026-10-09T08:00:00.000Z',
			follower: { completedPass: null, heldBefore: '2025-12-31T00:00:00.000Z' },
			signals: {
				checksum: { verdict: 'not-comparable-yet', firstDivergence: null },
				sweep: { verdict: 'not-comparable-yet', firstDivergence: null, confidence: { kind: 'none' } },
				apiDiff: { verdict: 'not-comparable-yet', firstDivergence: null, newBehaviors: [] },
				shadowVotes: { verdict: 'not-comparable-yet', runs: 0, notComparableReasons: ['no-run'], latest: null, firstDivergence: null }
			}
		});
	});

	test('passes the checksum when the stored checksum equals the fold and the block counts agree within the tolerance', function() {
		const at = '2026-10-09T02:00:00.000Z';
		const records = [crossCheck(at, { kind: 'equal' }), blockCount(at, { kind: 'pass' }), blockCount(at, { kind: 'pass' }, OTHER_REPRESENTATIVE)];
		expect(report(records).signals.checksum).toMatchObject({
			verdict: 'pass',
			crossCheck: { verdict: 'pass', runs: 1 },
			blockCount: { verdict: 'pass', counts: { comparisons: 2, comparable: 2, passed: 2, failed: 0 } },
			confidence: { kind: 'not-sampled' },
			firstDivergence: null
		});
	});

	test('fails the checksum on a cross-check an earlier build recorded, which a stop could leave short of the ledger', function() {
		const at = '2026-10-09T02:00:00.000Z';
		expect(report([crossCheck(at, { kind: 'unsynced', staples: [STAPLE] }), blockCount(at, { kind: 'pass' })]).signals.checksum.verdict).toBe('fail');
		expect(report([crossCheck(at, { kind: 'lost-run', firstSequence: '1', lastSequence: '18', staples: 18, firstMoment: at, lastMoment: at }), blockCount(at, { kind: 'pass' })]).signals.checksum.verdict).toBe('fail');
		expect(report([crossCheck(at, { kind: 'lost-run', firstSequence: '1', lastSequence: '18', staples: 18, firstMoment: at, lastMoment: at }), crossCheck(at, { kind: 'equal' }), blockCount(at, { kind: 'pass' })]).signals.checksum.verdict).toBe('pass');
	});

	test('is not comparable yet while the block counts are not, however the cross-check stands', function() {
		const at = '2026-10-09T02:00:00.000Z';
		expect(report([]).signals.checksum).toMatchObject({ verdict: 'not-comparable-yet', crossCheck: { verdict: 'not-comparable-yet', runs: 0, latest: null } });
		expect(report([crossCheck(at, { kind: 'equal' }), blockCount(at, { kind: 'not-comparable-yet', reasons: ['no-completed-pass'] })]).signals.checksum).toMatchObject({
			verdict: 'not-comparable-yet',
			crossCheck: { verdict: 'pass' },
			blockCount: { verdict: 'not-comparable-yet', notComparableReasons: ['no-completed-pass'] }
		});
	});

	test('fails on a stored checksum apart from the fold, or a block count beyond the tolerance in the latest run', function() {
		const earlier = '2026-10-09T01:00:00.000Z';
		const at = '2026-10-09T02:00:00.000Z';
		expect(report([crossCheck(at, { kind: 'differs', offset: '0xABC', staples: [{ sequence: '3', blocksHash: STAPLE, stored: '0x1', fold: '0xABD' }] }), blockCount(at, { kind: 'pass' })]).signals.checksum).toMatchObject({
			verdict: 'fail',
			firstDivergence: { at, representative: null, account: '', field: 'ledgerChecksum', staple: null }
		});
		expect(report([crossCheck(at, { kind: 'equal' }), blockCount(earlier, { kind: 'fail', difference: 500 }), blockCount(at, { kind: 'pass' }), blockCount(at, { kind: 'fail', difference: -300 }, OTHER_REPRESENTATIVE)]).signals.checksum).toMatchObject({
			verdict: 'fail',
			blockCount: { counts: { comparisons: 3, comparable: 3, passed: 1, failed: 2 } },
			firstDivergence: { at, representative: OTHER_REPRESENTATIVE, field: 'blockCount' }
		});
		expect(report([crossCheck(at, { kind: 'equal' }), blockCount(earlier, { kind: 'fail', difference: 500 }), blockCount(at, { kind: 'pass' })]).signals.checksum.verdict).toBe('pass');
	});

	test('records the representatives\' checksums for information only', function() {
		const at = '2026-10-09T02:00:00.000Z';
		const other = { kind: 'read', first: { checksum: '0x2', blockCount: 2 }, second: { checksum: '0x02', blockCount: 2 } } as const;
		const records = [checksum(at, FAIL), { ...checksum(at, FAIL, OTHER_REPRESENTATIVE), representativeWindow: other }, { ...checksum(at, FAIL, OTHER_REPRESENTATIVE), representativeWindow: READ }];
		expect(report(records).signals.checksum).toMatchObject({ verdict: 'not-comparable-yet', representativeChecksums: { comparisons: 3, agreeing: 2, distinctInLatestRun: 2 } });
	});

	test('passes the API diff with the rule of three in each stratum, counting each request by its latest comparison', function() {
		const path = `/node/ledger/account/${ACCOUNT}`;
		const signal = report([
			apiDiff('2026-10-09T01:00:00.000Z', 'token', path, { kind: 'diverged', field: 'body.info', follower: {}, representative: {} }),
			apiDiff('2026-10-09T01:00:01.000Z', 'token', path, { kind: 'match' }),
			apiDiff('2026-10-09T01:00:02.000Z', 'token', `${path}/head`, { kind: 'match' }),
			apiDiff('2026-10-09T01:00:03.000Z', 'storage', path, { kind: 'skipped', reason: 'moving', side: 'representative', detail: 'recent' }),
			apiDiff('2026-10-09T01:00:04.000Z', 'operation:SEND', '/vote/AB', { kind: 'match' }, ['/api/vote/{blockhash} 200 error=-', 'operation=SEND'])
		]).signals.apiDiff;
		expect(signal).toMatchObject({
			verdict: 'pass',
			counts: { requestsCompared: 3, matched: 3, diverged: 0, skippedMoving: 1, unanswered: 0, divergenceRecords: 1 },
			newBehaviors: [{ behavior: '/api/vote/{blockhash} 200 error=-', path: '/vote/AB' }, { behavior: 'operation=SEND', path: '/vote/AB' }],
			firstDivergence: null
		});
		expect(signal.strata.find(function(stratum) {
			return(stratum.stratum === 'token');
		})).toEqual({ stratum: 'token', requestsCompared: 2, diverged: 0, confidence: { kind: 'rule-of-three', samples: 2, level: 0.95, divergenceRateBelow: 1.5 } });
		expect(signal.strata.find(function(stratum) {
			return(stratum.stratum === 'storage');
		})).toMatchObject({ requestsCompared: 0, confidence: { kind: 'none' } });
	});

	test('fails the API diff while a request\'s latest comparison diverges, naming it', function() {
		const path = `/node/ledger/account/${ACCOUNT}`;
		const signal = report([
			apiDiff('2026-10-09T01:00:00.000Z', 'token', path, { kind: 'match' }),
			apiDiff('2026-10-09T01:00:01.000Z', 'token', path, { kind: 'diverged', field: 'body.info', follower: {}, representative: {} })
		]).signals.apiDiff;
		expect(signal).toMatchObject({ verdict: 'fail', firstDivergence: { at: '2026-10-09T01:00:01.000Z', representative: REPRESENTATIVE, stratum: 'token', path, field: 'body.info' } });
	});

	test('passes shadow votes only once the latest run voted on the whole scoped window, up to a target fixed with the follower caught up', function() {
		const passed = shadowRun('2026-10-10T12:00:00.000Z', {});
		expect(report([shadowRun('2026-10-10T11:00:00.000Z', { complete: false }), passed]).signals.shadowVotes).toEqual({
			verdict: 'pass',
			runs: 2,
			notComparableReasons: [],
			latest: {
				at: passed.at,
				scope: passed.scope,
				base: passed.base,
				target: passed.target,
				reached: '420000',
				complete: true,
				scoped: { replayed: 30_000, shadowVoted: 30_000, voted: 29_990, explained: { 'self-requirement-return': { refusals: 10, changedIn: '0.18.5' } }, unexplained: 0, votedFrom: '2026-07-24T20:40:00.000Z', votedTo: '2026-10-10T09:00:00.000Z' },
				informational: { replayed: 170_000, shadowVoted: 17_000, voted: 16_000, explained: { 'send-recipient-access': { refusals: 990, changedIn: '0.18.0' } }, unexplained: 10, votedFrom: '2026-05-20T00:00:00.000Z', votedTo: '2026-07-24T20:30:00.000Z', every: 10 },
				refusedForWeight: 0,
				unapplied: 0,
				cost: passed.cost
			},
			confidence: { kind: 'rule-of-three', samples: 30_000, level: 0.95, divergenceRateBelow: 0.0001 },
			firstDivergence: null
		});
	});

	test('keeps shadow votes not comparable, with the reasons, until the run can decide', function() {
		expect(report([]).signals.shadowVotes).toMatchObject({ verdict: 'not-comparable-yet', notComparableReasons: ['no-run'] });
		const pending = shadowRun('2026-10-10T05:00:00.000Z', { complete: false, target: { sequence: '90000', fixedAt: '2026-10-10T05:00:00.000Z', followerCaughtUp: false, heldBefore: null } });
		expect(report([pending]).signals.shadowVotes).toMatchObject({ verdict: 'not-comparable-yet', notComparableReasons: ['run-incomplete', 'follower-not-caught-up'] });
		const late = shadowRun('2026-10-10T12:00:00.000Z', { base: { database: 'follower_snapshot_20261010090000', sequence: '400000', blocksHash: STAPLE, scopedStaples: 12 }, scoped: TALLY_EMPTY });
		expect(report([late]).signals.shadowVotes).toMatchObject({ verdict: 'not-comparable-yet', notComparableReasons: ['base-within-window', 'window-empty'] });
	});

	test('fails shadow votes on a refusal in the scoped window no classified difference explains, while the run is under way', function() {
		const refusal = { blocksHash: STAPLE, code: 'LEDGER_INVALID_PERMISSIONS', message: 'no access', why: '0 reasons explain the refusal' };
		const failed = shadowRun('2026-10-10T07:00:00.000Z', { complete: false, scoped: { ...TALLY_SCOPED, voted: 29_989, unexplained: 1, firstUnexplained: [refusal] } });
		expect(report([failed]).signals.shadowVotes).toMatchObject({
			verdict: 'fail',
			confidence: { kind: 'observed', samples: 30_000, divergences: 1 },
			firstDivergence: { at: failed.at, staple: STAPLE, code: 'LEDGER_INVALID_PERMISSIONS', why: 'no access: 0 reasons explain the refusal' }
		});
	});

	test('fails shadow votes on a staple the complete run never applied', function() {
		const unapplied = shadowRun('2026-10-10T12:00:00.000Z', { unapplied: [{ sequence: '410000', blocksHash: STAPLE, why: 'deferred' }] });
		expect(report([unapplied]).signals.shadowVotes).toMatchObject({ verdict: 'fail', firstDivergence: { staple: STAPLE, code: 'deferred' } });
		expect(report([{ ...unapplied, complete: false }]).signals.shadowVotes).toMatchObject({ verdict: 'not-comparable-yet', notComparableReasons: ['run-incomplete'] });
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
			checksumSnapshot: () => Promise.resolve({ stored: 0n, folded: 0n, mainBlocks: 0, mismatched: [] }),
			quietAccounts: () => Promise.resolve([]),
			lastSequence: () => Promise.resolve(0n),
			stapleAt: () => Promise.resolve(undefined),
			staplesAfter: () => Promise.resolve([]),
			staplesOf: () => Promise.resolve([]),
			heldBlocks: () => Promise.resolve([]),
			heldBlocksOfStaples: () => Promise.resolve([]),
			newestStaples: () => Promise.resolve(new Map()),
			close: () => Promise.resolve()
		};

		const result = await runParity({
			follower: httpSource(follower.endpoint),
			representatives: [httpSource(representative.endpoint)],
			store,
			log,
			cursorPath: join(directory, 'parity-sweep.json'),
			sampleAccounts: 1,
			apiDiff: { samplesPerStratum: 1, seed: 'test', edgeCaseStaples: [], knownBehaviors: new Set() },
			gapMilliseconds: 10_000,
			wait: () => Promise.resolve(),
			stopped: new AbortController().signal
		});

		expect(result.signals.checksum).toMatchObject({ verdict: 'not-comparable-yet', crossCheck: { verdict: 'pass', runs: 1 }, blockCount: { counts: { comparisons: 1 }, notComparableReasons: ['no-completed-pass'] } });
		expect(result.signals.sweep).toMatchObject({ verdict: 'pass', counts: { knownAccounts: 1, lap: 0, walkedThisLap: 1, accountsCompared: 2, matched: 2 } });
		expect(result.signals.apiDiff).toMatchObject({ verdict: 'not-comparable-yet', counts: { requestsCompared: 0 } });
		expect((await log.read()).records.map(function(record) {
			return(record.kind);
		})).toEqual(['sweep', 'cross-check', 'checksum', 'block-count', 'sweep']);
	});
});
