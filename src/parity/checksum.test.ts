import { describe, expect, test } from 'vitest';
import { startFakeAPI } from '../testing/fake-api.js';
import type { FakeAPI } from '../testing/fake-api.js';
import { httpSource } from './api-source.js';
import { BLOCK_COUNT_FLOOR, checksumsEqual, compareChecksums, crossCheckChecksum, crossCheckOutcomeOf, lostRunOf, MAX_LOST_RUN, UNSYNCED_CANDIDATES, xorSubsetOf } from './checksum.js';
import type { ChecksumSnapshot, FollowerProgress, SnapshotStaples, StapleFold } from './follower-store.js';
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

/** A fixed pseudo-random 256-bit value, as a block hash folds to. */
function hashLike(seed: number): bigint {
	let value = 0n;
	let state = BigInt(seed) * 6364136223846793005n + 1442695040888963407n;
	for (let word = 0; word < 4; word++) {
		state = (state * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
		value = (value << 64n) | state;
	}
	return(value);
}

function staples(count: number): StapleFold[] {
	return(Array.from({ length: count }, function(_unused, index): StapleFold {
		return({ sequence: String(index + 1), blocksHash: String(index + 1).padStart(64, '0'), moment: new Date(Date.UTC(2026, 9, 8, 22, 0, index)), fold: hashLike(index) });
	}));
}

function foldOf(listed: readonly StapleFold[]): bigint {
	return(listed.reduce(function(fold, staple): bigint {
		return(fold ^ staple.fold);
	}, 0n));
}

describe('the vectors that XOR to a target', function() {
	test('are found among the ones given, by index', function() {
		const vectors = [0b0011n, 0b0110n, 0b1000n, 0b0101n];
		const found = xorSubsetOf(vectors, 0b1101n);
		expect(found).toBeDefined();
		expect((found ?? []).reduce(function(fold, index): bigint {
			return(fold ^ (vectors[index] ?? 0n));
		}, 0n)).toBe(0b1101n);
	});

	test('are none for a target outside their span', function() {
		expect(xorSubsetOf([0b0011n, 0b0110n], 0b1000n)).toBeUndefined();
		expect(xorSubsetOf([], 0b1n)).toBeUndefined();
	});
});

describe('the run of staples lost from the stored checksum', function() {
	test('is the consecutive run whose blocks XOR to the offset', function() {
		const listed = staples(200);
		expect(lostRunOf(listed, foldOf(listed.slice(40, 58)))).toEqual({ first: 40, last: 57 });
	});

	test('is none when only staples apart from each other make the offset, or the run is too long', function() {
		const listed = staples(MAX_LOST_RUN + 20);
		expect(lostRunOf(listed, (listed[3]?.fold ?? 0n) ^ (listed[9]?.fold ?? 0n))).toBeUndefined();
		expect(lostRunOf(listed, foldOf(listed.slice(5, MAX_LOST_RUN + 6)))).toBeUndefined();
	});
});

function snapshot(stored: bigint, listed: readonly StapleFold[]): ChecksumSnapshot {
	return({ stored, folded: foldOf(listed), mainBlocks: listed.length, staples: listed });
}

describe('the follower\'s stored checksum against the fold of its main blocks', function() {
	test('is equal when nothing is missing', function() {
		const listed = staples(10);
		expect(crossCheckOutcomeOf(snapshot(foldOf(listed), listed))).toEqual({ kind: 'equal' });
	});

	test('is short of the newest staples, not synced yet', function() {
		const listed = staples(UNSYNCED_CANDIDATES + 10);
		const stored = foldOf(listed) ^ foldOf(listed.slice(-1)) ^ foldOf(listed.slice(-3, -2));
		const outcome = crossCheckOutcomeOf(snapshot(stored, listed));
		expect(outcome.kind).toBe('unsynced');
		expect(outcome.kind === 'unsynced' && [...outcome.staples].sort()).toEqual([listed.at(-3)?.blocksHash, listed.at(-1)?.blocksHash]);
	});

	test('is short of a run of staples whose statistics were never written', function() {
		const listed = staples(300);
		const outcome = crossCheckOutcomeOf(snapshot(foldOf(listed) ^ foldOf(listed.slice(100, 118)), listed));
		expect(outcome).toEqual({ kind: 'lost-run', firstSequence: '101', lastSequence: '118', staples: 18, firstMoment: listed[100]?.moment.toISOString(), lastMoment: listed[117]?.moment.toISOString() });
	});

	test('is unexplained otherwise, with the offset', function() {
		const listed = staples(300);
		expect(crossCheckOutcomeOf(snapshot(foldOf(listed) ^ 0xABCn, listed))).toEqual({ kind: 'unexplained', offset: '0xABC' });
	});
});

describe('cross-checking the follower\'s stored checksum', function() {
	test('syncs the follower through its API, then reads the newest staples only while they explain the difference', async function() {
		const follower = await startFakeAPI();
		follower.serve('/node/version', { node: 'x' });
		const listed = staples(100);
		const asked: SnapshotStaples[] = [];
		const record = await crossCheckChecksum({
			follower: httpSource(follower.endpoint),
			store: {
				checksumSnapshot(wanted: SnapshotStaples): Promise<ChecksumSnapshot> {
					asked.push(wanted);
					const newest = listed.slice(-UNSYNCED_CANDIDATES);
					return(Promise.resolve(snapshot(foldOf(newest) ^ foldOf(listed.slice(-1)), newest)));
				}
			}
		});
		expect(follower.requests).toEqual(['GET /node/version']);
		expect(asked).toEqual([{ kind: 'newest', count: UNSYNCED_CANDIDATES }]);
		expect(record).toMatchObject({ kind: 'cross-check', mainBlocks: UNSYNCED_CANDIDATES, outcome: { kind: 'unsynced', staples: [listed.at(-1)?.blocksHash] } });
	});

	test('reads every staple when the newest do not explain the difference', async function() {
		const follower = await startFakeAPI();
		follower.serve('/node/version', { node: 'x' });
		const listed = staples(300);
		const stored = foldOf(listed) ^ foldOf(listed.slice(10, 20));
		const asked: SnapshotStaples[] = [];
		const record = await crossCheckChecksum({
			follower: httpSource(follower.endpoint),
			store: {
				checksumSnapshot(wanted: SnapshotStaples): Promise<ChecksumSnapshot> {
					asked.push(wanted);
					const all = snapshot(stored, listed);
					if (wanted.kind === 'every') {
						return(Promise.resolve(all));
					}
					return(Promise.resolve({ ...all, staples: listed.slice(-wanted.count) }));
				}
			}
		});
		expect(asked.map(function(wanted) {
			return(wanted.kind);
		})).toEqual(['newest', 'every']);
		expect(follower.requests).toEqual(['GET /node/version', 'GET /node/version']);
		expect(record.outcome).toMatchObject({ kind: 'lost-run', staples: 10, firstSequence: '11', lastSequence: '20' });
	});
});
