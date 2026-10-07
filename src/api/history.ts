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

/** One staple more than the page holds tells whether another page follows. */
const LOOKAHEAD = 1;

type HistoryEntry = HistoryPage['history'][number];

/**
 * A history entry: the staple, the hash of its blocks, which names it as the
 * start of the next page [Keeta TS] index.js:58986-58995, 81044-81053, and
 * the time this node gives it, its own vote's time when it voted, which is
 * what the staple's timestamp prefers [Keeta TS] index.js:81070-81087.
 */
function historyEntry(staple: VoteStaple, representative: Parameters<VoteStaple['timestamp']>[0]): HistoryEntry {
	return({ voteStaple: staple, $id: staple.blocksHash.toString(), $timestamp: staple.timestamp(representative).toISOString() });
}

/**
 * A page of the history of an account, or of the whole ledger, newest first,
 * continuing after the staple named by start; nextKey names the page's last
 * staple when another page follows, and is null on the last page.
 * [node-lite] adapted from getAccountHistory.
 */
export async function historyPage(request: APIRequest, account: GenericAccount | null, startText: string | undefined): Promise<HistoryPage> {
	const limit = parseLimit(request.query, HISTORY_LIMIT);
	let start: VoteBlockHash | null = null;
	if (startText !== undefined) {
		start = new lib.Vote.VoteBlocksHash(startText);
	}
	const staples = await request.node.ledger.getHistory(account, start, limit + LOOKAHEAD);
	const page = staples.slice(0, limit);
	const representative = request.node.config.ledgerPrivateKey;
	let nextKey: VoteBlockHash | null = null;
	const last = page.at(-1);
	if (staples.length > page.length && last !== undefined) {
		nextKey = last.blocksHash;
	}
	return({
		history: page.map(function(staple): HistoryEntry {
			return(historyEntry(staple, representative));
		}),
		nextKey
	});
}
