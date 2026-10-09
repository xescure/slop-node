import { describe, expect, test } from 'vitest';
import { KVInternals } from '../upstream/internals.js';
import { BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RETRY_ARENA, BootstrapCursors, KVRetryStore } from './bootstrap-cursors.js';
import type { PeerProgress } from './bootstrap-pass.js';
import type { RangeLayout } from './bootstrap-ranges.js';
import type { QueuedStaple } from './bootstrap-retry.js';

const ENDPOINT = 'https://representative.example/api';

const PROGRESS: PeerProgress = {
	reached: new Date(Date.UTC(2025, 9, 20, 17, 42)),
	caughtUp: false,
	deepScanFrom: new Date(0),
	nextDeepScan: new Date(Date.UTC(2026, 9, 8, 20)),
	deepScan: undefined,
	keying: 'votes'
};

describe('the bootstrap cursors', function() {
	test('keep a peer\'s progress', async function() {
		const cursors = new BootstrapCursors(new KVInternals.KVStorageProviderMemory());

		await cursors.write(ENDPOINT, PROGRESS);
		expect(await cursors.read(ENDPOINT)).toEqual(PROGRESS);
		expect(await cursors.read('https://other.example/api')).toBeUndefined();
	});

	test('read progress written by versions that kept no keying, or kept when the node took what it holds, which a pass no longer reads', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		const cursors = new BootstrapCursors(kv);
		const stored = { reached: PROGRESS.reached.getTime(), caughtUp: false, deepScanFrom: 0, nextDeepScan: PROGRESS.nextDeepScan.getTime(), deepScan: null };

		await kv.set(BOOTSTRAP_CURSOR_ARENA, ENDPOINT, stored);
		expect(await cursors.read(ENDPOINT)).toEqual({ ...PROGRESS, keying: 'unknown' });

		await kv.set(BOOTSTRAP_CURSOR_ARENA, ENDPOINT, { ...stored, heldSince: Date.UTC(2026, 9, 8, 19, 14), keying: 'votes' });
		expect(await cursors.read(ENDPOINT)).toEqual(PROGRESS);
	});

	test('keep how the peer keys its staples, and refuse a value that names no way', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		const cursors = new BootstrapCursors(kv);

		for (const keying of ['unknown', 'votes', 'applied', 'late-votes'] as const) {
			await cursors.write(ENDPOINT, { ...PROGRESS, keying });
			expect((await cursors.read(ENDPOINT))?.keying).toBe(keying);
		}

		await kv.set(BOOTSTRAP_CURSOR_ARENA, ENDPOINT, { ...(await kv.get(BOOTSTRAP_CURSOR_ARENA, ENDPOINT) as object), keying: 'sideways' });
		expect(await cursors.read(ENDPOINT)).toBeUndefined();
	});

	test('keep the ranges the node reads while far behind, which a reset forgets with the progress', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		const cursors = new BootstrapCursors(kv);
		const layout: RangeLayout = {
			from: new Date(Date.UTC(2025, 11, 31)),
			end: new Date(Date.UTC(2026, 9, 9, 3)),
			deepScanPeer: ENDPOINT,
			ranges: [
				{ reached: new Date(Date.UTC(2025, 11, 31, 0, 2)), end: new Date(Date.UTC(2026, 2, 11)), peer: ENDPOINT },
				{ reached: new Date(Date.UTC(2026, 2, 10, 23, 58, 59)), end: new Date(Date.UTC(2026, 9, 9, 3)), peer: undefined }
			],
			standings: {
				[ENDPOINT]: { failures: 1, benchedUntil: undefined },
				'https://other.example/api': { failures: 0, benchedUntil: new Date(Date.UTC(2026, 9, 9, 4)) }
			}
		};

		expect(await cursors.readLayout()).toBeUndefined();
		await cursors.write(ENDPOINT, PROGRESS);
		await cursors.writeLayout(layout);
		expect(await cursors.readLayout()).toEqual(layout);

		await kv.set(BOOTSTRAP_RANGES_ARENA, 'layout', { ...(await kv.get(BOOTSTRAP_RANGES_ARENA, 'layout') as object), ranges: [{ reached: -1, end: 0, peer: null }] });
		expect(await cursors.readLayout()).toBeUndefined();

		await cursors.writeLayout(layout);
		await cursors.clear();
		expect(await cursors.readLayout()).toBeUndefined();
		expect(await cursors.read(ENDPOINT)).toBeUndefined();
	});
});

describe('the bootstrap retry store', function() {
	const bytes = Uint8Array.from([1, 2, 3, 4]).buffer;
	const entry: QueuedStaple = { key: 'AB'.repeat(32), bytes, queuedAt: Date.UTC(2026, 9, 9, 15), code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT', reported: false, awaited: { kind: 'weight', voters: [ENDPOINT] } };

	test('keeps a queued staple as its bytes, with what it awaits, under the hash of its blocks, until removed', async function() {
		const store = new KVRetryStore(new KVInternals.KVStorageProviderMemory());

		await store.put(entry);
		await store.put({ ...entry, key: 'CD'.repeat(32), awaited: { kind: 'accounts', accounts: [ENDPOINT] } });
		const loaded = await store.load();
		expect(loaded).toHaveLength(2);
		expect(loaded.map(function(each) {
			return([each.key, Buffer.from(each.bytes).toString('hex'), each.awaited]);
		})).toEqual([['AB'.repeat(32), '01020304', entry.awaited], ['CD'.repeat(32), '01020304', { kind: 'accounts', accounts: [ENDPOINT] }]]);

		await store.remove(entry.key);
		expect((await store.load()).map(function(each) {
			return(each.key);
		})).toEqual(['CD'.repeat(32)]);
	});

	test('reads a staple an earlier build queued without what it awaits as awaiting nothing the queue watches for', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		await kv.set(BOOTSTRAP_RETRY_ARENA, entry.key, { staple: Buffer.from(bytes).toString('base64'), queuedAt: entry.queuedAt, code: entry.code, reported: true });

		const [loaded] = await new KVRetryStore(kv).load();
		expect(loaded).toMatchObject({ key: entry.key, queuedAt: entry.queuedAt, code: entry.code, reported: true, awaited: { kind: 'unknown' } });
	});
});
