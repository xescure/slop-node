import { performance } from 'node:perf_hooks';
import pg from 'pg';

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
	| { readonly kind: 'refused'; readonly reason: 'timeout' | 'sql-error' | 'empty'; readonly message: string };

type Refusal = Extract<SQLAnswer, { kind: 'refused' }>;

const QUERY_CANCELED = '57014';

/*
 * The newlines keep a trailing line comment in the agent's text from
 * commenting out the closing parenthesis.
 */
const WRAP_PREFIX = 'SELECT * FROM (\n';

/*
 * pg sends a query without values through the simple protocol, which runs
 * every statement in the text; the extended protocol parses it as one
 * prepared statement, so a second statement is an error. pg reads queryMode,
 * which its types leave out.
 */
type ExtendedArrayQuery = pg.QueryArrayConfig & { readonly queryMode: 'extended' };

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

/** A value pg returned, in a form JSON carries without losing digits or bytes. */
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

const refusalOf = function(error: pg.DatabaseError, statement: string): Refusal {
	if (error.code === QUERY_CANCELED) {
		return({ kind: 'refused', reason: 'timeout', message: error.message });
	}

	const position = Number(error.position) - WRAP_PREFIX.length;
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

const answerOf = function(result: pg.QueryArrayResult, limits: SQLLimits, milliseconds: number): SQLAnswer {
	const columns = result.fields.map(function(field) {
		return(field.name);
	});
	const duplicate = duplicateColumn(columns);
	if (duplicate !== undefined) {
		return({ kind: 'refused', reason: 'sql-error', message: `column "${duplicate}" appears more than once; give each column its own name` });
	}

	const rows: SQLRow[] = [];
	let bytes = 0;
	for (const values of result.rows.slice(0, limits.rowCap)) {
		const row = Object.fromEntries(columns.map(function(column, index) {
			return([column, toJSONValue(values[index])]);
		}));
		bytes += Buffer.byteLength(JSON.stringify(row));
		if (bytes > limits.byteCap) {
			return({ kind: 'rows', columns, rows, truncated: 'byte-cap', milliseconds });
		}
		rows.push(row);
	}
	if (result.rows.length > limits.rowCap) {
		return({ kind: 'rows', columns, rows, truncated: 'row-cap', milliseconds });
	}
	return({ kind: 'rows', columns, rows, truncated: null, milliseconds });
};

const answerOn = async function(client: pg.PoolClient, statement: string, limits: SQLLimits, timeout: number): Promise<SQLAnswer> {
	const query: ExtendedArrayQuery = {
		text: `${WRAP_PREFIX}${statement}\n) AS q LIMIT ${(limits.rowCap + 1).toString()}`,
		rowMode: 'array',
		queryMode: 'extended'
	};
	try {
		await client.query('BEGIN READ ONLY');
		await client.query(`SET LOCAL statement_timeout = ${timeout.toString()}`);
		const started = performance.now();
		const result = await client.query(query);
		return(answerOf(result, limits, Math.round(performance.now() - started)));
	} catch (error) {
		if (error instanceof pg.DatabaseError) {
			return(refusalOf(error, statement));
		}
		throw(error);
	}
};

/*
 * DISCARD ALL drops the session advisory locks, settings and prepared
 * statements a query left behind, so the next borrower of the connection
 * starts clean; a held lock could otherwise block the node's migrations.
 */
const cleaned = async function(client: pg.PoolClient): Promise<boolean> {
	try {
		await client.query('ROLLBACK');
		await client.query('DISCARD ALL');
		return(true);
	} catch {
		return(false);
	}
};

/** Runs one agent statement read-only under a timeout, a row cap and a byte cap, leaving nothing on the connection. */
export async function runReadOnlySQL(reader: pg.Pool, sql: string, limits: SQLLimits, requestedTimeout?: number): Promise<SQLAnswer> {
	const statement = statementOf(sql);
	if (statement === null) {
		return({ kind: 'refused', reason: 'empty', message: 'The query is empty.' });
	}

	const client = await reader.connect();
	/*
	 * The pool listens for errors only on idle clients, and a connection the
	 * query ended (pg_terminate_backend on its own backend) emits one while
	 * borrowed; without a listener that error would end the process. The
	 * failed query already reports it.
	 */
	const ignore = function(): void {
		// Reported through the query's rejection.
	};
	client.on('error', ignore);
	try {
		return(await answerOn(client, statement, limits, timeoutOf(limits, requestedTimeout)));
	} finally {
		const clean = await cleaned(client);
		client.removeListener('error', ignore);
		client.release(!clean);
	}
}
