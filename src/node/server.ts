import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

/**
 * How long stopping waits for requests in flight before it drops their
 * connections, so that a client holding a connection open cannot keep the
 * node from stopping.
 */
export const SHUTDOWN_GRACE_MILLISECONDS = 5000;

export type ListenTarget = { readonly host: string | undefined; readonly port: number };

export type Listening = { readonly server: http.Server; readonly address: AddressInfo };

export function listen(app: Express, target: ListenTarget): Promise<Listening> {
	const server = http.createServer(app);
	return(new Promise<Listening>(function(resolve, reject) {
		server.once('error', reject);
		server.listen(target.port, target.host, function() {
			server.off('error', reject);
			const address = server.address();
			if (address === null || typeof address === 'string') {
				reject(new Error('internal error: a TCP server reports no port'));
				return;
			}
			resolve({ server, address });
		});
	}));
}

/**
 * Stops accepting connections and closes the idle ones, then waits for the
 * requests in flight to be answered, for the grace period at most, after
 * which every connection still open is dropped.
 */
export function close(server: http.Server): Promise<void> {
	return(new Promise<void>(function(resolve, reject) {
		const grace = setTimeout(function() {
			server.closeAllConnections();
		}, SHUTDOWN_GRACE_MILLISECONDS);
		server.close(function(error) {
			clearTimeout(grace);
			if (error !== undefined) {
				reject(error);
				return;
			}
			resolve();
		});
		server.closeIdleConnections();
	}));
}
