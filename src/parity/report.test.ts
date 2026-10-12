import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startFakeAPI } from '../testing/fake-api.js';
import { httpSource } from './api-source.js';
import type { FollowerProgress, FollowerStore, KnownAccount } from './follower-store.js';
import { ParityLog } from './log.js';
import type { APIDiffExplainedRecord, APIDiffOutcome, APIDiffPlanRecord, APIDiffRecord, BlockCountRecord, BlockCountVerdict, ChecksumRecord, ChecksumVerdict, CrossCheckOutcome, CrossCheckRecord, ParityRecord, SelfCheck, ShadowRunRecord, ShadowWindowTally, SweepBatchRecord, SweepOutcome, SweepRecord, SweepWalk } from './log.js';
import { answerDigest } from './api-diff.js';
import { neverComparedAccountsOf, parityReportOf, runParity, neverComparedCandidatesOf } from './report.js';
import type { SweepPosition } from './report.js';
import { sweepCursorPaths } from './sweep.js';
import type { Stratum } from './strata.js';

const REPRESENTATIVE = 'https://rep1.example/api';
const OTHER_REPRESENTATIVE = 'https://rep2.example/api';
const ACCOUNT = 'keeta_aabiko2lb4klv75vi72jxkgaotfravn7p4clfko4lcw7vywrzfznrvemqxb5iai';
const OTHER_ACCOUNT = 'keeta_aabk62tezl4whordlviamlx3zrdgux6lk63cghay45vkzdatyemzvqqjuj5resa';
const THIRD_ACCOUNT = 'keeta_aabwip6zeo2fnzfxp5hssrrqtascs2277w2zk7vqd6d3k3m4dkt2flcbca2mqki';
const FOURTH_ACCOUNT = 'keeta_aabvmwxttv4q56gbfveighwfwp3yvitlrdfsacic3ckqc7lqelsspvmhc7oldmq';
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

function swept(at: string, account: string, outcome: SweepOutcome, lap = 0, walk: SweepWalk = 'chain'): SweepRecord {
	return({ kind: 'sweep', at, representative: REPRESENTATIVE, account, lap, walk, outcome });
}

/** A batch of the passive walk over the rows after the first through the second, naming the accounts it did not compare. */
function batch(at: string, lap: number, rows: readonly [string, string], accounts: number, skipped: readonly string[] = [], unanswered: string | null = null): SweepBatchRecord {
	const matched = accounts - skipped.length;
	return({ kind: 'sweep-batch', at, representative: REPRESENTATIVE, lap, afterRowID: rows[0], throughRowID: rows[1], accounts, matched, skipped, unanswered });
}

/** An account with a chain, quiet on the follower since long before the records. */
function chainAccount(account: string, newestStaple: Date = new Date('2025-06-01T00:00:00.000Z')): KnownAccount {
	return({ rowID: '1', account, newestStaple });
}

const CURSORS = { chain: { lap: 1, afterRowID: '7' }, passive: { lap: 0, afterRowID: '40' } } as const;

const MATCH: SweepOutcome = { kind: 'match', head: null, staple: STAPLE };
const MOVING: SweepOutcome = { kind: 'skipped', reason: 'moving', side: 'representative', detail: 'recent' };
const UNANSWERED: SweepOutcome = { kind: 'skipped', reason: 'unanswered', detail: '500' };

/** A divergence of the kind given; one left to a representative apart with the follower's balances found consistent with its history. */
function diverged(account: string, field: string, kind: 'diverged' | 'representative-local' | 'unresolved' = 'diverged'): SweepOutcome {
	let selfCheck: SelfCheck | null = null;
	if (kind === 'representative-local') {
		selfCheck = { kind: 'consistent', tokens: 1 };
	}
	return({ kind, divergence: { account, field, staple: STAPLE }, follower: {}, representative: {}, readings: [], selfCheck });
}

const KNOWN_BEHAVIOR = '/api/node/ledger/account/{account} 200 error=-';

/** The representative's answer an API divergence was about, and the follower's. */
const REPRESENTATIVE_INFO = { status: 200, body: { info: { name: 'KTA' } } };

const FOLLOWER_INFO = { status: 200, body: { info: { name: '' } } };

/** An API answer apart, with no other representative read again. */
const DIVERGED_INFO = { kind: 'diverged', field: 'body.info.name', follower: FOLLOWER_INFO, representative: REPRESENTATIVE_INFO, readings: [] } as const;

/** A comparison of an account's state that found the follower answering what the representative answered in DIVERGED_INFO. */
const MATCHED_INFO: APIDiffOutcome = { kind: 'match', digest: answerDigest(`/node/ledger/account/${ACCOUNT}`, REPRESENTATIVE_INFO) ?? null };

/** A comparison that found both answering alike, on a state no divergence here is about. */
const MATCHED: APIDiffOutcome = { kind: 'match', digest: 'EF'.repeat(32) };

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
		unapplied: [],
		complete: true,
		cost: { seconds: 3600, staples: 200_000, shadowVotes: 47_000, maxResidentMiB: 900 },
		...changes
	});
}

function report(records: readonly ParityRecord[], position: Partial<SweepPosition> = {}) {
	const sweep: SweepPosition = { knownAccounts: 10, chainAccounts: [], cursors: CURSORS, rowIDs: new Map(), ...position };
	return(parityReportOf({ generatedAt: new Date('2026-10-09T08:00:00.000Z'), progress: PROGRESS, sweep, log: { records, unreadableLines: 0 }, knownBehaviors: new Set([KNOWN_BEHAVIOR]) }));
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
			apiDiff('2026-10-09T01:00:00.000Z', 'token', path, DIVERGED_INFO),
			apiDiff('2026-10-09T01:00:01.000Z', 'token', path, MATCHED_INFO),
			apiDiff('2026-10-09T01:00:02.000Z', 'token', `${path}/head`, MATCHED),
			apiDiff('2026-10-09T01:00:03.000Z', 'storage', path, { kind: 'skipped', reason: 'moving', side: 'representative', detail: 'recent' }),
			apiDiff('2026-10-09T01:00:04.000Z', 'operation:SEND', '/vote/AB', MATCHED, ['/api/vote/{blockhash} 200 error=-', 'operation=SEND'])
		]).signals.apiDiff;
		expect(signal).toMatchObject({
			verdict: 'pass',
			counts: { requestsCompared: 3, matched: 3, diverged: 0, skippedMoving: 1, unanswered: 0, divergenceRecords: 1 },
			newBehaviors: [{ behavior: '/api/vote/{blockhash} 200 error=-', path: '/vote/AB' }, { behavior: 'operation=SEND', path: '/vote/AB' }],
			firstDivergence: null
		});
		expect(signal.strata.find(function(stratum) {
			return(stratum.stratum === 'token');
		})).toEqual({ stratum: 'token', requestsCompared: 2, standingOnExplanation: 0, diverged: 0, representativeLocal: 0, census: null, skippedByRoute: {}, routesUncovered: [], covered: false, confidence: { kind: 'rule-of-three', samples: 2, level: 0.95, divergenceRateBelow: 1.5 } });
		expect(signal.strata.find(function(stratum) {
			return(stratum.stratum === 'storage');
		})).toMatchObject({ requestsCompared: 0, confidence: { kind: 'none' } });
	});

	test('fails the API diff while a request\'s latest comparison diverges, naming it', function() {
		const path = `/node/ledger/account/${ACCOUNT}`;
		const signal = report([
			apiDiff('2026-10-09T01:00:00.000Z', 'token', path, MATCHED),
			apiDiff('2026-10-09T01:00:01.000Z', 'token', path, DIVERGED_INFO)
		]).signals.apiDiff;
		expect(signal).toMatchObject({ verdict: 'fail', firstDivergence: { at: '2026-10-09T01:00:01.000Z', representative: REPRESENTATIVE, stratum: 'token', path, field: 'body.info.name' } });
	});

	test('supersedes a divergence by a later comparison of the identical request that finds the follower answering as the representative then did, listing both rather than dropping it', function() {
		const path = `/node/ledger/account/${ACCOUNT}`;
		const divergence = apiDiff('2026-10-09T08:40:25.000Z', 'token', path, DIVERGED_INFO);
		const later = apiDiff('2026-10-11T15:00:00.000Z', 'token', path, MATCHED_INFO);
		const signal = report([divergence, apiDiff('2026-10-10T00:00:00.000Z', 'token', path, { kind: 'skipped', reason: 'moving', side: 'representative', detail: 'recent' }), later]).signals.apiDiff;
		expect(signal).toMatchObject({ verdict: 'pass', counts: { diverged: 0, superseded: 1, divergenceRecords: 1 }, superseded: [{ divergence, by: later }], retestedOnAnotherState: [], firstDivergence: null });
	});

	test('keeps a divergence failing that a later comparison retested only on a state either side reached since', function() {
		const path = `/node/ledger/account/${ACCOUNT}`;
		const divergence = apiDiff('2026-10-09T08:40:25.000Z', 'token', path, DIVERGED_INFO);
		const later = apiDiff('2026-10-11T15:00:00.000Z', 'token', path, MATCHED);
		const signal = report([divergence, later]).signals.apiDiff;
		expect(signal).toMatchObject({ verdict: 'fail', counts: { diverged: 1, superseded: 0 }, superseded: [], retestedOnAnotherState: [{ divergence, by: later }], firstDivergence: { at: divergence.at, path } });
		expect(report([divergence, apiDiff('2026-10-11T15:00:00.000Z', 'token', path, { kind: 'match', digest: null })]).signals.apiDiff.verdict).toBe('fail');
	});

	test('lists apart a divergence a triage record explains, which then fails nothing', function() {
		const path = `/node/ledger/account/${ACCOUNT}`;
		const divergence = apiDiff('2026-10-09T08:40:25.000Z', 'token', path, DIVERGED_INFO);
		const explanation: APIDiffExplainedRecord = { kind: 'api-diff-explained', at: '2026-10-11T17:00:00.000Z', stratum: 'token', path, divergenceAt: divergence.at, divergence: 'our-bug', reference: 'fixed by 0000000', retest: { kind: 'retested' } };
		const signal = report([divergence, apiDiff('2026-10-11T15:00:00.000Z', 'token', path, MATCHED), explanation]).signals.apiDiff;
		expect(signal).toMatchObject({ verdict: 'pass', counts: { diverged: 0, explained: 1, superseded: 0 }, explained: [{ divergence, explanation }], retestedOnAnotherState: [], firstDivergence: null });
	});

	test('counts a request whose latest comparison is the divergence a triage explains apart, neither as matched nor as a sample, nor toward its census', function() {
		const path = `/node/ledger/account/${ACCOUNT}`;
		const plan: APIDiffPlanRecord = { kind: 'api-diff-plan', at: '2026-10-11T14:00:00.000Z', quietBefore: '2026-10-11T13:00:00.000Z', samplesPerStratum: 300, strata: [{ stratum: 'multisig', population: { kind: 'census', requests: [path] } }] };
		const divergence = apiDiff('2026-10-11T14:01:00.000Z', 'multisig', path, DIVERGED_INFO);
		const explanation: APIDiffExplainedRecord = { kind: 'api-diff-explained', at: '2026-10-11T17:00:00.000Z', stratum: 'multisig', path, divergenceAt: divergence.at, divergence: 'our-bug', reference: 'fixed by 0000000', retest: { kind: 'retested' } };
		const signal = report([plan, divergence, explanation]).signals.apiDiff;
		expect(signal).toMatchObject({ verdict: 'not-comparable-yet', counts: { requestsCompared: 0, matched: 0, diverged: 0, explained: 1, standingOnExplanation: 1 } });
		expect(signal.strata.find(function(entry) {
			return(entry.stratum === 'multisig');
		})).toMatchObject({ requestsCompared: 0, standingOnExplanation: 1, census: { requests: 1, compared: 0 }, covered: false, confidence: { kind: 'none' } });
	});

	test('leaves a stratum uncovered while a route of it was attempted and never compared, counting its requests skipped by route', function() {
		const compared = Array.from({ length: 300 }, function(_, index) {
			return(apiDiff('2026-10-11T14:01:00.000Z', 'token', `/node/ledger/account/${ACCOUNT}/history/start/${index.toString(16).padStart(64, '0')}`, MATCHED));
		});
		const skipped: APIDiffRecord = { ...apiDiff('2026-10-11T14:02:00.000Z', 'token', `/node/ledger/account/${ACCOUNT}/pending`, { kind: 'skipped', reason: 'unanswered', detail: 'fetch failed' }), route: '/api/node/ledger/account/{account}/pending' };
		const stratum = report([...compared, skipped]).signals.apiDiff.strata.find(function(entry) {
			return(entry.stratum === 'token');
		});
		expect(stratum).toMatchObject({ requestsCompared: 300, skippedByRoute: { '/api/node/ledger/account/{account}/pending': { moving: 0, unanswered: 1 } }, routesUncovered: [{ route: '/api/node/ledger/account/{account}/pending', compared: 0, neverCompared: 1 }], covered: false });
	});

	test('counts a request whose latest comparison is the divergence a triage explains as never compared in its route\'s share', function() {
		const route = '/api/node/ledger/account/{account}/balance';
		const compared = Array.from({ length: 300 }, function(_, index): APIDiffRecord {
			return({ ...apiDiff('2026-10-11T14:01:00.000Z', 'token', `/node/ledger/account/${ACCOUNT}/history/start/${index.toString(16).padStart(64, '0')}`, MATCHED), route: '/api/node/ledger/account/{account}/history/start/{block}' });
		});
		const clean: APIDiffRecord = { ...apiDiff('2026-10-11T14:02:00.000Z', 'token', `/node/ledger/account/${ACCOUNT}/balance`, MATCHED), route };
		const divergence: APIDiffRecord = { ...apiDiff('2026-10-11T14:03:00.000Z', 'token', `/node/ledger/account/${OTHER_ACCOUNT}/balance`, DIVERGED_INFO), route };
		const explanation: APIDiffExplainedRecord = { kind: 'api-diff-explained', at: '2026-10-11T17:00:00.000Z', stratum: 'token', path: divergence.path, divergenceAt: divergence.at, divergence: 'our-bug', reference: 'fixed by 0000000', retest: { kind: 'retested' } };
		const token = report([...compared, clean, divergence, explanation]).signals.apiDiff.strata.find(function(entry) {
			return(entry.stratum === 'token');
		});
		expect(token).toMatchObject({ requestsCompared: 301, standingOnExplanation: 1, routesUncovered: [{ route, compared: 1, neverCompared: 1 }], covered: false });
	});

	test('leaves a stratum uncovered while more than a tenth of the requests of a route of it were never compared, listing the worst routes first', function() {
		const onRoute = function(route: APIDiffRecord['route'], compared: number, skipped: number): APIDiffRecord[] {
			return(Array.from({ length: compared + skipped }, function(_, index): APIDiffRecord {
				let outcome: APIDiffOutcome = MATCHED;
				if (index >= compared) {
					outcome = { kind: 'skipped', reason: 'moving', side: 'representative', detail: 'recent' };
				}
				return({ ...apiDiff('2026-10-11T14:01:00.000Z', 'token', `${route}/${String(index)}`, outcome), route });
			}));
		};
		const history = onRoute('/api/node/ledger/account/{account}/history/start/{block}', 300, 0);
		const tenth = onRoute('/api/node/ledger/account/{account}/pending', 9, 1);
		const fifth = onRoute('/api/node/ledger/account/{account}/balance', 8, 2);
		const most = onRoute('/api/node/ledger/block/{blockhash}/successor', 1, 3);
		const of = function(records: readonly APIDiffRecord[]) {
			return(report(records).signals.apiDiff.strata.find(function(entry) {
				return(entry.stratum === 'token');
			}));
		};

		expect(of([...history, ...tenth])).toMatchObject({ routesUncovered: [], covered: true });
		expect(of([...history, ...tenth, ...fifth, ...most])).toMatchObject({
			routesUncovered: [
				{ route: '/api/node/ledger/block/{blockhash}/successor', compared: 1, neverCompared: 3 },
				{ route: '/api/node/ledger/account/{account}/balance', compared: 8, neverCompared: 2 }
			],
			covered: false
		});
	});

	test('fails the API diff on an unresolved request, but counts one representative\'s own difference apart without failing', function() {
		const path = `/node/ledger/account/${ACCOUNT}`;
		const disputed = { field: 'body.info', follower: FOLLOWER_INFO, representative: REPRESENTATIVE_INFO, readings: [] };
		const local = report([apiDiff('2026-10-11T15:00:00.000Z', 'token', path, { kind: 'representative-local', ...disputed })]).signals.apiDiff;
		expect(local).toMatchObject({ verdict: 'pass', counts: { requestsCompared: 1, matched: 0, diverged: 0, representativeLocal: 1 }, representativeLocal: { [REPRESENTATIVE]: 1 } });
		const alsoApart = report([apiDiff('2026-10-11T15:00:00.000Z', 'token', path, { kind: 'representative-local', ...disputed, readings: [{ representative: OTHER_REPRESENTATIVE, kind: 'disagrees', answer: {} }] })]).signals.apiDiff;
		expect(alsoApart.representativeLocal).toEqual({ [REPRESENTATIVE]: 1, [OTHER_REPRESENTATIVE]: 1 });
		const unresolved = report([apiDiff('2026-10-11T15:00:00.000Z', 'token', path, { kind: 'unresolved', ...disputed })]).signals.apiDiff;
		expect(unresolved).toMatchObject({ verdict: 'fail', counts: { diverged: 1, unresolved: 1 }, firstDivergence: { path, field: 'body.info' } });
	});

	test('states a census of a stratum whose every planned request was compared, and covers a stratum by 300 requests or its census', function() {
		const census = [`/node/ledger/account/${ACCOUNT}`, `/node/ledger/account/${ACCOUNT}/head`];
		const plan: APIDiffPlanRecord = { kind: 'api-diff-plan', at: '2026-10-11T14:00:00.000Z', quietBefore: '2026-10-11T13:00:00.000Z', samplesPerStratum: 300, strata: [{ stratum: 'multisig', population: { kind: 'census', requests: census } }, { stratum: 'storage', population: { kind: 'census', requests: [`/node/ledger/account/${OTHER_ACCOUNT}`] } }] };
		const tokens = Array.from({ length: 300 }, function(_, index) {
			return(apiDiff('2026-10-11T14:01:00.000Z', 'token', `/node/ledger/account/${ACCOUNT}/history/start/${index.toString(16).padStart(64, '0')}`, MATCHED));
		});
		const sampled: APIDiffPlanRecord = { ...plan, at: '2026-10-11T16:00:00.000Z', strata: [{ stratum: 'token', population: { kind: 'sample', drawn: 300, whole: false } }, { stratum: 'operation:TOKEN_ADMIN_MODIFY_BALANCE', population: { kind: 'census', requests: [] } }] };
		const signal = report([plan, ...census.map(function(path) {
			return(apiDiff('2026-10-11T14:02:00.000Z', 'multisig', path, MATCHED));
		}), ...tokens, sampled]).signals.apiDiff;
		const of = function(stratum: Stratum) {
			return(signal.strata.find(function(entry) {
				return(entry.stratum === stratum);
			}));
		};
		expect(of('multisig')).toMatchObject({ requestsCompared: 2, census: { requests: 2, compared: 2, plannedAt: plan.at }, covered: true, confidence: { kind: 'census', requests: 2 } });
		expect(of('storage')).toMatchObject({ requestsCompared: 0, census: { requests: 1, compared: 0 }, covered: false });
		expect(of('token')).toMatchObject({ requestsCompared: 300, census: null, covered: true, confidence: { kind: 'rule-of-three', samples: 300, divergenceRateBelow: 0.01 } });
		expect(of('permissions')).toMatchObject({ census: null, covered: false });
		expect(of('operation:TOKEN_ADMIN_MODIFY_BALANCE')).toMatchObject({ census: { requests: 0, compared: 0 }, covered: true, confidence: { kind: 'empty-population' } });
		expect(signal).toMatchObject({ samplesTarget: 300, everyStratumCovered: false });
	});

	test('ends a census by a later plan drawing a sample of its stratum, whose population grew past it, so that only the done criterion covers the stratum', function() {
		const census = [`/node/ledger/account/${ACCOUNT}`];
		const plan: APIDiffPlanRecord = { kind: 'api-diff-plan', at: '2026-10-11T14:00:00.000Z', quietBefore: '2026-10-11T13:00:00.000Z', samplesPerStratum: 300, strata: [{ stratum: 'multisig', population: { kind: 'census', requests: census } }] };
		const sampled: APIDiffPlanRecord = { ...plan, at: '2026-10-12T14:00:00.000Z', strata: [{ stratum: 'multisig', population: { kind: 'sample', drawn: 300, whole: false } }] };
		const multisig = report([plan, apiDiff('2026-10-11T14:02:00.000Z', 'multisig', census[0] ?? '', MATCHED), sampled]).signals.apiDiff.strata.find(function(entry) {
			return(entry.stratum === 'multisig');
		});
		expect(multisig).toMatchObject({ requestsCompared: 1, census: null, covered: false, confidence: { kind: 'rule-of-three', samples: 1 } });
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
			counts: { accountsCompared: 2, matched: 2, diverged: 0, skippedMoving: 0, unanswered: 0 },
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

	test('counts the accounts the passive walk matched in batches among the samples, each batch of rows once', function() {
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, MATCH),
			batch('2026-10-09T01:00:01.000Z', 0, ['0', '20'], 10, [OTHER_ACCOUNT]),
			batch('2026-10-09T01:00:02.000Z', 0, ['0', '20'], 10),
			batch('2026-10-09T01:00:03.000Z', 0, ['20', '40'], 5)
		]).signals.sweep;
		expect(sweep).toMatchObject({ verdict: 'pass', confidence: { kind: 'rule-of-three', samples: 16 } });
	});

	test('reports each walk lap by lap against the accounts known', function() {
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, MATCH, 0),
			swept('2026-10-09T01:00:01.000Z', OTHER_ACCOUNT, MOVING, 0),
			swept('2026-10-09T01:00:02.000Z', OTHER_ACCOUNT, MATCH, 1),
			swept('2026-10-09T01:00:03.000Z', THIRD_ACCOUNT, diverged(THIRD_ACCOUNT, 'balances'), 0, 'passive'),
			batch('2026-10-09T01:00:04.000Z', 0, ['0', '20'], 4, [FOURTH_ACCOUNT]),
			batch('2026-10-09T01:00:05.000Z', 0, ['20', '40'], 3, [], null)
		], { chainAccounts: [chainAccount(ACCOUNT), chainAccount(OTHER_ACCOUNT)] }).signals.sweep;
		expect(sweep.coverage).toEqual({
			knownAccounts: 10,
			chainAccounts: 2,
			walks: {
				chain: { cursor: CURSORS.chain, laps: [{ lap: 0, complete: true, walked: 2, compared: 1, diverged: 0, skipped: 1, notCompared: 1 }, { lap: 1, complete: false, walked: 1, compared: 1, diverged: 0, skipped: 0, notCompared: 1 }] },
				passive: { cursor: CURSORS.passive, laps: [{ lap: 0, complete: false, walked: 7, compared: 6, diverged: 1, skipped: 1, notCompared: 1 }] }
			},
			neverCompared: 1,
			neverComparedChain: 0,
			firstNeverCompared: [FOURTH_ACCOUNT],
			everyAccountCompared: false
		});
	});

	test('says every account was compared once both walks completed a lap and each account skipped was compared since', function() {
		const records = [
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, MOVING, 0),
			swept('2026-10-09T01:00:01.000Z', ACCOUNT, MATCH, 1),
			batch('2026-10-09T01:00:02.000Z', 0, ['0', '20'], 4, [OTHER_ACCOUNT, THIRD_ACCOUNT], 'answered 504'),
			batch('2026-10-09T01:00:03.000Z', 1, ['0', '15'], 3, [THIRD_ACCOUNT]),
			batch('2026-10-09T01:00:04.000Z', 1, ['15', '30'], 3)
		];
		const cursors = { chain: { lap: 2, afterRowID: '0' }, passive: { lap: 2, afterRowID: '0' } };
		const rowIDs = new Map([[OTHER_ACCOUNT, '12'], [THIRD_ACCOUNT, '18']]);
		const chainAccounts = [chainAccount(ACCOUNT)];
		expect(report(records, { cursors, rowIDs, chainAccounts }).signals.sweep.coverage).toMatchObject({ neverCompared: 0, firstNeverCompared: [], everyAccountCompared: true });
		expect(report(records, { cursors, chainAccounts, rowIDs: new Map([[OTHER_ACCOUNT, '12'], [THIRD_ACCOUNT, '14']]) }).signals.sweep.coverage).toMatchObject({ neverCompared: 1, firstNeverCompared: [THIRD_ACCOUNT], everyAccountCompared: false });
		expect(report(records, { cursors: { ...cursors, passive: { lap: 0, afterRowID: '20' } }, rowIDs }).signals.sweep.coverage).toMatchObject({ neverCompared: 0, everyAccountCompared: false });
	});

	test('clears a chain account skipped on every attempt only by a comparison by itself, not by a passive batch over its row', function() {
		const records = [
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, MOVING, 0),
			batch('2026-10-09T01:00:01.000Z', 0, ['0', '20'], 4)
		];
		const cursors = { chain: { lap: 1, afterRowID: '0' }, passive: { lap: 1, afterRowID: '0' } };
		expect(report(records, { cursors, chainAccounts: [chainAccount(ACCOUNT)], rowIDs: new Map([[ACCOUNT, '5']]) }).signals.sweep.coverage).toMatchObject({ neverCompared: 1, neverComparedChain: 1, firstNeverCompared: [ACCOUNT], everyAccountCompared: false });
	});

	test('counts a chain account the chain walk never compared, though a passive batch matched it before it gained its chain', function() {
		const records = [
			swept('2026-10-09T01:00:00.000Z', OTHER_ACCOUNT, MATCH, 0),
			batch('2026-10-09T01:00:01.000Z', 0, ['0', '20'], 4)
		];
		const cursors = { chain: { lap: 1, afterRowID: '0' }, passive: { lap: 1, afterRowID: '0' } };
		const position = { cursors, rowIDs: new Map([[ACCOUNT, '5']]) };
		expect(report(records, { ...position, chainAccounts: [chainAccount(OTHER_ACCOUNT), chainAccount(ACCOUNT)] }).signals.sweep.coverage).toMatchObject({ neverCompared: 1, neverComparedChain: 1, everyAccountCompared: false });
		// One whose newest staple is from after the lap's last comparison may have gained its chain since, and waits for the next lap.
		expect(report(records, { ...position, chainAccounts: [chainAccount(OTHER_ACCOUNT), chainAccount(ACCOUNT, new Date('2026-10-09T02:00:00.000Z'))] }).signals.sweep.coverage).toMatchObject({ neverCompared: 0, everyAccountCompared: true });
	});

	test('does not excuse a chain account the last complete lap attempted, however recently the follower holds a staple of it', function() {
		const records = [
			swept('2026-10-09T01:00:00.000Z', OTHER_ACCOUNT, MATCH, 0),
			swept('2026-10-09T01:00:01.000Z', ACCOUNT, UNANSWERED, 0)
		];
		const cursors = { chain: { lap: 1, afterRowID: '0' }, passive: { lap: 1, afterRowID: '0' } };
		const sweep = report(records, { cursors, chainAccounts: [chainAccount(OTHER_ACCOUNT), chainAccount(ACCOUNT, new Date('2026-10-09T02:00:00.000Z'))] }).signals.sweep;
		expect(sweep.coverage).toMatchObject({ neverCompared: 1, neverComparedChain: 1, everyAccountCompared: false });
		expect(sweep.coverage.walks.chain.laps[0]).toMatchObject({ lap: 0, complete: true, notCompared: 1 });
	});

	test('counts a chain account compared by its chain apart from the state matches, and not among the samples', function() {
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', OTHER_ACCOUNT, MATCH),
			swept('2026-10-09T01:00:01.000Z', ACCOUNT, { kind: 'compared-chain', head: STAPLE, representativeHead: STAPLE, lacking: 2 })
		], { chainAccounts: [chainAccount(ACCOUNT), chainAccount(OTHER_ACCOUNT)] }).signals.sweep;
		expect(sweep).toMatchObject({ verdict: 'pass', counts: { accountsCompared: 2, matched: 1, comparedByChain: 1 }, coverage: { neverCompared: 0 }, confidence: { samples: 1 } });
	});

	test('counts the passive walk\'s batch matches of one lap only among the samples, however the spans fall in each', function() {
		const sweep = report([
			batch('2026-10-09T01:00:00.000Z', 0, ['0', '20'], 10),
			batch('2026-10-09T01:00:01.000Z', 1, ['0', '25'], 12)
		]).signals.sweep;
		expect(sweep.confidence).toMatchObject({ kind: 'rule-of-three', samples: 12 });
	});

	test('counts accounts both answered with an error, and those an unanswered batch named, as not compared', function() {
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, { kind: 'error-both', error: 'Error: x' }, 0, 'passive'),
			batch('2026-10-09T01:00:01.000Z', 0, ['0', '20'], 2, [ACCOUNT]),
			batch('2026-10-09T01:00:02.000Z', 0, ['20', '40'], 1, [OTHER_ACCOUNT], 'answered 504')
		], { rowIDs: new Map([[ACCOUNT, '5'], [OTHER_ACCOUNT, '25']]) }).signals.sweep;
		expect(sweep.counts).toMatchObject({ accountsCompared: 0, errorBoth: 1, unanswered: 1 });
		expect(sweep.coverage).toMatchObject({ neverCompared: 2 });
	});

	test('lists the accounts the log names as not compared, whose rows the report reads', function() {
		expect(neverComparedCandidatesOf([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, MOVING),
			swept('2026-10-09T01:00:01.000Z', ACCOUNT, MATCH),
			swept('2026-10-09T01:00:02.000Z', OTHER_ACCOUNT, UNANSWERED),
			batch('2026-10-09T01:00:03.000Z', 0, ['0', '20'], 4, [THIRD_ACCOUNT])
		])).toEqual([OTHER_ACCOUNT, THIRD_ACCOUNT]);
	});

	test('shows the differences of one representative\'s own apart, and passes the sweep on them', function() {
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, MATCH),
			{ ...swept('2026-10-09T01:00:01.000Z', OTHER_ACCOUNT, diverged(OTHER_ACCOUNT, 'balances[0].balance')), representative: OTHER_REPRESENTATIVE },
			{ ...swept('2026-10-09T01:00:02.000Z', OTHER_ACCOUNT, diverged(OTHER_ACCOUNT, 'balances[0].balance', 'representative-local')), representative: OTHER_REPRESENTATIVE },
			{ ...swept('2026-10-09T01:00:03.000Z', THIRD_ACCOUNT, diverged(THIRD_ACCOUNT, 'balances[1].balance', 'representative-local')), representative: OTHER_REPRESENTATIVE }
		]).signals.sweep;
		expect(sweep).toMatchObject({
			verdict: 'pass',
			counts: { accountsCompared: 3, matched: 1, diverged: 0, resolvedDivergences: 1 },
			representativeLocal: { records: 2, accounts: 2, byRepresentative: { [OTHER_REPRESENTATIVE]: 2 }, first: { account: OTHER_ACCOUNT, field: 'balances[0].balance', representative: OTHER_REPRESENTATIVE, at: '2026-10-09T01:00:02.000Z' } },
			confidence: { kind: 'rule-of-three', samples: 3 }
		});
	});

	test('counts a difference of each representative\'s own against every one that answered apart', function() {
		const THIRD_REPRESENTATIVE = 'https://rep3.example/api';
		const local: SweepOutcome = {
			kind: 'representative-local',
			divergence: { account: ACCOUNT, field: 'balances[0].balance', staple: STAPLE },
			follower: {},
			representative: {},
			readings: [{ representative: OTHER_REPRESENTATIVE, kind: 'agrees', state: {}, staple: STAPLE }, { representative: THIRD_REPRESENTATIVE, kind: 'disagrees', state: {}, staple: STAPLE }],
			selfCheck: { kind: 'consistent', tokens: 1 }
		};
		const sweep = report([swept('2026-10-09T01:00:00.000Z', ACCOUNT, local)]).signals.sweep;
		expect(sweep.representativeLocal).toMatchObject({ records: 1, accounts: 1, byRepresentative: { [REPRESENTATIVE]: 1, [THIRD_REPRESENTATIVE]: 1 } });
	});

	test('names the accounts a lap never compared, by walk, which a later comparison of each by itself covers', function() {
		const position: SweepPosition = { knownAccounts: 3, chainAccounts: [chainAccount(ACCOUNT)], cursors: { chain: { lap: 1, afterRowID: '0' }, passive: { lap: 1, afterRowID: '0' } }, rowIDs: new Map([[OTHER_ACCOUNT, '5']]) };
		const missed = [batch('2026-10-09T01:00:00.000Z', 0, ['0', '20'], 4, [OTHER_ACCOUNT])];
		expect(neverComparedAccountsOf(missed, position)).toEqual({ chain: [chainAccount(ACCOUNT)], passive: [OTHER_ACCOUNT] });
		expect(neverComparedAccountsOf([...missed, swept('2026-10-09T02:00:00.000Z', ACCOUNT, MATCH, 0, 'chain'), swept('2026-10-09T02:00:01.000Z', OTHER_ACCOUNT, MATCH, 0, 'passive')], position)).toEqual({ chain: [], passive: [] });
	});

	test('counts a difference left to the representatives apart as unresolved until a check of the follower\'s balances bears it out', function() {
		const local = function(selfCheck: SelfCheck | null): SweepOutcome {
			return({ kind: 'representative-local', divergence: { account: ACCOUNT, field: 'balances[0].balance', staple: STAPLE }, follower: {}, representative: {}, readings: [], selfCheck });
		};
		for (const selfCheck of [null, { kind: 'unchecked', why: 'the follower failed' } as const]) {
			expect(report([swept('2026-10-09T01:00:00.000Z', ACCOUNT, local(selfCheck))]).signals.sweep).toMatchObject({ verdict: 'fail', counts: { diverged: 1, unresolved: 1 }, representativeLocal: { accounts: 0 }, firstDivergence: { account: ACCOUNT } });
		}
		expect(report([swept('2026-10-09T01:00:00.000Z', ACCOUNT, local({ kind: 'consistent', tokens: 1 }))]).signals.sweep).toMatchObject({ verdict: 'pass', counts: { diverged: 0 }, representativeLocal: { accounts: 1 } });
	});

	test('keeps a divergence of an account\'s state standing over a later comparison of its chain alone, which reads neither its state nor its history', function() {
		const chained: SweepOutcome = { kind: 'compared-chain', head: STAPLE, representativeHead: STAPLE, lacking: 0 };
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, diverged(ACCOUNT, 'balances[0].balance')),
			swept('2026-10-09T02:00:00.000Z', ACCOUNT, chained, 1),
			swept('2026-10-09T02:00:01.000Z', OTHER_ACCOUNT, MATCH, 1)
		]).signals.sweep;
		expect(sweep).toMatchObject({ verdict: 'fail', counts: { diverged: 1, resolvedDivergences: 0 }, firstDivergence: { account: ACCOUNT } });
		const byChain = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, diverged(ACCOUNT, 'chain')),
			swept('2026-10-09T02:00:00.000Z', ACCOUNT, chained, 1)
		]).signals.sweep;
		expect(byChain.counts).toMatchObject({ diverged: 0, resolvedDivergences: 1 });
	});

	test('fails the sweep on an account the representatives split on', function() {
		const sweep = report([
			swept('2026-10-09T01:00:00.000Z', ACCOUNT, diverged(ACCOUNT, 'balances[0].balance', 'unresolved'))
		]).signals.sweep;
		expect(sweep).toMatchObject({ verdict: 'fail', counts: { diverged: 1, unresolved: 1 }, representativeLocal: { records: 0, first: null }, firstDivergence: { account: ACCOUNT } });
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
		const passiveState = { account: OTHER_ACCOUNT, balances: [], currentHeadBlock: null, currentHeadBlockHeight: null, info: {}, representative: null };
		for (const api of [follower, representative]) {
			api.serve(`/node/ledger/accounts/${OTHER_ACCOUNT}`, [passiveState]);
		}
		const known: KnownAccount[] = [{ rowID: '1', account: ACCOUNT, newestStaple: new Date('2025-06-01T00:00:00.000Z') }];
		const passive: KnownAccount[] = [{ rowID: '2', account: OTHER_ACCOUNT, newestStaple: new Date('2025-06-01T00:00:00.000Z') }];
		const after = function(accounts: readonly KnownAccount[], rowID: string) {
			return(Promise.resolve(accounts.filter(function(entry) {
				return(BigInt(entry.rowID) > BigInt(rowID));
			})));
		};
		const store: FollowerStore = {
			progress: () => Promise.resolve(PROGRESS),
			chainAccountsAfter: (rowID) => after(known, rowID),
			passiveAccountsAfter: (rowID) => after(passive, rowID),
			accountCount: () => Promise.resolve(2),
			chainAccounts: () => Promise.resolve(known),
			rowIDsOf: () => Promise.resolve(new Map()),
			historyHolds: () => Promise.resolve(false),
			holdsBlock: () => Promise.resolve(false),
			balancesSnapshot: () => Promise.resolve({ stored: new Map(), head: null, fromHistory: new Map(), during: null }),
			checksumSnapshot: () => Promise.resolve({ stored: 0n, folded: 0n, mainBlocks: 0, mismatched: [] }),
			quietAccounts: () => Promise.resolve([]),
			lastSequence: () => Promise.resolve(0n),
			stapleAt: () => Promise.resolve(undefined),
			staplesAfter: () => Promise.resolve([]),
			staplesOf: () => Promise.resolve([]),
			heldBlocks: () => Promise.resolve([]),
			blockPages: () => Promise.resolve(0),
			heldBlocksInPages: () => Promise.resolve([]),
			heldBlocksOfStaples: () => Promise.resolve([]),
			newestStaples: () => Promise.resolve(new Map()),
			close: () => Promise.resolve()
		};

		const result = await runParity({
			follower: httpSource(follower.endpoint),
			representatives: [httpSource(representative.endpoint)],
			store,
			log,
			cursorPaths: sweepCursorPaths(directory),
			sampleAccounts: 1,
			passiveSampleAccounts: 1,
			apiDiff: { samplesPerStratum: 1, seed: 'test', edgeCaseStaples: [], knownBehaviors: new Set() },
			gapMilliseconds: 10_000,
			wait: () => Promise.resolve(),
			stopped: new AbortController().signal
		});

		expect(result.signals.checksum).toMatchObject({ verdict: 'not-comparable-yet', crossCheck: { verdict: 'pass', runs: 1 }, blockCount: { counts: { comparisons: 1 }, notComparableReasons: ['no-completed-pass'] } });
		expect(result.signals.sweep).toMatchObject({
			verdict: 'pass',
			counts: { accountsCompared: 2, matched: 2 },
			coverage: { knownAccounts: 2, chainAccounts: 1, walks: { chain: { cursor: { lap: 0, afterRowID: '1' } }, passive: { cursor: { lap: 0, afterRowID: '2' }, laps: [{ lap: 0, walked: 1, compared: 1 }] } } }
		});
		expect(result.signals.apiDiff).toMatchObject({ verdict: 'not-comparable-yet', counts: { requestsCompared: 0 } });
		const kinds = (await log.read()).records.map(function(record) {
			return(record.kind);
		});
		// The two walks run side by side, so their records interleave in no fixed order.
		expect(kinds.slice(0, 4)).toEqual(['sweep', 'cross-check', 'checksum', 'block-count']);
		expect(kinds.slice(4).filter(function(kind): boolean {
			return(kind === 'sweep' || kind === 'sweep-batch');
		}).sort()).toEqual(['sweep', 'sweep-batch']);
	});
});
