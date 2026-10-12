import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { CertificateWithIntermediates } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import { assertNever } from '../util/assert-never.js';
import type { DeclaredAccountGroup, DeclaredResult } from './declared.js';
import { historyPage } from './history.js';
import type { HistoryPage } from './history.js';
import { balancesByToken, permissionsByEntity, permissionsByPrincipal } from './order.js';
import {
	parseAccount,
	parseAccountList,
	parseBase64,
	parseBlockHash,
	parseLedgerStorage,
	parseLimit,
	parseToken,
	readLedger
} from './parameters.js';
import type { LedgerReader, LimitBounds } from './parameters.js';
import { defineGET } from './route.js';
import type { APIRequest, Route } from './route.js';

const lib = KeetaNet.lib;

type AccountStateOrError = DeclaredResult<DeclaredAccountGroup['GET']>;

/** An account's head, representative, info and balances (api/node.d.ts, AccountState). */
type AccountState = Exclude<AccountStateOrError, { error: string }>;

/** Why an account's state could not be read (api/node.d.ts, AccountStateError). */
type AccountStateError = Extract<AccountStateOrError, { error: string }>;

/** An account as a request names it: one the library parses, or the text and why it does not. */
export type RequestedAccount =
	| { readonly kind: 'account'; readonly account: GenericAccount }
	| { readonly kind: 'malformed'; readonly error: AccountStateError };

/**
 * A malformed account is not a failure of the request: the client reads the
 * error of an account state and throws it for that account alone
 * [Keeta TS] index.js:58241-58256, 60000-60008. The error is written as
 * String writes it, an Error by its name and message, which is how a
 * representative reports an account it cannot parse.
 */
export function requestedAccount(text: string): RequestedAccount {
	try {
		return({ kind: 'account', account: parseAccount(text) });
	} catch (error) {
		return({ kind: 'malformed', error: { account: text, error: String(error) } });
	}
}

/**
 * An account's head block hash and height, representative, balances and
 * info. The head comes with its height, as the client reads it
 * [Keeta TS] index.js:60000-60023.
 * [node-lite] adapted from getAccountState.
 */
async function accountState(ledger: LedgerReader, account: GenericAccount): Promise<AccountState> {
	const heights = await ledger.getAccountsBlockHeightInfo([{ account }]);
	const head = heights[account.publicKeyString.get()] ?? null;
	const representative = await ledger.getAccountRep(account);
	const balances = balancesByToken(await ledger.getAllBalances(account));
	const info = await ledger.getAccountInfo(account);
	return({
		account,
		currentHeadBlock: head?.blockHash ?? null,
		currentHeadBlockHeight: head?.height ?? null,
		representative,
		balances,
		info
	});
}

/** The state of each account requested, or why it could not be read, in the order requested. */
export async function accountStates(ledger: LedgerReader, requested: readonly RequestedAccount[]): Promise<AccountStateOrError[]> {
	const states: AccountStateOrError[] = [];
	for (const entry of requested) {
		switch (entry.kind) {
			case 'account':
				states.push(await accountState(ledger, entry.account));
				break;
			case 'malformed':
				states.push(entry.error);
				break;
			default:
				assertNever(entry);
		}
	}
	return(states);
}

async function getAccountState(request: APIRequest, text: string): Promise<AccountStateOrError> {
	const [state] = await readLedger(request, 'account-state', function(ledger) {
		return(accountStates(ledger, [requestedAccount(text)]));
	});
	if (state === undefined) {
		throw(new Error('internal error: one account was requested and none was read'));
	}
	return(state);
}

/**
 * The head block of the account's chain and its height, both null for an
 * account without blocks [Keeta TS] index.js:58743-58745.
 * [node-lite] adapted from getAccountsHead.
 */
function getAccountHead(request: APIRequest, text: string): Promise<DeclaredResult<DeclaredAccountGroup['head']['GET']>> {
	const account = parseAccount(text);
	return(readLedger(request, 'account-head', async function(ledger) {
		const block = await ledger.getHeadBlock(account, 'main');
		if (block === null) {
			return({ account, block: null, height: null });
		}
		const heights = await ledger.getAccountsBlockHeightInfo([{ account, blockHash: block.hash }]);
		return({ account, block, height: heights[account.publicKeyString.get()]?.height ?? null });
	}));
}

/** A page of the chain holds 25 blocks unless the request asks for fewer, or for more up to the 200 the client asks for [Keeta TS] index.js:58873. */
const CHAIN_LIMIT: LimitBounds = { defaultLimit: 25, maximum: 200 };

/** The start that names the account's head block [Keeta TS] index.js:58871-58877. */
const CHAIN_HEAD = 'HEAD';

type ChainPage = DeclaredResult<DeclaredAccountGroup['chain']['GET']>;

/** The block a page of the chain starts from; a block of another account starts nothing. */
async function chainStart(ledger: LedgerReader, account: GenericAccount, start: BlockHash | typeof CHAIN_HEAD): Promise<Block | null> {
	if (start === CHAIN_HEAD) {
		return(await ledger.getHeadBlock(account, 'main'));
	}
	const block = await ledger.getBlock(start, 'main');
	if (block === null || !block.account.comparePublicKey(account)) {
		return(null);
	}
	return(block);
}

/**
 * A page of the account's chain, newest first, from the block named by start
 * (the head by default) down to the block named by end, which it includes,
 * holding blocks until their count reaches the limit. nextKey is the block
 * the next page starts from, which may be end itself, and null once the
 * chain or the range is exhausted, as a representative answers and the
 * client pages [Keeta TS] index.js:58868-58901.
 * [node-lite] adapted from getAccountChain.
 */
function getAccountChain(request: APIRequest, text: string): Promise<ChainPage> {
	const account = parseAccount(text);
	const limit = parseLimit(request.query, CHAIN_LIMIT);
	const startText = request.query['start'] ?? CHAIN_HEAD;
	let start: BlockHash | typeof CHAIN_HEAD = CHAIN_HEAD;
	if (startText !== CHAIN_HEAD) {
		start = parseBlockHash(startText);
	}
	const endText = request.query['end'];
	let end: BlockHash | undefined;
	if (endText !== undefined) {
		end = parseBlockHash(endText);
	}
	const accountText = account.publicKeyString.get();
	return(readLedger(request, 'account-chain', async function(ledger): Promise<ChainPage> {
		const blocks: ChainPage['blocks'] = [];
		for (let block = await chainStart(ledger, account, start); block !== null; block = await ledger.getBlock(block.previous, 'main')) {
			blocks.push({ block });
			// A hash compares unequal to an absent end [Keeta TS] index.js:76878-76881.
			if (block.$opening || block.hash.compare(end)) {
				break;
			}
			if (blocks.length >= limit) {
				return({ account: accountText, blocks, nextKey: block.previous });
			}
		}
		return({ account: accountText, blocks, nextKey: null });
	}));
}

/** [node-lite] adapted from getAccountHistory. */
function getAccountHistory(request: APIRequest, text: string): Promise<HistoryPage> {
	return(historyPage(request, parseAccount(text), request.query['start']));
}

/** The staple to continue after, named in the path instead of in "start" (api/node.d.ts, getAccountHistory). */
function getAccountHistoryFrom(request: APIRequest, text: string, start: string): Promise<HistoryPage> {
	return(historyPage(request, parseAccount(text), start));
}

/** [node-lite] adapted from getAllBalances. */
async function getAllBalances(request: APIRequest, text: string): Promise<DeclaredResult<DeclaredAccountGroup['balance']['GET']>> {
	const account = parseAccount(text);
	return({ account, balances: balancesByToken(await request.node.ledger.getAllBalances(account)) });
}

/** [node-lite] adapted from getAccountBalance. */
async function getAccountBalance(request: APIRequest, text: string, tokenText: string): Promise<DeclaredResult<DeclaredAccountGroup['balance'][':token']['GET']>> {
	const account = parseAccount(text);
	const token = parseToken(tokenText);
	return({ account, token, balance: await request.node.ledger.getBalance(account, token) });
}

type PermissionsList = DeclaredResult<DeclaredAccountGroup['acl']['GET']>;

/** The permissions the account holds as principal. [node-lite] adapted from listACLsByPrincipal. */
async function listACLsByPrincipal(request: APIRequest, text: string): Promise<PermissionsList> {
	return({ permissions: permissionsByEntity(await request.node.ledger.listACLsByPrincipal(parseAccount(text))) });
}

/** The permissions the account holds as principal on the listed entities. [node-lite] adapted from listACLsByPrincipal. */
async function listACLsByPrincipalForEntities(request: APIRequest, text: string, entityList: string): Promise<PermissionsList> {
	return({ permissions: permissionsByEntity(await request.node.ledger.listACLsByPrincipal(parseAccount(text), parseAccountList(entityList))) });
}

/** The permissions any principal holds on the account as entity [Keeta TS] index.js:58637-58644. [node-lite] adapted from listACLsByEntity. */
async function listACLsByEntity(request: APIRequest, text: string): Promise<DeclaredResult<DeclaredAccountGroup['acl']['granted']['GET']>> {
	return({ permissions: permissionsByPrincipal(await request.node.ledger.listACLsByEntity(parseAccount(text))) });
}

type PrincipalAccess = DeclaredResult<DeclaredAccountGroup['acl']['additional']['GET']>;

/** Each entity once, in the order its first row lists it. */
function distinctEntities(rows: PermissionsList['permissions']): GenericAccount[] {
	const seen = new Set<string>();
	const entities: GenericAccount[] = [];
	for (const row of rows) {
		const key = row.entity.publicKeyString.get();
		if (!seen.has(key)) {
			seen.add(key);
			entities.push(row.entity);
		}
	}
	return(entities);
}

/**
 * Each entity the principal holds permissions on, with the entity's info,
 * balances and every principal's permissions on it, which the client reads
 * [Keeta TS] index.js:58618-58627; entities named in the request narrow the
 * principal's rows first.
 * [node-lite] adapted from listACLsByPrincipalWithInfo.
 */
function principalAccess(request: APIRequest, text: string, entityList: string | undefined): Promise<PrincipalAccess> {
	const account = parseAccount(text);
	let requested: GenericAccount[] | undefined;
	if (entityList !== undefined) {
		requested = parseAccountList(entityList);
	}
	return(readLedger(request, 'account-acl-additional', async function(ledger): Promise<PrincipalAccess> {
		const rows = permissionsByEntity(await ledger.listACLsByPrincipal(account, requested));
		const access: PrincipalAccess['access'] = [];
		for (const entity of distinctEntities(rows)) {
			const info = await ledger.getAccountInfo(entity);
			const balances = balancesByToken(await ledger.getAllBalances(entity));
			const principals = permissionsByPrincipal(await ledger.listACLsByEntity(entity));
			access.push({ entity, info, balances, principals });
		}
		return({ account, access });
	}));
}

function listACLsByPrincipalWithInfo(request: APIRequest, text: string): Promise<PrincipalAccess> {
	return(principalAccess(request, text, undefined));
}

function listACLsByPrincipalWithInfoForEntities(request: APIRequest, text: string, entityList: string): Promise<PrincipalAccess> {
	return(principalAccess(request, text, entityList));
}

type CertificateStrings = DeclaredResult<DeclaredAccountGroup['certificates']['GET']>['certificates'][number];

/** A certificate and its intermediates as PEM text, which the client parses [Keeta TS] index.js:60054-60065. */
function certificateStrings(found: CertificateWithIntermediates): CertificateStrings {
	return({
		certificate: found.certificate.toPEM(),
		intermediates: found.intermediates?.getCertificates().map(function(intermediate): string {
			return(intermediate.toPEM());
		}) ?? null
	});
}

/** [node-lite] adapted from getAccountCertificates. */
async function getAccountCertificates(request: APIRequest, text: string): Promise<DeclaredResult<DeclaredAccountGroup['certificates']['GET']>> {
	const account = parseAccount(text);
	const certificates = await request.node.ledger.getAccountCertificates(account);
	return({ account: account.publicKeyString.get(), certificates: certificates.map(certificateStrings) });
}

/**
 * One certificate, or nulls when the account holds none with the hash
 * [Keeta TS] index.js:58720-58722.
 * [node-lite] adapted from getCertificateByHash.
 */
async function getCertificateByHash(request: APIRequest, text: string, hashText: string): Promise<DeclaredResult<DeclaredAccountGroup['certificates'][':certificateHash']['GET']>> {
	const account = parseAccount(text);
	const found = await request.node.ledger.getAccountCertificateByHash(account, new lib.Utils.Certificate.CertificateHash(hashText));
	const accountText = account.publicKeyString.get();
	if (found === null) {
		return({ certificate: null, intermediates: null, account: accountText });
	}
	return({ ...certificateStrings(found), account: accountText });
}

/**
 * The block the side ledger holds after the account's main head, or after
 * the start of its chain when it has no blocks yet: the block awaiting votes
 * [Keeta TS] index.js:59219-59226.
 * [node-lite] adapted from getAccountPendingBlock.
 */
function getAccountPendingBlock(request: APIRequest, text: string): Promise<DeclaredResult<DeclaredAccountGroup['pending']['GET']>> {
	const account = parseAccount(text);
	return(readLedger(request, 'account-pending', async function(ledger) {
		const head = await ledger.getHeadBlock(account, 'main');
		const previous = head?.hash ?? lib.Block.getAccountOpeningHash(account);
		return({ account: account.publicKeyString.get(), block: await ledger.getBlockFromPrevious(previous, 'side') });
	}));
}

/**
 * The block the account published with the idempotent key, base64 encoded
 * [Keeta TS] index.js:59526-59542.
 * [node-lite] adapted from getBlockFromIdempotent.
 */
async function getBlockFromIdempotent(request: APIRequest, text: string, idempotent: string): Promise<DeclaredResult<DeclaredAccountGroup['idempotent'][':idempotent']['GET']>> {
	const account = parseAccount(text);
	const block = await request.node.ledger.getBlockFromIdempotent(account, parseBase64(idempotent), parseLedgerStorage(request.query));
	return({ block });
}

/** The routes about one account, below /node/ledger/account/:account. */
export const accountRoutes: readonly Route[] = [
	defineGET('/node/ledger/account/:account', getAccountState),
	defineGET('/node/ledger/account/:account/head', getAccountHead),
	defineGET('/node/ledger/account/:account/chain', getAccountChain),
	defineGET('/node/ledger/account/:account/history', getAccountHistory),
	defineGET('/node/ledger/account/:account/history/start/:block', getAccountHistoryFrom),
	defineGET('/node/ledger/account/:account/balance', getAllBalances),
	defineGET('/node/ledger/account/:account/balance/:token', getAccountBalance),
	defineGET('/node/ledger/account/:account/acl', listACLsByPrincipal),
	defineGET('/node/ledger/account/:account/acl/:entityList', listACLsByPrincipalForEntities),
	defineGET('/node/ledger/account/:account/acl/granted', listACLsByEntity),
	defineGET('/node/ledger/account/:account/acl/additional', listACLsByPrincipalWithInfo),
	defineGET('/node/ledger/account/:account/acl/additional/:entityList', listACLsByPrincipalWithInfoForEntities),
	defineGET('/node/ledger/account/:account/certificates', getAccountCertificates),
	defineGET('/node/ledger/account/:account/certificates/:certificateHash', getCertificateByHash),
	defineGET('/node/ledger/account/:account/pending', getAccountPendingBlock),
	defineGET('/node/ledger/account/:account/idempotent/:idempotent', getBlockFromIdempotent)
];
