import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { parse as parseArray } from 'postgres-array';

export type SQLLimits = {
	readonly timeoutMilliseconds: number;
	readonly maxTimeoutMilliseconds: number;
	readonly rowCap: number;
	readonly byteCap: number;
};

export const DEFAULT_SQL_LIMITS: SQLLimits = {
	timeoutMilliseconds: 5_000,
	maxTimeoutMilliseconds: 30_000,
	rowCap: 1_000,
	byteCap: 2_000_000
};

export type JSONValue = string | number | boolean | null | readonly JSONValue[] | { readonly [key: string]: JSONValue };

export type SQLRow = Readonly<Record<string, JSONValue>>;

export type SQLAnswer =
	| { readonly kind: 'rows'; readonly columns: readonly string[]; readonly rows: readonly SQLRow[]; readonly truncated: 'row-cap' | 'byte-cap' | null; readonly milliseconds: number }
	| { readonly kind: 'refused'; readonly reason: 'timeout' | 'sql-error' | 'byte-cap' | 'empty'; readonly message: string };

export type SQLRefusal = Extract<SQLAnswer, { kind: 'refused' }>;

export type FixedQuery = { readonly text: string; readonly values: readonly unknown[] };

export type FixedAnswer =
	| { readonly kind: 'rows'; readonly results: readonly (readonly SQLRow[])[] }
	| SQLRefusal;

const QUERY_CANCELED = '57014';

/** Raised by explorer.row_fits (schema/explorer/migrations/0003_sql_guard.sql) for a row over the byte cap. */
const ROW_OVER_CAP = 'XE001';

const TIMEOUT_MESSAGE = 'canceling statement due to statement timeout';

const CURSOR = 'explorer_sql';

const PROBE = 'explorer_probe';

/*
 * Rows are fetched a few at a time, so the client holds at most this many
 * rows, each within the byte cap, beyond the rows it keeps.
 */
const FETCH_ROWS = 10;

/*
 * The probe proves the agent's text a complete query on its own before it is
 * pasted inside the guard's parentheses: text that closes them and goes on
 * (`...) AS q UNION ALL SELECT ... FROM (SELECT 1`) would put a branch outside
 * the guard, and is no complete query alone. Declaring a cursor plans the
 * query without running it. The newlines keep a trailing line comment in the
 * text from commenting out what follows.
 */
const PROBE_PREFIX = `DECLARE ${PROBE} NO SCROLL CURSOR FOR\n`;

const WRAP_PREFIX = `DECLARE ${CURSOR} NO SCROLL CURSOR FOR SELECT q.* FROM (\n`;

/*
 * pg sends a query without values through the simple protocol, which runs
 * every statement in the text; the extended protocol parses it as one
 * prepared statement, so a second statement is an error. pg reads queryMode,
 * which its types leave out.
 */
type ExtendedQuery = pg.QueryConfig & { readonly queryMode: 'extended' };

/*
 * pg parses json with JSON.parse, which rounds numbers past 2^53, so json and
 * jsonb come back as the text Postgres wrote, digits intact, and json[] and
 * jsonb[] as arrays of that text; every other type keeps pg's parser.
 */
const RESULT_TYPES = new pg.TypeOverrides();
const keepText = function(text: string): string {
	return(text);
};
/** json and jsonb. */
for (const oid of [114, 3802]) {
	RESULT_TYPES.setTypeParser(oid, 'text', keepText);
}
/** json[] and jsonb[]. */
for (const oid of [199, 3807]) {
	RESULT_TYPES.setTypeParser(oid, 'text', function(text: string): unknown {
		// Typed as unknown: the entries can also be null or nested arrays, which the package's types leave out.
		const entries: unknown = parseArray(text, keepText);
		return(entries);
	});
}

const isPlainObject = function(value: object): boolean {
	const prototype: unknown = Object.getPrototypeOf(value);
	return(prototype === Object.prototype || prototype === null);
};

const hasISOString = function(value: object): value is { toISOString: () => unknown } {
	return('toISOString' in value && typeof value.toISOString === 'function');
};

/*
 * Only objects pg has no parser for land here, such as a typed array a test
 * hands in, and their own toString is the best text they have.
 */
const textOf = function(value: { toString: () => string }): string {
	return(value.toString());
};

/**
 * A value pg returned, in a form JSON carries without losing digits or bytes.
 * The runner reads json and jsonb columns as their JSON text, which this
 * keeps as a string.
 */
export function toJSONValue(value: unknown): JSONValue {
	switch (typeof value) {
		case 'undefined':
			return(null);
		case 'string':
		case 'boolean':
			return(value);
		case 'number':
			if (Number.isFinite(value)) {
				return(value);
			}
			return(String(value));
		case 'bigint':
			return(value.toString());
		case 'symbol':
		case 'function':
			return(String(value));
		case 'object':
			break;
	}

	if (value === null) {
		return(null);
	}
	if (Buffer.isBuffer(value)) {
		return(value.toString('hex').toUpperCase());
	}
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			return(String(value));
		}
		return(value.toISOString());
	}
	if (Array.isArray(value)) {
		return(value.map(toJSONValue));
	}
	if (isPlainObject(value)) {
		return(Object.fromEntries(Object.entries(value).map(function([key, member]) {
			return([key, toJSONValue(member)]);
		})));
	}
	// pg's intervals, written as ISO 8601 durations.
	if (hasISOString(value)) {
		return(String(value.toISOString()));
	}
	return(textOf(value));
}

const statementOf = function(sql: string): string | null {
	const text = sql.trimEnd().replace(/;$/, '').trimEnd();
	if (text.trim() === '') {
		return(null);
	}
	return(text);
};

const timeoutOf = function(limits: SQLLimits, requested: number | undefined): number {
	let wanted = limits.timeoutMilliseconds;
	if (requested !== undefined && !Number.isNaN(requested)) {
		wanted = requested;
	}
	// A statement_timeout of 0 turns the timeout off, so the floor is 1.
	return(Math.max(1, Math.min(Math.floor(wanted), limits.maxTimeoutMilliseconds)));
};

const refusalOf = function(error: pg.DatabaseError, statement: string, prefix: string): SQLRefusal {
	if (error.code === QUERY_CANCELED) {
		return({ kind: 'refused', reason: 'timeout', message: error.message });
	}
	if (error.code === ROW_OVER_CAP) {
		return({ kind: 'refused', reason: 'byte-cap', message: error.message });
	}

	const position = Number(error.position) - prefix.length;
	if (!Number.isInteger(position) || position < 1 || position > statement.length) {
		return({ kind: 'refused', reason: 'sql-error', message: error.message });
	}
	return({ kind: 'refused', reason: 'sql-error', message: `${error.message} (at character ${position.toString()})` });
};

const duplicateColumn = function(columns: readonly string[]): string | undefined {
	return(columns.find(function(column, index) {
		return(columns.indexOf(column) !== index);
	}));
};

type Collected = { readonly done: false } | { readonly done: true; readonly truncated: 'row-cap' | 'byte-cap' | null };

/** Rows kept so far, within the row cap and the byte cap. */
class Collection {
	readonly rows: SQLRow[] = [];
	readonly #limits: SQLLimits;
	#bytes = 0;

	constructor(limits: SQLLimits) {
		this.#limits = limits;
	}

	add(columns: readonly string[], batch: readonly (readonly unknown[])[]): Collected {
		for (const values of batch) {
			if (this.rows.length >= this.#limits.rowCap) {
				return({ done: true, truncated: 'row-cap' });
			}
			const row = Object.fromEntries(columns.map(function(column, index) {
				return([column, toJSONValue(values[index])]);
			}));
			this.#bytes += Buffer.byteLength(JSON.stringify(row));
			if (this.#bytes > this.#limits.byteCap) {
				return({ done: true, truncated: 'byte-cap' });
			}
			this.rows.push(row);
		}
		if (batch.length < FETCH_ROWS) {
			return({ done: true, truncated: null });
		}
		return({ done: false });
	}
}

/*
 * The statement timeout bounds each statement, and the query runs across one
 * FETCH per batch, so each FETCH gets only what is left of the call's time.
 */
const answerOn = async function(client: pg.PoolClient, statement: string, limits: SQLLimits, timeout: number): Promise<SQLAnswer> {
	const probe: ExtendedQuery = { text: `${PROBE_PREFIX}${statement}\n`, queryMode: 'extended' };
	const declare: ExtendedQuery = {
		text: `${WRAP_PREFIX}${statement}\n) AS q WHERE explorer.row_fits(octet_length(ROW(q.*)::text), ${limits.byteCap.toString()}) LIMIT ${(limits.rowCap + 1).toString()}`,
		queryMode: 'extended'
	};
	const started = performance.now();
	let prefix = PROBE_PREFIX;
	try {
		await client.query('BEGIN READ ONLY');
		await client.query(`SET LOCAL statement_timeout = ${timeout.toString()}`);
		await client.query(probe);
		await client.query(`CLOSE ${PROBE}`);
		prefix = WRAP_PREFIX;
		await client.query(declare);
		const collection = new Collection(limits);
		for (;;) {
			const left = Math.ceil(timeout - (performance.now() - started));
			if (left < 1) {
				return({ kind: 'refused', reason: 'timeout', message: TIMEOUT_MESSAGE });
			}
			await client.query(`SET LOCAL statement_timeout = ${left.toString()}`);
			const batch = await client.query<unknown[]>({ text: `FETCH ${FETCH_ROWS.toString()} FROM ${CURSOR}`, rowMode: 'array', types: RESULT_TYPES });
			const columns = batch.fields.map(function(field) {
				return(field.name);
			});
			const duplicate = duplicateColumn(columns);
			if (duplicate !== undefined) {
				return({ kind: 'refused', reason: 'sql-error', message: `column "${duplicate}" appears more than once; give each column its own name` });
			}
			const collected = collection.add(columns, batch.rows);
			if (collected.done) {
				return({ kind: 'rows', columns, rows: collection.rows, truncated: collected.truncated, milliseconds: Math.round(performance.now() - started) });
			}
		}
	} catch (error) {
		if (error instanceof pg.DatabaseError) {
			return(refusalOf(error, statement, prefix));
		}
		throw(error);
	}
};

/*
 * ROLLBACK closes the cursor. DISCARD ALL then drops the session advisory
 * locks, settings and prepared statements a query left behind, so the next
 * borrower of the connection starts clean; a held lock could otherwise block
 * the node's migrations. The failure, if any, goes to the pool with the client,
 * which destroys a client released with an error.
 */
const cleanupFailure = async function(client: pg.PoolClient): Promise<Error | undefined> {
	try {
		await client.query('ROLLBACK');
		await client.query('DISCARD ALL');
		return(undefined);
	} catch (error) {
		return(new Error('Could not clean the connection after an agent query', { cause: error }));
	}
};

/*
 * The pool listens for errors only on idle clients, and a connection the
 * query ended (pg_terminate_backend on its own backend) emits one while
 * borrowed; without a listener that error would end the process. The failed
 * query already reports it.
 */
const onReaderConnection = async function<T>(reader: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
	const client = await reader.connect();
	const ignore = function(): void {
		// Reported through the query's rejection.
	};
	client.on('error', ignore);
	try {
		return(await work(client));
	} finally {
		const failure = await cleanupFailure(client);
		client.removeListener('error', ignore);
		client.release(failure);
	}
};

/** Runs one agent statement read-only under a timeout, a row cap and a byte cap, leaving nothing on the connection. */
export async function runReadOnlySQL(reader: pg.Pool, sql: string, limits: SQLLimits, requestedTimeout?: number): Promise<SQLAnswer> {
	const statement = statementOf(sql);
	if (statement === null) {
		return({ kind: 'refused', reason: 'empty', message: 'The query is empty.' });
	}
	return(await onReaderConnection(reader, function(client) {
		return(answerOn(client, statement, limits, timeoutOf(limits, requestedTimeout)));
	}));
}

/**
 * Runs the explorer's own parameterized queries in one read-only transaction
 * under the default timeout, with the rows in the form the agent's queries
 * take. Their text is fixed and bounded by its own LIMIT, so no cap applies.
 */
export async function runFixedQueries(reader: pg.Pool, queries: readonly FixedQuery[], limits: SQLLimits): Promise<FixedAnswer> {
	return(await onReaderConnection(reader, async function(client): Promise<FixedAnswer> {
		try {
			await client.query('BEGIN READ ONLY');
			await client.query(`SET LOCAL statement_timeout = ${timeoutOf(limits, undefined).toString()}`);
			const results: SQLRow[][] = [];
			for (const query of queries) {
				const answer = await client.query<Record<string, unknown>>({ text: query.text, values: [...query.values], types: RESULT_TYPES });
				results.push(answer.rows.map(function(row) {
					return(Object.fromEntries(Object.entries(row).map(function([column, value]) {
						return([column, toJSONValue(value)]);
					})));
				}));
			}
			return({ kind: 'rows', results });
		} catch (error) {
			if (error instanceof pg.DatabaseError) {
				// A position in the explorer's own text would mean nothing to the agent.
				return(refusalOf(error, '', ''));
			}
			throw(error);
		}
	}));
}
