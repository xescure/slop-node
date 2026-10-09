import { afterEach, describe, expect, inject, test, vi } from 'vitest';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { ChainCursor, GENESIS_MOMENT, requireAt } from '../ledger/storage/suite/support.js';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import { BOOTSTRAP_CAUGHT_UP_ARENA, BOOTSTRAP_CURSOR_ARENA, BOOTSTRAP_RANGES_ARENA, BOOTSTRAP_RETRY_ARENA } from '../node/bootstrap-cursors.js';
import { stagedOf } from '../node/bootstrap-stage.js';
import { confirmedStaple, sendBlock } from '../testing/blocks.js';
import { advanceClock, createTestNetwork, freezeClock } from '../testing/network.js';
import { createDatabase } from '../testing/postgres.js';
import type { TestDatabase } from '../testing/postgres.js';
import { restage } from './restage.js';
import type { Restaged } from './restage.js';

const databases: TestDatabase[] = [];
const storages: PostgresLedgerStorage[] = [];

afterEach(async function() {
	vi.useRealTimers();
	await Promise.all(storages.splice(0).map(function(storage) {
		return(storage.destroy());
	}));
	await Promise.all(databases.splice(0).map(function(database) {
		return(database.drop());
	}));
});

async function ledgerDatabase(): Promise<{ readonly database: TestDatabase; readonly storage: PostgresLedgerStorage }> {
	const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	databases.push(database);
	const storage = new PostgresLedgerStorage({ kind: 'connection-string', connectionString: database.connectionString });
	storages.push(storage);
	return({ database, storage });
}

function keysOf(staples: readonly VoteStaple[]): string[] {
	return(staples.map(function(staple): string {
		return(staple.blocksHash.toString());
	}).sort());
}

describe('restaging a follower', function() {
	test('stages every staple the ledger holds, has deferred or queued, as the bytes it holds, with the bootstrap\'s progress and ranges, and leaves the source as it was', async function() {
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: [1000n, 1000n] });
		const source = await ledgerDatabase();
		const ledger = network.createLedger(source.storage, requireAt(network.representatives, 0));
		const user = requireAt(network.users, 0);
		const cursor = new ChainCursor(network.genesis);
		const held: VoteStaple[] = [network.genesis];
		await ledger.add(network.genesis);
		for (let index = 0; index < 3; index++) {
			advanceClock(1000);
			const block = cursor.append(await sendBlock({ from: user, to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, previous: cursor.previous(user), network: network.network }));
			const staple = await confirmedStaple([block], network.representatives);
			await ledger.add(staple);
			held.push(staple);
		}
		// A send whose previous the ledger lacks is deferred, and one more is queued for retry as a refused staple is.
		const skipped = await sendBlock({ from: user, to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, previous: cursor.previous(user), network: network.network });
		const deferred = await confirmedStaple([await sendBlock({ from: user, to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, previous: skipped.hash, network: network.network })], network.representatives);
		expect(await ledger.add(deferred)).toEqual([]);
		const queued = await confirmedStaple([await sendBlock({ from: requireAt(network.users, 1), to: user, amount: 1n, token: network.baseToken, previous: network.genesis.blocks[0]?.hash ?? skipped.hash, network: network.network })], network.representatives);
		const pool = source.database.pool();
		// A staple stored before its bytes were kept is rebuilt from its rows.
		await pool.query('UPDATE staples SET bytes = NULL WHERE blocks_hash = $1', [Buffer.from(requireAt(held, 1).blocksHash.toString(), 'hex')]);
		const entries: readonly [string, string, unknown][] = [
			[BOOTSTRAP_CURSOR_ARENA, 'https://rep1.example/api', { reached: 5000 }],
			[BOOTSTRAP_RANGES_ARENA, 'layout', { from: 1000, ranges: [] }],
			[BOOTSTRAP_CAUGHT_UP_ARENA, 'horizon', 4000],
			[BOOTSTRAP_RETRY_ARENA, queued.blocksHash.toString(), { staple: Buffer.from(queued.toBytes()).toString('base64'), queuedAt: 0, code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT', reported: false }]
		];
		for (const [arena, key, value] of entries) {
			await pool.query('INSERT INTO kv_entries (arena, key, value) VALUES ($1, $2, $3)', [arena, key, JSON.stringify(value)]);
		}
		const target = await ledgerDatabase();
		const progress: Restaged[] = [];

		const done = await restage(pool, target.storage.bootstrapStage(), target.database.pool(), function(each) {
			progress.push(each);
		});

		const everything = [...held, deferred, queued];
		expect(done).toEqual({ held: 4, deferred: 1, queued: 1, staged: { staples: 6, bytes: expect.any(Number) as number }, distinct: 6 });
		expect(progress.at(-1)).toEqual(done);
		const staged = await target.storage.bootstrapStage().firstBefore(new Date(8.64e15), 100);
		expect(staged.map(function(each): string {
			return(each.key);
		}).sort()).toEqual(keysOf(everything));
		for (const staple of [...held.slice(2), deferred, queued]) {
			expect(staged).toContainEqual(stagedOf(staple));
		}
		const kept = await target.database.pool().query<{ arena: string; key: string; value: unknown }>('SELECT arena, key, value FROM kv_entries ORDER BY arena');
		expect(kept.rows).toEqual([
			{ arena: BOOTSTRAP_CURSOR_ARENA, key: 'https://rep1.example/api', value: { reached: 5000 } },
			{ arena: BOOTSTRAP_RANGES_ARENA, key: 'layout', value: { from: 1000, ranges: [] } }
		]);
		const left = await pool.query<{ count: string }>('SELECT (SELECT count(*) FROM staples) + (SELECT count(*) FROM deferred_staples) + (SELECT count(*) FROM kv_entries) AS count');
		expect(left.rows).toEqual([{ count: String(held.length + 1 + entries.length) }]);
	});
});
