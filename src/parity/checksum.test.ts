import { describe, expect, test } from 'vitest';
import { startFakeAPI } from '../testing/fake-api.js';
import type { FakeAPI } from '../testing/fake-api.js';
import { httpSource } from './api-source.js';
import { BLOCK_COUNT_FLOOR, checksumsEqual, compareChecksums, crossCheckChecksum, crossCheckOutcomeOf } from './checksum.js';
import type { ChecksumSnapshot, FollowerProgress, MismatchedStaple } from './follower-store.js';
import type { SweepPointer } from './log.js';

const GAP = 10_000;

const COMPLETED: FollowerProgress = { completedPass: new Date('2026-10-09T05:00:00.000Z'), heldBefore: new Date('2026-10-09T05:00:00.000Z') };

const CATCHING_UP: FollowerProgress = { completedPass: undefined, heldBefore: new Date('2025-12-31T00:00:00.000Z') };

const POINTER: SweepPointer = { cursor: { lap: 0, afterRowID: '12' }, firstDivergence: null };

function checksum(value: string): unknown {
	return({ moment: '2026-10-09T06:00:00.000Z', momentRange: 1, checksum: value });
}

function stats(blockCount: number): unknown {
	return({ ledger: { blockCount, moment: '2026-10-09T06:00:00.000Z', momentRange: 1, representativeCount: 4, transactionCount: 1, db: { retries: 0 } }, switch: {} });
}

/** A node serving these checksums and block counts, the first reading then every later one. */
function serveReadings(api: FakeAPI, readings: readonly (readonly [string, number])[]): void {
	api.serve('/node/ledger/checksum', ...readings.map(function([value]) {
		return(checksum(value));
	}));
	api.serve('/node/stats', ...readings.map(function([, blockCount]) {
		return(stats(blockCount));
	}));
}

type Setup = {
	readonly follower: FakeAPI;
	readonly representatives: readonly FakeAPI[];
	readonly waits: number[];
};

async function setup(representativeCount: number): Promise<Setup> {
	const follower = await startFakeAPI();
	const representatives: FakeAPI[] = [];
	for (let index = 0; index < representativeCount; index++) {
		representatives.push(await startFakeAPI());
	}
	return({ follower, representatives, waits: [] });
}

async function compare(running: Setup, progress: FollowerProgress) {
	return((await compareAll(running, progress)).checksums);
}

async function compareAll(running: Setup, progress: FollowerProgress) {
	return(await compareChecksums({
		follower: httpSource(running.follower.endpoint),
		representatives: running.representatives.map(function(api) {
			return(httpSource(api.endpoint));
		}),
		progress,
		gapMilliseconds: GAP,
		wait(milliseconds: number): Promise<void> {
			running.waits.push(milliseconds);
			return(Promise.resolve());
		},
		sweep(): Promise<SweepPointer> {
			return(Promise.resolve(POINTER));
		}
	}));
}

describe('the checksums of two ledgers', function() {
	test('are compared by value, not by spelling', function() {
		expect(checksumsEqual('0xAB', '0x00ab')).toBe(true);
		expect(checksumsEqual('0xAB', '0xAC')).toBe(false);
	});
});

describe('comparing the follower\'s checksum with each representative\'s', function() {
	test('passes when both held still across the window and agree', async function() {
		const running = await setup(2);
		serveReadings(running.follower, [['0x0F', 100]]);
		serveReadings(running.representatives[0] ?? running.follower, [['0xF', 100]]);
		serveReadings(running.representatives[1] ?? running.follower, [['0x0F', 100]]);

		const records = await compare(running, COMPLETED);

		expect(records.map(function(record) {
			return([record.representative, record.verdict]);
		})).toEqual(running.representatives.map(function(api) {
			return([api.endpoint, { kind: 'pass' }]);
		}));
		expect(records[0]).toMatchObject({
			kind: 'checksum',
			gapMilliseconds: GAP,
			completedPass: '2026-10-09T05:00:00.000Z',
			follower: { kind: 'read', first: { checksum: '0x0F', blockCount: 100 }, second: { checksum: '0x0F', blockCount: 100 } },
			representativeWindow: { kind: 'read', first: { checksum: '0xF', blockCount: 100 }, second: { checksum: '0xF', blockCount: 100 } }
		});
		// The window is waited out once for every representative, each read at both of its ends with GETs only.
		expect(running.waits).toEqual([GAP]);
		for (const api of [running.follower, ...running.representatives]) {
			expect(api.requests).toEqual(['GET /node/ledger/checksum', 'GET /node/stats', 'GET /node/ledger/checksum', 'GET /node/stats']);
		}
	});

	test('fails when both held still and disagree, with the block counts and the sweep\'s pointer to bisect from', async function() {
		const running = await setup(1);
		serveReadings(running.follower, [['0x0F', 99]]);
		serveReadings(running.representatives[0] ?? running.follower, [['0x1F', 100]]);

		const [record] = await compare(running, COMPLETED);

		expect(record?.verdict).toEqual({ kind: 'fail', bisect: { followerBlockCount: 99, representativeBlockCount: 100, sweep: POINTER } });
	});

	test('does not count before the follower has completed a bootstrap pass, even when the two agree', async function() {
		const running = await setup(1);
		serveReadings(running.follower, [['0x0F', 100]]);
		serveReadings(running.representatives[0] ?? running.follower, [['0x0F', 100]]);

		const [record] = await compare(running, CATCHING_UP);

		expect(record?.verdict).toEqual({ kind: 'not-comparable-yet', reasons: ['no-completed-pass'] });
		expect(record?.completedPass).toBeNull();
	});

	test('does not count a representative whose checksum or block count moved within the window', async function() {
		const running = await setup(2);
		serveReadings(running.follower, [['0x0F', 100]]);
		serveReadings(running.representatives[0] ?? running.follower, [['0x0F', 100], ['0x1F', 101]]);
		serveReadings(running.representatives[1] ?? running.follower, [['0x0F', 100], ['0x0F', 101]]);

		const records = await compare(running, COMPLETED);

		expect(records.map(function(record) {
			return(record.verdict);
		})).toEqual([
			{ kind: 'not-comparable-yet', reasons: ['representative-moving'] },
			{ kind: 'not-comparable-yet', reasons: ['representative-moving'] }
		]);
	});

	test('does not count while the follower moves within the window', async function() {
		const running = await setup(1);
		serveReadings(running.follower, [['0x0F', 100], ['0x1F', 101]]);
		serveReadings(running.representatives[0] ?? running.follower, [['0x1F', 101]]);

		const [record] = await compare(running, CATCHING_UP);

		expect(record?.verdict).toEqual({ kind: 'not-comparable-yet', reasons: ['no-completed-pass', 'follower-moving'] });
	});

	test('records a representative that does not answer, and still compares the others', async function() {
		const running = await setup(2);
		serveReadings(running.follower, [['0x0F', 100]]);
		running.representatives[0]?.answer('/node/ledger/checksum', { status: 500, body: { error: true, message: 'Internal error occurred (error ID: x)' } });
		serveReadings(running.representatives[1] ?? running.follower, [['0x0F', 100]]);

		const records = await compare(running, COMPLETED);

		expect(records[0]?.verdict).toEqual({ kind: 'not-comparable-yet', reasons: ['representative-unanswered'] });
		expect(records[0]?.representativeWindow.kind).toBe('unanswered');
		expect(JSON.stringify(records[0]?.representativeWindow)).toContain('answered 500');
		expect(records[1]?.verdict).toEqual({ kind: 'pass' });
	});
});

describe('comparing the follower\'s block count with each representative\'s', function() {
	test('passes within the floor, widened by the representatives\' spread and by what each side added in its window', async function() {
		const running = await setup(2);
		serveReadings(running.follower, [['0x1', 1000], ['0x2', 1010]]);
		serveReadings(running.representatives[0] ?? running.follower, [['0x3', 1000 + BLOCK_COUNT_FLOOR + 40]]);
		serveReadings(running.representatives[1] ?? running.follower, [['0x4', 1000], ['0x5', 1005]]);

		const { blockCounts } = await compareAll(running, COMPLETED);

		// The spread is 1140 - 1005 = 135; the follower moved 10 and the second representative 5.
		expect(blockCounts.map(function(record) {
			return([record.toleranceBlocks, record.verdict]);
		})).toEqual([
			[BLOCK_COUNT_FLOOR + 135 + 10, { kind: 'pass' }],
			[BLOCK_COUNT_FLOOR + 135 + 15, { kind: 'pass' }]
		]);
	});

	test('fails beyond the tolerance, with the difference', async function() {
		const running = await setup(1);
		serveReadings(running.follower, [['0x1', 1000]]);
		serveReadings(running.representatives[0] ?? running.follower, [['0x1', 1000 + BLOCK_COUNT_FLOOR + 1]]);

		const { blockCounts } = await compareAll(running, COMPLETED);

		expect(blockCounts[0]?.verdict).toEqual({ kind: 'fail', difference: -(BLOCK_COUNT_FLOOR + 1) });
	});

	test('does not count before the follower has completed a bootstrap pass, or without an answer', async function() {
		const running = await setup(2);
		serveReadings(running.follower, [['0x1', 1000]]);
		serveReadings(running.representatives[0] ?? running.follower, [['0x1', 1000]]);
		running.representatives[1]?.answer('/node/stats', { status: 500, body: { error: true, message: 'no' } });
		running.representatives[1]?.serve('/node/ledger/checksum', checksum('0x1'));

		const { blockCounts } = await compareAll(running, CATCHING_UP);

		expect(blockCounts.map(function(record) {
			return(record.verdict);
		})).toEqual([
			{ kind: 'not-comparable-yet', reasons: ['no-completed-pass'] },
			{ kind: 'not-comparable-yet', reasons: ['no-completed-pass', 'representative-unanswered'] }
		]);
	});
});

describe('the follower\'s stored checksum against the fold of its main blocks', function() {
	test('is equal when the two are', function() {
		expect(crossCheckOutcomeOf({ stored: 0xABCn, folded: 0xABCn, mainBlocks: 3, mismatched: [] })).toEqual({ kind: 'equal' });
	});

	test('differs by the offset otherwise, naming the staples whose own checksum is not the fold of their blocks', function() {
		const mismatched: readonly MismatchedStaple[] = [{ sequence: '7', blocksHash: 'AB'.repeat(32), stored: 0x1n, fold: 0x3n }];
		expect(crossCheckOutcomeOf({ stored: 0xA0n, folded: 0xA2n, mainBlocks: 3, mismatched })).toEqual({
			kind: 'differs',
			offset: '0x2',
			staples: [{ sequence: '7', blocksHash: 'AB'.repeat(32), stored: '0x1', fold: '0x3' }]
		});
	});
});

describe('cross-checking the follower\'s stored checksum', function() {
	test('reads one snapshot of the follower\'s database and nothing of its API', async function() {
		let snapshots = 0;
		const record = await crossCheckChecksum({
			store: {
				checksumSnapshot(): Promise<ChecksumSnapshot> {
					snapshots++;
					return(Promise.resolve({ stored: 0x5n, folded: 0x5n, mainBlocks: 2, mismatched: [] }));
				}
			}
		});
		expect(snapshots).toBe(1);
		expect(record).toMatchObject({ kind: 'cross-check', stored: '0x5', folded: '0x5', mainBlocks: 2, outcome: { kind: 'equal' } });
	});
});
