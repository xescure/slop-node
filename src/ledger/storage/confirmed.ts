import type { Account, AccountKeyAlgorithm, GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { CertificateUpdate, ComputedEffectOfBlocks } from '@keetanetwork/keetanet-client/lib/ledger/effects.js';
import type { AccountInfo, AccountInfoForType } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals } from '../../upstream/internals.js';
import { toAccountKey, toBlockHashKey, toIdempotentKeyString } from './keys.js';
import type { AccountKey, BlockHashKey, IdempotentKeyString } from './keys.js';

type ComputeLedgerEffect = typeof LedgerInternals.computeLedgerEffect<false, true, true>;

/** Balance, supply and weight deltas plus ACL updates already resolved to SET or delete. */
export type ConfirmedLedgerEffect = Awaited<ReturnType<ComputeLedgerEffect>>;

/** The storage reads computeLedgerEffect makes. */
export type LedgerEffectReader = Parameters<ComputeLedgerEffect>[2];

/** Account info fields a staple sets; an absent field keeps the stored value. */
export type AccountInfoUpdate = {
	readonly name?: AccountInfo['name'];
	readonly description?: AccountInfo['description'];
	readonly metadata?: AccountInfo['metadata'];
	readonly defaultPermission?: NonNullable<AccountInfoForType<AccountKeyAlgorithm.NETWORK>['defaultPermission']>;
	readonly multisigQuorum?: AccountInfoForType<AccountKeyAlgorithm.MULTISIG>['multisigQuorum'];
};

/** A certificate change together with the account that holds the certificate. */
export type CertificateChange = {
	readonly account: GenericAccount;
	readonly update: CertificateUpdate;
};

/** An idempotent key that a confirmed block claims. */
export type IdempotentKeyClaim = {
	readonly key: IdempotentKeyString;
	readonly block: Block;
	readonly idempotent: Buffer;
};

/** Everything a driver writes for one confirmed staple, computed before any write. */
export type ConfirmedStapleChange = {
	readonly staple: VoteStaple;
	/** The moment of the transaction that confirms the staple on this node. */
	readonly moment: Date;
	/** The main-chain height of every block in the staple. */
	readonly blockHeights: ReadonlyMap<BlockHashKey, bigint>;
	readonly ledgerEffect: ConfirmedLedgerEffect;
	readonly infoUpdates: ReadonlyMap<AccountKey, AccountInfoUpdate>;
	readonly delegations: ReadonlyMap<AccountKey, Account>;
	readonly certificateUpdates: readonly CertificateChange[];
	readonly idempotentKeys: readonly IdempotentKeyClaim[];
	/** Accounts whose history lists the staple (D18). */
	readonly historyAccounts: ReadonlySet<AccountKey>;
	/** Accounts that need a row, whether or not they had one: every account the staple touches or may create. */
	readonly newAccounts: ReadonlySet<AccountKey>;
	/** The staple's part of the ledger checksum: the XOR of its blocks' hashes (D19). */
	readonly checksum: bigint;
};

type Mutable<Shape> = { -readonly [Field in keyof Shape]: Shape[Field] };

/*
 * Upstream builds info effects whose present fields may still hold undefined,
 * for example when a multisig identifier is created; such a field keeps its
 * stored value.
 * [Keeta TS] index.js:69209, 69345, 69370-69377
 */
type InfoEffect = { readonly [Field in keyof AccountInfoUpdate]?: AccountInfoUpdate[Field] | undefined };

function definedInfoFields(info: InfoEffect): AccountInfoUpdate {
	const update: Mutable<AccountInfoUpdate> = {};
	if (info.name !== undefined) {
		update.name = info.name;
	}
	if (info.description !== undefined) {
		update.description = info.description;
	}
	if (info.metadata !== undefined) {
		update.metadata = info.metadata;
	}
	if (info.defaultPermission !== undefined) {
		update.defaultPermission = info.defaultPermission;
	}
	if (info.multisigQuorum !== undefined) {
		update.multisigQuorum = info.multisigQuorum;
	}
	return(update);
}

function collectAccountFields(effects: ComputedEffectOfBlocks): Pick<ConfirmedStapleChange, 'infoUpdates' | 'delegations' | 'certificateUpdates'> {
	const infoUpdates = new Map<AccountKey, AccountInfoUpdate>();
	const delegations = new Map<AccountKey, Account>();
	const certificateUpdates: CertificateChange[] = [];
	for (const effect of Object.values(effects.accounts)) {
		// Certificate principals only ever receive permissions, which the
		// ledger effect resolves.
		if (effect.type !== 'ACCOUNT') {
			continue;
		}
		const key = toAccountKey(effect.account);
		const { info, delegation, certificate } = effect.fields;
		if (info !== undefined) {
			infoUpdates.set(key, definedInfoFields(info));
		}
		if (delegation !== undefined) {
			delegations.set(key, delegation.delegateTo);
		}
		for (const update of certificate ?? []) {
			certificateUpdates.push({ account: effect.account, update });
		}
	}
	return({ infoUpdates, delegations, certificateUpdates });
}

/** [Keeta TS] index.js:69956-69967 */
function collectIdempotentKeys(staple: VoteStaple): IdempotentKeyClaim[] {
	const claims: IdempotentKeyClaim[] = [];
	for (const block of staple.blocks) {
		if (block.idempotent === undefined) {
			continue;
		}
		const key = LedgerInternals.IdempotentKey.fromAccountAndIdempotent(block.account, block.idempotent);
		claims.push({ key: toIdempotentKeyString(key), block, idempotent: block.idempotent });
	}
	return(claims);
}

function toAccountKeys(...accountSets: readonly Iterable<GenericAccount>[]): Set<AccountKey> {
	const keys = new Set<AccountKey>();
	for (const accounts of accountSets) {
		for (const account of accounts) {
			keys.add(toAccountKey(account));
		}
	}
	return(keys);
}

/**
 * The accounts whose history lists a staple: every account it has an effect
 * on, the principal of a permission requirement among them, which takes in
 * every signer of its blocks: a block's account has an effect
 * [Keeta TS] index.js:69753-69759, and a signer other than the account,
 * nested multisig signers included, is a requirement's principal
 * [Keeta TS] index.js:69778-69803. An account that only a requirement names
 * as its entity or target, such as the token of a send or the network address
 * of an identifier's creation, is touched [Keeta TS] index.js:69698-69701 but
 * not listed, as the main network's representatives list history (D18).
 */
export function historyAccountsOf(effects: Pick<ComputedEffectOfBlocks, 'accounts'>): Set<AccountKey> {
	const listed = new Set<AccountKey>();
	for (const effect of Object.values(effects.accounts)) {
		if (effect.type === 'ACCOUNT') {
			listed.add(toAccountKey(effect.account));
		}
	}
	return(listed);
}

/**
 * Turns a confirmed staple into the writes a driver performs, reading the
 * current state only through upstream's own computeLedgerEffect, so that SET
 * balances, representative weight moves and ACL fallbacks behave exactly as
 * upstream intends.
 * [Keeta TS] index.js:68223-68616
 */
export async function computeConfirmedStapleChange(input: {
	readonly transaction: unknown;
	readonly staple: VoteStaple;
	readonly effects: ComputedEffectOfBlocks;
	readonly blockHeights: ReadonlyMap<BlockHashKey, bigint>;
	readonly storage: LedgerEffectReader;
	readonly network: bigint;
	readonly baseToken: TokenAddress;
	readonly moment: Date;
}): Promise<ConfirmedStapleChange> {
	const { transaction, staple, effects, blockHeights, storage, network, baseToken, moment } = input;
	const ledgerEffect = await LedgerInternals.computeLedgerEffect({
		getFinalNumericValues: false,
		computePermissions: true,
		computeWeights: true,
		baseToken
	}, effects.accounts, storage, network, transaction);

	return({
		staple,
		moment,
		blockHeights,
		ledgerEffect,
		...collectAccountFields(effects),
		idempotentKeys: collectIdempotentKeys(staple),
		historyAccounts: historyAccountsOf(effects),
		newAccounts: toAccountKeys(effects.touched, effects.possibleNewAccounts),
		checksum: stapleChecksumOf(staple)
	});
}

/** The XOR of the hashes of the staple's blocks, which upstream folds into the ledger checksum [Keeta TS] index.js:70449-70453. */
function stapleChecksumOf(staple: VoteStaple): bigint {
	let checksum = 0n;
	for (const block of staple.blocks) {
		checksum ^= block.hash.toBigInt();
	}
	return(checksum);
}

/** Upstream reports heights keyed by hash; every block of the staple must have one. */
export function blockHeightsOf(staple: VoteStaple, heights: { readonly [blockHash: string]: bigint }): Map<BlockHashKey, bigint> {
	const result = new Map<BlockHashKey, bigint>();
	for (const block of staple.blocks) {
		const key = toBlockHashKey(block.hash);
		const height = heights[key];
		if (height === undefined) {
			throw(new Error(`internal error: no height for block ${key}`));
		}
		result.set(key, height);
	}
	return(result);
}
