import { describe, expect, inject, onTestFinished, test } from 'vitest';
import pg from 'pg';
import { DEFAULT_SQL_LIMITS, runFixedQueries, runReadOnlySQL, toJSONValue } from './sql.js';
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

const refusalOf = function(answer: SQLAnswer): Extract<SQLAnswer, { kind: 'refused' }> {
	if (answer.kind !== 'refused') {
		throw(new Error(`Expected a refusal, got ${JSON.stringify(answer)}`));
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

	test('refuses a row over the byte cap before any of it is sent, and serves the next call', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		const answer = await runReadOnlySQL(reader, `SELECT repeat('x', 101) AS text`, limits({ byteCap: 100 }));
		expect(answer).toEqual({ kind: 'refused', reason: 'byte-cap', message: 'a row of 103 bytes is over the cap of 100 bytes' });
		expect(rowsOf(await runReadOnlySQL(reader, 'SELECT 1 AS one', DEFAULT_SQL_LIMITS)).rows).toEqual([{ one: 1 }]);
	});

	test.each([
		`SELECT repeat('x', 101) AS t) AS q UNION ALL SELECT t FROM (SELECT 'y' AS t`,
		`SELECT repeat('x', 101) AS t) AS q EXCEPT SELECT t FROM (SELECT 'y' AS t`,
		`SELECT 1 AS one) AS p, (SELECT 1`
	])('refuses text that closes the guard\'s parentheses to put rows outside it: %s', async function(sql) {
		const { reader } = await explorerDatabase();
		expect(await runReadOnlySQL(reader, sql, limits({ byteCap: 100 }))).toMatchObject({ kind: 'refused', reason: 'sql-error' });
	});

	test('measures a row of bytes by the hex it is written in', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, `SELECT decode(repeat('ab', 1500000), 'hex') AS bytes`, DEFAULT_SQL_LIMITS);
		expect(answer).toMatchObject({ kind: 'refused', reason: 'byte-cap' });
	});

	test('stops many rows that each fit at the byte cap of their total', async function() {
		const { reader } = await explorerDatabase();
		const answer = rowsOf(await runReadOnlySQL(reader, `SELECT n, repeat('x', 100000) AS text FROM generate_series(1, 50) AS n`, DEFAULT_SQL_LIMITS));
		expect(answer.truncated).toBe('byte-cap');
		expect(answer.rows).toHaveLength(19);
		expect(answer.rows.at(-1)).toMatchObject({ n: 19 });
	});

	test('reads a column named q, the name of the wrapping subquery', async function() {
		const { reader } = await explorerDatabase();
		const answer = rowsOf(await runReadOnlySQL(reader, 'SELECT 1 AS q, 2 AS r', DEFAULT_SQL_LIMITS));
		expect(answer.rows).toEqual([{ q: 1, r: 2 }]);
	});

	test('returns json as its exact text', async function() {
		const { reader } = await explorerDatabase();
		const answer = rowsOf(await runReadOnlySQL(reader, `SELECT jsonb_build_object('amount', 1000000000000000000000000000001::numeric) AS j, json_build_array(1, 'a') AS k, ARRAY[jsonb_build_object('amount', 1000000000000000000000000000001::numeric), NULL] AS l, ARRAY[ARRAY['1'::json], ARRAY['"a"'::json]] AS m`, DEFAULT_SQL_LIMITS));
		expect(answer.rows).toEqual([{ j: '{"amount": 1000000000000000000000000000001}', k: '[1, "a"]', l: ['{"amount": 1000000000000000000000000000001}', null], m: [['1'], ['"a"']] }]);
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

	test('refuses two statements, which the simple protocol would run one after the other', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'select 1; select 2', DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'refused', reason: 'sql-error', message: 'cannot insert multiple commands into a prepared statement' });
	});

	test('refuses a write and leaves the data as it was', async function() {
		const { reader, admin } = await explorerDatabase();
		await withHoldings(admin);
		const answer = await runReadOnlySQL(reader, 'WITH d AS (DELETE FROM explorer.holdings RETURNING 1) SELECT * FROM d', DEFAULT_SQL_LIMITS);
		expect(refusalOf(answer)).toEqual({ kind: 'refused', reason: 'sql-error', message: 'DECLARE CURSOR must not contain data-modifying statements in WITH' });
		const count = await admin.query<{ count: string }>('SELECT count(*) FROM explorer.holdings');
		expect(count.rows[0]?.count).toBe(String(HOLDERS.length));
	});

	test('runs the query in a read-only transaction', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT lo_create(0)', DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'refused', reason: 'sql-error', message: 'cannot execute lo_create() in a read-only transaction' });
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

	test('stops a query that lifts its own timeout', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, `SELECT set_config('statement_timeout', '0', true), pg_sleep(1)`, DEFAULT_SQL_LIMITS, 200);
		expect(answer).toMatchObject({ kind: 'refused', reason: 'timeout' });
	});

	test('bounds the whole call by the timeout, not each batch of rows it fetches', async function() {
		const { reader } = await explorerDatabase();
		// Each batch of ten rows sleeps 1.8 s, under the timeout, so a second
		// batch given the whole timeout again would end the call after 3.6 s.
		const started = performance.now();
		const answer = await runReadOnlySQL(reader, 'SELECT n, pg_sleep(0.18) FROM generate_series(1, 60) AS n', DEFAULT_SQL_LIMITS, 2_000);
		expect(answer).toMatchObject({ kind: 'refused', reason: 'timeout' });
		expect(performance.now() - started).toBeLessThan(3_200);
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

describe('runFixedQueries', function() {
	test('answers each parameterized query in order, amounts exact and json as its text', async function() {
		const { admin, reader } = await explorerDatabase();
		await withHoldings(admin);
		const answer = await runFixedQueries(reader, [
			{ text: 'SELECT account, amount FROM explorer.holders WHERE token_id = explorer.id_of($1) ORDER BY amount DESC LIMIT $2', values: [TOKEN, 2] },
			{ text: `SELECT $1::jsonb AS details`, values: ['{"amount": 123456789012345678901234567890}'] }
		], DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'rows', results: [
			[{ account: 'keeta_holder_one', amount: LARGE_BALANCE }, { account: 'keeta_holder_three', amount: '2' }],
			[{ details: '{"amount": 123456789012345678901234567890}' }]
		] });
	});

	test('runs read-only and refuses a write with its error', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runFixedQueries(reader, [{ text: 'SELECT pg_advisory_xact_lock(1)', values: [] }, { text: 'DELETE FROM explorer.holdings', values: [] }], DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'refused', reason: 'sql-error', message: 'cannot execute DELETE in a read-only transaction' });
	});

	test('stops at the default timeout', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runFixedQueries(reader, [{ text: 'SELECT pg_sleep(2)', values: [] }], limits({ timeoutMilliseconds: 200 }));
		expect(answer).toMatchObject({ kind: 'refused', reason: 'timeout' });
	});

	test('leaves no setting behind on the connection', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		await runFixedQueries(reader, [{ text: `SELECT set_config('application_name', 'left behind', false)`, values: [] }], DEFAULT_SQL_LIMITS);
		expect(rowsOf(await runReadOnlySQL(reader, `SELECT current_setting('application_name') AS name`, DEFAULT_SQL_LIMITS)).rows).toEqual([{ name: '' }]);
	});
});
