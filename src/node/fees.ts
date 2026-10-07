import type { Account, StorageAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { LedgerConfig } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import { assertNever } from '../util/assert-never.js';
import { AMOUNT } from './amount.js';

/** An account a fee may be paid to [Keeta TS] index.js:70267. */
export type FeeAccount = Account | StorageAddress;

/** What a representative charges for a vote, before who is paid and in which token. */
export type FeeSchedule =
	| { readonly kind: 'free' }
	| { readonly kind: 'flat'; readonly amountPerBlock: bigint };

/**
 * Who a flat fee is paid to and in which token. Without accounts the vote's
 * issuer is paid, and without a token the base token is used.
 */
export type FeeRecipients = {
	readonly payTo: readonly FeeAccount[];
	readonly token: TokenAddress | undefined;
};

export type FeePolicy =
	| { readonly kind: 'free' }
	| ({ readonly kind: 'flat'; readonly amountPerBlock: bigint } & FeeRecipients);

export type ComputeFeeFromBlocks = LedgerConfig['computeFeeFromBlocks'];

const FLAT_PREFIX = 'flat:';

/** The schedule written as "free" or "flat:<amount per block>", or undefined when it is neither. */
export function parseFeeSchedule(text: string): FeeSchedule | undefined {
	if (text === 'free') {
		return({ kind: 'free' });
	}
	if (!text.startsWith(FLAT_PREFIX)) {
		return(undefined);
	}
	const amount = text.slice(FLAT_PREFIX.length);
	if (!AMOUNT.test(amount)) {
		return(undefined);
	}
	return({ kind: 'flat', amountPerBlock: BigInt(amount) });
}

/**
 * The ledger's fee function for the policy. No fee is answered as null, which
 * upstream issues as a zero fee [Keeta TS] index.js:70219-70227. A flat fee
 * names its payee and token through the ledger, which picks one of the fee
 * accounts at random and leaves out a payee that is the representative and a
 * token that is the base token [Keeta TS] index.js:70267-70280.
 */
export function computeFeeFromBlocksFor(policy: FeePolicy): ComputeFeeFromBlocks {
	switch (policy.kind) {
		case 'free':
			return(function() {
				return(null);
			});
		case 'flat': {
			const { amountPerBlock, payTo, token } = policy;
			return(function(ledger, blocks) {
				return({ ...ledger.getFeePayToAndToken([...payTo], token), amount: amountPerBlock * BigInt(blocks.length) });
			});
		}
		default:
			return(assertNever(policy));
	}
}
