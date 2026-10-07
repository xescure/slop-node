import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { KVInternals, LedgerInternals, P2PInternals, StatsPending } from './internals.js';

const Account = KeetaNet.lib.Account;

const senderSeed = '0000000000000000000000000000000000000000000000000000000000000001';
const recipientSeed = '0000000000000000000000000000000000000000000000000000000000000002';
const tokenSeed = '0000000000000000000000000000000000000000000000000000000000000003';

type StorageBase = InstanceType<typeof LedgerInternals.LedgerStorageBase>;

class ProbeStorage extends LedgerInternals.LedgerStorageBase {
	protected adjustDefer(): Promise<void> {
		return(Promise.reject(new Error('not implemented: adjustDefer')));
	}

	getBlockHeight(): Promise<bigint | null> {
		return(Promise.reject(new Error('not implemented: getBlockHeight')));
	}

	getHeadBlocks(): ReturnType<StorageBase['getHeadBlocks']> {
		return(Promise.reject(new Error('not implemented: getHeadBlocks')));
	}

	getVotesFromMultiplePrevious(): ReturnType<StorageBase['getVotesFromMultiplePrevious']> {
		return(Promise.reject(new Error('not implemented: getVotesFromMultiplePrevious')));
	}

	protected gcBatch(): Promise<boolean> {
		return(Promise.reject(new Error('not implemented: gcBatch')));
	}
}

describe('LedgerInternals', function() {
	test('exposes every driver internal', function() {
		expect(new ProbeStorage()).toBeInstanceOf(LedgerInternals.LedgerStorageBase);
		expect(typeof LedgerInternals.computeEffectOfBlocks).toBe('function');
		expect(typeof LedgerInternals.computeLedgerEffect).toBe('function');
		expect(typeof LedgerInternals.addTimeStatistic).toBe('function');
		expect(typeof LedgerInternals.IdempotentKey).toBe('function');
	});

	test('computeEffectOfBlocks reports the touched accounts of a block', async function() {
		const sender = Account.fromSeed(senderSeed, 0);
		const recipient = Account.fromSeed(recipientSeed, 0);
		const token = Account.fromSeed(tokenSeed, 0, Account.AccountKeyAlgorithm.TOKEN);
		const builder = new KeetaNet.lib.Block.Builder();
		builder.account = sender;
		builder.signer = sender;
		builder.network = 0n;
		builder.previous = KeetaNet.lib.Block.Builder.NO_PREVIOUS;
		builder.date = new Date(0);
		builder.addOperation({
			type: KeetaNet.lib.Block.OperationType.SEND,
			to: recipient,
			amount: 1n,
			token
		});
		const block = await builder.seal();

		const effect = LedgerInternals.computeEffectOfBlocks([block]);

		expect(effect.touched.has(sender)).toBe(true);
	});

	test('StatsPending is the accumulator that Stats merges', async function() {
		const pending = new StatsPending();
		pending.incr('ledger', 'probe', 2);
		const stats = new KeetaNet.lib.Stats({ kv: null });

		stats.merge(pending);
		await stats.sync();

		expect(pending).not.toBeInstanceOf(KeetaNet.lib.Stats);
		expect(await stats.get('ledger', 'probe')).toBe(2);
	});
});

describe('KVInternals', function() {
	test('exposes upstream\'s memory key-value store', async function() {
		const store = new KVInternals.KVStorageProviderMemory();
		await store.set('stats', 'probe', 3);

		expect(await store.incr('stats', 'probe', 2)).toBe(5n);
		expect(await store.get('stats', 'probe')).toBe(5);
	});
});

describe('P2PInternals', function() {
	test('exposes the switch\'s connection classes, peer parser and serializer, frame bound and WebSocket server', function() {
		expect(typeof P2PInternals.P2PWebSocket.connectToSwitch).toBe('function');
		expect(typeof P2PInternals.HTTPConnection.isInstance).toBe('function');
		expect(P2PInternals.P2PPeerFromJSO({ kind: KeetaNet.lib.Node.Kind.PARTICIPANT })).toEqual({ kind: KeetaNet.lib.Node.Kind.PARTICIPANT, id: '' });
		expect(P2PInternals.P2PPeerToJSO({ kind: KeetaNet.lib.Node.Kind.PARTICIPANT, id: '' })).toEqual({ kind: KeetaNet.lib.Node.Kind.PARTICIPANT });
		expect(P2PInternals.P2P_WEBSOCKET_MAX_PAYLOAD_BYTES).toBe(16 * 1024 * 1024);
		expect(P2PInternals.WebSocketServer.name).toBe('WebSocketServer');
	});
});
