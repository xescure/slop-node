import { describe, expect, inject, onTestFinished, test } from 'vitest';
import pg from 'pg';
import { DEFAULT_SQL_LIMITS, runReadOnlySQL, toJSONValue } from './sql.js';
import type { SQLAnswer, SQLLimits } from './sql.js';
import { explorerDatabase } from './testing.js';

const TOKEN = 'keeta_token_fixture';

const HOLDERS = ['keeta_holder_one', 'keeta_holder_two', 'keeta_holder_three'] as const;

const LARGE_BALANCE = '123456789012345678901234567890';

const withHoldings = async function(admin: pg.Pool): Promise<void> {
	await admin.query(`INSERT INTO public.accounts (public_key, key_type) VALUES ($1, 3)`, [TOKEN]);
	const balances = [LARGE_BALANCE, '1', '2'];
	for (const [index, holder] of HOLDERS.entries()) {
		await admin.query(`INSERT INTO public.accounts (public_key, key_type) VALUES ($1, 0)`, [holder]);
		await admin.query(`
			INSERT INTO explorer.holdings (token_id, account_id, balance)
			SELECT token.id, holder.id, $3::numeric
			FROM public.accounts token, public.accounts holder
			WHERE token.public_key = $1 AND holder.public_key = $2
		`, [TOKEN, holder, balances[index]]);
	}
};

/** A reader pool of one connection, so every call reuses the connection the call before it left behind. */
const singleReader = function(databaseName: string): pg.Pool {
	const cluster = inject('postgresCluster');
	const pool = new pg.Pool({ host: cluster.socketDirectory, port: cluster.port, user: 'explorer_reader', database: databaseName, max: 1 });
	pool.on('error', function() {
		// Dropping the database terminates idle connections; the pool discards them.
	});
	onTestFinished(function() {
		return(pool.end());
	});
	return(pool);
};

const rowsOf = function(answer: SQLAnswer): Extract<SQLAnswer, { kind: 'rows' }> {
	if (answer.kind !== 'rows') {
		throw(new Error(`Expected rows, got ${JSON.stringify(answer)}`));
	}
	return(answer);
};

const limits = function(overrides: Partial<SQLLimits>): SQLLimits {
	return({ ...DEFAULT_SQL_LIMITS, ...overrides });
};

describe('toJSONValue', function() {
	test('keeps numeric strings, writes bigints in decimal, bytes as upper-case hex and dates in ISO', function() {
		expect(toJSONValue(LARGE_BALANCE)).toBe(LARGE_BALANCE);
		expect(toJSONValue(2n ** 70n)).toBe('1180591620717411303424');
		expect(toJSONValue(Buffer.from([0xab, 0x01]))).toBe('AB01');
		expect(toJSONValue(new Date('2026-10-20T01:02:03.004Z'))).toBe('2026-10-20T01:02:03.004Z');
		expect(toJSONValue(null)).toBeNull();
		expect(toJSONValue(undefined)).toBeNull();
		expect(toJSONValue(true)).toBe(true);
		expect(toJSONValue(1.5)).toBe(1.5);
	});

	test('converts arrays and objects member by member', function() {
		expect(toJSONValue([1n, { at: new Date(0), bytes: Buffer.from([1]) }])).toEqual(['1', { at: '1970-01-01T00:00:00.000Z', bytes: '01' }]);
	});

	test('keeps a key named __proto__ as an ordinary key', function() {
		const value = toJSONValue(JSON.parse('{"__proto__": {"polluted": 1}}'));
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.keys(value ?? {})).toEqual(['__proto__']);
	});

	test('writes values JSON cannot carry as text', function() {
		expect(toJSONValue(Number.NaN)).toBe('NaN');
		expect(toJSONValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
		expect(toJSONValue(new Date(Number.NaN))).toBe('Invalid Date');
		expect(toJSONValue(new Uint16Array([1, 2]))).toBe('1,2');
	});
});

describe('runReadOnlySQL', function() {
	test('reads the holders view with amounts as exact decimal strings', async function() {
		const { reader, admin } = await explorerDatabase();
		await withHoldings(admin);
		const answer = rowsOf(await runReadOnlySQL(reader, `SELECT account, amount FROM holders WHERE token = '${TOKEN}' ORDER BY amount DESC;`, DEFAULT_SQL_LIMITS));
		expect(answer.columns).toEqual(['account', 'amount']);
		expect(answer.rows).toEqual([
			{ account: 'keeta_holder_one', amount: LARGE_BALANCE },
			{ account: 'keeta_holder_three', amount: '2' },
			{ account: 'keeta_holder_two', amount: '1' }
		]);
		expect(answer.truncated).toBeNull();
		expect(answer.milliseconds).toBeGreaterThanOrEqual(0);
	});

	test('gives the columns of a query that returns no rows', async function() {
		const { reader } = await explorerDatabase();
		const answer = rowsOf(await runReadOnlySQL(reader, 'SELECT 1 AS one, 2 AS two WHERE false', DEFAULT_SQL_LIMITS));
		expect(answer.columns).toEqual(['one', 'two']);
		expect(answer.rows).toEqual([]);
	});

	test('stops at the row cap and says so', async function() {
		const { reader } = await explorerDatabase();
		const answer = rowsOf(await runReadOnlySQL(reader, 'SELECT n FROM (VALUES (1), (2), (3)) AS v(n) ORDER BY n', limits({ rowCap: 2 })));
		expect(answer.rows).toEqual([{ n: 1 }, { n: 2 }]);
		expect(answer.truncated).toBe('row-cap');
	});

	test('returns every row when there are exactly as many as the cap', async function() {
		const { reader } = await explorerDatabase();
		const answer = rowsOf(await runReadOnlySQL(reader, 'SELECT n FROM (VALUES (1), (2)) AS v(n) ORDER BY n', limits({ rowCap: 2 })));
		expect(answer.rows).toEqual([{ n: 1 }, { n: 2 }]);
		expect(answer.truncated).toBeNull();
	});

	test('stops before the row that would pass the byte cap and says so', async function() {
		const { reader } = await explorerDatabase();
		const row = JSON.stringify({ text: 'x'.repeat(100) });
		const answer = rowsOf(await runReadOnlySQL(reader, `SELECT repeat('x', 100) AS text FROM generate_series(1, 5)`, limits({ byteCap: Buffer.byteLength(row) * 2 })));
		expect(answer.rows).toHaveLength(2);
		expect(answer.truncated).toBe('byte-cap');
	});

	test('keeps every row that fits the byte cap exactly', async function() {
		const { reader } = await explorerDatabase();
		const row = JSON.stringify({ text: 'x'.repeat(100) });
		const answer = rowsOf(await runReadOnlySQL(reader, `SELECT repeat('x', 100) AS text FROM generate_series(1, 2)`, limits({ byteCap: Buffer.byteLength(row) * 2 })));
		expect(answer.rows).toHaveLength(2);
		expect(answer.truncated).toBeNull();
	});

	test('keeps a column named __proto__ as an ordinary column', async function() {
		const { reader } = await explorerDatabase();
		const answer = rowsOf(await runReadOnlySQL(reader, 'SELECT 1 AS "__proto__"', DEFAULT_SQL_LIMITS));
		const [row] = answer.rows;
		expect(Object.keys(row ?? {})).toEqual(['__proto__']);
		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
	});

	test('writes an interval as an ISO 8601 duration', async function() {
		const { reader } = await explorerDatabase();
		const answer = rowsOf(await runReadOnlySQL(reader, `SELECT interval '1 hour 30 minutes' AS lag`, DEFAULT_SQL_LIMITS));
		expect(answer.rows).toEqual([{ lag: 'P0Y0M0DT1H30M0S' }]);
	});

	test('refuses two columns of one name, which one row cannot hold', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT 1 AS a, 2 AS a', DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'refused', reason: 'sql-error', message: 'column "a" appears more than once; give each column its own name' });
	});

	test('runs a query that ends in a line comment', async function() {
		const { reader } = await explorerDatabase();
		const answer = rowsOf(await runReadOnlySQL(reader, 'SELECT 1 AS one -- note', DEFAULT_SQL_LIMITS));
		expect(answer.rows).toEqual([{ one: 1 }]);
	});

	test('refuses a query whose semicolon is followed by a comment as a second statement', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT 1 AS one; -- note', DEFAULT_SQL_LIMITS);
		expect(answer).toMatchObject({ kind: 'refused', reason: 'sql-error' });
	});

	test('refuses two statements', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'select 1; select 2', DEFAULT_SQL_LIMITS);
		expect(answer).toMatchObject({ kind: 'refused', reason: 'sql-error' });
	});

	test('runs the user text as a prepared statement, where two statements cannot be parsed', async function() {
		const { reader } = await explorerDatabase();
		// The closing parenthesis would make this one valid wrapped query in the simple protocol.
		const answer = await runReadOnlySQL(reader, 'SELECT 1) AS a; SELECT * FROM (SELECT 2', DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'refused', reason: 'sql-error', message: 'cannot insert multiple commands into a prepared statement' });
	});

	test('refuses a write and leaves the data as it was', async function() {
		const { reader, admin } = await explorerDatabase();
		await withHoldings(admin);
		const answer = await runReadOnlySQL(reader, 'WITH d AS (DELETE FROM explorer.holdings RETURNING 1) SELECT * FROM d', DEFAULT_SQL_LIMITS);
		expect(answer).toMatchObject({ kind: 'refused', reason: 'sql-error' });
		const count = await admin.query<{ count: string }>('SELECT count(*) FROM explorer.holdings');
		expect(count.rows[0]?.count).toBe(String(HOLDERS.length));
	});

	test('refuses the node tables', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT * FROM public.balances', DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'refused', reason: 'sql-error', message: 'permission denied for table balances' });
	});

	test('gives the position of an error in the text that was sent', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT 1 FROM nowhere', DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'refused', reason: 'sql-error', message: 'relation "nowhere" does not exist (at character 15)' });
	});

	test('stops a query at the requested timeout', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT pg_sleep(2)', DEFAULT_SQL_LIMITS, 200);
		expect(answer).toEqual({ kind: 'refused', reason: 'timeout', message: 'canceling statement due to statement timeout' });
	});

	test('stops a query at the default timeout', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT pg_sleep(2)', limits({ timeoutMilliseconds: 200 }));
		expect(answer).toMatchObject({ kind: 'refused', reason: 'timeout' });
	});

	test('holds a requested timeout above the maximum to the maximum', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT pg_sleep(1)', limits({ maxTimeoutMilliseconds: 300 }), 60_000);
		expect(answer).toMatchObject({ kind: 'refused', reason: 'timeout' });
	});

	test('holds a default timeout above the maximum to the maximum', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT pg_sleep(1)', limits({ timeoutMilliseconds: 60_000, maxTimeoutMilliseconds: 300 }));
		expect(answer).toMatchObject({ kind: 'refused', reason: 'timeout' });
	});

	test.each([0, -5, Number.NaN, 0.4])('never lifts the timeout for a requested timeout of %d', async function(requested) {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT pg_sleep(1)', limits({ timeoutMilliseconds: 200, maxTimeoutMilliseconds: 300 }), requested);
		expect(answer).toMatchObject({ kind: 'refused', reason: 'timeout' });
	});

	test('leaves no setting a query changed to the next call on the connection', async function() {
		const { database, admin } = await explorerDatabase();
		const reader = singleReader(database.name);
		rowsOf(await runReadOnlySQL(reader, `SELECT set_config('statement_timeout', '0', false)`, DEFAULT_SQL_LIMITS));
		expect(await runReadOnlySQL(reader, 'SELECT pg_sleep(1)', limits({ timeoutMilliseconds: 200 }))).toMatchObject({ kind: 'refused', reason: 'timeout' });
		// A setting outside the transaction would also outlive a rollback.
		rowsOf(await runReadOnlySQL(reader, `SELECT set_config('application_name', 'left behind', false)`, DEFAULT_SQL_LIMITS));
		const names = await admin.query<{ name: string }>(`SELECT application_name AS name FROM pg_stat_activity WHERE usename = 'explorer_reader' AND datname = current_database()`);
		expect(names.rows.map(function(row) {
			return(row.name);
		})).not.toContain('left behind');
	});

	test('releases an advisory lock a query took', async function() {
		const { database, admin } = await explorerDatabase();
		const reader = singleReader(database.name);
		rowsOf(await runReadOnlySQL(reader, 'SELECT pg_advisory_lock(42)', DEFAULT_SQL_LIMITS));
		const taken = await admin.query<{ taken: boolean }>('SELECT pg_try_advisory_lock(42) AS taken');
		expect(taken.rows[0]?.taken).toBe(true);
	});

	test('releases an advisory lock a query took before it timed out', async function() {
		const { database, admin } = await explorerDatabase();
		const reader = singleReader(database.name);
		const answer = await runReadOnlySQL(reader, 'SELECT pg_advisory_lock(43), pg_sleep(2)', DEFAULT_SQL_LIMITS, 200);
		expect(answer).toMatchObject({ kind: 'refused', reason: 'timeout' });
		const taken = await admin.query<{ taken: boolean }>('SELECT pg_try_advisory_lock(43) AS taken');
		expect(taken.rows[0]?.taken).toBe(true);
	});

	test('discards a connection that could not be cleaned and serves the next call on a fresh one', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		const ended = await runReadOnlySQL(reader, 'SELECT pg_terminate_backend(pg_backend_pid())', DEFAULT_SQL_LIMITS);
		expect(ended).toMatchObject({ kind: 'refused', reason: 'sql-error' });
		expect(rowsOf(await runReadOnlySQL(reader, 'SELECT 1 AS one', DEFAULT_SQL_LIMITS)).rows).toEqual([{ one: 1 }]);
	});

	test.each(['', ';', '  ;  ', '\n\t'])('refuses the empty query %j', async function(sql) {
		const { reader } = await explorerDatabase();
		expect(await runReadOnlySQL(reader, sql, DEFAULT_SQL_LIMITS)).toMatchObject({ kind: 'refused', reason: 'empty' });
	});
});
