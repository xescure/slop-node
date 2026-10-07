import { readdirSync, readFileSync } from 'node:fs';
import { isJSONObject } from './document.js';

export const CAPTURE_DIRECTORY: URL = new URL('../../../conformance/api/mainnet/', import.meta.url);

/** One request to a mainnet representative and its answer, as conformance/API.md describes the files. */
export type Capture = {
	readonly request: { readonly method: 'GET'; readonly path: string; readonly query: Readonly<Record<string, string>> };
	readonly status: number;
	readonly contentType: string | null;
	readonly body: unknown;
};

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
	return(isJSONObject(value) && Object.values(value).every(function(entry): boolean {
		return(typeof entry === 'string');
	}));
}

export function readJSON(file: URL): unknown {
	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
	return(parsed);
}

export function jsonFiles(directory: URL): readonly string[] {
	return(readdirSync(directory).filter(function(name): boolean {
		return(name.endsWith('.json'));
	}).sort());
}

/** The capture in the named file of the capture directory. */
export function readCapture(name: string): Capture {
	const parsed = readJSON(new URL(name, CAPTURE_DIRECTORY));
	if (!isJSONObject(parsed) || !isJSONObject(parsed['request']) || !isJSONObject(parsed['headers'])) {
		throw(new Error(`${name}: not a capture`));
	}
	const { request, headers, status } = parsed;
	const { method, path, query } = request;
	const contentType = headers['content-type'];
	if (method !== 'GET' || typeof path !== 'string' || !isStringRecord(query) || typeof status !== 'number' || (typeof contentType !== 'string' && contentType !== null)) {
		throw(new Error(`${name}: not a GET capture`));
	}
	return({ request: { method, path, query }, status, contentType, body: parsed['body'] });
}

/** The capture's request below the API prefix, its query encoded as a form, as the capture sent it. */
export function requestPathOf(capture: Capture): string {
	const path = capture.request.path.replace(/^\/api/, '');
	const query = new URLSearchParams(capture.request.query).toString();
	if (query === '') {
		return(path);
	}
	return(`${path}?${query}`);
}
