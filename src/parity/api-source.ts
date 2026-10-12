import type { RepresentativePacer, ServedAnswer } from './representative-pacer.js';
import { isFields } from './values.js';

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

/** Sends a GET request below the API's root, and reads its answer with the wait a Retry-After header asks for. */
async function servedOverHTTP(endpoint: string, path: string, timeoutMilliseconds: number): Promise<ServedAnswer> {
	const response = await fetch(`${endpoint}${path}`, { method: 'GET', signal: AbortSignal.timeout(timeoutMilliseconds) });
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// Kept as text, as a representative's HTML page for a path that names no route.
	}
	return({ answer: { status: response.status, body }, retryAfter: response.headers.get('retry-after') });
}

/** A source that reads the API at its root over HTTP. */
export function httpSource(endpoint: string, timeoutMilliseconds: number = REQUEST_TIMEOUT_MILLISECONDS): APISource {
	return({
		endpoint,
		async get(path: string): Promise<APIAnswer> {
			return((await servedOverHTTP(endpoint, path, timeoutMilliseconds)).answer);
		}
	});
}

/** A representative's API read over HTTP, its requests paced by the pacer, which every parity tool in the process shares. */
export function pacedSource(endpoint: string, pacer: RepresentativePacer, stopped: AbortSignal, timeoutMilliseconds: number = REQUEST_TIMEOUT_MILLISECONDS): APISource {
	return({
		endpoint,
		get(path: string): Promise<APIAnswer> {
			return(pacer.paced(endpoint, stopped, function() {
				return(servedOverHTTP(endpoint, path, timeoutMilliseconds));
			}));
		}
	});
}

const TOO_MANY_REQUESTS = 429;

const FIRST_SERVER_ERROR = 500;

const FIRST_NON_SERVER_ERROR = 600;


/** Whether the body is the API's error envelope, which every failure the API itself answers has. */
export function isErrorEnvelope(body: unknown): body is Readonly<Record<string, unknown>> {
	return(isFields(body) && body['error'] === true);
}

/**
 * Whether the answer is an internal failure that names no error code of
 * the API: the envelope with nothing but an error ID, which a node answers
 * for a request it cannot serve and for one it fails at alike, so that two
 * such answers show nothing alike.
 */
export function isAnonymousFailure(answer: APIAnswer): boolean {
	return(answer.status >= FIRST_SERVER_ERROR && isErrorEnvelope(answer.body) && answer.body['code'] === undefined);
}

/**
 * Whether the API itself answered: not a rate limit, nor a server error
 * without the API's error envelope, which a gateway or proxy in front of a
 * representative answers in its place.
 */
export function answeredByAPI(answer: APIAnswer): boolean {
	if (answer.status === TOO_MANY_REQUESTS) {
		return(false);
	}
	if (answer.status < FIRST_SERVER_ERROR || answer.status >= FIRST_NON_SERVER_ERROR) {
		return(true);
	}
	return(isErrorEnvelope(answer.body));
}

/** The body of a 200 answer; any other status is an error naming the request. */
export async function getOK(source: APISource, path: string): Promise<unknown> {
	const answer = await source.get(path);
	if (answer.status !== 200) {
		throw(new Error(`${source.endpoint}${path} answered ${String(answer.status)}: ${JSON.stringify(answer.body).slice(0, 200)}`));
	}
	return(answer.body);
}
