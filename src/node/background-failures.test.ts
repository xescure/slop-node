import { describe, expect, inject, onTestFinished, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { KVSetOptionsType } from '@keetanetwork/keetanet-client/lib/kv/index.js';
import type { P2PPeer } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { JSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { PostgresKVStorage } from '../kv/postgres.js';
import type { KVRetryPolicy } from '../kv/postgres.js';
import { request, useLocalNodes } from '../testing/local-node.js';
import { createDatabase } from '../testing/postgres.js';
import { interceptQueries, serverError } from '../testing/query-faults.js';
import { captureUnhandledRejections } from '../testing/unhandled-rejections.js';
import { KVInternals } from '../upstream/internals.js';
import { NODE_VERSION } from '../version.js';
import { logUnhandledRejections, noteRejectionsHandledLate } from './background-failures.js';
import type { LocalNode } from './local.js';

const lib = KeetaNet.lib;

const CHECK_IN_ARENA = 'manualPeerCheckIn';

/** A representative no one listens for, which the node checks in with as it runs. */
const MANUAL_PEER: P2PPeer = {
	kind: lib.Node.Kind.REPRESENTATIVE,
	key: lib.Account.fromSeed('d4f6a8c1e3b5d7f9a0c2e4b6d8f1a3c5e7092b4d6f8a0c2e4b6d8f1a3c5e7b93', 0),
	endpoints: { api: 'http://127.0.0.1:9/api', p2p: 'ws://127.0.0.1:9/p2p' },
	preferUpdates: 'websocket',
	certificate: null
};

/** The error the store raises for every write of a check-in. */
const CHECK_IN_REFUSED = 'the store refuses check-ins';

/** A store in memory whose every write of a manual peer's check-in fails. */
class RefusingCheckIns extends KVInternals.KVStorageProviderMemory {
	override set(arena: string, key: string, value: JSONSerializable | undefined, options?: KVSetOptionsType): Promise<void> {
		if (arena === CHECK_IN_ARENA) {
			return(Promise.reject(new Error(CHECK_IN_REFUSED)));
		}
		return(super.set(arena, key, value, options));
	}
}

const IMMEDIATE_RETRIES: KVRetryPolicy = {
	attempts: 3,
	backoffMilliseconds: function(): number {
		return(0);
	}
};

const nodes = useLocalNodes();

/** Runs the node with the manual peer, so that the switch checks in with it at once [Keeta TS] index.js:73770-73806. */
async function runWithManualPeer(node: LocalNode): Promise<void> {
	node.config.manualPeers = [MANUAL_PEER];
	await node.run();
}

describe('a manual peer\'s check-in whose write fails', function() {
	test('is, as upstream starts it, a rejection that nothing handles', async function() {
		const rejections = captureUnhandledRejections();
		const created = await nodes.create({ p2p: { kv: new RefusingCheckIns() } });
		onTestFinished(noteRejectionsHandledLate(created.node.log));
		const rejected = rejections.next();

		await runWithManualPeer(created.node);

		expect(await rejected).toEqual(expect.objectContaining({ message: CHECK_IN_REFUSED }));
		// The switch handles the check-in once stopping waits for it [Keeta TS] index.js:73824-73831.
		await created.node.stop();
	});

	test('succeeds when the Postgres store fails it transiently, by attempting it again', async function() {
		const rejections = captureUnhandledRejections();
		const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
		onTestFinished(function() {
			return(database.drop());
		});
		const pool = database.pool();
		let checkIns = 0;
		interceptQueries(pool, function(issued, run) {
			if (issued.name === 'kv_put_entry' && issued.values[0] === CHECK_IN_ARENA && ++checkIns === 1) {
				return(Promise.reject(serverError('40001', 'could not serialize access')));
			}
			return(run());
		});
		const store = new PostgresKVStorage({ kind: 'injected', pool: function() {
			return(Promise.resolve(pool));
		} }, IMMEDIATE_RETRIES);
		onTestFinished(function() {
			return(store.destroy());
		});
		const created = await nodes.create({ p2p: { kv: store } });

		await runWithManualPeer(created.node);
		await created.node.switch.wait();

		expect(checkIns).toBe(2);
		expect(Object.values(await store.getAll(CHECK_IN_ARENA))).toEqual([expect.any(Number)]);
		expect(rejections.reasons).toEqual([]);
		// The store and its database close as the test finishes, so the node stops first.
		await created.node.stop();
	});

	test('is logged at ERROR under an error ID once the node serves, and the node carries on serving', async function() {
		const rejections = captureUnhandledRejections();
		const created = await nodes.create({ p2p: { kv: new RefusingCheckIns() } });
		onTestFinished(noteRejectionsHandledLate(created.node.log));
		onTestFinished(logUnhandledRejections(created.node.log));
		const rejected = rejections.next();

		await runWithManualPeer(created.node);
		const reason = await rejected;
		await created.node.log.sync();

		const logged = created.logs.filter(function(entry): boolean {
			return(entry.level === 'ERROR' && entry.args.includes(reason));
		});
		expect(logged).toHaveLength(1);
		const errorID = logged[0]?.options.currentRequestInfo?.id ?? '';
		expect(errorID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(logged[0]?.args[0]).toContain(`(error ID: ${errorID})`);
		const apiURL = created.node.config.endpoints?.api?.replace(/\/$/, '') ?? '';
		const version = await request({ apiURL }, '/node/version');
		expect(version).toMatchObject({ status: 200, body: { node: NODE_VERSION } });
		await created.node.stop();
	});
});
