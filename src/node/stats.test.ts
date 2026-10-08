import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BufferStorage } from '@keetanetwork/keetanet-client/lib/utils/buffer.js';
import { useLocalNodes } from '../testing/local-node.js';
import { KVInternals } from '../upstream/internals.js';
import { NodeStats } from './stats.js';

const lib = KeetaNet.lib;

const CHECKSUM_KEY = 'checksum';

/** A store in memory whose counters fail while it is told to, as Postgres does while it restarts. */
class InterruptedStore extends KVInternals.KVStorageProviderMemory {
	interrupted = false;
	readonly #outage = new Error('connect ENOENT /tmp/postgres/socket');

	override incr(arena: string, key: string, change: number): Promise<bigint> {
		if (this.interrupted) {
			return(Promise.reject(this.#outage));
		}
		return(super.incr(arena, key, change));
	}

	override xor(arena: null, key: string, change: BufferStorage): Promise<void> {
		if (this.interrupted) {
			return(Promise.reject(this.#outage));
		}
		return(super.xor(arena, key, change));
	}
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error: unknown) {
		return(error);
	}
	throw(new Error('the promise was not refused'));
}

const nodes = useLocalNodes();

describe('the node\'s statistics', function() {
	test('upstream\'s fail every later sync and read once one sync has failed, which is why the node has its own', async function() {
		const store = new InterruptedStore();
		const stats = new lib.Stats({ kv: store });
		stats.incr('ledger', 'staples', 1);
		store.interrupted = true;
		const outage = await refusal(stats.sync());

		store.interrupted = false;
		stats.incr('ledger', 'staples', 1);
		expect(await refusal(stats.sync())).toBe(outage);
		expect(await refusal(stats.getXor(CHECKSUM_KEY))).toBe(outage);
	});

	test('a sync after a failed one writes what the failed one could not, and reads succeed again', async function() {
		const store = new InterruptedStore();
		const stats = new NodeStats({ kv: store });
		stats.incr('ledger', 'staples', 2);
		stats.xor(CHECKSUM_KEY, 0b0101n);
		store.interrupted = true;
		await refusal(stats.sync());

		store.interrupted = false;
		stats.incr('ledger', 'staples', 1);
		stats.xor(CHECKSUM_KEY, 0b0011n);
		await stats.sync();

		expect(await stats.get('ledger', 'staples')).toBe(3);
		expect((await stats.getXor(CHECKSUM_KEY)).toBigInt()).toBe(0b0110n);
		const fresh = new NodeStats({ kv: store });
		expect(await fresh.get('ledger', 'staples')).toBe(3);
		expect((await fresh.getXor(CHECKSUM_KEY)).toBigInt()).toBe(0b0110n);
	});

	test('changes a sync wrote are not written again by the next', async function() {
		const store = new InterruptedStore();
		const stats = new NodeStats({ kv: store });
		stats.incr('ledger', 'staples', 1);
		stats.xor(CHECKSUM_KEY, 0b0001n);
		await stats.sync();

		stats.incr('ledger', 'staples', 1);
		store.interrupted = true;
		await refusal(stats.sync());
		store.interrupted = false;
		await stats.sync();

		const fresh = new NodeStats({ kv: store });
		expect(await fresh.get('ledger', 'staples')).toBe(2);
		expect((await fresh.getXor(CHECKSUM_KEY)).toBigInt()).toBe(0b0001n);
	});

	test('a node keeps its statistics in them', async function() {
		const { node } = await nodes.create();
		expect(node.stats).toBeInstanceOf(NodeStats);
		expect(node.copy().stats).toBe(node.stats);
	});
});
