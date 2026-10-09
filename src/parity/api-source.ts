import type { PeerPacer } from '../node/bootstrap-pacing.js';

/** An answer of a node's HTTP API: its status, and its body parsed as JSON, or as text when it is not JSON. */
export type APIAnswer = { readonly status: number; readonly body: unknown };

/**
 * One node's API, which the parity tools only read: a source sends nothing
 * but GET requests, below the API's root.
 */
export type APISource = {
	/** The API's root, which names the node in the parity log. */
	readonly endpoint: string;
	get(path: string): Promise<APIAnswer>;
};

/** A representative may take seconds over a large account; this bounds a request that hangs. */
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;

/** A source that reads the API at its root over HTTP. */
export function httpSource(endpoint: string, timeoutMilliseconds: number = REQUEST_TIMEOUT_MILLISECONDS): APISource {
	return({
		endpoint,
		async get(path: string): Promise<APIAnswer> {
			const response = await fetch(`${endpoint}${path}`, { method: 'GET', signal: AbortSignal.timeout(timeoutMilliseconds) });
			const text = await response.text();
			let body: unknown = text;
			try {
				body = JSON.parse(text);
			} catch {
				// Kept as text, as a representative's HTML page for a path that names no route.
			}
			return({ status: response.status, body });
		}
	});
}

/** The source with its requests kept apart by the pacer, which every parity tool in the process shares. */
export function pacedSource(source: APISource, pacer: PeerPacer, stopped: AbortSignal): APISource {
	return({
		endpoint: source.endpoint,
		get(path: string): Promise<APIAnswer> {
			return(pacer.paced(source.endpoint, stopped, function() {
				return(source.get(path));
			}));
		}
	});
}

/** The body of a 200 answer; any other status is an error naming the request. */
export async function getOK(source: APISource, path: string): Promise<unknown> {
	const answer = await source.get(path);
	if (answer.status !== 200) {
		throw(new Error(`${source.endpoint}${path} answered ${String(answer.status)}: ${JSON.stringify(answer.body).slice(0, 200)}`));
	}
	return(answer.body);
}
