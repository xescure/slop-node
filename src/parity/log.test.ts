import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ParityLog, parityLogPath } from './log.js';
import type { BlockCountRecord, ChecksumRecord, CrossCheckRecord, ParityRecord, ShadowRunRecord, SweepRecord } from './log.js';

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

const SWEEPS: readonly SweepRecord[] = [
	{ kind: 'sweep', at: CHECKSUM.at, representative: REPRESENTATIVE, account: ACCOUNT, lap: 0, outcome: { kind: 'match', head: 'CD'.repeat(32), staple: null } },
	{ kind: 'sweep', at: CHECKSUM.at, representative: REPRESENTATIVE, account: ACCOUNT, lap: 0, outcome: { kind: 'diverged', divergence: { account: ACCOUNT, field: 'representative', staple: null }, follower: { representative: null }, representative: { representative: ACCOUNT } } },
	{ kind: 'sweep', at: CHECKSUM.at, representative: REPRESENTATIVE, account: ACCOUNT, lap: 1, outcome: { kind: 'skipped', reason: 'moving', side: 'follower', detail: 'its state changed' } },
	{ kind: 'sweep', at: CHECKSUM.at, representative: REPRESENTATIVE, account: ACCOUNT, lap: 1, outcome: { kind: 'skipped', reason: 'unanswered', detail: '500' } }
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
	refusedForWeight: 2,
	unapplied: [{ sequence: '4499', blocksHash: 'EF'.repeat(32), why: 'voting-weight' }],
	complete: false,
	cost: { seconds: 61.5, staples: 4500, shadowVotes: 450, maxResidentMiB: 812 }
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
		const records: readonly ParityRecord[] = [CHECKSUM, ...SWEEPS, FAILED_CHECKSUM, ...CROSS_CHECKS, BLOCK_COUNT, SHADOW_RUN];
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

	test('counts a line cut short, or one it does not know, apart from the records', async function() {
		const log = await scratchLog();
		await log.append([CHECKSUM]);
		await appendFile(log.path, `${JSON.stringify({ ...CHECKSUM, kind: 'other' })}\n${JSON.stringify(FAILED_CHECKSUM).slice(0, 40)}`);

		expect(await log.read()).toEqual({ records: [CHECKSUM], unreadableLines: 2 });
	});
});
