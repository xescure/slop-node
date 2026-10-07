import type { DeclaredP2PGroup, DeclaredResult } from './declared.js';
import { asPayload, requiredObject, requiredString } from './payload.js';
import { definePOST } from './route.js';
import type { APIRequest, Route } from './route.js';

/**
 * A peer-to-peer message a representative posts over HTTP, with its own
 * peer record as the greeting [Keeta TS] index.js:72195-72216. Receiving
 * peer-to-peer messages is not offered yet, so a well-formed message is
 * answered as not accepted; the sender does not read the answer
 * [Keeta TS] index.js:72203-72218.
 * [node-lite] adapted from handleMessage.
 */
function handleMessage(_ignoredRequest: APIRequest, body: unknown): Promise<DeclaredResult<DeclaredP2PGroup['message']['POST']>> {
	const payload = asPayload(body);
	requiredString(payload, 'message');
	requiredObject(payload, 'greeting');
	return(Promise.resolve({ success: false }));
}

/** The routes peers use to reach the node over HTTP, below /p2p. */
export const p2pRoutes: readonly Route[] = [
	definePOST('/p2p/message', handleMessage)
];
