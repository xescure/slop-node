import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ShadowRunState, ShadowVoteEntry } from './log.js';
import { freshShadowRun } from './shadow-live.js';
import { fileShadowState } from './shadow-state.js';

const STATE: ShadowRunState = freshShadowRun(
	{ release: '0.18.4', from: new Date('2026-07-24T20:33:26.082Z') },
	10,
	{ database: 'follower_snapshot_20261010080000', sequence: '250000', blocksHash: 'AB'.repeat(32), scopedStaples: 0 },
	{ sequence: '420000', fixedAt: '2026-10-10T10:00:00.000Z', followerCaughtUp: true, heldBefore: '2026-10-10T09:59:00.000Z' }
);

function vote(sequence: number, outcome: ShadowVoteEntry['outcome']): ShadowVoteEntry {
	return({ sequence: String(sequence), blocksHash: sequence.toString(16).toUpperCase().padStart(64, '0'), window: 'scoped', votedFrom: '2026-08-01T00:00:00.000Z', outcome });
}

const directories: string[] = [];

afterEach(async function() {
	await Promise.all(directories.splice(0).map(function(directory) {
		return(rm(directory, { recursive: true, force: true }));
	}));
});

async function scratch(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'slop-shadow-state-'));
	directories.push(directory);
	return(join(directory, 'shadow-live'));
}

describe('a shadow-vote run\'s standing on disk', function() {
	test('stands nowhere before it is saved', async function() {
		expect(await fileShadowState(await scratch()).load()).toBeUndefined();
	});

	test('reads back the standing saved, and the votes recorded since', async function() {
		const directory = await scratch();
		const state = fileShadowState(directory);
		const saved = vote(1, { kind: 'voted' });
		const later = vote(2, { kind: 'explained', reason: 'self-requirement-return', code: 'LEDGER_INVALID_PERMISSIONS' });
		const refused = vote(3, { kind: 'unexplained', code: 'LEDGER_INVALID_PERMISSIONS', message: 'no access', why: '0 reasons explain the refusal' });
		await state.record(saved);
		await state.save(STATE);
		await state.record(later);
		await state.record(refused);

		const resumed = fileShadowState(directory);
		expect(await resumed.load()).toEqual(STATE);
		expect(await resumed.recordedSinceSaved()).toEqual(new Map([[later.blocksHash, later], [refused.blocksHash, refused]]));
		await resumed.save({ ...STATE, reached: { sequence: '250003', blocksHash: refused.blocksHash } });
		expect(await resumed.recordedSinceSaved()).toEqual(new Map());
	});

	test('drops a vote a stop cut short, so that the next starts a line of its own', async function() {
		const directory = await scratch();
		const state = fileShadowState(directory);
		await state.save(STATE);
		const whole = vote(1, { kind: 'voted' });
		await state.record(whole);
		await appendFile(join(directory, 'votes.jsonl'), JSON.stringify(vote(2, { kind: 'voted' })).slice(0, 30));

		const resumed = fileShadowState(directory);
		await resumed.load();
		expect(await resumed.recordedSinceSaved()).toEqual(new Map([[whole.blocksHash, whole]]));
		const next = vote(3, { kind: 'voted' });
		await resumed.record(next);
		expect(await readFile(join(directory, 'votes.jsonl'), 'utf8')).toBe(`${JSON.stringify(whole)}\n${JSON.stringify(next)}\n`);
	});

	test('refuses a cursor it does not understand, and forgets everything when cleared', async function() {
		const directory = await scratch();
		const state = fileShadowState(directory);
		await state.save(STATE);
		await state.clear();
		expect(await state.load()).toBeUndefined();
		await state.save({ ...STATE, informationalEvery: 0 });
		await expect(fileShadowState(directory).load()).rejects.toThrow('holds no shadow-vote cursor this version writes');
	});
});
