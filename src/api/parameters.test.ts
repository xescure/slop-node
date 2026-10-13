import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { requireAt } from '../ledger/storage/suite/support.js';
import { DEFAULT_PEER_LIMITS } from '../node/peer-limits.js';
import { createTestNetwork } from '../testing/network.js';
import { readLedger } from './parameters.js';
import type { APIRequest } from './route.js';

const lib = KeetaNet.lib;

/** Every character an RFC 9110 token may hold. */
const EVERY_TOKEN_CHARACTER = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&\'*+-.^_`|~';

/**
 * A request on a node that is never run, whose timing is upstream's own, as
 * that of the copy of the node a request runs on is.
 */
async function request(): Promise<APIRequest> {
	const network = await createTestNetwork({ representativeWeights: [1000n] });
	return({
		node: new lib.Node(network.nodeConfig(new MemoryLedgerStorage(), requireAt(network.representatives, 0))),
		params: {},
		query: {},
		payload: undefined,
		peerLimits: DEFAULT_PEER_LIMITS,
		header: {
			get: function(): undefined {
				return(undefined);
			}
		}
	});
}

function readNothing(): Promise<null> {
	return(Promise.resolve(null));
}

describe('the name of a read of a request', function() {
	test('may be any RFC 9110 token, which the request\'s timing takes as the name of a section', async function() {
		await expect(readLedger(await request(), EVERY_TOKEN_CHARACTER, readNothing)).resolves.toBeNull();
	});

	test('is checked by the compiler for what the request\'s timing refuses at run time', async function() {
		const onRequest = await request();
		// @ts-expect-error -- '/' is no token character
		await expect(readLedger(onRequest, 'account/state', readNothing)).rejects.toMatchObject({ code: 'TIMING_INVALID_NAME' });
		// @ts-expect-error -- nor is a space
		await expect(readLedger(onRequest, 'account state', readNothing)).rejects.toMatchObject({ code: 'TIMING_INVALID_NAME' });
	});

	test('is refused by the compiler when it may be anything but a token', function() {
		function readsNamed(onRequest: APIRequest, wide: string, either: 'account-state' | 'account/state'): void {
			// @ts-expect-error -- a wide string could be anything
			void readLedger(onRequest, wide, readNothing);
			// @ts-expect-error -- each member of a union is checked
			void readLedger(onRequest, either, readNothing);
			// @ts-expect-error -- a token holds one character at least
			void readLedger(onRequest, '', readNothing);
		}
		expect(readsNamed).toBeTypeOf('function');
	});
});
