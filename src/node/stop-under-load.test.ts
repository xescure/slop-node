import { expect, onTestFinished, test } from 'vitest';
import { PostgresKVStorage } from '../kv/postgres.js';
import { useClusters } from '../testing/cluster.js';
import { captureUnhandledRejections } from '../testing/unhandled-rejections.js';

const clusters = useClusters();

const STOPS = 20;

/** Broadcasts in flight as the node stops, each from the node to every peer it knows. */
const BROADCASTS_PER_STOP = 20;

/** Every representative's vote is needed, so each is a peer the others know. */
const EQUAL_WEIGHTS: readonly bigint[] = [1000n, 1000n, 1000n];

/*
 * Twenty stops and restarts of a node on Postgres took about 10 s alone and
 * under make -j8; the limit allows for a machine several times slower.
 */
const STOP_UNDER_LOAD_TIMEOUT_MILLISECONDS = 120_000;

const WATCHED_METHODS = ['destroy', 'set', 'get', 'getAll', 'list', 'incr', 'xor'] as const;

type WatchedMethod = typeof WATCHED_METHODS[number];

/**
 * Records, until the test ends, every operation that reaches a Postgres
 * key-value store once it has been destroyed, whether or not its caller
 * handles the failure that follows.
 */
function watchUsesAfterDestroy(): readonly string[] {
	const prototype: object = PostgresKVStorage.prototype;
	const destroyed = new WeakSet();
	const late: string[] = [];
	for (const method of WATCHED_METHODS) {
		const original: unknown = Reflect.get(prototype, method);
		if (typeof original !== 'function') {
			throw(new Error(`the store has no ${method} method`));
		}
		Reflect.set(prototype, method, function(this: object, ...input: unknown[]): unknown {
			noteUse(method, this, input);
			const result: unknown = Reflect.apply(original, this, input);
			return(result);
		});
		onTestFinished(function() {
			Reflect.set(prototype, method, original);
		});
	}
	function noteUse(method: WatchedMethod, store: object, input: readonly unknown[]): void {
		if (method === 'destroy') {
			destroyed.add(store);
			return;
		}
		if (destroyed.has(store)) {
			late.push(`${method}(${input.slice(0, 2).map(String).join(', ')})`);
		}
	}
	return(late);
}

/*
 * A broadcast returns once one peer has the message, while its sends to the
 * others, which redial a peer whose connection failed, carry on
 * [Keeta TS] index.js:74312-74388, 74409-74472; stopping the node closes
 * those connections under them.
 */
test('a node stopped while it broadcasts uses its key-value store only until it has stopped, and leaves no rejection unhandled', async function() {
	const rejections = captureUnhandledRejections();
	const late = watchUsesAfterDestroy();
	const cluster = await clusters.start({ storage: 'postgres', weights: EQUAL_WEIGHTS });
	const member = cluster.representatives[2];
	if (member === undefined) {
		throw(new Error('the cluster has no third representative'));
	}

	for (let stop = 0; stop < STOPS; stop++) {
		const node = member.node;
		// The first broadcast connects the node to its peers, which the others then send over.
		await node.sendMessage(`stop-${String(stop)}-connect`, 'add', cluster.genesis, 1);
		const broadcasts = Array.from({ length: BROADCASTS_PER_STOP }, function(_ignored, index): Promise<unknown> {
			return(node.sendMessage(`stop-${String(stop)}-${String(index)}`, 'add', cluster.genesis, 1).catch(function(error: unknown): unknown {
				return(error);
			}));
		});
		await member.takeOffline();
		await Promise.all(broadcasts);
		await member.start();
	}

	expect(late).toEqual([]);
	expect(rejections.reasons).toEqual([]);
}, STOP_UNDER_LOAD_TIMEOUT_MILLISECONDS);
