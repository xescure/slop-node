import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Endpoints } from '@keetanetwork/keetanet-client/config/index.js';
import { accountStates, requestedAccount } from './account.js';
import type { DeclaredLedgerGroup, DeclaredResult } from './declared.js';
import { historyPage } from './history.js';
import type { HistoryPage } from './history.js';
import { apiError, parseBlockHash, parseKeyAccount, parseLedgerSelector, readLedger } from './parameters.js';
import { defineGET } from './route.js';
import type { APIRequest, Route } from './route.js';

const lib = KeetaNet.lib;

/** [node-lite] adapted from getBlockByHash. */
function getBlockByHash(request: APIRequest, text: string): Promise<DeclaredResult<DeclaredLedgerGroup['block'][':blockhash']['GET']>> {
	const blockhash = parseBlockHash(text);
	const side = parseLedgerSelector(request.query);
	return(readLedger(request, 'block', async function(ledger) {
		return({ blockhash: blockhash.toString(), block: await ledger.getBlock(blockhash, side) });
	}));
}

/**
 * The block on the main ledger whose previous is the block named
 * [Keeta TS] index.js:59255-59263.
 * [node-lite] adapted from getBlockSuccessor.
 */
async function getBlockSuccessor(request: APIRequest, text: string): Promise<DeclaredResult<DeclaredLedgerGroup['block'][':blockhash']['successor']['GET']>> {
	const blockhash = parseBlockHash(text);
	return({ blockhash: blockhash.toString(), successorBlock: await request.node.ledger.getBlockFromPrevious(blockhash, 'main') });
}

type RepresentativeWeight = DeclaredResult<DeclaredLedgerGroup['representative']['GET']>;

async function representativeWeight(request: APIRequest, representative: Account): Promise<RepresentativeWeight> {
	return({ representative: representative.publicKeyString.get(), weight: await request.node.ledger.votingPower(representative) });
}

/** The node's own representative and its weight. [node-lite] adapted from getRepresentative. */
function getRepresentative(request: APIRequest): Promise<RepresentativeWeight> {
	const representative = request.node.config.ledgerPrivateKey;
	if (representative === undefined) {
		throw(apiError('API_REP_MISSING', 'This node has no representative'));
	}
	return(representativeWeight(request, representative));
}

/** [node-lite] adapted from getRepresentative. */
function getRepresentativeByAccount(request: APIRequest, text: string): Promise<RepresentativeWeight> {
	return(representativeWeight(request, parseKeyAccount(text)));
}

type RepresentativeEntry = DeclaredResult<DeclaredLedgerGroup['representatives']['GET']>['representatives'][number];

type AdvertisedRepresentative = { readonly key: Account; readonly endpoints: Endpoints };

/**
 * The representatives the node can name with their endpoints: itself first,
 * then each representative peer it holds a record of and has seen, however
 * long ago and whether or not it has reached the peer itself.
 */
async function advertisedRepresentatives(request: APIRequest): Promise<AdvertisedRepresentative[]> {
	const advertised: AdvertisedRepresentative[] = [];
	const { ledgerPrivateKey, endpoints } = request.node.config;
	if (ledgerPrivateKey !== undefined && endpoints?.api !== undefined && endpoints.p2p !== undefined) {
		advertised.push({ key: ledgerPrivateKey, endpoints: { api: endpoints.api, p2p: endpoints.p2p } });
	}
	const peers = await request.node.switch.peers({ includeStale: true, includeUnverified: true });
	for (const peer of peers) {
		if (peer.kind === lib.Node.Kind.REPRESENTATIVE) {
			advertised.push({ key: peer.key, endpoints: peer.endpoints });
		}
	}
	return(advertised);
}

/**
 * Every representative the node knows of, with its weight and endpoints,
 * each once: itself and the representatives among its peers, current or
 * not, since a client takes this list to find representatives it does not
 * know yet [Keeta TS] index.js:60090-60127.
 * [node-lite] adapted from getAllRepresentatives.
 */
async function getAllRepresentatives(request: APIRequest): Promise<DeclaredResult<DeclaredLedgerGroup['representatives']['GET']>> {
	const advertised = await advertisedRepresentatives(request);
	return(readLedger(request, 'representatives', async function(ledger) {
		const seen = new Set<string>();
		const representatives: RepresentativeEntry[] = [];
		for (const { key, endpoints } of advertised) {
			const representative = key.publicKeyString.get();
			if (!seen.has(representative)) {
				seen.add(representative);
				representatives.push({ representative, weight: await ledger.votingPower(key), endpoints });
			}
		}
		return({ representatives });
	}));
}

/** The history of the whole ledger. [node-lite] adapted from getAccountHistory. */
function getHistory(request: APIRequest): Promise<HistoryPage> {
	return(historyPage(request, null, request.query['start']));
}

/**
 * The state of each account, in the order requested; a malformed account is
 * answered with its error in place of its state, and the client matches the
 * states to accounts by "account" [Keeta TS] index.js:59569-59572.
 * [node-lite] adapted from getAccountStates.
 */
function getAccountStates(request: APIRequest, list: string): Promise<DeclaredResult<DeclaredLedgerGroup['accounts'][':accounts']['GET']>> {
	const requested = list.split(',').map(requestedAccount);
	return(readLedger(request, 'account-states', function(ledger) {
		return(accountStates(ledger, requested));
	}));
}

/** The routes about the ledger as a whole, below /node/ledger, other than one account's. */
export const ledgerRoutes: readonly Route[] = [
	defineGET('/node/ledger/block/:blockhash', getBlockByHash),
	defineGET('/node/ledger/block/:blockhash/successor', getBlockSuccessor),
	defineGET('/node/ledger/representative', getRepresentative),
	defineGET('/node/ledger/representative/:rep', getRepresentativeByAccount),
	defineGET('/node/ledger/representatives', getAllRepresentatives),
	defineGET('/node/ledger/history', getHistory),
	defineGET('/node/ledger/accounts/:accounts', getAccountStates)
];
