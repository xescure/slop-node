import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { loadMainnetFixture } from '../conformance/mainnet/fixture.js';
import { REPLAY_TIMEOUT_MILLISECONDS } from '../conformance/mainnet/head-replay.js';
import { replayOrder } from '../conformance/mainnet/replay.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import type { HeldStaple, StapleKey } from './follower-store.js';
import { shadowVoteLive } from './shadow-live.js';
import type { ShadowLiveStore } from './shadow-live.js';

const HOUR = 60 * 60_000;

/** The follower's store serving the staples in the order given, its reach two hours after the last of them. */
function servedInOrder(staples: readonly VoteStaple[]): ShadowLiveStore {
	const held: HeldStaple[] = staples.map(function(staple): HeldStaple {
		return({ staple, stapleTime: staple.timestamp() });
	});
	const lastMoment = Math.max(...held.map(function(entry): number {
		return(entry.stapleTime.getTime());
	}));
	const positionAfter = function(after: StapleKey | undefined): number {
		if (after === undefined) {
			return(0);
		}
		return(held.findIndex(function(entry): boolean {
			return(entry.staple.blocksHash.toString() === after.blocksHash);
		}) + 1);
	};
	return({
		progress: () => Promise.resolve({ completedPass: undefined, heldBefore: new Date(lastMoment + 2 * HOUR), staged: 0 }),
		stapleCountBefore: (before) => Promise.resolve(held.filter(function(entry) {
			return(entry.stapleTime < before);
		}).length),
		staplesBefore: (before, after, count) => Promise.resolve(held.slice(positionAfter(after)).filter(function(entry) {
			return(entry.stapleTime < before);
		}).slice(0, count))
	});
}

/** The follower's store holding the staples in history order. */
function storeOf(staples: readonly VoteStaple[]): ShadowLiveStore {
	return(servedInOrder(replayOrder(staples)));
}

async function committedExceptions(): Promise<ReadonlyMap<string, string>> {
	const parsed: unknown = JSON.parse(await readFile(new URL('../../conformance/mainnet/shadow-vote-exceptions.json', import.meta.url), 'utf8'));
	const exceptions = new Map<string, string>();
	if (typeof parsed !== 'object' || parsed === null) {
		throw(new Error('no exceptions'));
	}
	for (const [blocksHash, entry] of Object.entries(parsed)) {
		const fields: unknown = entry;
		if (typeof fields === 'object' && fields !== null && 'reason' in fields && typeof fields.reason === 'string') {
			exceptions.set(blocksHash, fields.reason);
		}
	}
	return(exceptions);
}

describe('shadow votes on the follower\'s history', function() {
	test('replay its history and refuse in the window only what the classified differences explain, as on the head', async function() {
		const head = await loadMainnetFixture('head');
		const window = 400;
		const record = await shadowVoteLive({ store: storeOf(head), windowStaples: window, storage: () => new MemoryLedgerStorage(), batchStaples: 250 });

		const inWindow = new Set(replayOrder(head).slice(-window).map(function(staple) {
			return(staple.blocksHash.toString());
		}));
		const expected = [...(await committedExceptions())].filter(function([blocksHash]) {
			return(inWindow.has(blocksHash));
		});
		expect(expected.length).toBeGreaterThan(0);
		expect(record).toMatchObject({ kind: 'shadow-live', replayed: head.length, windowStaples: window, unexplained: [], deferredInWindow: [], unappliedBeforeWindow: [] });
		expect(record.windowTo).toBe(replayOrder(head).at(-1)?.timestamp().toISOString());
		expect(new Map(record.explained.map(function(refusal) {
			return([refusal.blocksHash, refusal.reason]);
		}))).toEqual(new Map(expected));
		expect(record.voted + record.explained.length).toBe(window);
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('report a staple of the window whose history the follower lacks, as not explained', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 300);
		const window = head.slice(-100);
		const blockStaple = new Map(window.flatMap(function(staple) {
			return(staple.blocks.map(function(block) {
				return([block.hash.toString(), staple] as const);
			}));
		}));
		// A staple of the window that builds on a block another staple of the window holds.
		const dependent = window.find(function(staple) {
			return(staple.blocks.some(function(block) {
				const holder = blockStaple.get(block.previous.toString());
				return(holder !== undefined && holder !== staple);
			}));
		});
		const missing = dependent?.blocks.map(function(block) {
			return(blockStaple.get(block.previous.toString()));
		}).find(function(holder) {
			return(holder !== undefined && holder !== dependent);
		});
		expect(dependent).toBeDefined();
		expect(missing).toBeDefined();

		const record = await shadowVoteLive({ store: storeOf(head.filter(function(staple) {
			return(staple !== missing);
		})), windowStaples: 99, storage: () => new MemoryLedgerStorage() });

		expect(record.unexplained.map(function(refusal) {
			return(refusal.blocksHash);
		})).toContain(dependent?.blocksHash.toString());
		expect(record.deferredInWindow).toContain(dependent?.blocksHash.toString());
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('retry a staple refused for want of voting weight once the staples that give it come', async function() {
		const head = replayOrder(await loadMainnetFixture('head')).slice(0, 200);
		// The genesis staple gives the first representatives their weight; served late, the staples before it wait for it.
		const rest = head.slice(1);
		const late = [...rest.slice(0, 5), ...head.slice(0, 1), ...rest.slice(5)];
		const record = await shadowVoteLive({ store: servedInOrder(late), windowStaples: 50, storage: () => new MemoryLedgerStorage(), batchStaples: 20 });
		expect(record.refusedForWeight).toBeGreaterThan(0);
		expect(record).toMatchObject({ replayed: 200, unappliedBeforeWindow: [], deferredInWindow: [] });
	}, REPLAY_TIMEOUT_MILLISECONDS);

	test('vote on nothing before the follower has read anything', async function() {
		const record = await shadowVoteLive({
			store: { progress: () => Promise.resolve({ completedPass: undefined, heldBefore: undefined, staged: 0 }), stapleCountBefore: () => Promise.resolve(0), staplesBefore: () => Promise.resolve([]) },
			windowStaples: 10,
			storage: () => new MemoryLedgerStorage()
		});
		expect(record).toMatchObject({ replayed: 0, windowStaples: 0, windowFrom: null, voted: 0 });
	});
});
