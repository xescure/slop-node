import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { TCPProxy } from './proxy.js';
import type { ConnectionOrigin } from './proxy.js';

const LOOPBACK = '127.0.0.1';

const cleanups: (() => Promise<void>)[] = [];

type Deferred = { readonly promise: Promise<number>; readonly resolve: (value: number) => void };

function deferred(): Deferred {
	let resolve: (value: number) => void = function() {
		// Replaced as the promise is made.
	};
	const promise = new Promise<number>(function(resolvePromise) {
		resolve = resolvePromise;
	});
	return({ promise, resolve });
}

const noOrigin: ConnectionOrigin = function() {
	return(Promise.resolve(undefined));
};

afterEach(async function() {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

/** A server that answers every byte with itself, prefixed by its name. */
async function echoServer(name: string): Promise<number> {
	const sockets = new Set<Socket>();
	const server = createServer(function(socket) {
		sockets.add(socket);
		socket.on('close', function() {
			sockets.delete(socket);
		});
		socket.on('error', function() {
			// The proxy may cut the connection.
		});
		socket.on('data', function(data) {
			socket.write(`${name}:${data.toString()}`);
		});
	});
	await listening(server);
	cleanups.push(function() {
		for (const socket of sockets) {
			socket.destroy();
		}
		return(closed(server));
	});
	return(portOf(server));
}

function listening(server: Server): Promise<void> {
	return(new Promise(function(resolve, reject) {
		server.once('error', reject);
		server.listen(0, LOOPBACK, function() {
			resolve();
		});
	}));
}

function closed(server: Server): Promise<void> {
	return(new Promise(function(resolve) {
		server.close(function() {
			resolve();
		});
	}));
}

function portOf(server: Server): number {
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw(new Error('the server has no TCP address'));
	}
	return(address.port);
}

/** A port nothing listens on, so that connecting to it is refused. */
async function refusingPort(): Promise<number> {
	const server = createServer();
	await listening(server);
	const port = portOf(server);
	await closed(server);
	return(port);
}

async function startProxy(target: number, origin: ConnectionOrigin = noOrigin): Promise<TCPProxy> {
	const proxy = await TCPProxy.start({ target, origin });
	cleanups.push(function() {
		return(proxy.close());
	});
	return(proxy);
}

type Client = {
	readonly socket: Socket;
	/** Everything received until the connection ends. */
	readonly ended: Promise<string>;
	/** Resolves once the text received so far includes the expected text. */
	readonly received: (expected: string) => Promise<void>;
};

function client(port: number): Promise<Client> {
	return(new Promise(function(resolve, reject) {
		const socket = connect(port, LOOPBACK);
		let text = '';
		const waiting: (() => void)[] = [];
		socket.setEncoding('utf8');
		socket.on('data', function(chunk: string) {
			text += chunk;
			for (const check of waiting) {
				check();
			}
		});
		socket.on('error', function() {
			// A cut connection ends the same way as a closed one.
		});
		const ended = new Promise<string>(function(resolveEnded) {
			socket.on('close', function() {
				resolveEnded(text);
			});
		});
		cleanups.push(function() {
			socket.destroy();
			return(ended.then(function() {
				// Only the close matters.
			}));
		});
		socket.once('connect', function() {
			resolve({
				socket,
				ended,
				received: function(expected) {
					return(new Promise<void>(function(resolveReceived, rejectReceived) {
						const check = function(): void {
							if (text.includes(expected)) {
								resolveReceived();
							}
						};
						waiting.push(check);
						check();
						void ended.then(function(all) {
							rejectReceived(new Error(`the connection ended having received ${JSON.stringify(all)}, not ${JSON.stringify(expected)}`));
						});
					}));
				}
			});
		});
		socket.once('error', reject);
	}));
}

describe('the TCP proxy of a devnet node', function() {
	test('passes bytes both ways between a client and its target', async function() {
		const proxy = await startProxy(await echoServer('a'));
		const user = await client(proxy.port);
		user.socket.write('ping');
		await user.received('a:ping');
	});

	test('holds connections while its target starts, and passes them on once released', async function() {
		const proxy = await startProxy(await echoServer('a'));
		proxy.hold();
		const user = await client(proxy.port);
		user.socket.write('early');
		proxy.release();
		await user.received('a:early');
	});

	test('cuts every connection and refuses new ones while blocked, in both directions', async function() {
		const proxy = await startProxy(await echoServer('a'));
		const before = await client(proxy.port);
		before.socket.write('one');
		await before.received('a:one');

		proxy.block();
		expect(await before.ended).toBe('a:one');
		expect(proxy.refusals).toBe(0);
		const during = await client(proxy.port);
		expect(await during.ended).toBe('');
		expect(proxy.refusals).toBe(1);

		proxy.unblock();
		const after = await client(proxy.port);
		after.socket.write('two');
		await after.received('a:two');
	});

	test('cuts held connections when blocked', async function() {
		const proxy = await startProxy(await echoServer('a'));
		proxy.hold();
		const user = await client(proxy.port);
		proxy.block();
		expect(await user.ended).toBe('');
	});

	test('sends new connections to a new target', async function() {
		const proxy = await startProxy(await echoServer('a'));
		const first = await client(proxy.port);
		proxy.setTarget(await echoServer('b'));
		const second = await client(proxy.port);
		first.socket.write('x');
		second.socket.write('y');
		await first.received('a:x');
		await second.received('b:y');
	});

	test('closes a connection its target refuses', async function() {
		const proxy = await startProxy(await refusingPort());
		const user = await client(proxy.port);
		expect(await user.ended).toBe('');
	});

	test('refuses only the connections of the processes it is told to', async function() {
		const refused = new Set<number>();
		let nextOrigin = 1;
		// Each client's port is known only once it has connected, which the proxy may see first.
		const origins = new Map<number, Deferred>();
		const originOfPort = function(port: number): Deferred {
			let origin = origins.get(port);
			if (origin === undefined) {
				origin = deferred();
				origins.set(port, origin);
			}
			return(origin);
		};
		const origin: ConnectionOrigin = async function(socket, candidates) {
			const processID = await originOfPort(socket.remotePort ?? 0).promise;
			if (!candidates.has(processID)) {
				return(undefined);
			}
			return(processID);
		};
		const proxy = await startProxy(await echoServer('a'), origin);
		const opened = async function(): Promise<Client> {
			const user = await client(proxy.port);
			originOfPort(user.socket.localPort ?? 0).resolve(nextOrigin++);
			return(user);
		};
		const first = await opened();
		const second = await opened();
		first.socket.write('1');
		second.socket.write('2');
		await first.received('a:1');
		await second.received('a:2');

		refused.add(1);
		await proxy.refuseFrom(refused);
		expect(await first.ended).toBe('a:1');
		second.socket.write('3');
		await second.received('a:3');

		refused.add(3);
		await proxy.refuseFrom(refused);
		const third = await opened();
		expect(await third.ended).toBe('');
		// The connection cut as it was refused is not one refused as it came.
		expect(proxy.refusals).toBe(1);

		await proxy.refuseFrom(new Set());
		const fourth = await opened();
		fourth.socket.write('4');
		await fourth.received('a:4');
	});
});
