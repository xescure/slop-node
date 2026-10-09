import * as KeetaNet from '@keetanetwork/keetanet-client';
import type pg from 'pg';
import type { BootstrapStage, StagedCounts, StagedStaple } from '../ledger/storage/stage.js';
import { BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RETRY_ARENA } from '../node/bootstrap-cursors.js';
import { stagedOf } from '../node/bootstrap-stage.js';
import { heldStaplesOf } from './follower-store.js';

const lib = KeetaNet.lib;

/**
 * How many staples a restage reads and stages at a time. Each is decoded on
 * its own and dropped before the next, as a decoded staple of the main
 * network takes up to about forty times its bytes.
 */
const RESTAGE_BATCH = 200;

/**
 * The arenas of the bootstrap's state that a restage keeps: where it reached
 * on each peer and the ranges it reads. Every staple read from those is held,
 * deferred or queued, and the restage stages each of them, so what the state
 * says was read stays read. The retry queue's staples are staged instead, and
 * no pass had completed while ranges were read.
 */
export const RESTAGED_ARENAS: readonly string[] = [BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RANGES_ARENA];

/** What a restage read from each place a staple was kept, and what it staged in all. */
export type Restaged = {
	readonly held: number;
	readonly deferred: number;
	readonly queued: number;
	readonly staged: StagedCounts;
	/** The staples it read, each once: the stage must hold as many. */
	readonly distinct: number;
};

const MAIN_STAPLES_AFTER = `
	SELECT sequence, blocks_hash, staple_time, bytes FROM staples
	WHERE sequence > $1::bigint ORDER BY sequence LIMIT $2`;

const DEFERRED_STAPLES_AFTER = `
	SELECT blocks_hash, bytes, latest_vote_from FROM deferred_staples
	WHERE blocks_hash > $1 ORDER BY blocks_hash LIMIT $2`;

const QUEUED_STAPLES = 'SELECT key, value->>\'staple\' AS staple FROM kv_entries WHERE arena = $1 ORDER BY key';

const KEPT_ENTRIES = 'SELECT arena, key, value::text AS value FROM kv_entries WHERE arena = ANY($1) AND expires_at IS NULL ORDER BY arena, key';

const KEEP_ENTRY = `
	INSERT INTO kv_entries (arena, key, value) VALUES ($1, $2, $3::json)
	ON CONFLICT (arena, key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL`;

function arrayBufferOf(bytes: Buffer): ArrayBuffer {
	return(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/**
 * Decodes the staple as the node adding it from the stage will, so that a
 * staple it could not read back is found here, while the database it came
 * from is whole.
 */
function readBack(bytes: ArrayBuffer): StagedStaple {
	return(stagedOf(new lib.Vote.Staple(bytes)));
}

/**
 * Stages every staple a follower's database holds on its main ledger, has
 * deferred, or has queued for retry, as the bytes it holds them as, into the
 * stage of another database, with the bootstrap's progress and ranges, so
 * that a node on that database adds them again in the order of their votes.
 * The source is only read. The progress hears the totals after each batch.
 */
export async function restage(source: pg.Pool, stage: BootstrapStage, target: pg.Pool, progress: (done: Restaged) => void): Promise<Restaged> {
	const keys = new Set<string>();
	let done: Restaged = { held: 0, deferred: 0, queued: 0, staged: { staples: 0, bytes: 0 }, distinct: 0 };
	const stageAll = async function(staples: readonly StagedStaple[]): Promise<StagedCounts> {
		for (const staple of staples) {
			keys.add(staple.key);
		}
		const kept = await stage.put(staples);
		return({ staples: done.staged.staples + kept.staples, bytes: done.staged.bytes + kept.bytes });
	};
	let sequence = '0';
	for (;;) {
		const rows = (await source.query<{ sequence: string; blocks_hash: Buffer; staple_time: Date; bytes: Buffer | null }>(MAIN_STAPLES_AFTER, [sequence, RESTAGE_BATCH])).rows;
		const last = rows.at(-1);
		if (last === undefined) {
			break;
		}
		const held: StagedStaple[] = [];
		for (const row of rows) {
			if (row.bytes === null) {
				const [rebuilt] = await heldStaplesOf(source, [row]);
				if (rebuilt === undefined) {
					throw(new Error(`the staple ${row.blocks_hash.toString('hex')} could not be rebuilt`));
				}
				held.push(readBack(rebuilt.staple.toBytes()));
			} else {
				held.push(readBack(arrayBufferOf(row.bytes)));
			}
		}
		done = { ...done, held: done.held + held.length, staged: await stageAll(held), distinct: keys.size };
		progress(done);
		sequence = last.sequence;
	}
	let after = Buffer.alloc(0);
	for (;;) {
		const rows = (await source.query<{ blocks_hash: Buffer; bytes: Buffer }>(DEFERRED_STAPLES_AFTER, [after, RESTAGE_BATCH])).rows;
		const last = rows.at(-1);
		if (last === undefined) {
			break;
		}
		const deferred = rows.map(function(row): StagedStaple {
			return(readBack(arrayBufferOf(row.bytes)));
		});
		done = { ...done, deferred: done.deferred + deferred.length, staged: await stageAll(deferred), distinct: keys.size };
		progress(done);
		after = last.blocks_hash;
	}
	const queued = (await source.query<{ key: string; staple: string | null }>(QUEUED_STAPLES, [BOOTSTRAP_RETRY_ARENA])).rows.map(function(row): StagedStaple {
		if (row.staple === null) {
			throw(new Error(`the queued staple ${row.key} holds no bytes`));
		}
		return(readBack(arrayBufferOf(Buffer.from(row.staple, 'base64'))));
	});
	done = { ...done, queued: queued.length, staged: await stageAll(queued), distinct: keys.size };
	progress(done);
	for (const entry of (await source.query<{ arena: string; key: string; value: string }>(KEPT_ENTRIES, [RESTAGED_ARENAS])).rows) {
		await target.query(KEEP_ENTRY, [entry.arena, entry.key, entry.value]);
	}
	const counts = await stage.counts();
	if (counts.staples !== done.distinct) {
		throw(new Error(`the stage holds ${String(counts.staples)} staples, but ${String(done.distinct)} were read`));
	}
	return(done);
}
