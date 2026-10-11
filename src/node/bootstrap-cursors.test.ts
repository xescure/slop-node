import { describe, expect, test } from 'vitest';
import type { KVGenericOptionsType } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { JSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { KVInternals } from '../upstream/internals.js';
import { BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, BOOTSTRAP_RETRY_ARENA, BootstrapCursors, KVRetryStore } from './bootstrap-cursors.js';
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
				{ id: 4, reached: new Date(Date.UTC(2025, 11, 31, 0, 2)), end: new Date(Date.UTC(2026, 2, 11)), peer: ENDPOINT, pace: { spent: 120_000, advanced: 20_000 } },
				{ id: 2, reached: new Date(Date.UTC(2026, 2, 10, 23, 58, 59)), end: new Date(Date.UTC(2026, 9, 9, 3)), peer: undefined, pace: { spent: 0, advanced: 0 } }
			],
			standings: {
				[ENDPOINT]: { failures: 1, benchedUntil: undefined },
				'https://other.example/api': { failures: 0, benchedUntil: new Date(Date.UTC(2026, 9, 9, 4)) }
			},
			fullQueueUpdates: 3,
			nextID: 6
		};

		expect(await cursors.readLayout()).toBeUndefined();
		await cursors.write(ENDPOINT, PROGRESS);
		await cursors.writeLayout(layout);
		expect(await cursors.readLayout()).toEqual(layout);

		await kv.set(BOOTSTRAP_RANGES_ARENA, 'layout', { ...(await kv.get(BOOTSTRAP_RANGES_ARENA, 'layout') as object), ranges: [{ reached: -1, end: 0, peer: null }] });
		expect(await cursors.readLayout()).toBeUndefined();
		await kv.set(BOOTSTRAP_RANGES_ARENA, 'layout', { ...(await kv.get(BOOTSTRAP_RANGES_ARENA, 'layout') as object), ranges: [{ id: 1, reached: 0, end: 1, peer: null }, { id: 1, reached: 1, end: 2, peer: null }] });
		expect(await cursors.readLayout()).toBeUndefined();

		await cursors.writeLayout(layout);
		await cursors.clear();
		expect(await cursors.readLayout()).toBeUndefined();
		expect(await cursors.read(ENDPOINT)).toBeUndefined();
	});

	test('read the ranges an earlier build kept, with no IDs, paces or count of updates with a full queue, as named in order, not read yet, and with none', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		await kv.set(BOOTSTRAP_RANGES_ARENA, 'layout', {
			from: 1000,
			end: 9000,
			deepScanPeer: ENDPOINT,
			ranges: [{ reached: 2000, end: 4000, peer: ENDPOINT }, { reached: 4000, end: 9000, peer: null }],
			standings: {}
		});

		expect(await new BootstrapCursors(kv).readLayout()).toEqual({
			from: new Date(1000),
			end: new Date(9000),
			deepScanPeer: ENDPOINT,
			ranges: [
				{ id: 0, reached: new Date(2000), end: new Date(4000), peer: ENDPOINT, pace: { spent: 0, advanced: 0 } },
				{ id: 1, reached: new Date(4000), end: new Date(9000), peer: undefined, pace: { spent: 0, advanced: 0 } }
			],
			standings: {},
			fullQueueUpdates: 0,
			nextID: 2
		});
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

/** A store that answers null for every key, as one may for a value the node did not write. */
class NullStore extends KVInternals.KVStorageProviderMemory {
	override get(_arena: string | null, _key: string, _options?: KVGenericOptionsType): Promise<JSONSerializable | undefined> {
		return(Promise.resolve(null));
	}

	override getAll(_arena: string, _options?: KVGenericOptionsType): Promise<{ [key: string]: JSONSerializable }> {
		return(Promise.resolve({ queued: null }));
	}
}

/** Progress as the node stores it, every moment in milliseconds. */
const STORED_PROGRESS = { reached: PROGRESS.reached.getTime(), caughtUp: false, deepScanFrom: 0, nextDeepScan: PROGRESS.nextDeepScan.getTime(), deepScan: null, keying: 'votes' };

/** A layout as the node stores it. */
const STORED_LAYOUT = {
	from: 1000,
	end: 9000,
	deepScanPeer: ENDPOINT,
	ranges: [{ id: 3, reached: 2000, end: 9000, peer: ENDPOINT, spent: 10, advanced: 20 }],
	standings: { [ENDPOINT]: { failures: 2, benchedUntil: null } },
	fullQueueUpdates: 1,
	nextID: 4
};

/** The bytes 1, 2 and 3, in base64, as a queued staple is kept. */
const THREE_BYTES = Buffer.from([1, 2, 3]).toString('base64');

describe('values the node did not write', function() {
	test('are kept under the arenas and keys of earlier builds', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		const cursors = new BootstrapCursors(kv);

		await cursors.write(ENDPOINT, PROGRESS);
		await cursors.writeCaughtUp(new Date(5000));
		await cursors.writeLayout({ from: new Date(1000), end: new Date(9000), deepScanPeer: ENDPOINT, ranges: [], standings: {}, fullQueueUpdates: 0, nextID: 0 });
		await new KVRetryStore(kv).put({ key: 'AB', bytes: Uint8Array.from([1]).buffer, queuedAt: 1, code: 'X', reported: false, awaited: { kind: 'unknown' } });

		expect([BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, BOOTSTRAP_RETRY_ARENA]).toEqual(['bootstrapCursors', 'bootstrapCaughtUp', 'horizon', 'bootstrapRanges', 'layout', 'bootstrapRetries']);
		expect(await kv.get('bootstrapCursors', ENDPOINT)).toEqual(STORED_PROGRESS);
		expect(await kv.get('bootstrapCaughtUp', 'horizon')).toBe(5000);
		expect(await kv.get('bootstrapRanges', 'layout')).toMatchObject({ from: 1000, end: 9000 });
		expect(await kv.list('bootstrapRetries')).toEqual(['AB']);
	});

	test('count null, from a store that answers it, as no progress, layout, horizon or queued staple', async function() {
		const store = new NullStore();
		const cursors = new BootstrapCursors(store);

		expect(await cursors.read(ENDPOINT)).toBeUndefined();
		expect(await cursors.readLayout()).toBeUndefined();
		expect(await cursors.readCaughtUp()).toBeUndefined();
		expect(await new KVRetryStore(store).load()).toEqual([]);
	});

	test('read back a deep re-scan under way and the horizon of the latest pass that completed', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		const cursors = new BootstrapCursors(kv);
		const scanning: PeerProgress = { ...PROGRESS, deepScan: { reached: new Date(1000), horizon: new Date(2000) } };

		expect(await cursors.readCaughtUp()).toBeUndefined();
		await cursors.write(ENDPOINT, scanning);
		await cursors.writeCaughtUp(new Date(5000));

		expect(await kv.get(BOOTSTRAP_CURSOR_ARENA, ENDPOINT)).toMatchObject({ deepScan: { reached: 1000, horizon: 2000 } });
		expect(await cursors.read(ENDPOINT)).toEqual(scanning);
		expect(await cursors.readCaughtUp()).toEqual(new Date(5000));
		for (const horizon of [-1, 1.5, '5000', null]) {
			await kv.set(BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, horizon);
			expect(await cursors.readCaughtUp()).toBeUndefined();
		}
	});

	test.each<[string, JSONSerializable]>([
		['no record', 5],
		['a moment reached before the beginning of time', { ...STORED_PROGRESS, reached: -1 }],
		['a moment reached between two milliseconds', { ...STORED_PROGRESS, reached: 1.5 }],
		['a moment reached past what a number holds exactly', { ...STORED_PROGRESS, reached: 2 ** 53 }],
		['a moment reached written as text', { ...STORED_PROGRESS, reached: '5000' }],
		['a caught-up flag that is no boolean', { ...STORED_PROGRESS, caughtUp: 'false' }],
		['no start of the next deep re-scan', { reached: STORED_PROGRESS.reached, caughtUp: false, nextDeepScan: STORED_PROGRESS.nextDeepScan, deepScan: null, keying: 'votes' }],
		['no moment the next deep re-scan is due', { ...STORED_PROGRESS, nextDeepScan: -5 }],
		['a deep re-scan that is no record', { ...STORED_PROGRESS, deepScan: 5 }],
		['a deep re-scan with no moment reached', { ...STORED_PROGRESS, deepScan: { horizon: 2000 } }],
		['a deep re-scan with no horizon', { ...STORED_PROGRESS, deepScan: { reached: 1000, horizon: -1 } }]
	])('count as no progress: %s', async function(_ignored: string, stored: JSONSerializable) {
		const kv = new KVInternals.KVStorageProviderMemory();
		await kv.set(BOOTSTRAP_CURSOR_ARENA, ENDPOINT, stored);

		expect(await new BootstrapCursors(kv).read(ENDPOINT)).toBeUndefined();
	});

	test.each<[string, JSONSerializable]>([
		['no record', [STORED_LAYOUT]],
		['no beginning', { ...STORED_LAYOUT, from: -1 }],
		['no end', { ...STORED_LAYOUT, end: '9000' }],
		['no peer whose next deep re-scan reads it again', { ...STORED_LAYOUT, deepScanPeer: 5 }],
		['ranges that are no list', { ...STORED_LAYOUT, ranges: {} }],
		['standings that are no record', { ...STORED_LAYOUT, standings: [] }],
		['a count of updates with a full queue that is no whole number', { ...STORED_LAYOUT, fullQueueUpdates: -1 }],
		['a next ID that is no whole number', { ...STORED_LAYOUT, nextID: 0.5 }],
		['a range that is no record', { ...STORED_LAYOUT, ranges: [5] }],
		['a range that is null', { ...STORED_LAYOUT, ranges: [null] }],
		['a standing that is null', { ...STORED_LAYOUT, standings: { [ENDPOINT]: null } }],
		['a range whose ID is no whole number', { ...STORED_LAYOUT, ranges: [{ ...STORED_LAYOUT.ranges[0], id: 1.5 }] }],
		['a range with no moment reached', { ...STORED_LAYOUT, ranges: [{ ...STORED_LAYOUT.ranges[0], reached: null }] }],
		['a range with no end', { ...STORED_LAYOUT, ranges: [{ ...STORED_LAYOUT.ranges[0], end: -1 }] }],
		['a range whose peer is no text', { ...STORED_LAYOUT, ranges: [{ ...STORED_LAYOUT.ranges[0], peer: 5 }] }],
		['a range whose time spent is no whole number', { ...STORED_LAYOUT, ranges: [{ ...STORED_LAYOUT.ranges[0], spent: -1 }] }],
		['a range whose history read is no whole number', { ...STORED_LAYOUT, ranges: [{ ...STORED_LAYOUT.ranges[0], advanced: 'far' }] }],
		['a standing that is no record', { ...STORED_LAYOUT, standings: { [ENDPOINT]: 5 } }],
		['a standing whose failures are no whole number', { ...STORED_LAYOUT, standings: { [ENDPOINT]: { failures: -1, benchedUntil: null } } }],
		['a standing benched until no moment', { ...STORED_LAYOUT, standings: { [ENDPOINT]: { failures: 0, benchedUntil: 'later' } } }]
	])('count as no layout: %s', async function(_ignored: string, stored: JSONSerializable) {
		const kv = new KVInternals.KVStorageProviderMemory();
		await kv.set(BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, stored);

		expect(await new BootstrapCursors(kv).readLayout()).toBeUndefined();
	});

	test('name a range kept without an ID after the largest ID kept, whichever comes first', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		await kv.set(BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, { ...STORED_LAYOUT, ranges: [{ reached: 2000, end: 4000, peer: null }, { id: 5, reached: 4000, end: 9000, peer: null }], standings: { [ENDPOINT]: { failures: 0, benchedUntil: 7000 } }, nextID: 1 });

		const layout = await new BootstrapCursors(kv).readLayout();

		expect(layout?.ranges.map(function(range): number {
			return(range.id);
		})).toEqual([6, 5]);
		expect(layout?.nextID).toBe(7);
		expect(layout?.standings).toEqual({ [ENDPOINT]: { failures: 0, benchedUntil: new Date(7000) } });
	});

	test.each<[string, JSONSerializable, unknown]>([
		['voters that are no list', { kind: 'weight', voters: 'keeta_a' }, { kind: 'unknown' }],
		['voters that are not all text', { kind: 'weight', voters: ['keeta_a', 5] }, { kind: 'unknown' }],
		['accounts named as voters', { kind: 'weight', accounts: ['keeta_a'] }, { kind: 'unknown' }],
		['voters named as accounts', { kind: 'accounts', voters: ['keeta_a'] }, { kind: 'unknown' }],
		['accounts that are not all text', { kind: 'accounts', accounts: [5] }, { kind: 'unknown' }],
		['a kind of its own', { kind: 'blocks', accounts: ['keeta_a'] }, { kind: 'unknown' }],
		['nothing', 'weight', { kind: 'unknown' }],
		['voters', { kind: 'weight', voters: ['keeta_a'] }, { kind: 'weight', voters: ['keeta_a'] }],
		['accounts', { kind: 'accounts', accounts: ['keeta_a'] }, { kind: 'accounts', accounts: ['keeta_a'] }]
	])('read what a queued staple awaits as nothing the queue watches for unless it names it whole: %s', async function(_ignored: string, awaited: JSONSerializable, read: unknown) {
		const kv = new KVInternals.KVStorageProviderMemory();
		await kv.set(BOOTSTRAP_RETRY_ARENA, 'AB', { staple: THREE_BYTES, queuedAt: 1, code: 'X', reported: false, awaited });

		expect((await new KVRetryStore(kv).load())[0]?.awaited).toEqual(read);
	});

	test('keep a queued staple that awaits nothing the queue watches for as such', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		await new KVRetryStore(kv).put({ key: 'AB', bytes: Uint8Array.from([1, 2, 3]).buffer, queuedAt: 1, code: 'X', reported: false, awaited: { kind: 'unknown' } });

		expect(await kv.get(BOOTSTRAP_RETRY_ARENA, 'AB')).toEqual({ staple: THREE_BYTES, queuedAt: 1, code: 'X', reported: false, awaited: { kind: 'unknown' } });
	});

	test('leave out of the queue loaded each queued staple the node did not write, and keep the others', async function() {
		const kv = new KVInternals.KVStorageProviderMemory();
		const stored = { staple: THREE_BYTES, queuedAt: 1, code: 'X', reported: false };
		const unwritten: Readonly<Record<string, JSONSerializable>> = {
			record: 5,
			staple: { ...stored, staple: 5 },
			queuedAt: { ...stored, queuedAt: -1 },
			code: { ...stored, code: 5 },
			reported: { ...stored, reported: 'no' }
		};
		for (const [key, value] of Object.entries(unwritten)) {
			await kv.set(BOOTSTRAP_RETRY_ARENA, key, value);
		}
		await kv.set(BOOTSTRAP_RETRY_ARENA, 'kept', stored);

		const loaded = await new KVRetryStore(kv).load();

		expect(loaded.map(function(each): string {
			return(each.key);
		})).toEqual(['kept']);
		expect(Buffer.from(loaded[0]?.bytes ?? new ArrayBuffer(0)).toString('hex')).toBe('010203');
	});
});
