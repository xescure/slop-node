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
import { compareText } from '../../util/compare-text.js';
import { DRIVER_WRAPPING_CODE } from '../case.js';

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
 * - `send-recipient-access`: the recipient's access on a sent token, which no
 *   release before 0.18.0 required and which the staple's votes predate.
 * - `permanent-vote-block-age`: a block dated more than five minutes before
 *   the staple's earliest vote, and none after it. A representative checks a
 *   block's date only as it issues a temporary vote on its own, not one
 *   asked for beside permanent votes alone, while the shadow vote is a
 *   temporary one on its own at the permanent votes' moment. It is explained
 *   only once the same ledger votes for the staple beside the staple's own
 *   permanent votes.
 */
const PERMISSION_REFUSAL_REASONS = ['self-requirement-return', 'same-staple-grant-scope', 'trusted-account-genesis', 'send-recipient-access'] as const;

type PermissionRefusalReason = typeof PERMISSION_REFUSAL_REASONS[number];

export const SHADOW_REFUSAL_REASONS: readonly [...typeof PERMISSION_REFUSAL_REASONS, 'permanent-vote-block-age'] = [...PERMISSION_REFUSAL_REASONS, 'permanent-vote-block-age'];

export type ShadowRefusalReason = typeof SHADOW_REFUSAL_REASONS[number];

/**
 * The release of @keetanetwork/keetanet-client that changed the rule each
 * reason names, or null when no release did. 0.18.5 is the first whose
 * effects skip only the self requirement [Keeta TS 0.18.5] index.js:68512-68513
 * and scope an earlier grant [Keeta TS 0.18.5] index.js:67903; 0.18.4 has
 * neither [Keeta TS 0.18.4] index.js:68490-68491. 0.18.0 is the first that
 * lists a SEND's recipient [Keeta TS 0.18.0] index.js:68263-68279. Every
 * release refuses the genesis staple's vote, and checks a block's date only
 * for a temporary vote.
 */
export const SHADOW_REFUSAL_RELEASES: Readonly<Record<ShadowRefusalReason, string | null>> = {
	'self-requirement-return': '0.18.5',
	'same-staple-grant-scope': '0.18.5',
	'trusted-account-genesis': null,
	'send-recipient-access': '0.18.0',
	'permanent-vote-block-age': null
};

export type LedgerRefusal = { readonly code: ErrorCode; readonly message: string };

export type ShadowVote =
	{ readonly outcome: 'voted'; readonly staple: VoteStaple; readonly vote: Vote } |
	{ readonly outcome: 'refused'; readonly staple: VoteStaple; readonly refusal: LedgerRefusal };

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
export function refusalOf(error: unknown): LedgerRefusal {
	if (lib.Error.isInstance(error) && error.code !== DRIVER_WRAPPING_CODE) {
		return({ code: error.code, message: error.message });
	}
	throw(new Error('the shadow vote failed without a decision', { cause: error }));
}

/** The ledger's vote on the staple's blocks, which must run with the clock at the staple's moment. */
export function shadowVote(staple: VoteStaple, ledger: Ledger): Promise<ShadowVote> {
	return(voteOn(staple, ledger, undefined));
}

/**
 * The ledger's vote on the staple's blocks asked for beside the staple's
 * own permanent votes, as a temporary vote that skips the check of the
 * blocks' dates, once those votes hold more than a quarter of the voting
 * weight [Keeta TS] index.js:69028-69050, 69228-69238, 69309-69316; it
 * must run with the clock at the staple's moment.
 */
export function voteBesidePermanentVotes(staple: VoteStaple, ledger: Ledger): Promise<ShadowVote> {
	return(voteOn(staple, ledger, staple.votes));
}

async function voteOn(staple: VoteStaple, ledger: Ledger, otherVotes: readonly Vote[] | undefined): Promise<ShadowVote> {
	if (Date.now() !== staple.timestamp().valueOf()) {
		throw(new Error(`a shadow vote on ${staple.blocksHash.toString()} runs with the clock away from the staple's timestamp`));
	}
	let vote: Vote;
	try {
		let others: Vote[] | undefined;
		if (otherVotes !== undefined) {
			others = [...otherVotes];
		}
		vote = await ledger.vote(staple.blocks, others);
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
	readonly votes: readonly Pick<Vote, 'issuer' | 'validityFrom'>[];
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

function refusedRequirement(blocks: readonly Block[], refusal: LedgerRefusal, anchors: NetworkAnchors): Requirement {
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
export function sendRequirements(block: Block, operation: BlockOperationSEND): Requirement[] {
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
 * only vote is the trusted account's own, as upstream's genesis vote is. The
 * refused requirement is one of another account on either of them, since
 * the trusted account's own on its opening blocks are never recorded.
 * [Keeta TS] index.js:79675-79688, 68653-68661
 */
function isTrustedAccountGenesis(staple: RefusedStaple, refused: Requirement, anchors: NetworkAnchors): boolean {
	function opens(account: Account | GenericAccount): boolean {
		return(staple.blocks.some(function(block): boolean {
			return(block.$opening && block.account.comparePublicKey(account));
		}));
	}
	const vouchedByTrustedAccountAlone = staple.votes.length > 0 && staple.votes.every(function(vote): boolean {
		return(vote.issuer.comparePublicKey(anchors.initialTrustedAccount));
	});
	const onGenesisAccount = refused.entity.comparePublicKey(anchors.baseToken) || refused.entity.comparePublicKey(anchors.networkAddress);
	const ofAnotherAccount = !refused.principal.comparePublicKey(anchors.initialTrustedAccount);
	return(vouchedByTrustedAccountAlone && opens(anchors.networkAddress) && opens(anchors.baseToken) && onGenesisAccount && ofAnotherAccount);
}

/** When the npm registry published @keetanetwork/keetanet-client 0.18.0, the first release whose SEND lists its recipient's access. */
const RECIPIENT_ACCESS_RELEASE = new Date('2026-05-23T16:44:23.024Z');

/*
 * Every release from 0.10.5 through 0.16.2 lists only the sender's access on
 * the token for a SEND [Keeta TS 0.16.2] index.js:68008-68015; 0.18.0 adds the
 * recipient's [Keeta TS 0.18.0] index.js:68263-68279, as 0.18.7 does
 * [Keeta TS] index.js:68461-68474. No representative can have run 0.18.0
 * before it was published, so a staple whose every vote is older was voted
 * without it. Only a
 * SEND names an account other than a block's own or its signer as the
 * principal of a requirement on a token, so a principal that is neither for any
 * block of the staple is required only as a recipient. A recipient listed after
 * a self requirement in every SEND is the early return's instead.
 * [Keeta TS] index.js:68458-68603, 68620-68631
 */
function requiredOnlyOfRecipient(staple: RefusedStaple, refused: Requirement): boolean {
	const votedBeforeRelease = staple.votes.length > 0 && staple.votes.every(function(vote): boolean {
		return(vote.validityFrom.valueOf() < RECIPIENT_ACCESS_RELEASE.valueOf());
	});
	const accessAlone = refused.target === undefined && refused.permissions.compare(new lib.Permissions(['ACCESS']));
	const actsInStaple = staple.blocks.some(function(block): boolean {
		return(block.account.comparePublicKey(refused.principal) || block.principal.comparePublicKey(refused.principal));
	});
	if (!votedBeforeRelease || !accessAlone || actsInStaple) {
		return(false);
	}
	return(staple.blocks.some(function(block): boolean {
		return(block.operations.filter(isSend).some(function(operation): boolean {
			const [sender, recipient] = sendRequirements(block, operation);
			return(sender !== undefined && recipient !== undefined && sameScope(recipient, refused) && !isSelfRequirement(sender));
		}));
	}));
}

function explains(reason: PermissionRefusalReason, staple: RefusedStaple, refused: Requirement, anchors: NetworkAnchors): boolean {
	switch (reason) {
		case 'self-requirement-return':
			return(skippedAfterSelfRequirement(staple.blocks, refused));
		case 'same-staple-grant-scope':
			return(grantedUnderOldScope(staple.blocks, refused, anchors));
		case 'trusted-account-genesis':
			return(isTrustedAccountGenesis(staple, refused, anchors));
		case 'send-recipient-access':
			return(requiredOnlyOfRecipient(staple, refused));
		default:
			return(assertNever(reason));
	}
}

/** How far from the moment a temporary vote is issued a block may be dated [Keeta TS] index.js:70185-70197. */
export const BLOCK_DATE_WINDOW_MILLISECONDS: number = 5 * 60_000;

/*
 * A ledger checks a block's date only once the ledger's outcome of the
 * blocks has validated, and only for a temporary vote asked for on its own:
 * a vote asked for beside temporary votes is permanent and issued without
 * the check, as is a temporary one asked for beside permanent votes alone
 * [Keeta TS] index.js:69028-69050, 69309-69316, 69317-69347, 70179-70197;
 * 0.18.4 checks the same [Keeta TS 0.18.4] index.js:70013-70025. A staple
 * whose block is dated more than the window before its earliest vote was
 * therefore voted on through one of those, as its blocks were older than
 * the window when the votes were made. A block dated after the votes is no
 * such staple's: the representatives' clocks were then behind it.
 */
function voteSkippedTheDateCheck(staple: RefusedStaple): boolean {
	if (staple.votes.length === 0) {
		return(false);
	}
	const earliestVote = Math.min(...staple.votes.map(function(vote): number {
		return(vote.validityFrom.valueOf());
	}));
	const dates = staple.blocks.map(function(block): number {
		return(block.date.valueOf());
	});
	return(dates.every(function(date): boolean {
		return(date <= earliestVote);
	}) && dates.some(function(date): boolean {
		return(date < earliestVote - BLOCK_DATE_WINDOW_MILLISECONDS);
	}));
}

export type ExplainedRefusal =
	{
		readonly reason: PermissionRefusalReason;
		/** The requirement the refusal names, as the staple's effects record it. */
		readonly requirement: Requirement;
	} |
	{ readonly reason: 'permanent-vote-block-age'; readonly requirement: null };

/**
 * The one reason that explains the refusal, with the requirement refused;
 * any other outcome throws UnexplainedRefusal. A refusal for a block's date
 * is explained by the staple's dates alone, which a vote beside the
 * staple's own permanent votes then confirms (src/parity/shadow-live.ts).
 */
export function explainRefusal(staple: RefusedStaple, refusal: LedgerRefusal, anchors: NetworkAnchors): ExplainedRefusal {
	if (refusal.code === 'LEDGER_BLOCK_EXPIRED') {
		if (!voteSkippedTheDateCheck(staple)) {
			throw(new UnexplainedRefusal(`a block of the staple is dated after its earliest vote, or none more than ${String(BLOCK_DATE_WINDOW_MILLISECONDS / 60_000)} min before it: ${refusal.message}`));
		}
		return({ reason: 'permanent-vote-block-age', requirement: null });
	}
	if (refusal.code !== 'LEDGER_INVALID_PERMISSIONS') {
		throw(new UnexplainedRefusal(`only a permission or a block date refusal is explained, not ${refusal.code}: ${refusal.message}`));
	}
	const refused = refusedRequirement(staple.blocks, refusal, anchors);
	const reasons = PERMISSION_REFUSAL_REASONS.filter(function(reason): boolean {
		return(explains(reason, staple, refused, anchors));
	});
	const [reason] = reasons;
	if (reason === undefined || reasons.length !== 1) {
		throw(new UnexplainedRefusal(`${String(reasons.length)} reasons explain the refusal: ${refusal.message}`));
	}
	return({ reason, requirement: refused });
}

export type ShadowVoteException = Extract<ExplainedRefusal, { readonly requirement: Requirement }> & {
	readonly blocksHash: string;
	readonly code: ErrorCode;
};

/**
 * Each refused staple with its reason; an unexplained refusal throws, as
 * does one for a block's date, which the replay's voter does not confirm.
 */
export function shadowVoteExceptions(votes: readonly ShadowVote[], anchors: NetworkAnchors): ShadowVoteException[] {
	return(votes.flatMap(function(vote): ShadowVoteException[] {
		switch (vote.outcome) {
			case 'voted':
				return([]);
			case 'refused': {
				const explained = explainRefusal(vote.staple, vote.refusal, anchors);
				if (explained.requirement === null) {
					throw(new UnexplainedRefusal(`a refusal for a block's date is explained only by a vote beside the staple's permanent votes, which the replay does not make: ${vote.refusal.message}`));
				}
				return([{ blocksHash: vote.staple.blocksHash.toString(), code: vote.refusal.code, ...explained }]);
			}
			default:
				return(assertNever(vote));
		}
	}));
}

type RenderedRequirement = {
	readonly principal: string;
	readonly entity: string;
	readonly target?: string;
	readonly base: readonly string[];
	readonly external: readonly number[];
};

/** Its scope as account strings, a target only when it has one, and its flags by name and offset. */
function renderRequirement({ principal, entity, target, permissions }: Requirement): RenderedRequirement {
	const scope = { principal: principal.publicKeyString.get(), entity: entity.publicKeyString.get() };
	const flags = { base: permissions.base.flags, external: permissions.external.trueOffsets };
	if (target === undefined) {
		return({ ...scope, ...flags });
	}
	return({ ...scope, target: target.publicKeyString.get(), ...flags });
}

/** A JSON object from blocks hash to reason, code and refused requirement, in code-point order of the hashes. */
export function renderShadowVoteExceptions(exceptions: readonly ShadowVoteException[]): string {
	const sorted = [...exceptions].sort(function(left, right): number {
		return(compareText(left.blocksHash, right.blocksHash));
	});
	const byBlocksHash = Object.fromEntries(sorted.map(function({ blocksHash, reason, code, requirement }) {
		return([blocksHash, { reason, code, requirement: renderRequirement(requirement) }]);
	}));
	return(`${JSON.stringify(byBlocksHash, null, 2)}\n`);
}
