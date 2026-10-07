import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { expect, onTestFinished, test } from 'vitest';
import { processOfConnection } from './origin.js';

const LOOPBACK = '127.0.0.1';

/** A server whose next accepted connection is answered, with the server's port. */
async function acceptingServer(): Promise<{ readonly port: number; readonly accepted: Promise<Socket> }> {
	const server = createServer();
	const accepted = new Promise<Socket>(function(resolve) {
		server.once('connection', resolve);
	});
	await new Promise<void>(function(resolve) {
		server.listen(0, LOOPBACK, resolve);
	});
	onTestFinished(async function() {
		const socket = await accepted;
		socket.destroy();
		await new Promise<void>(function(resolve) {
			server.close(function() {
				resolve();
			});
		});
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw(new Error('the server has no TCP address'));
	}
	return({ port: address.port, accepted });
}

test('names the process that opened a connection, among those given', async function() {
	const { port, accepted } = await acceptingServer();
	const child = spawn(process.execPath, ['-e', `require('node:net').connect(${String(port)}, '${LOOPBACK}'); process.stdin.resume();`], { stdio: ['pipe', 'ignore', 'inherit'] });
	onTestFinished(function() {
		child.kill('SIGKILL');
	});
	const socket = await accepted;
	const processID = child.pid;
	if (processID === undefined) {
		throw(new Error('the child has no process ID'));
	}

	expect(await processOfConnection(socket, new Set([process.pid, processID]))).toBe(processID);
	expect(await processOfConnection(socket, new Set([process.pid]))).toBeUndefined();
});

test('names this process for a connection it opened itself', async function() {
	const { port, accepted } = await acceptingServer();
	const own = connect(port, LOOPBACK);
	onTestFinished(function() {
		own.destroy();
	});
	const socket = await accepted;
	expect(await processOfConnection(socket, new Set([process.pid]))).toBe(process.pid);
});
