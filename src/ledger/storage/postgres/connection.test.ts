import { describe, expect, inject, onTestFinished, test } from 'vitest';
import type pg from 'pg';
import { createDatabase } from '../../../testing/postgres.js';
import { checkIn, checkOut } from './connection.js';

const poolOfOne = async function(): Promise<pg.Pool> {
	const database = await createDatabase(inject('postgresCluster'));
	const pool = database.pool({ max: 1 });
	onTestFinished(async function() {
		await pool.end();
		await database.drop();
	});
	return(pool);
};

/** The listener checkOut added, which it adds after every listener the pool has. */
const listenerOfCheckOut = function(client: pg.PoolClient): unknown {
	return(client.listeners('error').at(-1));
};

describe('checking connections out and in', function() {
	test('a connection checked in to the pool stops listening for its errors, however often it is checked out', async function() {
		const pool = await poolOfOne();
		const first = await checkOut(pool);
		const listening = first.listenerCount('error');
		const listener = listenerOfCheckOut(first);

		checkIn(first, false);

		expect(first.listeners('error')).not.toContain(listener);
		for (let checkout = 0; checkout < 3; checkout++) {
			const again = await checkOut(pool);
			expect(again).toBe(first);
			expect(again.listenerCount('error')).toBe(listening);
			checkIn(again, false);
		}
	});

	test('a connection closed at check-in keeps listening for its errors, so a late one does not end the process', async function() {
		const pool = await poolOfOne();
		const client = await checkOut(pool);
		const listener = listenerOfCheckOut(client);

		checkIn(client, true);

		expect(client.listeners('error')).toContain(listener);
		expect(client.emit('error', new Error('the server ended the session'))).toBe(true);
	});
});
