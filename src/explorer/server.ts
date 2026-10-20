import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type pg from 'pg';
import { authorized } from './auth.js';
import type { BearerToken } from './auth.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import type { SQLLimits } from './sql.js';
import { QuerySlots, registerTools } from './tools.js';
import type { ToolContext } from './tools.js';

export type ExplorerApp = { readonly app: Express };

const SERVER_INFO = { name: 'slop-explorer', version: '1.0.0' };

const PARSE_ERROR = -32700;

const INTERNAL_ERROR = -32603;

const jsonRPCError = function(response: Response, status: number, code: number, message: string): void {
	response.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
};

/*
 * The SDK's transport declares its optional callbacks as possibly undefined,
 * which its own Transport type does not allow under
 * exactOptionalPropertyTypes; the class implements that type.
 */
const asTransport = function(transport: StreamableHTTPServerTransport): Transport {
	return(transport as Transport);
};

/*
 * A new server and transport per request keeps no state between requests,
 * so any instance can answer any request.
 */
const answerMCP = function(context: ToolContext) {
	return(async function(request: Request, response: Response): Promise<void> {
		const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
		registerTools(server, context);
		// Without a session id generator the transport is stateless.
		const transport = new StreamableHTTPServerTransport({});
		response.on('close', function() {
			void transport.close();
			void server.close();
		});
		try {
			await server.connect(asTransport(transport));
			await transport.handleRequest(request, response, request.body);
		} catch {
			if (!response.headersSent) {
				jsonRPCError(response, 500, INTERNAL_ERROR, 'Internal error');
			}
		}
	});
};

/*
 * Express's own error page carries the stack trace outside production, so a
 * body it could not read gets a JSON-RPC error instead.
 */
const bodyError = function(error: unknown, _request: Request, response: Response, next: NextFunction): void {
	if (response.headersSent) {
		next(error);
		return;
	}
	if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
		jsonRPCError(response, error.status, PARSE_ERROR, 'Parse error');
		return;
	}
	jsonRPCError(response, 500, INTERNAL_ERROR, 'Internal error');
};

/** The explorer's HTTP app: a health check, and the MCP endpoint behind a bearer token. */
export function explorerApp(input: { readonly reader: pg.Pool; readonly tokens: readonly BearerToken[]; readonly limits: SQLLimits; readonly maxConcurrentQueries: number }): ExplorerApp {
	const context: ToolContext = { reader: input.reader, limits: input.limits, slots: new QuerySlots(input.maxConcurrentQueries) };
	const app = express();
	app.disable('x-powered-by');

	app.get('/healthz', function(_request, response) {
		response.type('text/plain').send('ok');
	});

	app.use('/mcp', function(request, response, next) {
		if (!authorized(request.get('authorization'), input.tokens)) {
			response.status(401).set('WWW-Authenticate', 'Bearer').end();
			return;
		}
		next();
	});
	app.post('/mcp', express.json({ limit: '256kb' }), answerMCP(context));
	app.all('/mcp', function(_request, response) {
		response.status(405).set('Allow', 'POST').end();
	});
	app.use(bodyError);

	return({ app });
}
