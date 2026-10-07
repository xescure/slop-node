import type pg from 'pg';

/*
 * pg reports a connection lost while a client is checked out as an event,
 * which would end the process without a listener; the failing statement
 * reports it instead. The pool stops listening at checkout.
 */
function ignoreConnectionError(): void {
	// The failing statement carries the error.
}

/** Checks a connection out of the pool, listening for its errors until it is checked in. */
export async function checkOut(pool: pg.Pool): Promise<pg.PoolClient> {
	const client = await pool.connect();
	client.on('error', ignoreConnectionError);
	return(client);
}

/**
 * Returns the connection to the pool, or closes it when its session may
 * still hold a transaction or a lock: closing a session rolls back the one
 * and releases the other.
 */
export function checkIn(client: pg.PoolClient, close: boolean): void {
	client.removeListener('error', ignoreConnectionError);
	client.release(close);
}
