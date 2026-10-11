import type { KVStorageProvider } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import { assertNever } from '../util/assert-never.js';
import type { PeerKeying } from './bootstrap-evidence.js';
import type { DeepScan, PeerProgress } from './bootstrap-pass.js';
import type { BootstrapRange, RangeLayout, RangeStanding } from './bootstrap-ranges.js';
import type { Awaited, QueuedStaple, RetryStore } from './bootstrap-retry.js';

/**
 * The arena that holds, for each representative the node bootstraps from,
 * how far it has caught up on that representative and when it re-scans it.
 * Each representative orders its staples by moments of its own, so a moment
 * reached on one says nothing about another.
 */
export const BOOTSTRAP_CURSOR_ARENA = 'bootstrapCursors';

/** The arena that holds, under BOOTSTRAP_CAUGHT_UP_KEY, the horizon of the latest pass over any peer that completed (src/node/bootstrap-update.ts). */
export const BOOTSTRAP_CAUGHT_UP_ARENA = 'bootstrapCaughtUp';

export const BOOTSTRAP_CAUGHT_UP_KEY = 'horizon';

/** The arena that holds, under BOOTSTRAP_RANGES_KEY, the history the node reads in ranges while far behind, and where each range reached (src/node/bootstrap-ranges.ts). */
export const BOOTSTRAP_RANGES_ARENA = 'bootstrapRanges';

export const BOOTSTRAP_RANGES_KEY = 'layout';

/** The arena that holds the staples the ledger refused, by the hash of their blocks, until they apply (src/node/bootstrap-retry.ts). */
export const BOOTSTRAP_RETRY_ARENA = 'bootstrapRetries';

/** A peer's progress as stored: moments in milliseconds. */
type StoredProgress = {
	readonly reached: number;
	readonly caughtUp: boolean;
	readonly deepScanFrom: number;
	readonly nextDeepScan: number;
	readonly deepScan: { readonly reached: number; readonly horizon: number } | null;
	readonly keying: PeerKeying;
};

function isWholeNumber(value: unknown): value is number {
	return(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** The deep re-scan under way as stored, nothing when none is, or false when the value is not one. */
function deepScanOf(value: unknown): DeepScan | undefined | false {
	if (value === null) {
		return(undefined);
	}
	if (!isRecord(value) || !isWholeNumber(value['reached']) || !isWholeNumber(value['horizon'])) {
		return(false);
	}
	return({ reached: new Date(value['reached']), horizon: new Date(value['horizon']) });
}

const EVERY_KEYING: readonly PeerKeying[] = ['unknown', 'votes', 'applied', 'late-votes'];

/** How the peer keys its staples as stored, unknown when the node did not record it, as before it did, or false when the value is not one. */
function keyingOf(value: unknown): PeerKeying | false {
	if (value === undefined) {
		return('unknown');
	}
	return(EVERY_KEYING.find(function(keying): boolean {
		return(keying === value);
	}) ?? false);
}

/** A peer's progress as stored, or nothing when the value is not one the node wrote. */
export function progressOf(value: unknown): PeerProgress | undefined {
	if (!isRecord(value)) {
		return(undefined);
	}
	const { reached, caughtUp, deepScanFrom, nextDeepScan } = value;
	const deepScan = deepScanOf(value['deepScan']);
	const keying = keyingOf(value['keying']);
	if (!isWholeNumber(reached) || typeof caughtUp !== 'boolean' || !isWholeNumber(deepScanFrom) || !isWholeNumber(nextDeepScan) || deepScan === false || keying === false) {
		return(undefined);
	}
	return({ reached: new Date(reached), caughtUp, deepScanFrom: new Date(deepScanFrom), nextDeepScan: new Date(nextDeepScan), deepScan, keying });
}

/** A layout as stored: moments in milliseconds, and no peer as null. */
type StoredLayout = {
	readonly from: number;
	readonly end: number;
	readonly deepScanPeer: string;
	readonly ranges: { readonly id: number; readonly reached: number; readonly end: number; readonly peer: string | null; readonly spent: number; readonly advanced: number }[];
	readonly standings: Readonly<Record<string, { readonly failures: number; readonly benchedUntil: number | null }>>;
	readonly fullQueueUpdates: number;
	readonly nextID: number;
};

/** A count as stored, none when an earlier build did not store it, or false when the value is not one. */
function countOf(value: unknown): number | false {
	if (value === undefined) {
		return(0);
	}
	if (!isWholeNumber(value)) {
		return(false);
	}
	return(value);
}

/** A range as stored, but for its ID, which an earlier build did not store, nor its pace. */
function rangeOf(value: unknown): (Omit<BootstrapRange, 'id'> & { readonly id: number | undefined }) | undefined {
	if (!isRecord(value)) {
		return(undefined);
	}
	const { id, reached, end, peer } = value;
	const spent = countOf(value['spent']);
	const advanced = countOf(value['advanced']);
	if ((id !== undefined && !isWholeNumber(id)) || !isWholeNumber(reached) || !isWholeNumber(end) || (peer !== null && typeof peer !== 'string') || spent === false || advanced === false) {
		return(undefined);
	}
	return({ id, reached: new Date(reached), end: new Date(end), peer: peer ?? undefined, pace: { spent, advanced } });
}

function standingOf(value: unknown): RangeStanding | undefined {
	if (!isRecord(value)) {
		return(undefined);
	}
	const { failures, benchedUntil } = value;
	if (!isWholeNumber(failures) || (benchedUntil !== null && !isWholeNumber(benchedUntil))) {
		return(undefined);
	}
	let until: Date | undefined;
	if (benchedUntil !== null) {
		until = new Date(benchedUntil);
	}
	return({ failures, benchedUntil: until });
}

/**
 * The layout as stored, or nothing when the node did not write it, as a
 * cursor's. The ranges an earlier build stored without IDs are named after
 * the largest ID stored, in order, so that each still has its own, and the
 * next ID follows the largest.
 */
export function layoutOf(value: unknown): RangeLayout | undefined {
	if (!isRecord(value)) {
		return(undefined);
	}
	const { from, end, deepScanPeer, ranges, standings } = value;
	const fullQueueUpdates = countOf(value['fullQueueUpdates']);
	const storedNextID = countOf(value['nextID']);
	if (!isWholeNumber(from) || !isWholeNumber(end) || typeof deepScanPeer !== 'string' || !Array.isArray(ranges) || !isRecord(standings) || fullQueueUpdates === false || storedNextID === false) {
		return(undefined);
	}
	const read = ranges.map(rangeOf);
	const readStandings = Object.entries(standings).map(function([peer, standing]): [string, RangeStanding | undefined] {
		return([peer, standingOf(standing)]);
	});
	const everyRange = read.filter(function(range): range is NonNullable<typeof range> {
		return(range !== undefined);
	});
	const everyStanding = readStandings.filter(function(entry): entry is [string, RangeStanding] {
		return(entry[1] !== undefined);
	});
	if (everyRange.length !== read.length || everyStanding.length !== readStandings.length) {
		return(undefined);
	}
	let unnamed = Math.max(-1, ...everyRange.map(function(range): number {
		return(range.id ?? -1);
	}));
	const named = everyRange.map(function(range): BootstrapRange {
		let id = range.id;
		if (id === undefined) {
			unnamed++;
			id = unnamed;
		}
		return({ ...range, id });
	});
	if (new Set(named.map(function(range): number {
		return(range.id);
	})).size !== named.length) {
		return(undefined);
	}
	const nextID = Math.max(storedNextID, unnamed + 1);
	return({ from: new Date(from), end: new Date(end), deepScanPeer, ranges: named, standings: Object.fromEntries(everyStanding), fullQueueUpdates, nextID });
}

function storedLayout(layout: RangeLayout): StoredLayout {
	return({
		from: layout.from.getTime(),
		end: layout.end.getTime(),
		deepScanPeer: layout.deepScanPeer,
		ranges: layout.ranges.map(function(range) {
			return({ id: range.id, reached: range.reached.getTime(), end: range.end.getTime(), peer: range.peer ?? null, spent: range.pace.spent, advanced: range.pace.advanced });
		}),
		standings: Object.fromEntries(Object.entries(layout.standings).map(function([peer, standing]) {
			return([peer, { failures: standing.failures, benchedUntil: standing.benchedUntil?.getTime() ?? null }]);
		})),
		fullQueueUpdates: layout.fullQueueUpdates,
		nextID: layout.nextID
	});
}

function storedDeepScan(deepScan: DeepScan | undefined): StoredProgress['deepScan'] {
	if (deepScan === undefined) {
		return(null);
	}
	return({ reached: deepScan.reached.getTime(), horizon: deepScan.horizon.getTime() });
}

/** How far the node has caught up on each representative, keyed by its API endpoint. */
export class BootstrapCursors {
	readonly #kv: KVStorageProvider;

	constructor(kv: KVStorageProvider) {
		this.#kv = kv;
	}

	/** A value the node did not write, from another version or by hand, counts as none, so the peer is read from the beginning. */
	async read(endpoint: string): Promise<PeerProgress | undefined> {
		return(progressOf(await this.#kv.get(BOOTSTRAP_CURSOR_ARENA, endpoint)));
	}

	async write(endpoint: string, progress: PeerProgress): Promise<void> {
		const stored: StoredProgress = {
			reached: progress.reached.getTime(),
			caughtUp: progress.caughtUp,
			deepScanFrom: progress.deepScanFrom.getTime(),
			nextDeepScan: progress.nextDeepScan.getTime(),
			deepScan: storedDeepScan(progress.deepScan),
			keying: progress.keying
		};
		await this.#kv.set(BOOTSTRAP_CURSOR_ARENA, endpoint, stored);
	}

	/** The horizon of the latest pass over any peer that completed, or nothing while none has. */
	async readCaughtUp(): Promise<Date | undefined> {
		const stored = await this.#kv.get(BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY);
		if (!isWholeNumber(stored)) {
			return(undefined);
		}
		return(new Date(stored));
	}

	async writeCaughtUp(horizon: Date): Promise<void> {
		await this.#kv.set(BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, horizon.getTime());
	}

	/** The history the node reads in ranges, or nothing while it reads none. */
	async readLayout(): Promise<RangeLayout | undefined> {
		return(layoutOf(await this.#kv.get(BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY)));
	}

	async writeLayout(layout: RangeLayout | undefined): Promise<void> {
		if (layout === undefined) {
			await this.#kv.set(BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, undefined);
			return;
		}
		await this.#kv.set(BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, storedLayout(layout));
	}

	/** Forgets every peer's progress, the ranges, and that any pass completed; the staples queued for retry stay, as nothing reads them again. */
	async clear(): Promise<void> {
		for (const endpoint of await this.#kv.list(BOOTSTRAP_CURSOR_ARENA)) {
			await this.#kv.set(BOOTSTRAP_CURSOR_ARENA, endpoint, undefined);
		}
		await this.#kv.set(BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CAUGHT_UP_KEY, undefined);
		await this.#kv.set(BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RANGES_KEY, undefined);
	}
}

/** A queued staple as stored: its bytes in base64, and what it awaits, which an earlier build did not store. */
type StoredQueued = {
	readonly staple: string;
	readonly queuedAt: number;
	readonly code: string;
	readonly reported: boolean;
	readonly awaited: StoredAwaited;
};

/** What a queued staple awaits, as JSON. */
type StoredAwaited = { kind: 'weight'; voters: string[] } | { kind: 'accounts'; accounts: string[] } | { kind: 'unknown' };

function storedAwaited(awaited: Awaited): StoredAwaited {
	switch (awaited.kind) {
		case 'weight':
			return({ kind: awaited.kind, voters: [...awaited.voters] });
		case 'accounts':
			return({ kind: awaited.kind, accounts: [...awaited.accounts] });
		case 'unknown':
			return({ kind: awaited.kind });
		default:
			return(assertNever(awaited));
	}
}

function isStringList(value: unknown): value is readonly string[] {
	return(Array.isArray(value) && value.every(function(item): boolean {
		return(typeof item === 'string');
	}));
}

/** What a stored staple awaits, or nothing the queue watches for when the node did not store it. */
function awaitedOf(value: unknown): Awaited {
	if (!isRecord(value)) {
		return({ kind: 'unknown' });
	}
	const { kind, voters, accounts } = value;
	if (kind === 'weight' && isStringList(voters)) {
		return({ kind, voters });
	}
	if (kind === 'accounts' && isStringList(accounts)) {
		return({ kind, accounts });
	}
	return({ kind: 'unknown' });
}

/** The queued staple of a stored value under its key, or nothing when the node did not write it. */
function queuedOf(key: string, value: unknown): QueuedStaple | undefined {
	if (!isRecord(value)) {
		return(undefined);
	}
	const { staple, queuedAt, code, reported } = value;
	if (typeof staple !== 'string' || !isWholeNumber(queuedAt) || typeof code !== 'string' || typeof reported !== 'boolean') {
		return(undefined);
	}
	const bytes = Buffer.from(staple, 'base64');
	return({ key, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), queuedAt, code, reported, awaited: awaitedOf(value['awaited']) });
}

/** The staples queued for retry, kept in the node's store so that a restart loses none. */
export class KVRetryStore implements RetryStore {
	readonly #kv: KVStorageProvider;

	constructor(kv: KVStorageProvider) {
		this.#kv = kv;
	}

	/** A value the node did not write counts as none, as a cursor's does. */
	async load(): Promise<QueuedStaple[]> {
		return(Object.entries(await this.#kv.getAll(BOOTSTRAP_RETRY_ARENA)).flatMap(function([key, value]): QueuedStaple[] {
			const queued = queuedOf(key, value);
			if (queued === undefined) {
				return([]);
			}
			return([queued]);
		}));
	}

	async put(entry: QueuedStaple): Promise<void> {
		const stored: StoredQueued = {
			staple: Buffer.from(entry.bytes).toString('base64'),
			queuedAt: entry.queuedAt,
			code: entry.code,
			reported: entry.reported,
			awaited: storedAwaited(entry.awaited)
		};
		await this.#kv.set(BOOTSTRAP_RETRY_ARENA, entry.key, stored);
	}

	async remove(key: string): Promise<void> {
		await this.#kv.set(BOOTSTRAP_RETRY_ARENA, key, undefined);
	}
}
