import { describe, expect } from 'vitest';
import { FAUCET, publishedStaple, userOf } from './genesis.js';
import { expectConvergedDumps, useDevnet } from './use-devnet.js';
import type { Timeout } from './use-devnet.js';

/*
 * A node killed and started again, two staples each awaited on four nodes,
 * and two rounds of dumps took about a second.
 */
const KILL_AND_RESTART: Timeout = { milliseconds: 60_000, reason: 'two node restarts, a few staples awaited on four nodes, and four dumps' };

const devnet = useDevnet();

describe('the devnet harness', function() {
	devnet.test('kills a node, which comes back behind its proxy, catches up and votes again', KILL_AND_RESTART, async function(network) {
		const killed = network.nodes[3];
		const previousProcess = killed.processID;
		await network.kill(3);
		expect(killed.running).toBe(false);

		// The client knows only the three that run, so it does not wait on the one that is down.
		const faucet = network.client(FAUCET, [0, 1, 2]);
		const missed = publishedStaple(await faucet.send(userOf(50), 100n, faucet.baseToken));
		await network.settled(missed);

		await network.restart(3);
		expect(killed.processID).not.toBe(previousProcess);
		// A node catches up from its manual peers as it starts.
		await network.settled(missed, [killed]);
		await expectConvergedDumps(network);

		const everyone = network.client(FAUCET);
		const after = publishedStaple(await everyone.send(userOf(51), 100n, everyone.baseToken));
		expect(after.votes).toHaveLength(4);
		await network.settled(after);
		await expectConvergedDumps(network);
	});
});
