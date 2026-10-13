import { describe, expect, test, vi } from 'vitest';
import { useLocalNodes } from '../testing/local-node.js';
import { opened, serveSwitch } from '../testing/peer-server.js';
import { P2PInternals } from '../upstream/internals.js';

const nodes = useLocalNodes();

describe('the peer-to-peer server', function() {
	test('logs a failure of the server, rather than leaving the failure to end the process', async function() {
		const { node } = await nodes.create();
		const { server } = await serveSwitch(node.switch, node.log);
		const logged = vi.spyOn(node.log, 'error');
		const failure = new Error('the server failed');

		server.emit('error', failure);

		expect(logged).toHaveBeenCalledWith('P2P', 'The peer-to-peer server failed:', failure);
	});

	test('logs a socket the switch fails to take', async function() {
		const { node } = await nodes.create();
		const { url } = await serveSwitch(node.switch, node.log);
		const failure = new Error('the switch failed to take the socket');
		vi.spyOn(P2PInternals.P2PWebSocket, 'connectToSwitch').mockRejectedValue(failure);
		const logged = vi.spyOn(node.log, 'error');

		const socket = new WebSocket(url);
		await opened(socket);

		await vi.waitFor(function() {
			expect(logged).toHaveBeenCalledWith('P2P', 'Attaching a peer\'s socket to the switch failed:', failure);
		});
		socket.close();
	});

	test('answers a failure to close the server', async function() {
		const { node } = await nodes.create();
		const { peers } = await serveSwitch(node.switch, node.log);
		await peers.close();

		await expect(peers.close()).rejects.toThrow('The server is not running');
	});
});
