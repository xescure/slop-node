import { describe, expect, inject, onTestFinished, test, vi } from 'vitest';
import pg from 'pg';
import { DEFAULT_SQL_LIMITS, MessageFrames, OversizedMessage, boundedReaderOptions, messageBoundOf, runFixedQueries, runReadOnlySQL, toJSONValue } from './sql.js';
import type { SQLAnswer, SQLLimits } from './sql.js';
import { interceptQueries, serverError } from '../testing/query-faults.js';
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

/**
 * A pool of one connection, so every call reuses the connection the call
 * before it left behind. The reader by default; the cluster's superuser for
 * the functions the reader is refused, to show that the runner also cleans
 * up after what they leave behind.
 */
const singleReader = function(databaseName: string, user = 'explorer_reader', options: pg.PoolConfig = {}): pg.Pool {
	const cluster = inject('postgresCluster');
	const pool = new pg.Pool({ ...options, host: cluster.socketDirectory, port: cluster.port, user, database: databaseName, max: 1 });
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

/** A reader of one connection that takes no backend message longer than the bound of these limits. */
const boundedReader = function(databaseName: string, bounded: SQLLimits): pg.Pool {
	return(singleReader(databaseName, 'explorer_reader', boundedReaderOptions(messageBoundOf(bounded))));
};

const superuserOf = function(): string {
	return(inject('postgresCluster').user);
};

/** A backend message of the given type whose length field says it is the given length. */
const message = function(type: string, length: number, body = Buffer.alloc(Math.max(0, length - 4))): Buffer {
	const header = Buffer.alloc(5);
	header.write(type, 0, 'latin1');
	header.writeUInt32BE(length >>> 0, 1);
	return(Buffer.concat([header, body]));
};

const byteChunks = function(buffer: Buffer): Buffer[] {
	return(Array.from(buffer, function(byte) {
		return(Buffer.from([byte]));
	}));
};

const firstOverBound = function(frames: MessageFrames, chunks: readonly Buffer[]): number | undefined {
	for (const chunk of chunks) {
		const length = frames.overBound(chunk);
		if (length !== undefined) {
			return(length);
		}
	}
	return(undefined);
};

describe('MessageFrames', function() {
	test('passes messages up to the bound and finds the first over it', function() {
		const frames = new MessageFrames(10);
		expect(frames.overBound(Buffer.concat([message('D', 10), message('C', 4), message('E', 11), message('Z', 5)]))).toBe(11);
	});

	test('follows messages whose headers and bodies are split across chunks', function() {
		const frames = new MessageFrames(10);
		const chunks = byteChunks(Buffer.concat([message('D', 10), message('C', 7), message('E', 11)]));
		// The last message's header is the 20th to the 24th byte.
		expect(firstOverBound(frames, chunks.slice(0, 23))).toBeUndefined();
		expect(frames.overBound(Buffer.alloc(0))).toBeUndefined();
		expect(firstOverBound(frames, chunks.slice(23))).toBe(11);
	});

	test('reads a body that holds what looks like a header as the body it is', function() {
		const frames = new MessageFrames(10);
		const body = message('E', 0xffffff, Buffer.alloc(0));
		expect(frames.overBound(Buffer.concat([message('D', 9, body), message('Z', 5)]))).toBeUndefined();
	});

	test('finds a message over the bound whose header ends a chunk', function() {
		const frames = new MessageFrames(10);
		const stream = Buffer.concat([message('D', 6), message('E', 11, Buffer.alloc(0))]);
		expect(frames.overBound(stream.subarray(0, 9))).toBeUndefined();
		expect(frames.overBound(stream.subarray(9))).toBe(11);
	});

	test('names the length and the bound of a message over it', function() {
		const failure = new OversizedMessage(11, 10);
		expect([failure.name, failure.message, failure.bound]).toEqual(['OversizedMessage', 'a backend message declared 11 bytes, over the bound of 10', 10]);
	});

	test('reads a negative length as one over any bound', function() {
		expect(new MessageFrames(10).overBound(message('E', -1, Buffer.alloc(0)))).toBe(0xffffffff);
	});
});

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
		expect(toJSONValue(Symbol('mark'))).toBe('Symbol(mark)');
		expect(toJSONValue(String)).toBe('function String() { [native code] }');
	});

	test('converts an object without a prototype member by member', function() {
		expect(toJSONValue(Object.assign(Object.create(null), { amount: 1n }))).toEqual({ amount: '1' });
	});

	test('writes an object whose toISOString is not a method as its own text', function() {
		class Marked {
			readonly toISOString = 'not a method';

			toString(): string {
				return('marked');
			}
		}
		expect(toJSONValue(new Marked())).toBe('marked');
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

	test('measures the time of the call alone', async function() {
		const { reader } = await explorerDatabase();
		const started = performance.now();
		const answer = rowsOf(await runReadOnlySQL(reader, 'SELECT 1 AS one', DEFAULT_SQL_LIMITS));
		expect(answer.milliseconds).toBeLessThanOrEqual(Math.ceil(performance.now() - started));
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

	test.each([
		['SHOUT 1', 'syntax error at or near "SHOUT" (at character 1)'],
		['  SHOUT 1', 'syntax error at or near "SHOUT" (at character 3)'],
		['SELECT 1 a b', 'syntax error at or near "b" (at character 12)'],
		['SELECT (1', 'syntax error at end of input']
	])('gives the position of an error in %j only when it falls within the text', async function(sql, message) {
		const { reader } = await explorerDatabase();
		expect(await runReadOnlySQL(reader, sql, DEFAULT_SQL_LIMITS)).toEqual({ kind: 'refused', reason: 'sql-error', message });
	});

	test('stops a query at the requested timeout', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runReadOnlySQL(reader, 'SELECT pg_sleep(2)', DEFAULT_SQL_LIMITS, 200);
		expect(answer).toEqual({ kind: 'refused', reason: 'timeout', message: 'canceling statement due to statement timeout' });
	});

	test('sets the timeout before the probe plans the query', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		const issued: string[] = [];
		interceptQueries(reader, function(query, run) {
			issued.push(query.text);
			return(run());
		});
		rowsOf(await runReadOnlySQL(reader, 'SELECT 1 AS one', DEFAULT_SQL_LIMITS, 100));
		expect(issued.slice(0, 3)).toEqual(['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 100', 'DECLARE explorer_probe NO SCROLL CURSOR FOR\nSELECT 1 AS one\n']);
	});

	test('fetches the next batch with the last millisecond of the call', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		let now = 0;
		const clock = vi.spyOn(performance, 'now').mockImplementation(function() {
			return(now);
		});
		onTestFinished(function() {
			clock.mockRestore();
		});
		const timeouts: string[] = [];
		interceptQueries(reader, async function(query, run) {
			if (query.text.startsWith('SET LOCAL statement_timeout')) {
				timeouts.push(query.text);
			}
			// Skipped, so that the FETCH it would bound cannot run out of time on a slow machine.
			if (query.text === 'SET LOCAL statement_timeout = 1') {
				return({});
			}
			const result = await run();
			if (query.text.startsWith('FETCH')) {
				now = 999;
			}
			return(result);
		});
		const answer = rowsOf(await runReadOnlySQL(reader, 'SELECT n FROM generate_series(1, 15) AS n', DEFAULT_SQL_LIMITS, 1_000));
		expect(answer.rows).toHaveLength(15);
		expect(timeouts).toEqual(['SET LOCAL statement_timeout = 1000', 'SET LOCAL statement_timeout = 1000', 'SET LOCAL statement_timeout = 1']);
	});

	test('gives no position for an error the server places in the explorer\'s own text before the query', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		interceptQueries(reader, function(query, run) {
			if (query.text.startsWith('DECLARE explorer_probe')) {
				const error = serverError('42601', 'syntax error');
				error.position = '5';
				return(Promise.reject(error));
			}
			return(run());
		});
		expect(await runReadOnlySQL(reader, 'SELECT 1 AS one', DEFAULT_SQL_LIMITS)).toEqual({ kind: 'refused', reason: 'sql-error', message: 'syntax error' });
	});

	test('discards a connection whose cleaning failed while it was still open', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		let failDiscard = true;
		interceptQueries(reader, function(query, run) {
			if (query.text === 'DISCARD ALL' && failDiscard) {
				failDiscard = false;
				return(Promise.reject(serverError('57014', 'canceling statement due to statement timeout')));
			}
			return(run());
		});
		const pidOf = async function(): Promise<unknown> {
			return(rowsOf(await runReadOnlySQL(reader, 'SELECT pg_backend_pid() AS pid', DEFAULT_SQL_LIMITS)).rows[0]?.['pid']);
		};
		const first = await pidOf();
		expect(await pidOf()).not.toBe(first);
	});

	test('stops a call whose time runs out between batches of rows', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		let offset = 0;
		const now = performance.now.bind(performance);
		const clock = vi.spyOn(performance, 'now').mockImplementation(function() {
			return(now() + offset);
		});
		onTestFinished(function() {
			clock.mockRestore();
		});
		interceptQueries(reader, async function(issued, run) {
			const result = await run();
			if (issued.text.startsWith('FETCH')) {
				offset += 1_000;
			}
			return(result);
		});
		const answer = await runReadOnlySQL(reader, 'SELECT n FROM generate_series(1, 30) AS n', DEFAULT_SQL_LIMITS, 1_000);
		expect(answer).toEqual({ kind: 'refused', reason: 'timeout', message: 'canceling statement due to statement timeout' });
	});

	test('throws a failure that is not the server\'s rather than answer it', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		const failure = new Error('the connection broke');
		interceptQueries(reader, function(issued, run) {
			if (issued.text.startsWith('FETCH')) {
				return(Promise.reject(failure));
			}
			return(run());
		});
		await expect(runReadOnlySQL(reader, 'SELECT 1 AS one', DEFAULT_SQL_LIMITS)).rejects.toBe(failure);
	});

	test('leaves no listener of its own on the connection', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		const listenersOfConnection = async function(): Promise<number> {
			const client = await reader.connect();
			const count = client.listenerCount('error');
			client.release();
			return(count);
		};
		const before = await listenersOfConnection();
		rowsOf(await runReadOnlySQL(reader, 'SELECT 1 AS one', DEFAULT_SQL_LIMITS));
		rowsOf(await runReadOnlySQL(reader, 'SELECT 1 AS one', DEFAULT_SQL_LIMITS));
		expect(await listenersOfConnection()).toBe(before);
	});

	test('stops a query that lifts its own timeout', async function() {
		const { database } = await explorerDatabase();
		const superuser = singleReader(database.name, superuserOf());
		const answer = await runReadOnlySQL(superuser, `SELECT set_config('statement_timeout', '0', true), pg_sleep(1)`, DEFAULT_SQL_LIMITS, 200);
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
		const superuser = singleReader(database.name, superuserOf());
		rowsOf(await runReadOnlySQL(superuser, `SELECT set_config('statement_timeout', '0', false)`, DEFAULT_SQL_LIMITS));
		expect(await runReadOnlySQL(superuser, 'SELECT pg_sleep(1)', limits({ timeoutMilliseconds: 200 }))).toMatchObject({ kind: 'refused', reason: 'timeout' });
		// A setting outside the transaction would also outlive a rollback.
		rowsOf(await runReadOnlySQL(superuser, `SELECT set_config('application_name', 'left behind', false)`, DEFAULT_SQL_LIMITS));
		const names = await admin.query<{ name: string }>(`SELECT application_name AS name FROM pg_stat_activity WHERE datname = current_database()`);
		expect(names.rows.map(function(row) {
			return(row.name);
		})).not.toContain('left behind');
	});

	test('releases an advisory lock a query took', async function() {
		const { database, admin } = await explorerDatabase();
		const superuser = singleReader(database.name, superuserOf());
		rowsOf(await runReadOnlySQL(superuser, 'SELECT pg_advisory_lock(42)', DEFAULT_SQL_LIMITS));
		const taken = await admin.query<{ taken: boolean }>('SELECT pg_try_advisory_lock(42) AS taken');
		expect(taken.rows[0]?.taken).toBe(true);
	});

	test('releases an advisory lock a query took before it timed out', async function() {
		const { database, admin } = await explorerDatabase();
		const superuser = singleReader(database.name, superuserOf());
		const answer = await runReadOnlySQL(superuser, 'SELECT pg_advisory_lock(43), pg_sleep(2)', DEFAULT_SQL_LIMITS, 200);
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

	test('cuts an error message that quotes a long value down to a few kilobytes', async function() {
		const { database } = await explorerDatabase();
		const reader = boundedReader(database.name, DEFAULT_SQL_LIMITS);
		const answer = refusalOf(await runReadOnlySQL(reader, `SELECT repeat('x', 3000000)::int`, DEFAULT_SQL_LIMITS));
		expect(answer.reason).toBe('sql-error');
		expect(answer.message).toBe(`invalid input syntax for type integer: "${'x'.repeat(4_096 - 40)}... (cut from 3000041 characters)`);
	});

	test('keeps a message as long as the cut whole', async function() {
		const { reader } = await explorerDatabase();
		const answer = refusalOf(await runReadOnlySQL(reader, `SELECT repeat('x', ${(4_096 - 41).toString()})::int`, DEFAULT_SQL_LIMITS));
		expect(answer.message).toBe(`invalid input syntax for type integer: "${'x'.repeat(4_096 - 41)}"`);
	});

	test('cuts a message before a character it would split in two', async function() {
		const { reader } = await explorerDatabase();
		const answer = refusalOf(await runReadOnlySQL(reader, `SELECT ('x' || repeat(U&'\\+01F600', 5000))::int`, DEFAULT_SQL_LIMITS));
		expect(answer.message).toBe(`invalid input syntax for type integer: "x${'\u{1F600}'.repeat(2_027)}... (cut from 10042 characters)`);
	});

	test('refuses an error longer than the bound of the connection, which ends, and serves the next call', async function() {
		const { database } = await explorerDatabase();
		const bounded = limits({ byteCap: 100 });
		const reader = boundedReader(database.name, bounded);
		const pidOf = async function(): Promise<unknown> {
			return(rowsOf(await runReadOnlySQL(reader, 'SELECT pg_backend_pid() AS pid', bounded)).rows[0]?.['pid']);
		};
		const first = await pidOf();
		const answer = await runReadOnlySQL(reader, `SELECT repeat('x', 3000000)::int`, bounded);
		expect(answer).toEqual({ kind: 'refused', reason: 'byte-cap', message: `a result or error exceeds ${messageBoundOf(bounded).toString()} bytes` });
		expect(await pidOf()).not.toBe(first);
	});

	test('passes a row as large as the byte cap allows through the bound of the connection', async function() {
		const { database } = await explorerDatabase();
		const reader = boundedReader(database.name, DEFAULT_SQL_LIMITS);
		const answer = rowsOf(await runReadOnlySQL(reader, `SELECT repeat('x', ${(DEFAULT_SQL_LIMITS.byteCap - 20).toString()}) AS text`, DEFAULT_SQL_LIMITS));
		expect(answer.rows[0]?.['text']).toHaveLength(DEFAULT_SQL_LIMITS.byteCap - 20);
	});

	test.each(['', ';', '  ;  ', '\n\t'])('refuses the empty query %j', async function(sql) {
		const { reader } = await explorerDatabase();
		expect(await runReadOnlySQL(reader, sql, DEFAULT_SQL_LIMITS)).toEqual({ kind: 'refused', reason: 'empty', message: 'The query is empty.' });
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
		const answer = await runFixedQueries(reader, [{ text: 'SELECT count(*) FROM explorer.holdings', values: [] }, { text: 'DELETE FROM explorer.holdings', values: [] }], DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'refused', reason: 'sql-error', message: 'cannot execute DELETE in a read-only transaction' });
	});

	test('refuses an error without its position in the explorer\'s own text', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runFixedQueries(reader, [{ text: 'SHOUT 1', values: [] }], DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'refused', reason: 'sql-error', message: 'syntax error at or near "SHOUT"' });
	});

	test('throws a failure that is not the server\'s rather than answer it', async function() {
		const { database } = await explorerDatabase();
		const reader = singleReader(database.name);
		const failure = new Error('the connection broke');
		interceptQueries(reader, function(issued, run) {
			if (issued.text === 'SELECT 1 AS one') {
				return(Promise.reject(failure));
			}
			return(run());
		});
		await expect(runFixedQueries(reader, [{ text: 'SELECT 1 AS one', values: [] }], DEFAULT_SQL_LIMITS)).rejects.toBe(failure);
	});

	test('refuses an error longer than the bound of the connection, and serves the next call', async function() {
		const { database } = await explorerDatabase();
		const bounded = limits({ byteCap: 100 });
		const reader = boundedReader(database.name, bounded);
		const answer = await runFixedQueries(reader, [{ text: `SELECT repeat('x', 3000000)::int`, values: [] }], bounded);
		expect(answer).toEqual({ kind: 'refused', reason: 'byte-cap', message: `a result or error exceeds ${messageBoundOf(bounded).toString()} bytes` });
		expect(await runFixedQueries(reader, [{ text: 'SELECT 1 AS one', values: [] }], bounded)).toEqual({ kind: 'rows', results: [[{ one: 1 }]] });
	});

	test('cuts a long error message', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runFixedQueries(reader, [{ text: `SELECT repeat('x', 10000)::int`, values: [] }], DEFAULT_SQL_LIMITS);
		expect(answer).toEqual({ kind: 'refused', reason: 'sql-error', message: `invalid input syntax for type integer: "${'x'.repeat(4_096 - 40)}... (cut from 10041 characters)` });
	});

	test('stops at the default timeout', async function() {
		const { reader } = await explorerDatabase();
		const answer = await runFixedQueries(reader, [{ text: 'SELECT pg_sleep(2)', values: [] }], limits({ timeoutMilliseconds: 200 }));
		expect(answer).toMatchObject({ kind: 'refused', reason: 'timeout' });
	});

	test('leaves no setting behind on the connection', async function() {
		const { database } = await explorerDatabase();
		const superuser = singleReader(database.name, superuserOf());
		await runFixedQueries(superuser, [{ text: `SELECT set_config('application_name', 'left behind', false)`, values: [] }], DEFAULT_SQL_LIMITS);
		expect(rowsOf(await runReadOnlySQL(superuser, `SELECT current_setting('application_name') AS name`, DEFAULT_SQL_LIMITS)).rows).toEqual([{ name: '' }]);
	});
});
