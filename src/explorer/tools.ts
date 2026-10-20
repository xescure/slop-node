import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type pg from 'pg';
import { z } from 'zod';
import { assertNever } from '../util/assert-never.js';
import type { Address, OperationTypeName } from './decode.js';
import { DESCRIBE_RULES } from './instructions.js';
import { runFixedQueries, runReadOnlySQL } from './sql.js';
import type { FixedQuery, JSONValue, SQLLimits, SQLRow } from './sql.js';

const lib = KeetaNet.lib;

export const DEFAULT_LIST_LIMIT = 50;

export const MAXIMUM_LIST_LIMIT = 500;

/** A block or staple hash as the views write it, 64 upper-case hex characters. */
type Hash = string & { readonly __hash: never };

type Direction = 'in' | 'out';

/** Where a page of an account's history ends, in the order the history is read: newest first. */
type HistoryCursor = { readonly stapleTime: string; readonly blockHash: Hash; readonly idx: number; readonly direction: Direction };

type Answer = { readonly [key: string]: JSONValue };

type ToolOutcome = { readonly kind: 'answer'; readonly answer: Answer } | { readonly kind: 'refused'; readonly message: string };

/** Lets a fixed number of calls query at once; the rest wait their turn in arrival order. */
export class QuerySlots {
	readonly #waiting: (() => void)[] = [];
	#free: number;

	constructor(slots: number) {
		if (!Number.isInteger(slots) || slots < 1) {
			throw(new Error(`maxConcurrentQueries must be a positive integer, got ${String(slots)}`));
		}
		this.#free = slots;
	}

	async run<T>(work: () => Promise<T>): Promise<T> {
		if (this.#free > 0) {
			this.#free--;
		} else {
			const waiting = this.#waiting;
			await new Promise<void>(function(resolve) {
				waiting.push(resolve);
			});
		}
		try {
			return(await work());
		} finally {
			// A slot passes straight to the next waiter, so a newcomer cannot take it first.
			const next = this.#waiting.shift();
			if (next === undefined) {
				this.#free++;
			} else {
				next();
			}
		}
	}
}

export type ToolContext = { readonly reader: pg.Pool; readonly limits: SQLLimits; readonly slots: QuerySlots };

class InvalidInput extends Error {}

const OPERATION_TYPES = [
	'SEND', 'SET_REP', 'SET_INFO', 'MODIFY_PERMISSIONS', 'CREATE_IDENTIFIER',
	'TOKEN_ADMIN_SUPPLY', 'TOKEN_ADMIN_MODIFY_BALANCE', 'RECEIVE', 'MANAGE_CERTIFICATE'
] as const satisfies readonly OperationTypeName[];

const HASH_PATTERN = /^[0-9A-Fa-f]{64}$/;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/*
 * The address must be the canonical spelling: the views compare it as text
 * with public.accounts.public_key.
 */
const parseAddress = function(field: string, value: string): Address {
	let canonical: string;
	try {
		canonical = lib.Account.fromPublicKeyString(value).publicKeyString.get();
	} catch {
		throw(new InvalidInput(`${field}: not a Keeta address`));
	}
	if (canonical !== value) {
		throw(new InvalidInput(`${field}: not a Keeta address in its canonical form, ${canonical}`));
	}
	return(canonical as Address);
};

const parseHash = function(field: string, value: string): Hash {
	if (!HASH_PATTERN.test(value)) {
		throw(new InvalidInput(`${field}: expected 64 hexadecimal characters`));
	}
	return(value.toUpperCase() as Hash);
};

const encodeHistoryCursor = function(cursor: HistoryCursor): string {
	return(Buffer.from(JSON.stringify([cursor.stapleTime, cursor.blockHash, cursor.idx, cursor.direction]), 'utf-8').toString('base64url'));
};

const decodeHistoryCursor = function(field: string, value: string): HistoryCursor {
	const refused = new InvalidInput(`${field}: not a cursor this server returned as next_before`);
	let parts: unknown;
	try {
		parts = JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'));
	} catch {
		throw(refused);
	}
	if (!Array.isArray(parts) || parts.length !== 4) {
		throw(refused);
	}
	const entries: readonly unknown[] = parts;
	const [stapleTime, blockHash, idx, direction] = entries;
	if (typeof stapleTime !== 'string' || !ISO_TIME.test(stapleTime) || Number.isNaN(Date.parse(stapleTime))) {
		throw(refused);
	}
	if (typeof blockHash !== 'string' || !HASH_PATTERN.test(blockHash)) {
		throw(refused);
	}
	if (typeof idx !== 'number' || !Number.isSafeInteger(idx) || idx < 0) {
		throw(refused);
	}
	if (direction !== 'in' && direction !== 'out') {
		throw(refused);
	}
	return({ stapleTime, blockHash: parseHash(field, blockHash), idx, direction });
};

const limitSchema = z.number().int().min(1).max(MAXIMUM_LIST_LIMIT).default(DEFAULT_LIST_LIMIT).describe(`How many rows to return, at most ${MAXIMUM_LIST_LIMIT.toString()}.`);

const addressSchema = z.string().describe('A keeta_ address.');

const hashSchema = z.string().describe('64 hexadecimal characters.');

const rowOf = function(rows: readonly SQLRow[] | undefined): SQLRow | null {
	return(rows?.[0] ?? null);
};

const required = function(results: readonly (readonly SQLRow[])[], index: number): readonly SQLRow[] {
	const rows = results[index];
	if (rows === undefined) {
		throw(new Error(`internal error: no result ${index.toString()} of a fixed query`));
	}
	return(rows);
};

/** Runs the tool's fixed queries and shapes their rows into its answer. */
const fixed = async function(context: ToolContext, queries: readonly FixedQuery[], shape: (results: readonly (readonly SQLRow[])[]) => Answer): Promise<ToolOutcome> {
	const answer = await context.slots.run(function() {
		return(runFixedQueries(context.reader, queries, context.limits));
	});
	switch (answer.kind) {
		case 'rows':
			return({ kind: 'answer', answer: shape(answer.results) });
		case 'refused':
			return({ kind: 'refused', message: `${answer.reason}: ${answer.message}` });
		default:
			return(assertNever(answer));
	}
};

const resultOf = function(outcome: ToolOutcome): CallToolResult {
	switch (outcome.kind) {
		case 'answer':
			return({ content: [{ type: 'text', text: JSON.stringify(outcome.answer) }], structuredContent: outcome.answer });
		case 'refused':
			return({ content: [{ type: 'text', text: outcome.message }], isError: true });
		default:
			return(assertNever(outcome));
	}
};

/*
 * Any failure but a refusal is the explorer's own, such as a lost database
 * connection, and its text is no help to the agent.
 */
const guarded = function<Input>(handler: (input: Input) => Promise<ToolOutcome>): (input: Input) => Promise<CallToolResult> {
	return(async function(input) {
		try {
			return(resultOf(await handler(input)));
		} catch (error) {
			if (error instanceof InvalidInput) {
				return(resultOf({ kind: 'refused', message: error.message }));
			}
			return(resultOf({ kind: 'refused', message: 'internal error: the explorer could not answer; try again' }));
		}
	});
};

const HISTORY_COLUMNS = `account, direction, to_char(staple_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS staple_time, block_hash, idx, type, counterparty, token, amount`;

type HistoryInput = { readonly account: string; readonly direction?: Direction | undefined; readonly type?: OperationTypeName | undefined; readonly token?: string | undefined; readonly limit: number; readonly before?: string | undefined };

/*
 * The index on (account_id, staple_time DESC) gives the rows in time order;
 * the rest of the order only breaks ties within one staple. The hash is
 * compared in the C collation so that its order is that of its bytes.
 */
const historyQuery = function(account: Address, input: HistoryInput): FixedQuery {
	const values: unknown[] = [account];
	const conditions = ['account_id = explorer.id_of($1)'];
	const bind = function(value: unknown): string {
		values.push(value);
		return(`$${values.length.toString()}`);
	};
	if (input.direction !== undefined) {
		conditions.push(`direction = ${bind(input.direction)}`);
	}
	if (input.type !== undefined) {
		conditions.push(`type = ${bind(input.type)}`);
	}
	if (input.token !== undefined) {
		conditions.push(`token_id = explorer.id_of(${bind(parseAddress('token', input.token))})`);
	}
	if (input.before !== undefined) {
		const cursor = decodeHistoryCursor('before', input.before);
		const time = bind(cursor.stapleTime);
		// The bound on the time alone is what the index can start from.
		conditions.push(`account_history.staple_time <= ${time}::timestamptz`);
		conditions.push(`(account_history.staple_time, block_hash COLLATE "C", idx, direction COLLATE "C") < (${time}::timestamptz, ${bind(cursor.blockHash)}, ${bind(cursor.idx)}::integer, ${bind(cursor.direction)})`);
	}
	const limit = bind(input.limit + 1);
	return({
		text: `SELECT ${HISTORY_COLUMNS} FROM explorer.account_history WHERE ${conditions.join(' AND ')} ORDER BY account_history.staple_time DESC, block_hash COLLATE "C" DESC, idx DESC, direction COLLATE "C" DESC LIMIT ${limit}`,
		values
	});
};

const historyAnswer = function(account: Address, rows: readonly SQLRow[], limit: number): Answer {
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	let next: string | null = null;
	if (rows.length > limit && last !== undefined) {
		const { staple_time: stapleTime, block_hash: blockHash, idx, direction } = last;
		if (typeof stapleTime !== 'string' || typeof blockHash !== 'string' || typeof idx !== 'number' || (direction !== 'in' && direction !== 'out')) {
			throw(new Error('internal error: a history row without its cursor columns'));
		}
		next = encodeHistoryCursor({ stapleTime, blockHash: parseHash('block_hash', blockHash), idx, direction });
	}
	return({ account, history: page, next_before: next });
};

/*
 * The staple of a block, or the hash itself when it names no indexed block,
 * as a key every query of the staple tool filters on.
 */
const STAPLE_KEY = `coalesce((SELECT staple_bytes FROM explorer.blocks WHERE hash_bytes = decode($1, 'hex')), decode($1, 'hex'))`;

const VIEWS_QUERY = `
	SELECT view.table_name AS name, obj_description(format('explorer.%I', view.table_name)::regclass, 'pg_class') AS comment
	FROM information_schema.views view
	WHERE view.table_schema = 'explorer'
	ORDER BY view.table_name`;

const COLUMNS_QUERY = `
	SELECT column_info.table_name AS view, column_info.column_name AS name, column_info.data_type AS type
	FROM information_schema.columns column_info
	JOIN information_schema.views view ON view.table_schema = column_info.table_schema AND view.table_name = column_info.table_name
	WHERE column_info.table_schema = 'explorer'
	ORDER BY column_info.table_name, column_info.ordinal_position`;

const describedViews = function(views: readonly SQLRow[], columns: readonly SQLRow[]): JSONValue {
	return(views.map(function({ name = null, comment = null }) {
		const own = columns.filter(function(column) {
			return(column['view'] === name);
		}).map(function({ name: column = null, type = null }) {
			return({ name: column, type });
		});
		return({ name, comment, columns: own });
	}));
};

/** Registers the explorer's tools on one request's server. */
export function registerTools(server: McpServer, context: ToolContext): void {
	server.registerTool('sql', {
		description: 'Runs one read-only SELECT against the explorer views. Read describe first: a filter on an id or raw key is what keeps a query within the timeout.',
		inputSchema: {
			query: z.string().describe('One SELECT statement.'),
			timeout_ms: z.number().int().positive().optional().describe('The statement timeout, up to the server\'s maximum.')
		},
		annotations: { readOnlyHint: true, openWorldHint: false }
	}, guarded(async function({ query, timeout_ms: timeout }): Promise<ToolOutcome> {
		const answer = await context.slots.run(function() {
			return(runReadOnlySQL(context.reader, query, context.limits, timeout));
		});
		switch (answer.kind) {
			case 'rows':
				return({ kind: 'answer', answer: { columns: answer.columns, rows: answer.rows, truncated: answer.truncated, milliseconds: answer.milliseconds } });
			case 'refused':
				return({ kind: 'refused', message: `${answer.reason}: ${answer.message}` });
			default:
				return(assertNever(answer));
		}
	}));

	server.registerTool('describe', {
		description: 'Lists the explorer views with their columns, and the rules for querying them with sql.',
		annotations: { readOnlyHint: true, openWorldHint: false }
	}, guarded(function(): Promise<ToolOutcome> {
		return(fixed(context, [{ text: VIEWS_QUERY, values: [] }, { text: COLUMNS_QUERY, values: [] }], function(results) {
			return({ views: describedViews(required(results, 0), required(results, 1)), rules: DESCRIBE_RULES });
		}));
	}));

	server.registerTool('status', {
		description: 'How far indexing trails the node: the newest staple indexed, the newest the node holds, how many are not yet indexed, and why indexing paused, if it did.',
		annotations: { readOnlyHint: true, openWorldHint: false }
	}, guarded(function(): Promise<ToolOutcome> {
		return(fixed(context, [{
			text: 'SELECT *, trim_scale(extract(epoch FROM newest_node_staple_time - newest_indexed_staple_time))::text AS lag_seconds FROM explorer.status',
			values: []
		}], function(results) {
			return(rowOf(required(results, 0)) ?? {});
		}));
	}));

	server.registerTool('holders', {
		description: 'The holders of a token, largest balance first, in base units and token units.',
		inputSchema: { token: addressSchema, limit: limitSchema },
		annotations: { readOnlyHint: true, openWorldHint: false }
	}, guarded(function({ token, limit }): Promise<ToolOutcome> {
		const address = parseAddress('token', token);
		return(fixed(context, [{
			text: 'SELECT account, amount, decimals, amount_units FROM explorer.holders WHERE token_id = explorer.id_of($1) ORDER BY amount DESC LIMIT $2',
			values: [address, limit]
		}], function(results) {
			return({ token: address, holders: required(results, 0) });
		}));
	}));

	server.registerTool('account', {
		description: 'An account\'s info, head block and representative, and its balances.',
		inputSchema: { account: addressSchema },
		annotations: { readOnlyHint: true, openWorldHint: false }
	}, guarded(function({ account }): Promise<ToolOutcome> {
		const address = parseAddress('account', account);
		const cap = context.limits.rowCap;
		return(fixed(context, [
			{
				text: 'SELECT account, kind, head, height, rep, name, description, metadata, default_base, default_external, multisig_quorum FROM explorer.accounts WHERE id = explorer.id_of($1)',
				values: [address]
			},
			{
				text: 'SELECT token, amount, decimals, amount_units FROM explorer.balances WHERE account_id = explorer.id_of($1) ORDER BY token_id LIMIT $2',
				values: [address, cap + 1]
			}
		], function(results) {
			const balances = required(results, 1);
			return({ account: rowOf(required(results, 0)), balances: balances.slice(0, cap), balances_truncated: balances.length > cap });
		}));
	}));

	server.registerTool('history', {
		description: 'An account\'s operations, newest first: out for those of its own blocks, in for sends to it. Page with before, set to the previous answer\'s next_before.',
		inputSchema: {
			account: addressSchema,
			direction: z.enum(['in', 'out']).optional(),
			type: z.enum(OPERATION_TYPES).optional(),
			token: addressSchema.optional(),
			limit: limitSchema,
			before: z.string().optional().describe('The next_before of the previous page.')
		},
		annotations: { readOnlyHint: true, openWorldHint: false }
	}, guarded(function(input): Promise<ToolOutcome> {
		const account = parseAddress('account', input.account);
		return(fixed(context, [historyQuery(account, input)], function(results) {
			return(historyAnswer(account, required(results, 0), input.limit));
		}));
	}));

	server.registerTool('block', {
		description: 'A block by its hash, with its operations.',
		inputSchema: { hash: hashSchema },
		annotations: { readOnlyHint: true, openWorldHint: false }
	}, guarded(function({ hash }): Promise<ToolOutcome> {
		const key = parseHash('hash', hash);
		return(fixed(context, [
			{
				text: `SELECT hash, account, height, date, version, purpose, signer, staple, staple_time, position, operation_count FROM explorer.blocks WHERE hash_bytes = decode($1, 'hex')`,
				values: [key]
			},
			{
				text: `SELECT idx, type, account, counterparty, token, amount, details FROM explorer.operations WHERE block_hash_bytes = decode($1, 'hex') ORDER BY idx`,
				values: [key]
			}
		], function(results) {
			return({ block: rowOf(required(results, 0)), operations: required(results, 1) });
		}));
	}));

	server.registerTool('staple', {
		description: 'A staple by its blocks hash or the hash of any block in it, with its blocks in order and its votes.',
		inputSchema: { hash: hashSchema },
		annotations: { readOnlyHint: true, openWorldHint: false }
	}, guarded(function({ hash }): Promise<ToolOutcome> {
		const key = parseHash('hash', hash);
		return(fixed(context, [
			{ text: `SELECT blocks_hash, staple_time, sequence, indexed FROM explorer.staples WHERE blocks_hash_bytes = ${STAPLE_KEY}`, values: [key] },
			{ text: `SELECT hash, account, height, signer, position, operation_count FROM explorer.blocks WHERE staple_bytes = ${STAPLE_KEY} ORDER BY position`, values: [key] },
			{ text: `SELECT issuer, validity_from, validity_to, permanent FROM explorer.votes WHERE staple_bytes = ${STAPLE_KEY} ORDER BY issuer`, values: [key] }
		], function(results) {
			const staple = rowOf(required(results, 0));
			if (staple === null) {
				return({ staple: null, blocks: [], votes: [] });
			}
			return({ staple, blocks: required(results, 1), votes: required(results, 2) });
		}));
	}));

	server.registerTool('rep_weights', {
		description: 'The representatives by voting weight, heaviest first.',
		inputSchema: { limit: limitSchema },
		annotations: { readOnlyHint: true, openWorldHint: false }
	}, guarded(function({ limit }): Promise<ToolOutcome> {
		return(fixed(context, [{ text: 'SELECT rep, weight FROM explorer.rep_weights ORDER BY weight DESC, rep LIMIT $1', values: [limit] }], function(results) {
			return({ rep_weights: required(results, 0) });
		}));
	}));
}
