import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { BlockOperations, BlockOperationSEND } from '@keetanetwork/keetanet-client/lib/block/operations.js';
import type { ErrorCode } from '@keetanetwork/keetanet-client/lib/error/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { ACLPermissionRequirement, ACLUpdate } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { Permissions } from '@keetanetwork/keetanet-client/lib/permissions.js';
import type { Vote, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals } from '../../upstream/internals.js';
import { assertNever } from '../../util/assert-never.js';
import { DRIVER_WRAPPING_CODE } from '../case.js';
import { compareText } from './replay.js';

/*
 * A representative that follows mainnet is also asked to vote on what it
 * follows. Before each confirmed staple is added, its blocks are put to the
 * replay ledger's vote, as a representative that had not yet seen them would
 * be asked. Each refusal must then be explained by one named reason, decided
 * from the requirement the ledger refused, and the explained refusals are the
 * committed exception set.
 */

const lib = KeetaNet.lib;

/**
 * Why a 0.18.7 ledger refuses a staple that mainnet confirmed:
 * - `self-requirement-return`: the requirement follows, in its operation's
 *   list, one whose entity is its principal; 0.18.4 stopped reading the list
 *   there, 0.18.7 skips only that one.
 * - `same-staple-grant-scope`: a grant made by an earlier block of the staple
 *   covers the requirement only under 0.18.4's scope, which ignored the
 *   grant's entity, target and method.
 * - `trusted-account-genesis`: the network's first staple, which the trusted
 *   account vouched for alone; no representative was asked to vote on it.
 */
export const SHADOW_REFUSAL_REASONS = ['self-requirement-return', 'same-staple-grant-scope', 'trusted-account-genesis'] as const;

export type ShadowRefusalReason = typeof SHADOW_REFUSAL_REASONS[number];

export type ShadowRefusal = { readonly code: ErrorCode; readonly message: string };

export type ShadowVote =
	{ readonly outcome: 'voted'; readonly staple: VoteStaple; readonly vote: Vote } |
	{ readonly outcome: 'refused'; readonly staple: VoteStaple; readonly refusal: ShadowRefusal };

export type ShadowVoter = {
	/** A replay's hook: it runs with the clock frozen at the staple's timestamp, before the staple is added. */
	readonly beforeAdd: (staple: VoteStaple, ledger: Ledger) => Promise<void>;
	/** One per staple, in replay order. */
	readonly votes: readonly ShadowVote[];
};

/**
 * The ledger's coded errors are its decisions. Anything else, including
 * the driver's wrapping of an error without a code, is a fault of the run.
 */
function refusalOf(error: unknown): ShadowRefusal {
	if (lib.Error.isInstance(error) && error.code !== DRIVER_WRAPPING_CODE) {
		return({ code: error.code, message: error.message });
	}
	throw(new Error('the shadow vote failed without a decision', { cause: error }));
}

async function shadowVote(staple: VoteStaple, ledger: Ledger): Promise<ShadowVote> {
	if (Date.now() !== staple.timestamp().valueOf()) {
		throw(new Error(`a shadow vote on ${staple.blocksHash.toString()} runs with the clock away from the staple's timestamp`));
	}
	let vote: Vote;
	try {
		vote = await ledger.vote(staple.blocks);
	} catch (error: unknown) {
		return({ outcome: 'refused', staple, refusal: refusalOf(error) });
	}
	return({ outcome: 'voted', staple, vote });
}

/**
 * A temporary vote is written beside the main ledger; adding the staple next
 * confirms the same blocks and so promotes that side write away.
 */
export function shadowVoter(): ShadowVoter {
	const votes: ShadowVote[] = [];
	return({
		votes,
		beforeAdd: async function(staple, ledger) {
			votes.push(await shadowVote(staple, ledger));
		}
	});
}

export type NetworkAnchors = Pick<Ledger, 'initialTrustedAccount' | 'baseToken' | 'networkAddress'>;

/** What the classification reads of a staple. */
export type RefusedStaple = {
	readonly blocks: readonly Block[];
	readonly votes: readonly Pick<Vote, 'issuer'>[];
};

/** A refusal that no reason, or more than one, explains. */
export class UnexplainedRefusal extends Error {
	override readonly name = 'UnexplainedRefusal';
}

type Requirement = ACLPermissionRequirement;

type Scoped = Pick<Requirement, 'principal' | 'entity' | 'target'>;

function requirementsOf(blocks: readonly Block[], anchors: NetworkAnchors): Requirement[] {
	const effects = LedgerInternals.computeEffectOfBlocks([...blocks], anchors);
	return(Object.values(effects.accounts).flatMap(function(effect): Requirement[] {
		return(effect.fields.permissionRequirements ?? []);
	}));
}

function keyOf(account: GenericAccount | undefined): string {
	return(String(account?.publicKeyString.get()));
}

/*
 * A refusal names the first requirement that its principal does not meet,
 * with an absent target interpolated as "undefined".
 * [Keeta TS] index.js:69873-69879
 */
function refusalMessageOf(requirement: Requirement): string {
	const flags = requirement.permissions.base.flags.join(', ');
	const offsets = requirement.permissions.external.trueOffsets.join(', ');
	return(`${keyOf(requirement.principal)} does not have required permissions to perform action on ${keyOf(requirement.entity)}/${keyOf(requirement.target)} -- needs [${flags}]/[${offsets}]`);
}

function refusedRequirement(blocks: readonly Block[], refusal: ShadowRefusal, anchors: NetworkAnchors): Requirement {
	const named = requirementsOf(blocks, anchors).filter(function(requirement): boolean {
		return(refusalMessageOf(requirement) === refusal.message);
	});
	const [requirement] = named;
	if (requirement === undefined || named.length !== 1) {
		throw(new UnexplainedRefusal(`${String(named.length)} requirements of the staple match the refusal: ${refusal.message}`));
	}
	return(requirement);
}

function sameScope(left: Scoped, right: Scoped): boolean {
	if (!left.principal.comparePublicKey(right.principal) || !left.entity.comparePublicKey(right.entity)) {
		return(false);
	}
	if (left.target === undefined || right.target === undefined) {
		return(left.target === right.target);
	}
	return(left.target.comparePublicKey(right.target));
}

function isSend(operation: BlockOperations): operation is BlockOperationSEND {
	return(operation.type === lib.Block.OperationType.SEND);
}

/*
 * The requirements a SEND puts on the block's account, in upstream's order,
 * each completed as an account requirement is: the block's account is the
 * principal and ACCESS the permissions unless the entry names its own.
 * [Keeta TS] index.js:68461-68492, 68620-68637
 */
function sendRequirements(block: Block, operation: BlockOperationSEND): Requirement[] {
	const access = new lib.Permissions(['ACCESS']);
	const listed: Requirement[] = [
		{ principal: block.account, entity: operation.token, permissions: access },
		{ principal: operation.to, entity: operation.token, permissions: access }
	];
	if (operation.to.keyType !== lib.Account.AccountKeyAlgorithm.STORAGE) {
		return(listed);
	}
	return([
		...listed,
		{ principal: operation.token, entity: operation.to, permissions: new lib.Permissions(['STORAGE_CAN_HOLD']) },
		{ principal: block.account, entity: operation.to, permissions: new lib.Permissions(['STORAGE_DEPOSIT']), target: operation.token }
	]);
}

function isSelfRequirement(requirement: Requirement): boolean {
	return(requirement.entity.comparePublicKey(requirement.principal));
}

/*
 * 0.18.4 returned from the whole list at a requirement whose entity is its
 * principal, so the requirements after it were never recorded; 0.18.7 skips
 * only that one. The refused requirement is explained when every SEND of the
 * staple that lists it lists it after such a requirement, and those SENDs
 * account for all of its flags. Only a SEND lists more than one requirement
 * that can be its own principal's, since a signer's requirements are made
 * only when the signer is not the account.
 * [Keeta TS 0.18.4] index.js:68490-68492
 * [Keeta TS] index.js:68646-68648
 */
function skippedAfterSelfRequirement(blocks: readonly Block[], refused: Requirement): boolean {
	let listings = 0;
	let flags: Permissions = new lib.Permissions();
	for (const block of blocks) {
		for (const operation of block.operations.filter(isSend)) {
			const listed = sendRequirements(block, operation);
			for (const [index, requirement] of listed.entries()) {
				if (!sameScope(requirement, refused)) {
					continue;
				}
				if (!listed.slice(0, index).some(isSelfRequirement)) {
					return(false);
				}
				listings++;
				flags = flags.combine(requirement.permissions);
			}
		}
	}
	return(listings > 0 && flags.compare(refused.permissions));
}

/*
 * 0.18.4 counted any grant the staple had already made to the principal,
 * whatever its entity, target or method, as meeting a requirement whose
 * flags it holds. 0.18.7 counts one only for the same entity and a matching
 * target, and never a SUBTRACT; it recorded the refused requirement, so no
 * earlier grant met it under that rule.
 * [Keeta TS 0.18.4] index.js:67901-67906
 * [Keeta TS] index.js:68035-68057
 */
function grantedUnderOldScope(blocks: readonly Block[], refused: Requirement, anchors: NetworkAnchors): boolean {
	const firstRequiring = blocks.findIndex(function(_block, index): boolean {
		return(requirementsOf(blocks.slice(0, index + 1), anchors).some(function(requirement): boolean {
			return(sameScope(requirement, refused));
		}));
	});
	if (firstRequiring <= 0) {
		return(false);
	}
	const earlier = LedgerInternals.computeEffectOfBlocks([...blocks.slice(0, firstRequiring)], anchors);
	const granted: ACLUpdate[] = earlier.accounts[keyOf(refused.principal)]?.fields.permissions ?? [];
	return(granted.some(function(grant): boolean {
		return(grant.permissions !== null && grant.permissions.has(refused.permissions));
	}));
}

/*
 * The first staple opens the network address and the base token, and its
 * only vote is the trusted account's own, as upstream's genesis is built.
 * [Keeta TS] index.js:79675-79688
 */
function isTrustedAccountGenesis(staple: RefusedStaple, anchors: NetworkAnchors): boolean {
	function opens(account: Account | GenericAccount): boolean {
		return(staple.blocks.some(function(block): boolean {
			return(block.$opening && block.account.comparePublicKey(account));
		}));
	}
	const vouchedByTrustedAccountAlone = staple.votes.length > 0 && staple.votes.every(function(vote): boolean {
		return(vote.issuer.comparePublicKey(anchors.initialTrustedAccount));
	});
	return(vouchedByTrustedAccountAlone && opens(anchors.networkAddress) && opens(anchors.baseToken));
}

function explains(reason: ShadowRefusalReason, staple: RefusedStaple, refused: Requirement, anchors: NetworkAnchors): boolean {
	switch (reason) {
		case 'self-requirement-return':
			return(skippedAfterSelfRequirement(staple.blocks, refused));
		case 'same-staple-grant-scope':
			return(grantedUnderOldScope(staple.blocks, refused, anchors));
		case 'trusted-account-genesis':
			return(isTrustedAccountGenesis(staple, anchors));
		default:
			return(assertNever(reason));
	}
}

/** The one reason that explains the refusal; any other outcome throws UnexplainedRefusal. */
export function refusalReason(staple: RefusedStaple, refusal: ShadowRefusal, anchors: NetworkAnchors): ShadowRefusalReason {
	if (refusal.code !== 'LEDGER_INVALID_PERMISSIONS') {
		throw(new UnexplainedRefusal(`only a permission refusal is explained, not ${refusal.code}: ${refusal.message}`));
	}
	const refused = refusedRequirement(staple.blocks, refusal, anchors);
	const reasons = SHADOW_REFUSAL_REASONS.filter(function(reason): boolean {
		return(explains(reason, staple, refused, anchors));
	});
	const [reason] = reasons;
	if (reason === undefined || reasons.length !== 1) {
		throw(new UnexplainedRefusal(`${String(reasons.length)} reasons explain the refusal: ${refusal.message}`));
	}
	return(reason);
}

export type ShadowVoteException = {
	readonly blocksHash: string;
	readonly reason: ShadowRefusalReason;
	readonly code: ErrorCode;
};

/** Each refused staple with its reason; an unexplained refusal throws. */
export function shadowVoteExceptions(votes: readonly ShadowVote[], anchors: NetworkAnchors): ShadowVoteException[] {
	return(votes.flatMap(function(vote): ShadowVoteException[] {
		switch (vote.outcome) {
			case 'voted':
				return([]);
			case 'refused':
				return([{ blocksHash: vote.staple.blocksHash.toString(), reason: refusalReason(vote.staple, vote.refusal, anchors), code: vote.refusal.code }]);
			default:
				return(assertNever(vote));
		}
	}));
}

/** A JSON object from blocks hash to reason and code, in code-point order of the hashes. */
export function renderShadowVoteExceptions(exceptions: readonly ShadowVoteException[]): string {
	const sorted = [...exceptions].sort(function(left, right): number {
		return(compareText(left.blocksHash, right.blocksHash));
	});
	const byBlocksHash = Object.fromEntries(sorted.map(function({ blocksHash, reason, code }) {
		return([blocksHash, { reason, code }]);
	}));
	return(`${JSON.stringify(byBlocksHash, null, 2)}\n`);
}
