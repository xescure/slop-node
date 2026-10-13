import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { APIErrorCode } from '@keetanetwork/keetanet-client/lib/error/api.js';
import type { Ledger, LedgerSelector, LedgerStorage } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { APIRequest } from './route.js';

const lib = KeetaNet.lib;

/** The ledger interface a read transaction hands its reads; the package declares it without exporting it. */
export type LedgerReader = Parameters<Parameters<Ledger['runReadOnly']>[1]>[0];

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type Letter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';

/** A character of an RFC 9110 token [Keeta TS 0.18.8] index.js:72643. */
type TokenCharacter = Digit | Letter | Uppercase<Letter> | '!' | '#' | '$' | '%' | '&' | '\'' | '*' | '+' | '-' | '.' | '^' | '_' | '`' | '|' | '~';

type TokenOf<Remaining extends string, Name extends string> = Remaining extends `${infer First}${infer Rest}`
	? (First extends TokenCharacter ? (Rest extends '' ? Name : TokenOf<Rest, Name>) : never)
	: never;

/**
 * The name, if it is a literal RFC 9110 token, and never otherwise: the
 * request's timing throws TIMING_INVALID_NAME at run time for a section
 * named by anything else [Keeta TS 0.18.8] index.js:72671-72673. Each member
 * of a union is checked on its own.
 */
type TimingName<Name extends string> = Name extends string ? TokenOf<Name, Name> : never;

/**
 * Runs the reads of one request in one read-only transaction of the request's
 * own ledger, so that together they describe one state of it.
 */
export function readLedger<Result, Identifier extends string>(request: APIRequest, identifier: TimingName<Identifier>, read: (ledger: LedgerReader) => Promise<Result>): Promise<Result>;
export function readLedger<Result>(request: APIRequest, identifier: string, read: (ledger: LedgerReader) => Promise<Result>): Promise<Result> {
	return(request.node.ledger.runReadOnly(`api-${identifier}`, read));
}

/**
 * A refusal of the request, as the API error the client rebuilds from the
 * code [Keeta TS] index.js:66022-66040. The package exports no constructor
 * for it, and its JSON decoder builds one from a valid code
 * [Keeta TS] index.js:66334-66410.
 */
export function apiError(code: APIErrorCode, message: string): Error {
	return(lib.Error.fromJSON({ type: 'API', code, message }));
}

/** A limit as a query parameter gives it: how many entries a page holds by default, and at most. */
export type LimitBounds = {
	readonly defaultLimit: number;
	readonly maximum: number;
};

/**
 * The limit a request asks for, within the bounds: absent, the default; above
 * the maximum, the maximum. A representative reads the text as Number does,
 * fraction and all: it refuses an empty limit as not above zero, and answers
 * limit=1.5 with two blocks of a chain or two staples of a bootstrap, and
 * with one staple of history. Each route applies the limit as it counts.
 * [node-lite] adapted from parseLimit.
 */
export function parseLimit(query: APIRequest['query'], bounds: LimitBounds): number {
	const text = query['limit'];
	if (text === undefined) {
		return(bounds.defaultLimit);
	}
	const limit = Number(text);
	if (Number.isNaN(limit)) {
		throw(apiError('API_LIMIT_NOT_NUMBER', 'Limit must be a number'));
	}
	if (limit <= 0) {
		throw(apiError('API_LIMIT_NOT_GREATER_THAN_ZERO', 'Limit must be greater than 0'));
	}
	return(Math.min(limit, bounds.maximum));
}

const LEDGER_STORAGES: readonly LedgerStorage[] = ['main', 'side'];

const LEDGER_SELECTORS: readonly LedgerSelector[] = [...LEDGER_STORAGES, 'both'];

function parseSide<Side extends string>(query: APIRequest['query'], sides: readonly Side[]): Side | 'main' {
	const text = query['side'];
	if (text === undefined) {
		return('main');
	}
	const side = sides.find(function(choice): boolean {
		return(choice === text);
	});
	if (side === undefined) {
		throw(apiError('API_INVALID_SIDE', `Invalid side: ${text}`));
	}
	return(side);
}

/**
 * Which ledger to read: the main ledger unless the request names the side
 * ledger [Keeta TS] index.js:67868-67873, 58778-58789; any other side is
 * refused as a representative refuses it.
 * [node-lite] adapted from ledgerSelector.
 */
export function parseLedgerStorage(query: APIRequest['query']): LedgerStorage {
	return(parseSide(query, LEDGER_STORAGES));
}

/**
 * Which ledger to find a block on, where a request may also name both, as
 * the client does for the blocks of an account it recovers
 * [Keeta TS] index.js:59349-59351; the ledger passes the choice on to its
 * storage, which reads both as it does for its own checks
 * [Keeta TS] index.js:69502-69505, 67668.
 */
export function parseLedgerSelector(query: APIRequest['query']): LedgerSelector {
	return(parseSide(query, LEDGER_SELECTORS));
}

/** Throws the library's own error for anything that is not an account's public key string. */
export function parseAccount(text: string): GenericAccount {
	return(lib.Account.fromPublicKeyString(text));
}

/** An account that holds a key, as a representative does. */
export function parseKeyAccount(text: string): Account {
	return(lib.Account.fromPublicKeyString(text).assertAccount());
}

export function parseToken(text: string): TokenAddress {
	return(lib.Account.fromPublicKeyString(text).assertKeyType(lib.Account.AccountKeyAlgorithm.TOKEN));
}

/**
 * Accounts separated by commas, as the client joins them [Keeta TS] index.js:59958-59960.
 * [node-lite] adapted from parseAccounts.
 */
export function parseAccountList(text: string): GenericAccount[] {
	return(text.split(',').map(parseAccount));
}

/** A hash in hexadecimal of either case; the library throws for anything else. */
export function parseBlockHash(text: string): BlockHash {
	return(new lib.Block.Hash(text));
}

/** Bytes in standard base64, as the client encodes blocks, votes, staples and keys. */
export function parseBase64(text: string): Buffer {
	return(lib.Utils.Helper.validateBase64ToBuffer(text));
}
