import http from 'node:http';
import { onTestFinished } from 'vitest';

/** An answer the fake serves: a status and a JSON body. */
export type FakeAnswer = { readonly status: number; readonly body: unknown };

/**
 * A node's API on the loopback interface that serves fixed bodies, standing
 * in for a representative or the follower, so that no test reaches a network.
 */
export type FakeAPI = {
	/** The API's root, as the parity tools take it. */
	readonly endpoint: string;
	/** Every request received, as its method and its path below the root with the query. */
	readonly requests: string[];
	/**
	 * Serves the bodies for the path with its query, one per request in
	 * turn, and the last for every request after them.
	 */
	serve(path: string, ...bodies: readonly unknown[]): void;
	/** Serves the answers for the path, one per request in turn, and the last for every request after them. */
	answer(path: string, ...answers: readonly FakeAnswer[]): void;
};

const API_ROOT = '/api';

/** Listens until the test ends; a path it was given nothing for is answered 404. */
export async function startFakeAPI(): Promise<FakeAPI> {
	const served = new Map<string, FakeAnswer[]>();
	const requests: string[] = [];
	const server = http.createServer(function(request, response) {
		const url = request.url ?? '';
		const path = url.slice(API_ROOT.length);
		requests.push(`${request.method ?? ''} ${path}`);
		const queue = served.get(path);
		let next = queue?.[0];
		if (queue !== undefined && queue.length > 1) {
			next = queue.shift();
		}
		if (!url.startsWith(API_ROOT) || next === undefined) {
			response.writeHead(404, { 'content-type': 'text/html' });
			response.end(`Cannot GET ${url}`);
			return;
		}
		response.writeHead(next.status, { 'content-type': 'application/json; charset=utf-8' });
		response.end(JSON.stringify(next.body));
	});
	await new Promise<void>(function(resolve, reject) {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	onTestFinished(async function() {
		server.closeAllConnections();
		await new Promise<void>(function(resolve) {
			server.close(function() {
				resolve();
			});
		});
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw(new Error('the fake API has no port'));
	}
	const answer = function(path: string, ...answers: readonly FakeAnswer[]): void {
		served.set(path, [...answers]);
	};
	return({
		endpoint: `http://127.0.0.1:${String(address.port)}${API_ROOT}`,
		requests,
		answer,
		serve(path: string, ...bodies: readonly unknown[]): void {
			answer(path, ...bodies.map(function(body): FakeAnswer {
				return({ status: 200, body });
			}));
		}
	});
}
