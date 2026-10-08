import { describe, expect, test } from 'vitest';
import { KVInternals } from '../upstream/internals.js';
import { BOOTSTRAP_CURSOR_ARENA, BootstrapCursors } from './bootstrap-cursors.js';
import type { PeerProgress } from './bootstrap-pass.js';

const ENDPOINT = 'https://representative.example/api';

const PROGRESS: PeerProgress = {
	reached: new Date(Date.UTC(2025, 9, 20, 17, 42)),
	caughtUp: false,
	deepScanFrom: new Date(0),
	nextDeepScan: new Date(Date.UTC(2026, 9, 8, 20)),
	deepScan: undefined,
	heldSince: new Date(Date.UTC(2026, 9, 8, 19, 14)),
	keying: 'votes'
};

describe('the bootstrap cursors', function() {
	test('keep when the node took the staples it holds from where it reached', async function() {
		const cursors = new BootstrapCursors(new KVInternals.KVStorageProviderMemory());

		await cursors.write(ENDPOINT, PROGRESS);
		expect(await cursors.read(ENDPOINT)).toEqual(PROGRESS);

		await cursors.write(ENDPOINT, { ...PROGRESS, heldSince: undefined });
		expect((await cursors.read(ENDPOINT))?.heldSince).toBeUndefined();
	});

	test('read progress written before they kept it as taken about where it reached, and refuse a value that is not a moment', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		const cursors = new BootstrapCursors(kv);
		const stored = { reached: PROGRESS.reached.getTime(), caughtUp: false, deepScanFrom: 0, nextDeepScan: PROGRESS.nextDeepScan.getTime(), deepScan: null };

		await kv.set(BOOTSTRAP_CURSOR_ARENA, ENDPOINT, stored);
		expect(await cursors.read(ENDPOINT)).toEqual({ ...PROGRESS, heldSince: undefined, keying: 'unknown' });

		await kv.set(BOOTSTRAP_CURSOR_ARENA, ENDPOINT, { ...stored, heldSince: 'yesterday' });
		expect(await cursors.read(ENDPOINT)).toBeUndefined();
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
});
