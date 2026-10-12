import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ParityLog, parityLogPath } from './log.js';
import type { APIDiffExplainedRecord, APIDiffPlanRecord, APIDiffRecord, BlockCountRecord, ChecksumRecord, CrossCheckRecord, ParityRecord, ShadowRunRecord, SweepBatchRecord, SweepRecord } from './log.js';

const REPRESENTATIVE = 'https://rep1.example/api';
const ACCOUNT = 'keeta_aabiko2lb4klv75vi72jxkgaotfravn7p4clfko4lcw7vywrzfznrvemqxb5iai';

const CHECKSUM: ChecksumRecord = {
	kind: 'checksum',
	at: '2026-10-09T06:00:00.000Z',
	representative: REPRESENTATIVE,
	gapMilliseconds: 10_000,
	completedPass: null,
	follower: { kind: 'read', first: { checksum: '0xAB', blockCount: 7 }, second: { checksum: '0xAB', blockCount: 7 } },
	representativeWindow: { kind: 'unanswered', error: 'refused' },
	verdict: { kind: 'not-comparable-yet', reasons: ['no-completed-pass', 'representative-unanswered'] }
};

const FAILED_CHECKSUM: ChecksumRecord = {
	...CHECKSUM,
	completedPass: '2026-10-09T05:00:00.000Z',
	verdict: {
		kind: 'fail',
		bisect: {
			followerBlockCount: 7,
			representativeBlockCount: 8,
			sweep: { cursor: { lap: 0, afterRowID: '41' }, firstDivergence: { account: ACCOUNT, field: 'balances[0].balance', staple: 'AB'.repeat(32) } }
		}
	}
};

const MATCHED: SweepRecord = { kind: 'sweep', at: CHECKSUM.at, representative: REPRESENTATIVE, account: ACCOUNT, lap: 0, walk: 'chain', outcome: { kind: 'match', head: 'CD'.repeat(32), staple: null } };

const SWEEPS: readonly SweepRecord[] = [
	MATCHED,
	{ ...MATCHED, outcome: { kind: 'compared-chain', head: 'CD'.repeat(32), representativeHead: 'EF'.repeat(32), lacking: 3 } },
	{ ...MATCHED, walk: 'passive', outcome: { kind: 'error-both', error: 'Error: Unable to parse account information' } },
	{ kind: 'sweep', at: CHECKSUM.at, representative: REPRESENTATIVE, account: ACCOUNT, lap: 0, walk: 'passive', outcome: { kind: 'diverged', divergence: { account: ACCOUNT, field: 'representative', staple: null }, follower: { representative: null }, representative: { representative: ACCOUNT }, readings: [], selfCheck: null } },
	{ kind: 'sweep', at: CHECKSUM.at, representative: REPRESENTATIVE, account: ACCOUNT, lap: 0, walk: 'chain', outcome: { kind: 'representative-local', divergence: { account: ACCOUNT, field: 'balances[0].balance', staple: 'AB'.repeat(32) }, follower: { balances: [] }, representative: { balances: [1] }, readings: [{ representative: 'https://rep2.example/api', kind: 'agrees', state: { balances: [] }, staple: 'AB'.repeat(32) }, { representative: 'https://rep3.example/api', kind: 'unanswered', detail: 'answered 504' }], selfCheck: { kind: 'consistent', tokens: 1 } } },
	{ kind: 'sweep', at: CHECKSUM.at, representative: REPRESENTATIVE, account: ACCOUNT, lap: 0, walk: 'chain', outcome: { kind: 'unresolved', divergence: { account: ACCOUNT, field: 'balances[0].balance', staple: null }, follower: { balances: [] }, representative: { balances: [1] }, readings: [{ representative: 'https://rep2.example/api', kind: 'disagrees', state: { balances: [2] }, staple: null }], selfCheck: { kind: 'inconsistent', token: 'keeta_t', served: '0x1', fromHistory: '0x2' } } },
	{ kind: 'sweep', at: CHECKSUM.at, representative: REPRESENTATIVE, account: ACCOUNT, lap: 1, walk: 'chain', outcome: { kind: 'skipped', reason: 'moving', side: 'follower', detail: 'its state changed' } },
	{ kind: 'sweep', at: CHECKSUM.at, representative: REPRESENTATIVE, account: ACCOUNT, lap: 1, walk: 'passive', outcome: { kind: 'skipped', reason: 'unanswered', detail: '500' } }
];

const SWEEP_BATCHES: readonly SweepBatchRecord[] = [
	{ kind: 'sweep-batch', at: CHECKSUM.at, representative: REPRESENTATIVE, lap: 0, afterRowID: '0', throughRowID: '230', accounts: 100, matched: 98, skipped: [ACCOUNT], unanswered: null },
	{ kind: 'sweep-batch', at: CHECKSUM.at, representative: REPRESENTATIVE, lap: 0, afterRowID: '230', throughRowID: '231', accounts: 1, matched: 0, skipped: [ACCOUNT], unanswered: 'answered 504' }
];

const CROSS_CHECKS: readonly CrossCheckRecord[] = [
	{ kind: 'cross-check', at: CHECKSUM.at, stored: '0x1', folded: '0x3', mainBlocks: 4, outcome: { kind: 'differs', offset: '0x2', staples: [{ sequence: '9', blocksHash: 'AB'.repeat(32), stored: '0x5', fold: '0x7' }] } },
	{ kind: 'cross-check', at: CHECKSUM.at, stored: '0x1', folded: '0x3', mainBlocks: 4, outcome: { kind: 'lost-run', firstSequence: '1', lastSequence: '18', staples: 18, firstMoment: CHECKSUM.at, lastMoment: CHECKSUM.at } }
];

const BLOCK_COUNT: BlockCountRecord = {
	kind: 'block-count',
	at: CHECKSUM.at,
	representative: REPRESENTATIVE,
	completedPass: '2026-10-09T05:00:00.000Z',
	staged: 339_533,
	follower: { kind: 'read', first: { checksum: '0xAB', blockCount: 207_002 }, second: { checksum: '0xAB', blockCount: 207_002 } },
	representativeWindow: { kind: 'read', first: { checksum: '0xCD', blockCount: 935_782 }, second: { checksum: '0xCD', blockCount: 935_782 } },
	toleranceBlocks: 120,
	verdict: { kind: 'not-comparable-yet', reasons: ['stage-not-empty'] }
};

const SHADOW_RUN: ShadowRunRecord = {
	kind: 'shadow-run',
	at: CHECKSUM.at,
	scope: { release: '0.18.4', from: '2026-07-24T20:33:26.082Z' },
	informationalEvery: 10,
	base: { database: null, sequence: '0', blocksHash: null, scopedStaples: 0 },
	target: { sequence: '90000', fixedAt: CHECKSUM.at, followerCaughtUp: false, heldBefore: null },
	reached: { sequence: '4500', blocksHash: 'AB'.repeat(32) },
	scoped: { replayed: 0, shadowVoted: 0, voted: 0, explained: {}, unexplained: 0, firstUnexplained: [], votedFrom: null, votedTo: null },
	informational: {
		replayed: 4500,
		shadowVoted: 450,
		voted: 440,
		explained: { 'self-requirement-return': 9, 'trusted-account-genesis': 1 },
		unexplained: 0,
		firstUnexplained: [{ blocksHash: 'CD'.repeat(32), code: 'LEDGER_INVALID_PERMISSIONS', message: 'no access', why: '0 reasons explain the refusal' }],
		votedFrom: '2025-09-23T00:00:00.000Z',
		votedTo: '2025-10-01T00:00:00.000Z'
	},
	unapplied: [{ sequence: '4499', blocksHash: 'EF'.repeat(32), why: 'voting-weight' }],
	complete: false,
	cost: { seconds: 61.5, staples: 4500, shadowVotes: 450, maxResidentMiB: 812 }
};

const API_DIFF: APIDiffRecord = { kind: 'api-diff', at: CHECKSUM.at, representative: REPRESENTATIVE, stratum: 'token', route: '/api/node/ledger/account/{account}', path: `/node/ledger/account/${ACCOUNT}`, behaviors: ['account=TOKEN'], outcome: { kind: 'match', digest: 'AB'.repeat(32) } };

const API_DIFFS: readonly APIDiffRecord[] = [
	API_DIFF,
	{ ...API_DIFF, outcome: { kind: 'representative-local', field: 'body.balances[0].balance', follower: { status: 200, body: {} }, representative: { status: 200, body: { balances: [1] } }, readings: [{ representative: 'https://rep2.example/api', kind: 'agrees', answer: { status: 200, body: {} } }, { representative: 'https://rep3.example/api', kind: 'moving', detail: 'recent' }] } },
	{ ...API_DIFF, outcome: { kind: 'unresolved', field: 'status', follower: { status: 200, body: {} }, representative: { status: 500, body: {} }, readings: [{ representative: 'https://rep2.example/api', kind: 'disagrees', answer: { status: 500, body: {} } }, { representative: 'https://rep3.example/api', kind: 'unanswered', detail: 'answered 504' }] } },
	{ ...API_DIFF, outcome: { kind: 'skipped', reason: 'moving', side: 'representative', detail: 'recent' } }
];

const API_DIFF_PLAN: APIDiffPlanRecord = {
	kind: 'api-diff-plan',
	at: CHECKSUM.at,
	quietBefore: '2026-10-09T05:00:00.000Z',
	samplesPerStratum: 300,
	strata: [
		{ stratum: 'multisig', population: { kind: 'census', requests: [`/node/ledger/account/${ACCOUNT}`] } },
		{ stratum: 'token', population: { kind: 'sample', drawn: 3600, whole: false } },
		{ stratum: 'operation:SEND', population: { kind: 'sample', drawn: 1500, whole: true } }
	]
};

const API_DIFF_EXPLAINED: APIDiffExplainedRecord = {
	kind: 'api-diff-explained',
	at: CHECKSUM.at,
	stratum: 'token',
	path: `/node/ledger/account/${ACCOUNT}`,
	divergenceAt: '2026-10-09T08:40:27.413Z',
	divergence: 'our-bug',
	reference: 'fixed by e27cc4e, with the history reindexed by 8ccbb10 (schema/CONTRACT.md, D18)',
	retest: { kind: 'forced', why: 'the follower and every representative refuse the page now' }
};

const directories: string[] = [];

async function scratchLog(): Promise<ParityLog> {
	const directory = await mkdtemp(join(tmpdir(), 'slop-parity-log-'));
	directories.push(directory);
	return(new ParityLog(parityLogPath(directory)));
}

afterEach(async function() {
	await Promise.all(directories.splice(0).map(function(directory) {
		return(rm(directory, { recursive: true, force: true }));
	}));
});

describe('the parity log', function() {
	test('holds no record before one is appended', async function() {
		expect(await (await scratchLog()).read()).toEqual({ records: [], unreadableLines: 0 });
	});

	test('reads back every kind of record it was given, in order', async function() {
		const log = await scratchLog();
		const records: readonly ParityRecord[] = [CHECKSUM, ...SWEEPS, ...SWEEP_BATCHES, FAILED_CHECKSUM, ...CROSS_CHECKS, BLOCK_COUNT, SHADOW_RUN, ...API_DIFFS, API_DIFF_PLAN, API_DIFF_EXPLAINED];
		await log.append(records.slice(0, 2));
		await log.append(records.slice(2));

		expect(await log.read()).toEqual({ records, unreadableLines: 0 });
	});

	test('reads a block count recorded before the stage was read as one that names no staged staples', async function() {
		const log = await scratchLog();
		const { staged, ...older } = BLOCK_COUNT;
		expect(staged).toBe(339_533);
		await appendFile(log.path, `${JSON.stringify({ ...older, verdict: { kind: 'fail', difference: -728_780 } })}\n`);

		expect(await log.read()).toEqual({ records: [{ ...older, staged: null, verdict: { kind: 'fail', difference: -728_780 } }], unreadableLines: 0 });
	});

	test('reads a sweep record written before the walks were split as one of the walk over every account', async function() {
		const log = await scratchLog();
		const { walk, ...older } = MATCHED;
		expect(walk).toBe('chain');
		await appendFile(log.path, `${JSON.stringify(older)}\n`);

		expect(await log.read()).toEqual({ records: [{ ...older, walk: 'every' }], unreadableLines: 0 });
	});

	test('reads a divergence recorded before divergences were read again as one with no other representative\'s reading', async function() {
		const log = await scratchLog();
		const outcome = { kind: 'diverged', divergence: { account: ACCOUNT, field: 'history', staple: null }, follower: {}, representative: {} };
		await appendFile(log.path, `${JSON.stringify({ ...MATCHED, outcome })}\n`);

		expect(await log.read()).toEqual({ records: [{ ...MATCHED, outcome: { ...outcome, readings: [], selfCheck: null } }], unreadableLines: 0 });
	});

	test('reads an API divergence recorded before divergences were sent again as one with no other representative\'s reading', async function() {
		const log = await scratchLog();
		const outcome = { kind: 'diverged', field: 'body.error', follower: { status: 200, body: {} }, representative: { status: 500, body: { error: true } } };
		await appendFile(log.path, `${JSON.stringify({ ...API_DIFF, outcome })}\n`);

		expect(await log.read()).toEqual({ records: [{ ...API_DIFF, outcome: { ...outcome, readings: [] } }], unreadableLines: 0 });
	});

	test('reads an API match recorded before matches kept a digest as one with none', async function() {
		const log = await scratchLog();
		await appendFile(log.path, `${JSON.stringify({ ...API_DIFF, outcome: { kind: 'match' } })}\n`);

		expect(await log.read()).toEqual({ records: [{ ...API_DIFF, outcome: { kind: 'match', digest: null } }], unreadableLines: 0 });
	});

	test('reads a shadow run recorded with a count of staples refused for want of voting weight, which no build counts any more, as one without it', async function() {
		const log = await scratchLog();
		await appendFile(log.path, `${JSON.stringify({ ...SHADOW_RUN, refusedForWeight: 2 })}\n`);

		expect(await log.read()).toEqual({ records: [SHADOW_RUN], unreadableLines: 0 });
	});

	test('reads a triage recorded before triages were checked for a retest as one whose retest is unrecorded, which no reason given to a forced triage can read as', async function() {
		const log = await scratchLog();
		const { retest, ...older } = API_DIFF_EXPLAINED;
		expect(retest.kind).toBe('forced');
		await appendFile(log.path, `${JSON.stringify(older)}\n${JSON.stringify({ ...older, retest: { kind: 'forced', why: 'unrecorded' } })}\n`);

		expect(await log.read()).toEqual({ records: [{ ...older, retest: { kind: 'unrecorded' } }, { ...older, retest: { kind: 'forced', why: 'unrecorded' } }], unreadableLines: 0 });
	});

	test('starts a record on a line of its own after a line a crash cut short', async function() {
		const log = await scratchLog();
		await appendFile(log.path, JSON.stringify(CHECKSUM).slice(0, 40));
		await log.append([FAILED_CHECKSUM]);

		expect(await log.read()).toEqual({ records: [FAILED_CHECKSUM], unreadableLines: 1 });
	});

	test('counts a line cut short, or one it does not know, apart from the records', async function() {
		const log = await scratchLog();
		await log.append([CHECKSUM]);
		await appendFile(log.path, `${JSON.stringify({ ...CHECKSUM, kind: 'other' })}\n${JSON.stringify(FAILED_CHECKSUM).slice(0, 40)}`);

		expect(await log.read()).toEqual({ records: [CHECKSUM], unreadableLines: 2 });
	});
});
