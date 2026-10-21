import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteBlockHash } from '@keetanetwork/keetanet-client/lib/vote.js';
import type {
	KeetaNetLedgerError,
	KeetaNetLedgerIdempotentKeyError,
	LedgerBaseErrorCode
} from '@keetanetwork/keetanet-client/lib/error/ledger.js';

const lib = KeetaNet.lib;

/** Whether Ledger.run may run the transaction again after this error. */
export type RetryPolicy =
	| { readonly retry: false }
	| { readonly retry: true; readonly delayMilliseconds?: number };

type ParsedError = ReturnType<typeof lib.Error.fromJSON>;

function assertCode<Code extends string>(error: ParsedError, code: Code): asserts error is Extract<ParsedError, { code: Code }> {
	if (!lib.Error.isInstance(error) || error.code !== code) {
		throw(new Error(`internal error: upstream did not build a ${code} error`, { cause: error }));
	}
}

/**
 * Builds upstream's own ledger error class, which the package does not export:
 * Ledger.run retries only instances of that exact class, and only when they
 * say so. The public JSON decoder is the one way to construct it.
 * [Keeta TS] index.js:67349-67405, 67517-67529, 71361-71411
 */
export function createLedgerError(code: LedgerBaseErrorCode, message: string, policy: RetryPolicy = { retry: false }): KeetaNetLedgerError {
	const encoded: { type: 'LEDGER'; code: LedgerBaseErrorCode; message: string; shouldRetry: boolean; retryDelay?: number } = {
		type: 'LEDGER',
		code,
		message,
		shouldRetry: policy.retry
	};
	if (policy.retry && policy.delayMilliseconds !== undefined) {
		encoded.retryDelay = policy.delayMilliseconds;
	}
	const error = lib.Error.fromJSON(encoded);
	assertCode(error, code);
	return(error);
}

/**
 * The error upstream raises when an idempotent key is already taken by another
 * block, built the same way as createLedgerError.
 * [Keeta TS] index.js:67364-67392, 67553-67581
 */
export function createIdempotentKeyError(input: { readonly blockHash: BlockHash; readonly existingBlockHash: BlockHash; readonly account: GenericAccount; readonly idempotent: Buffer }): KeetaNetLedgerIdempotentKeyError {
	const code = 'LEDGER_IDEMPOTENT_KEY_EXISTS';
	const error = lib.Error.fromJSON({
		type: 'LEDGER',
		code,
		message: '',
		blockhash: input.blockHash.toString(),
		existingBlockhash: input.existingBlockHash.toString(),
		account: input.account.publicKeyString.get(),
		idempotentKey: input.idempotent.toString('base64')
	});
	assertCode(error, code);
	return(error);
}

/** An error of upstream's own classes, as its guard names them. */
export type KeetaNetError = typeof KeetaNet.lib.Error.isInstance extends (error: unknown) => error is infer Guarded ? Guarded : never;

/** Domain errors carry codes that callers and the API depend on. */
export function isKeetaNetError(error: unknown): error is KeetaNetError {
	return(lib.Error.isInstance(error));
}

export function describeError(error: unknown): string {
	if (error instanceof Error) {
		return(error.message);
	}
	return(String(error));
}

/**
 * A page of an account's history asked to start after a staple that is no
 * entry of that history. The main network's representatives refuse it as an
 * internal failure, an error without a code, rather than answer an empty
 * page (conformance/API.md).
 */
export class HistoryStartNotListed extends Error {
	override readonly name = 'HistoryStartNotListed';

	constructor(account: GenericAccount, start: VoteBlockHash) {
		super(`the staple ${start.toString()} is not in the history of ${account.publicKeyString.get()}`);
	}
}
