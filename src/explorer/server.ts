import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type pg from 'pg';
import { authorizer } from './auth.js';
import type { BearerToken } from './auth.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import type { SQLLimits } from './sql.js';
import { QuerySlots, registerTools } from './tools.js';
import type { ReportFailure, ToolContext } from './tools.js';

export type ExplorerApp = { readonly app: Express };

const SERVER_INFO = { name: 'slop-explorer', version: '1.0.0' };

const PARSE_ERROR = -32700;

const INVALID_REQUEST = -32600;

const INTERNAL_ERROR = -32603;

const BODY_LIMIT_BYTES = 256 * 1024;

const PAYLOAD_TOO_LARGE = 413;

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
		try {
			const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
			registerTools(server, context);
			// Without a session id generator the transport is stateless.
			const transport = new StreamableHTTPServerTransport({ maxRequestBodySize: BODY_LIMIT_BYTES });
			response.on('close', function() {
				void transport.close();
				void server.close();
			});
			await server.connect(asTransport(transport));
			await transport.handleRequest(request, response, request.body);
		} catch (error) {
			context.report(error, { tool: null });
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
const bodyError = function(report: ReportFailure) {
	return(function(error: unknown, _request: Request, response: Response, next: NextFunction): void {
		if (response.headersSent) {
			next(error);
			return;
		}
		if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
			if (error.status === PAYLOAD_TOO_LARGE) {
				jsonRPCError(response, PAYLOAD_TOO_LARGE, INVALID_REQUEST, `Request body over ${BODY_LIMIT_BYTES.toString()} bytes`);
				return;
			}
			jsonRPCError(response, error.status, PARSE_ERROR, 'Parse error');
			return;
		}
		report(error, { tool: null });
		jsonRPCError(response, 500, INTERNAL_ERROR, 'Internal error');
	});
};

/** The explorer's HTTP app: a health check, and the MCP endpoint behind a bearer token. */
export function explorerApp(input: { readonly reader: pg.Pool; readonly tokens: readonly BearerToken[]; readonly limits: SQLLimits; readonly maxConcurrentQueries: number; readonly report: ReportFailure }): ExplorerApp {
	const context: ToolContext = { reader: input.reader, limits: input.limits, slots: new QuerySlots(input.maxConcurrentQueries), report: input.report };
	const authorized = authorizer(input.tokens);
	const app = express();
	app.disable('x-powered-by');

	app.get('/healthz', function(_request, response) {
		response.type('text/plain').send('ok');
	});

	app.use('/mcp', function(request, response, next) {
		if (!authorized(request.get('authorization'))) {
			response.status(401).set('WWW-Authenticate', 'Bearer').end();
			return;
		}
		next();
	});
	app.post('/mcp', express.json({ limit: BODY_LIMIT_BYTES }), answerMCP(context));
	app.all('/mcp', function(_request, response) {
		response.status(405).set('Allow', 'POST').end();
	});
	app.use(bodyError(input.report));

	return({ app });
}
