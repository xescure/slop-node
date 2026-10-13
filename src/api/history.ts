import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { VoteBlockHash, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { DeclaredLedgerGroup, DeclaredResult } from './declared.js';
import { parseLimit } from './parameters.js';
import type { LimitBounds } from './parameters.js';
import type { APIRequest } from './route.js';

const lib = KeetaNet.lib;

export type HistoryPage = DeclaredResult<DeclaredLedgerGroup['history']['GET']>;

/** A page holds 25 staples unless the request asks for fewer, or for more up to 200. */
const HISTORY_LIMIT: LimitBounds = { defaultLimit: 25, maximum: 200 };

type HistoryEntry = HistoryPage['history'][number];

/**
 * A history entry: the staple, the hash of its blocks, which names it as the
 * start of the next page [Keeta TS] index.js:59976-59985, 82196-82205, and
 * the time this node gives it, its own vote's time when it voted, which is
 * what the staple's timestamp prefers [Keeta TS] index.js:82222-82239.
 */
function historyEntry(staple: VoteStaple, representative: Parameters<VoteStaple['timestamp']>[0]): HistoryEntry {
	return({ voteStaple: staple, $id: staple.blocksHash.toString(), $timestamp: staple.timestamp(representative).toISOString() });
}

/**
 * A page of the history of an account, or of the whole ledger, newest first,
 * continuing after the staple named by start. A page holds only whole
 * staples, as many as the limit allows. nextKey names the page's last
 * staple, or on an empty page the staple it continued after, as a
 * representative answers; the client stops at an empty page
 * [Keeta TS] index.js:58969-58996.
 * [node-lite] adapted from getAccountHistory.
 */
export async function historyPage(request: APIRequest, account: GenericAccount | null, startText: string | undefined): Promise<HistoryPage> {
	const limit = Math.trunc(parseLimit(request.query, HISTORY_LIMIT));
	let start: VoteBlockHash | null = null;
	if (startText !== undefined) {
		start = new lib.Vote.VoteBlocksHash(startText);
	}
	const page = await request.node.ledger.getHistory(account, start, limit);
	const representative = request.node.config.ledgerPrivateKey;
	return({
		history: page.map(function(staple): HistoryEntry {
			return(historyEntry(staple, representative));
		}),
		nextKey: page.at(-1)?.blocksHash ?? start
	});
}
