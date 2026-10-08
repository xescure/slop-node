import { describe, expect, test } from 'vitest';
import type { JSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { useLocalNodes } from '../testing/local-node.js';
import { KVInternals } from '../upstream/internals.js';
import { SwitchStore } from './switch-store.js';

type Release = () => void;

/** A store in memory whose writes complete only once the test releases them. */
class HeldWrites extends KVInternals.KVStorageProviderMemory {
	readonly held: Release[] = [];

	override async set(arena: string, key: string, value: JSONSerializable | undefined): Promise<void> {
		await new Promise<void>((resolve) => {
			this.held.push(resolve);
		});
		await super.set(arena, key, value);
	}
}

const nodes = useLocalNodes();

describe('the store of a switch', function() {
	test('passes operations to the node\'s store, and once detached waits for those under way and keeps later ones from it', async function() {
		const store = new HeldWrites();
		const switchStore = new SwitchStore(store);
		const underWay = switchStore.set('knownPeers', 'first', 1);
		let detached = false;
		const detaching = switchStore.detach().then(function(): void {
			detached = true;
		});
		await Promise.resolve();
		expect(detached).toBe(false);

		store.held.shift()?.();
		await underWay;
		await detaching;
		await switchStore.set('knownPeers', 'second', 2);

		expect(await store.getAll('knownPeers')).toEqual({ first: 1 });
		expect(await switchStore.get('knownPeers', 'second')).toBe(2);
		expect(store.held).toEqual([]);

		switchStore.attach();
		expect(await switchStore.get('knownPeers', 'first')).toBe(1);
	});

	test('is the switch\'s while the node runs, and keeps the switch from the node\'s store once the node has stopped', async function() {
		const store = new KVInternals.KVStorageProviderMemory();
		const running = await nodes.start({ p2p: { kv: store } });
		await running.node.switch.config.kv.set('lastSeenPeers', 'while-running', '1');

		await running.node.stop();
		await running.node.switch.config.kv.set('lastSeenPeers', 'after-stop', '2');

		expect(await store.getAll('lastSeenPeers')).toEqual({ 'while-running': '1' });
	});
});
