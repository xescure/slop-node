import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { IdempotentKey } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { ACLRow } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { CertificateHash } from '@keetanetwork/keetanet-client/lib/utils/certificate.js';
import type { Vote, VoteBlockHash } from '@keetanetwork/keetanet-client/lib/vote.js';

/*
 * Canonical string keys for everything a driver stores. Each brand has exactly
 * one conversion function, so a key built any other way does not type-check and
 * two spellings of one entity can never become two rows.
 */

/** An account's public key string, `keeta_...`. */
export type AccountKey = string & { readonly __accountKey: never };

/** A block hash as upstream prints it: uppercase hex. */
export type BlockHashKey = ReturnType<BlockHash['toString']>;

/** A staple's identity: the hash of its blocks, never of its bytes. */
export type StapleKey = string & { readonly __stapleKey: never };

/** A vote's identity: issuer plus serial. */
export type VoteKey = string & { readonly __voteKey: never };

/** A confirmed idempotent key as upstream prints it: uppercase hex. */
export type IdempotentKeyString = ReturnType<IdempotentKey['toString']>;

/** A certificate hash as upstream prints it. */
export type CertificateHashKey = ReturnType<CertificateHash['toString']>;

/** An ACL principal: an account, or a certificate held by an account. */
export type PrincipalKey = string & { readonly __principalKey: never };

/** The (entity, target) pair one ACL row of a principal covers. */
export type ACLScopeKey = string & { readonly __aclScopeKey: never };

/**
 * Accepts a string so that members typed `GenericAccount | string` can key
 * their input; upstream canonicalizes the string through an Account.
 * [Keeta TS] index.js:62709-62714
 */
export function toAccountKey(account: GenericAccount | string): AccountKey {
	// The brand marks the canonical form that toPublicKeyString produces.
	return(KeetaNet.lib.Account.toPublicKeyString(account) as AccountKey);
}

export function toBlockHashKey(hash: BlockHash): BlockHashKey {
	return(hash.toString());
}

/** [Keeta TS] index.js:80126-80143 */
export function toStapleKey(blocksHash: VoteBlockHash): StapleKey {
	// The brand marks the canonical uppercase hex of the blocks hash.
	return(blocksHash.toString() as StapleKey);
}

/** [Keeta TS] index.js:80569-80570 */
export function toVoteKey(vote: Pick<Vote, '$uid'>): VoteKey {
	// The brand marks upstream's own issuer-and-serial identity string.
	return(vote.$uid as VoteKey);
}

export function toIdempotentKeyString(key: IdempotentKey): IdempotentKeyString {
	return(key.toString());
}

export function toCertificateHashKey(hash: CertificateHash): CertificateHashKey {
	return(hash.toString());
}

/**
 * The same spelling upstream uses to key effects by principal.
 * [Keeta TS] index.js:67997-68012
 */
export function toPrincipalKey(principal: ACLRow['principal']): PrincipalKey {
	if (KeetaNet.lib.Account.isInstance(principal)) {
		const accountPrincipal: string = toAccountKey(principal);
		// An account principal is keyed by its canonical account key.
		return(accountPrincipal as PrincipalKey);
	}
	// The brand marks the certificate-and-holder spelling built here.
	return(`${principal.certificate.toString()}:${toAccountKey(principal.certificateAccount)}` as PrincipalKey);
}

/**
 * An ACL without a target covers the whole entity, which upstream records as
 * the entity being its own target.
 * [Keeta TS] index.js:67109-67132
 */
export function toACLScopeKey(entity: GenericAccount, target: GenericAccount | undefined): ACLScopeKey {
	const resolvedTarget = target ?? entity;
	// The brand marks the entity-and-target spelling built here.
	return(`${toAccountKey(entity)}|${toAccountKey(resolvedTarget)}` as ACLScopeKey);
}
