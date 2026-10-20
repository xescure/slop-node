import { describe, expect, onTestFinished, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Environment } from '../node/config.js';
import { startCLI } from '../testing/cli.js';
import type { TestDatabase } from '../testing/postgres.js';
import { explorerDatabase } from './testing.js';

/* As src/testing/cli.ts runs the node: the command as built, which "make test" builds first. */
const BUILT_EXPLORER = new URL('../../dist/explorer/main.js', import.meta.url);

const TOKEN = 'explorer-main-token-0123456789abcdef';

const LISTENING = /"message":"listening on (http:\/\/[^"]+)"/;

const STOP_WITHIN_MILLISECONDS = 10_000;

const roleURL = function(database: TestDatabase, role: string): string {
	const url = new URL(database.connectionString);
	url.username = role;
	return(url.toString());
};

const environmentOf = function(database: TestDatabase): Environment {
	return({
		SLOP_EXPLORER_WRITER_URL: roleURL(database, 'explorer_writer'),
		SLOP_EXPLORER_READER_URL: roleURL(database, 'explorer_reader'),
		SLOP_EXPLORER_TOKENS: TOKEN,
		SLOP_EXPLORER_LISTEN_PORT: '0',
		SLOP_EXPLORER_LOG_FORMAT: 'json'
	});
};

const statusOf = async function(base: string): Promise<unknown> {
	const client = new Client({ name: 'explorer-main-test', version: '1' });
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
	// As in server.ts: the class implements Transport, which its optional callbacks spell differently.
	await client.connect(transport as Transport);
	onTestFinished(function() {
		return(client.close());
	});
	return(await client.callTool({ name: 'status', arguments: {} }));
};

describe('slop-explorer', function() {
	test.each(['SIGTERM', 'SIGINT'] as const)('serves the MCP until %s, then exits cleanly', async function(signal) {
		const { database } = await explorerDatabase();
		const explorer = startCLI([], environmentOf(database), BUILT_EXPLORER);
		const [, base = ''] = await explorer.printed(LISTENING);

		const health = await fetch(new URL('/healthz', base));
		expect(await health.text()).toBe('ok');
		expect(await statusOf(base)).toMatchObject({ structuredContent: { behind: '0', paused_reason: null } });

		const stopped = Date.now();
		explorer.signal(signal);
		expect(await explorer.exited).toEqual({ code: 0, signal: null });
		expect(Date.now() - stopped).toBeLessThan(STOP_WITHIN_MILLISECONDS);
		expect(explorer.stdout()).toContain(`"message":"stopping on ${signal}"`);
		expect(explorer.stderr()).toBe('');
	});

	test('names every problem of its configuration, and does not start', async function() {
		const explorer = startCLI([], { SLOP_EXPLORER_LISTEN_PORT: '70000' }, BUILT_EXPLORER);

		expect(await explorer.exited).toEqual({ code: 1, signal: null });
		const stderr = explorer.stderr();
		for (const problem of ['SLOP_EXPLORER_WRITER_URL is not set', 'SLOP_EXPLORER_READER_URL is not set', 'SLOP_EXPLORER_TOKENS is not set', 'SLOP_EXPLORER_LISTEN_PORT must be']) {
			expect(stderr).toContain(problem);
		}
		expect(explorer.stdout()).toBe('');
	});

	test('exits with a failure, without listening, when its migrations cannot run', async function() {
		const { database } = await explorerDatabase();
		const unreachable = new URL(roleURL(database, 'explorer_writer'));
		unreachable.pathname = '/no_such_database';
		const explorer = startCLI([], { ...environmentOf(database), SLOP_EXPLORER_WRITER_URL: unreachable.toString() }, BUILT_EXPLORER);

		expect(await explorer.exited).toEqual({ code: 1, signal: null });
		expect(explorer.stderr()).toContain('the explorer migrations could not be applied');
		expect(explorer.stdout()).not.toMatch(LISTENING);
	});
});
