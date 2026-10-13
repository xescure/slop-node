import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Vote, VoteQuote } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { DeclaredResult, DeclaredVoteGroup } from './declared.js';
import { votesByID } from './order.js';
import { parseBase64, parseBlockHash, parseLedgerStorage } from './parameters.js';
import { asPayload, optionalString, optionalStringList, requiredStringList } from './payload.js';
import type { Payload } from './payload.js';
import { defineGET, definePOST } from './route.js';
import type { APIRequest, Route } from './route.js';

const lib = KeetaNet.lib;

/** The blocks to vote on or quote, each the base64 of its bytes [Keeta TS] index.js:60835-60840. */
function blocksOf(payload: Payload): Block[] {
	return(requiredStringList(payload, 'blocks').map(function(encoded): Block {
		return(new lib.Block(parseBase64(encoded)));
	}));
}

/**
 * The node's vote for the blocks: a temporary vote, or a permanent one when
 * the request carries the other representatives' votes, paid for with the
 * fee its quote states when it carries one [Keeta TS] index.js:60843-60857,
 * 70048-70051.
 * [node-lite] adapted from createNewVote.
 */
async function createVote(request: APIRequest, body: unknown): Promise<DeclaredResult<DeclaredVoteGroup['_root']['POST']>> {
	const payload = asPayload(body);
	const blocks = blocksOf(payload);
	const otherVotes = optionalStringList(payload, 'votes')?.map(function(encoded): Vote {
		return(new lib.Vote(parseBase64(encoded)));
	});
	const quoteText = optionalString(payload, 'quote');
	let quote: VoteQuote | undefined;
	if (quoteText !== undefined) {
		quote = new lib.Vote.Quote(parseBase64(quoteText));
	}
	return({ vote: await request.node.ledger.vote(blocks, otherVotes, quote) });
}

/**
 * The fee the node charges for voting for the blocks [Keeta TS] index.js:70392-70396.
 * [node-lite] adapted from createNewQuote.
 */
async function createVoteQuote(request: APIRequest, body: unknown): Promise<DeclaredResult<DeclaredVoteGroup['quote']['POST']>> {
	return({ quote: await request.node.ledger.quote(blocksOf(asPayload(body))) });
}

/**
 * The votes the node holds for the block on one ledger, by their ID, null
 * when it holds none [Keeta TS] index.js:60906-60910.
 * [node-lite] adapted from getVotes.
 */
async function getVotes(request: APIRequest, text: string): Promise<DeclaredResult<DeclaredVoteGroup[':blockhash']['GET']>> {
	const blockhash = parseBlockHash(text);
	const votes = await request.node.ledger.getVotes(blockhash, parseLedgerStorage(request.query));
	if (votes === null) {
		return({ blockhash, votes });
	}
	return({ blockhash, votes: votesByID(votes) });
}

/** The routes that ask the node for votes and quotes, below /vote. */
export const voteRoutes: readonly Route[] = [
	definePOST('/vote', createVote),
	definePOST('/vote/quote', createVoteQuote),
	defineGET('/vote/:blockhash', getVotes)
];
