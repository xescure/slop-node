import { describe, expect, onTestFinished, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import pg from 'pg';
import { requireAt } from '../ledger/storage/suite/support.js';
import { sendBlock } from '../testing/blocks.js';
import { close, listen } from '../node/server.js';
import { parseBearerTokens } from './auth.js';
import type { BearerToken } from './auth.js';
import { explorerApp } from './server.js';
import { INTERNAL_ERROR_MESSAGE } from './tools.js';
import type { FailureSite } from './tools.js';
import { DEFAULT_SQL_LIMITS } from './sql.js';
import { addressOf, explorerDatabase, indexAll, ledgerFixture, mintedToken } from './testing.js';
import type { LedgerFixture } from './testing.js';

const TOKEN = 'explorer-test-token-0123456789abcdef';

const tokens = function(): readonly BearerToken[] {
	const parsed = parseBearerTokens(TOKEN);
	if ('refused' in parsed) {
		throw(new Error(parsed.refused));
	}
	return(parsed);
};

type Failure = { readonly error: unknown; readonly site: FailureSite };

/** Serves the explorer; unless the test collects the failures reported, it expects none. */
const serve = async function(reader: pg.Pool, options: { readonly maxConcurrentQueries?: number; readonly failures?: Failure[] } = {}): Promise<URL> {
	const failures = options.failures ?? [];
	if (options.failures === undefined) {
		onTestFinished(function() {
			expect(failures).toEqual([]);
		});
	}
	const report = function(error: unknown, site: FailureSite): void {
		failures.push({ error, site });
	};
	const { app } = explorerApp({ reader, tokens: tokens(), limits: DEFAULT_SQL_LIMITS, maxConcurrentQueries: options.maxConcurrentQueries ?? 4, report });
	const { server, address } = await listen(app, { host: '127.0.0.1', port: 0 });
	onTestFinished(function() {
		return(close(server));
	});
	return(new URL(`http://127.0.0.1:${address.port.toString()}/`));
};

const connect = async function(base: URL, header = `Bearer ${TOKEN}`): Promise<Client> {
	const client = new Client({ name: 'explorer-test', version: '1' });
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { Authorization: header } } });
	// As in server.ts: the class implements Transport, which its optional callbacks spell differently.
	await client.connect(transport as Transport);
	onTestFinished(function() {
		return(client.close());
	});
	return(client);
};

type Answer = Readonly<Record<string, unknown>>;

type ToolResult = { readonly isError: boolean; readonly text: string; readonly structured: Answer | undefined };

const textOf = function(content: unknown): string {
	if (!Array.isArray(content)) {
		return('');
	}
	const first: unknown = content[0];
	if (typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string') {
		return(first.text);
	}
	return('');
};

const answerOf = function(value: unknown): Answer | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return(undefined);
	}
	return(Object.fromEntries(Object.entries(value)));
};

const listOf = function(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw(new Error(`Expected a list, got ${JSON.stringify(value)}`));
	}
	const entries: readonly unknown[] = value;
	return(entries);
};

const call = async function(client: Client, name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
	const result = await client.callTool({ name, arguments: { ...args } });
	return({ isError: result.isError === true, text: textOf(result.content), structured: answerOf(result.structuredContent) });
};

const answer = async function(client: Client, name: string, args: Readonly<Record<string, unknown>>): Promise<Answer> {
	const result = await call(client, name, args);
	if (result.isError || result.structured === undefined) {
		throw(new Error(`Expected an answer from ${name}, got ${result.text}`));
	}
	const text: unknown = JSON.parse(result.text);
	expect(text).toEqual(result.structured);
	return(result.structured);
};

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };

/** Sends from the first user to the second, three blocks in one staple and two in the next. */
const sends = async function(context: LedgerFixture): Promise<void> {
	const { network, cursor } = context;
	const [sender, recipient] = [requireAt(network.users, 0), requireAt(network.users, 1)];
	for (const count of [3, 2]) {
		const blocks = [];
		for (let index = 0; index < count; index++) {
			blocks.push(cursor.append(await sendBlock({ from: sender, to: recipient, amount: BigInt(index + 1), token: network.baseToken, previous: cursor.previous(sender), network: network.network })));
		}
		await context.apply(blocks);
	}
};

describe('the explorer MCP server', function() {
	test('answers an unauthenticated initialize with 401 and touches no database', async function() {
		const { reader } = await explorerDatabase();
		const base = await serve(reader);

		const response = await fetch(new URL('/mcp', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(INITIALIZE) });
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe('Bearer');
		expect(await response.text()).toBe('');
		const wrong = await fetch(new URL('/mcp', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}x` }, body: JSON.stringify(INITIALIZE) });
		expect(wrong.status).toBe(401);
		await expect(connect(base, `Bearer ${TOKEN.slice(1)}`)).rejects.toThrow();

		expect(reader.totalCount).toBe(0);
	});

	test('refuses an unauthenticated request before reading its body', async function() {
		const { reader } = await explorerDatabase();
		const base = await serve(reader);

		const response = await fetch(new URL('/mcp', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":' });
		expect(response.status).toBe(401);
		expect(await response.text()).toBe('');
	});

	test('answers a body over the limit with 413 and a message of its own', async function() {
		const { reader } = await explorerDatabase();
		const base = await serve(reader);

		const response = await fetch(new URL('/mcp', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ ...INITIALIZE, padding: 'x'.repeat(256 * 1024) }) });
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: 'Request body over 262144 bytes' }, id: null });
	});

	test('reports a tool\'s own failure to the operator and tells the agent only that it failed', async function() {
		const unreachable = new pg.Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 2_000 });
		onTestFinished(function() {
			return(unreachable.end());
		});
		const failures: Failure[] = [];
		const client = await connect(await serve(unreachable, { failures }));

		const result = await call(client, 'status', {});
		expect(result).toEqual({ isError: true, text: INTERNAL_ERROR_MESSAGE, structured: undefined });
		expect(failures).toHaveLength(1);
		expect(failures[0]?.site).toEqual({ tool: 'status' });
		expect(failures[0]?.error).toBeInstanceOf(Error);
	});

	test('answers health checks without a token and other methods on /mcp with 405', async function() {
		const { reader } = await explorerDatabase();
		const base = await serve(reader);

		const health = await fetch(new URL('/healthz', base));
		expect(health.status).toBe(200);
		expect(await health.text()).toBe('ok');
		const get = await fetch(new URL('/mcp', base), { headers: { Authorization: `Bearer ${TOKEN}` } });
		expect(get.status).toBe(405);
		expect(get.headers.get('allow')).toBe('POST');
		expect(reader.totalCount).toBe(0);
	});

	test('answers a malformed body with a JSON-RPC parse error and no CORS headers', async function() {
		const { reader } = await explorerDatabase();
		const base = await serve(reader);

		const response = await fetch(new URL('/mcp', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, Origin: 'https://example.com' }, body: '{"jsonrpc":' });
		expect(response.status).toBe(400);
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
		expect(await response.json()).toEqual({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
	});

	test('lists the nine tools', async function() {
		const { reader } = await explorerDatabase();
		const client = await connect(await serve(reader));

		const listed = await client.listTools();
		expect(listed.tools.map(function(tool) {
			return(tool.name);
		}).sort()).toEqual(['account', 'block', 'describe', 'history', 'holders', 'rep_weights', 'sql', 'staple', 'status']);
		expect(client.getInstructions()).toContain('keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg');
	});

	test('lists the holders of a minted token highest first, and the account of each with its balances', async function() {
		const context = await ledgerFixture();
		const { token, first, second } = await mintedToken(context);
		await indexAll(context.writer);
		const client = await connect(await serve(context.reader));

		const holders = await answer(client, 'holders', { token: addressOf(token) });
		expect(holders).toEqual({
			token: addressOf(token),
			holders: [
				{ account: addressOf(first), amount: '100', decimals: 2, amount_units: '1' },
				{ account: addressOf(second), amount: '50', decimals: 2, amount_units: '0.5' }
			]
		});
		expect(await answer(client, 'holders', { token: addressOf(token), limit: 1 })).toMatchObject({ holders: [{ account: addressOf(first) }] });

		const account = await answer(client, 'account', { account: addressOf(token) });
		expect(account).toMatchObject({ account: { account: addressOf(token), kind: 'TOKEN', name: 'CENT' }, balances: [], balances_truncated: false });
		const holder = await answer(client, 'account', { account: addressOf(first) });
		expect(holder['balances']).toContainEqual({ token: addressOf(token), amount: '100', decimals: 2, amount_units: '1' });
	});

	test('pages an account\'s history with before, newest first, without repeating a row', async function() {
		const context = await ledgerFixture();
		await sends(context);
		await indexAll(context.writer);
		const client = await connect(await serve(context.reader));
		const sender = addressOf(requireAt(context.network.users, 0));

		const whole = await answer(client, 'history', { account: sender, limit: 500 });
		expect(whole['next_before']).toBeNull();
		const everything = listOf(whole['history']);
		expect(everything.length).toBeGreaterThanOrEqual(5);

		const paged: unknown[] = [];
		let before: unknown = undefined;
		for (let page = 0; page < 20; page++) {
			const cursor: Readonly<Record<string, unknown>> = {};
			if (before !== undefined) {
				Object.assign(cursor, { before });
			}
			const next = await answer(client, 'history', { account: sender, limit: 2, ...cursor });
			const rows = listOf(next['history']);
			expect(rows.length).toBeLessThanOrEqual(2);
			paged.push(...rows);
			before = next['next_before'];
			if (before === null) {
				break;
			}
		}
		expect(paged).toEqual(everything);

		const outgoing = await answer(client, 'history', { account: sender, direction: 'out', type: 'SEND', token: addressOf(context.network.baseToken) });
		const outgoingRows = listOf(outgoing['history']);
		expect(outgoingRows).toHaveLength(5);
		for (const row of outgoingRows) {
			expect(row).toMatchObject({ direction: 'out', type: 'SEND', token: addressOf(context.network.baseToken) });
		}
	});

	test('refuses a malformed cursor, address or hash as a tool error naming the field', async function() {
		const { reader } = await explorerDatabase();
		const client = await connect(await serve(reader));
		const someone = 'keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg';

		const cases = [
			{ name: 'block', args: { hash: 'A'.repeat(63) }, field: 'hash' },
			{ name: 'staple', args: { hash: 'G'.repeat(64) }, field: 'hash' },
			{ name: 'holders', args: { token: 'keeta_nonsense' }, field: 'token' },
			{ name: 'account', args: { account: `${someone}x` }, field: 'account' },
			{ name: 'history', args: { account: someone, before: 'not a cursor' }, field: 'before' },
			{ name: 'history', args: { account: someone, token: 'keeta_' }, field: 'token' },
			{ name: 'history', args: { account: someone, limit: 501 }, field: 'limit' }
		];
		for (const { name, args, field } of cases) {
			const result = await call(client, name, args);
			expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
			expect(result.text).toContain(field);
			expect(result.text).not.toMatch(/\n\s+at /);
		}
		expect(reader.totalCount).toBe(0);
	});

	test('answers a block with its operations and a staple by any of its block hashes', async function() {
		const context = await ledgerFixture();
		await sends(context);
		await indexAll(context.writer);
		const client = await connect(await serve(context.reader));
		const latest = context.cursor.previous(requireAt(context.network.users, 0));
		if (latest === null) {
			throw(new Error('the sender has no blocks'));
		}
		const hash = latest.toString();

		const block = await answer(client, 'block', { hash: hash.toLowerCase() });
		expect(block).toMatchObject({ block: { hash, account: addressOf(requireAt(context.network.users, 0)), operation_count: 1 }, operations: [{ idx: 0, type: 'SEND', amount: '2' }] });
		const staple = await answer(client, 'staple', { hash });
		const blocks = staple['blocks'];
		expect(blocks).toHaveLength(2);
		const stapleHash = answerOf(staple['staple'])?.['blocks_hash'];
		expect(stapleHash).toMatch(/^[0-9A-F]{64}$/);
		expect(await answer(client, 'staple', { hash: stapleHash })).toEqual(staple);
		expect(staple['votes']).not.toHaveLength(0);
		expect(await answer(client, 'block', { hash: '0'.repeat(64) })).toEqual({ block: null, operations: [] });
	});

	test('runs sql read-only and refuses a write as a tool error with its reason', async function() {
		const { reader } = await explorerDatabase();
		const client = await connect(await serve(reader));

		const deleted = await call(client, 'sql', { query: 'DELETE FROM explorer.holdings' });
		expect(deleted.isError).toBe(true);
		expect(deleted.text).toMatch(/^sql-error: /);
		const timedOut = await call(client, 'sql', { query: 'SELECT pg_sleep(2)', timeout_ms: 100 });
		expect(timedOut.isError).toBe(true);
		expect(timedOut.text).toMatch(/^timeout: /);
		expect(await answer(client, 'sql', { query: 'SELECT 1 AS one' })).toMatchObject({ columns: ['one'], rows: [{ one: 1 }], truncated: null });
	});

	test('describes the views with their columns and the rules, and reports status and rep weights', async function() {
		const context = await ledgerFixture();
		await indexAll(context.writer);
		const client = await connect(await serve(context.reader));

		const described = await answer(client, 'describe', {});
		const holders = listOf(described['views']).map(answerOf).find(function(view) {
			return(view?.['name'] === 'holders');
		});
		expect(holders?.['comment']).toContain('token_id');
		expect(holders?.['columns']).toContainEqual({ name: 'token_id', type: 'bigint' });
		expect(described['rules']).toContain('explorer.id_of');

		const status = await answer(client, 'status', {});
		expect(status).toMatchObject({ behind: '0', paused_reason: null, lag_seconds: '0' });
		const weights = await answer(client, 'rep_weights', { limit: 2 });
		expect(weights['rep_weights']).toHaveLength(2);
	});

	test('makes calls beyond the concurrent query cap wait rather than fail', async function() {
		const { reader } = await explorerDatabase();
		const client = await connect(await serve(reader, { maxConcurrentQueries: 1 }));

		const answers = await Promise.all([1, 2, 3].map(function() {
			return(call(client, 'sql', { query: 'SELECT pg_sleep(0.2) IS NULL AS slept' }));
		}));
		for (const answer of answers) {
			expect(answer.isError).toBe(false);
		}
		expect(reader.totalCount).toBe(1);
	});
});
