import { appendFile, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { SHADOW_REFUSAL_REASONS } from '../conformance/mainnet/shadow.js';
import type { ShadowRefusalReason } from '../conformance/mainnet/shadow.js';
import { stratumOf } from './strata.js';
import type { Stratum } from './strata.js';

/** The parity log, one JSON record per line, in the follower's directory. */
export const PARITY_LOG_FILE = 'parity.jsonl';

export function parityLogPath(directory: string): string {
	return(join(directory, PARITY_LOG_FILE));
}

/** A node's ledger checksum and block count, read together, as its API serves them. */
export type ChecksumReading = {
	/** As served: "0x" and uppercase hexadecimal without leading zeros (conformance/STATE-DUMP.md section 3.5). */
	readonly checksum: string;
	readonly blockCount: number;
};

/** A node's readings at both ends of the comparison window, or why it gave none. */
export type ChecksumWindow =
	| { readonly kind: 'read'; readonly first: ChecksumReading; readonly second: ChecksumReading }
	| { readonly kind: 'unanswered'; readonly error: string };

/** Why a checksum comparison does not count. */
export type NotComparableReason =
	/** The follower has not completed a bootstrap pass, so it may lack staples the representative holds. */
	| 'no-completed-pass'
	| 'follower-moving'
	| 'representative-moving'
	| 'follower-unanswered'
	| 'representative-unanswered';

/** Where the sweep stands, for a mismatch to be traced to the accounts it compared. */
export type SweepPointer = {
	readonly cursor: SweepCursor | null;
	/** The first account the sweep found diverging, which a checksum mismatch most likely comes from. */
	readonly firstDivergence: Divergence | null;
};

/** What a checksum mismatch gives to find its cause. */
export type BisectAid = {
	readonly followerBlockCount: number;
	readonly representativeBlockCount: number;
	readonly sweep: SweepPointer;
};

export type ChecksumVerdict =
	| { readonly kind: 'pass' }
	| { readonly kind: 'fail'; readonly bisect: BisectAid }
	| { readonly kind: 'not-comparable-yet'; readonly reasons: readonly NotComparableReason[] };

export type ChecksumRecord = {
	readonly kind: 'checksum';
	readonly at: string;
	readonly representative: string;
	readonly gapMilliseconds: number;
	/** The horizon of the follower's latest completed bootstrap pass, or null while none has completed. */
	readonly completedPass: string | null;
	readonly follower: ChecksumWindow;
	readonly representativeWindow: ChecksumWindow;
	readonly verdict: ChecksumVerdict;
};

/** Where a sweep resumes: within a lap over every account the follower knows, after the account with this row ID. */
export type SweepCursor = {
	readonly lap: number;
	readonly afterRowID: string;
};

/** The first difference between the follower's and a representative's answers about one account. */
export type Divergence = {
	readonly account: string;
	/** The path of the first field that differs, "history" when the follower lacks the account's newest staple. */
	readonly field: string;
	/** The account's newest staple on the representative, the hash of its blocks, where a bisection starts. */
	readonly staple: string | null;
};

/** Which side showed the account moving. */
export type MovingSide = 'representative' | 'follower';

/** Another representative's state of an account the follower and one representative answered apart, read again to tell whose the difference is. */
export type RepresentativeReading =
	/** Whether its state, and its newest staple of the account, which the follower must hold, are the follower's. */
	| { readonly representative: string; readonly kind: 'agrees' | 'disagrees'; readonly state: unknown; readonly staple: string | null }
	/** No reading that counts: it did not answer, or its newest staple of the account is from within the margin of the follower's reach. */
	| { readonly representative: string; readonly kind: 'unanswered' | 'moving'; readonly detail: string };

/** Whether the follower's balances of an account are those its own history leaves it with. */
export type SelfCheck =
	| { readonly kind: 'consistent'; readonly tokens: number }
	/** The first token whose balance the follower serves is not the net of its history's changes, both "0x" hexadecimal. */
	| { readonly kind: 'inconsistent'; readonly token: string; readonly served: string; readonly fromHistory: string }
	| { readonly kind: 'unchecked'; readonly why: string };

/** What the follower and the representative compared with answered apart, and what the other representatives answered when read again. */
export type Disputed = {
	readonly divergence: Divergence;
	readonly follower: unknown;
	readonly representative: unknown;
	/** None in a record written before divergences were read again. */
	readonly readings: readonly RepresentativeReading[];
	/** For a divergence the representatives leave to one of them or split on, the follower's check of its own balances; null otherwise, or in a record written before it was made. */
	readonly selfCheck: SelfCheck | null;
};

/** What a divergence from one representative turns out to be, once the others are read. */
export type DisputedKind =
	/** The follower disagrees with most of the representatives that answered: the follower's own. */
	| 'diverged'
	/** At least two answer as the follower, every other value fewer, and the follower holds what each apart holds newest: the own of those apart. */
	| 'representative-local'
	/** Neither side has most of them. */
	| 'unresolved';

export type SweepOutcome =
	| { readonly kind: 'match'; readonly head: string | null; readonly staple: string | null }
	/**
	 * A chain account moving on every attempt, compared by its chain: the
	 * follower's head is a block of the representative's chain, so every
	 * block below it is the representative's too, and each block the
	 * representative holds past it is too recent for the follower to hold.
	 */
	| { readonly kind: 'compared-chain'; readonly head: string; readonly representativeHead: string; readonly lacking: number }
	| ({ readonly kind: DisputedKind } & Disputed)
	/** Not compared: both sides answered the account in a batch with the same error. */
	| { readonly kind: 'error-both'; readonly error: string }
	/** Not compared: the two may hold the account at different points, so it is retried on a later lap. */
	| { readonly kind: 'skipped'; readonly reason: 'moving'; readonly side: MovingSide; readonly detail: string }
	| { readonly kind: 'skipped'; readonly reason: 'unanswered'; readonly detail: string };

/**
 * Whether an account's comparison leaves it diverging: a divergence of the
 * follower's or one the representatives split on, and one left to the
 * representatives apart that no check of the follower's balances bore out,
 * as nothing but their votes then rests on it; it stands unresolved until
 * a check is consistent.
 */
export function standsDiverging(outcome: SweepOutcome): boolean {
	return(outcome.kind === 'diverged' || outcome.kind === 'unresolved' || (outcome.kind === 'representative-local' && outcome.selfCheck?.kind !== 'consistent'));
}

/**
 * Whether a later comparison of an account stands in place of the one
 * before it: a comparison of the chain alone reads neither the account's
 * state nor its history, so it settles no divergence of them, which stands
 * until a comparison of the state settles it.
 */
export function standsInPlaceOf(later: SweepOutcome, standing: SweepOutcome | undefined): boolean {
	if (later.kind !== 'compared-chain' || standing === undefined || !standsDiverging(standing)) {
		return(true);
	}
	switch (standing.kind) {
		case 'diverged':
		case 'unresolved':
		case 'representative-local':
			return(standing.divergence.field === 'chain');
		default:
			return(true);
	}
}

/**
 * Which of the follower's accounts a walk of the sweep goes over: those with
 * blocks on its main ledger, compared one at a time by their heads, or the
 * rest, compared in batches.
 */
export type SweepWalk = 'chain' | 'passive';

/** A walk a record was written in: one of the two, or the walk over every account one at a time, before they were split. */
export type RecordedWalk = SweepWalk | 'every';

/** One account compared, or not, by itself. */
export type SweepRecord = {
	readonly kind: 'sweep';
	readonly at: string;
	readonly representative: string;
	readonly account: string;
	readonly lap: number;
	readonly walk: RecordedWalk;
	readonly outcome: SweepOutcome;
};

/**
 * A batch of the passive walk, written after a sweep record for each of its
 * accounts whose states the two answered apart, so that the accounts it
 * walked are known by their rows and those it did not compare by name.
 */
export type SweepBatchRecord = {
	readonly kind: 'sweep-batch';
	readonly at: string;
	readonly representative: string;
	readonly lap: number;
	/** The batch walked every passive account after the first row through the second. */
	readonly afterRowID: string;
	readonly throughRowID: string;
	readonly accounts: number;
	/** Accounts whose states the two answered alike. */
	readonly matched: number;
	/** Accounts not compared: found moving, or unanswered. */
	readonly skipped: readonly string[];
	/** Why the representative answered none of the batch, or null when it answered. */
	readonly unanswered: string | null;
};

/**
 * Why a block count comparison does not count. Until the follower has
 * completed a pass and added every staple it staged, its ledger stands at
 * an earlier point of the history than the representatives', and counts
 * fewer blocks for that alone.
 */
export type BlockCountNotComparableReason = Extract<NotComparableReason, 'no-completed-pass' | 'follower-unanswered' | 'representative-unanswered'> | 'stage-not-empty'
	/** The representative counts farther than the floor from the others' median, a count of its own. */
	| 'representative-outlier';

export type BlockCountVerdict =
	| { readonly kind: 'pass' }
	| { readonly kind: 'fail'; readonly difference: number }
	| { readonly kind: 'not-comparable-yet'; readonly reasons: readonly BlockCountNotComparableReason[] };

/** The follower's block count against a representative's, read in the windows of a checksum comparison. */
export type BlockCountRecord = {
	readonly kind: 'block-count';
	readonly at: string;
	readonly representative: string;
	readonly completedPass: string | null;
	/** Staples the follower had staged and not added yet, or null in a record of a build that did not read them. */
	readonly staged: number | null;
	readonly follower: ChecksumWindow;
	readonly representativeWindow: ChecksumWindow;
	/** How far apart the two counts may be and still describe the same ledger, as reckoned for this comparison. */
	readonly toleranceBlocks: number;
	readonly verdict: BlockCountVerdict;
};

/** A main staple whose stored checksum is not the XOR of its blocks' hashes, both "0x" and uppercase hexadecimal. */
export type MismatchedStapleRecord = {
	readonly sequence: string;
	readonly blocksHash: string;
	readonly stored: string;
	readonly fold: string;
};

/** How the follower's stored checksum stands against the XOR of the blocks on its main ledger. */
export type CrossCheckOutcome =
	| { readonly kind: 'equal' }
	/** They differ by the offset; the staples listed are the first whose own stored checksum is not the fold of their blocks. */
	| { readonly kind: 'differs'; readonly offset: string; readonly staples: readonly MismatchedStapleRecord[] }
	/*
	 * Recorded by builds that kept the checksum as a node statistic, written
	 * apart from the ledger: the difference was made by the blocks of these
	 * staples, which the node had not written yet; or by a run of staples
	 * committed one after another whose part of the statistic a stop lost;
	 * or by nothing that explained it.
	 */
	| { readonly kind: 'unsynced'; readonly staples: readonly string[] }
	| { readonly kind: 'lost-run'; readonly firstSequence: string; readonly lastSequence: string; readonly staples: number; readonly firstMoment: string; readonly lastMoment: string }
	| { readonly kind: 'unexplained'; readonly offset: string };

export type CrossCheckRecord = {
	readonly kind: 'cross-check';
	readonly at: string;
	/** The stored checksum and the XOR of every main block's hash, both "0x" and uppercase hexadecimal. */
	readonly stored: string;
	readonly folded: string;
	readonly mainBlocks: number;
	readonly outcome: CrossCheckOutcome;
};

/** Another representative's answer to a request the follower and one representative answered apart, sent to it again to tell whose the difference is. */
export type APIDiffReading =
	/** Whether its answer, once normalized, is the follower's; kept as served. */
	| { readonly representative: string; readonly kind: 'agrees' | 'disagrees'; readonly answer: unknown }
	/** No reading that counts: it did not answer, or an account the answer reads is not quiet on it. */
	| { readonly representative: string; readonly kind: 'unanswered' | 'moving'; readonly detail: string };

/** The check of the follower's balances a difference of an answer left to the representatives apart rests on. */
export type APISelfCheck =
	/** Of every account the answer reads. */
	| { readonly kind: 'accounts'; readonly checks: readonly { readonly account: string; readonly check: SelfCheck }[] }
	/** None applies, as the answer reads no account. */
	| { readonly kind: 'none'; readonly why: string };

/** The comparison of one sampled request's answers. */
export type APIDiffOutcome =
	/** The digest of the answer both gave once normalized, or null in a record written before matches kept one. */
	| { readonly kind: 'match'; readonly digest: string | null }
	/**
	 * The field is the path of the first that differs once both are
	 * normalized; the answers are kept as served, with every other
	 * representative's, which decide whose the difference is.
	 */
	| { readonly kind: DisputedKind; readonly field: string; readonly follower: unknown; readonly representative: unknown; readonly readings: readonly APIDiffReading[]; readonly selfCheck: APISelfCheck | null }
	/** Not compared: an account the answer reads may be held at different points. */
	| { readonly kind: 'skipped'; readonly reason: 'moving'; readonly side: MovingSide; readonly detail: string }
	| { readonly kind: 'skipped'; readonly reason: 'unanswered'; readonly detail: string };

export type APIDiffRecord = {
	readonly kind: 'api-diff';
	readonly at: string;
	readonly representative: string;
	readonly stratum: Stratum;
	/** The route of the document the request is of, and the request below the API's root. */
	readonly route: string;
	readonly path: string;
	/** The kinds of behavior the representative's answer shows, as the capture set is told apart by; none when it was not compared. */
	readonly behaviors: readonly string[];
	readonly outcome: APIDiffOutcome;
};

/**
 * The requests of a stratum an API diff run drew, out of every request the
 * sampler forms from the follower's data: from the accounts of the kind
 * quiet before the margin, each naming at most three tokens, certificates,
 * entities and blocks of its chain, or from every block within reach
 * carrying the operation.
 */
export type StratumPopulation =
	/** Every such request, fewer than the run compares, so the run sends each of them. */
	| { readonly kind: 'census'; readonly requests: readonly string[] }
	/** So many requests drawn, every one the data forms when whole. */
	| { readonly kind: 'sample'; readonly drawn: number; readonly whole: boolean };

/** What an API diff run drew of each stratum, written before its comparisons. */
export type APIDiffPlanRecord = {
	readonly kind: 'api-diff-plan';
	readonly at: string;
	/** An account counts as quiet when the follower holds no staple of it from this moment on. */
	readonly quietBefore: string;
	readonly samplesPerStratum: number;
	readonly strata: readonly { readonly stratum: Stratum; readonly population: StratumPopulation }[];
};

/** How a divergence is explained, as the triage of every divergence classifies it. */
export type DivergenceClass =
	/** A defect of this node, fixed by the change the reference names, with a regression test. */
	| 'our-bug'
	/** A rule the main network's release and 0.18.7 differ in, which conformance/MAINNET.md records. */
	| 'upstream-version'
	/** An artifact of how a node runs or answers rather than of the ledger, which conformance/API.md records. */
	| 'operational-artifact';

export const DIVERGENCE_CLASSES: readonly DivergenceClass[] = ['our-bug', 'upstream-version', 'operational-artifact'];

/** What preceded a triage: a later attempt that retested its divergence, or the operator's reason none needs to, or, for a triage recorded before triages were checked, nothing recorded. */
export type TriageRetest =
	| { readonly kind: 'retested' }
	| { readonly kind: 'forced'; readonly why: string }
	| { readonly kind: 'unrecorded' };

/**
 * The triage of an API divergence no later comparison can settle, as the
 * state it was about has moved on: what it was and where that is fixed or
 * recorded. It closes the divergence it names by its request and moment.
 */
export type APIDiffExplainedRecord = {
	readonly kind: 'api-diff-explained';
	readonly at: string;
	readonly stratum: Stratum;
	readonly path: string;
	/** When the divergence explained was recorded. */
	readonly divergenceAt: string;
	readonly divergence: DivergenceClass;
	/** The change that fixed it, or the section of the conformance documents that records it. */
	readonly reference: string;
	/** Whether a later attempt at its request retested the divergence first; for a triage recorded before the explain command checked, only its reference states the evidence. */
	readonly retest: TriageRetest;
};

/** A staple of the window the offline ledger refused to vote on, and the classified difference that explains it. */
export type ShadowRefusal = {
	readonly blocksHash: string;
	readonly reason: ShadowRefusalReason;
	readonly code: string;
};

/** A refusal no classified difference explains, or more than one does. */
export type UnexplainedShadowRefusal = {
	readonly blocksHash: string;
	readonly code: string;
	readonly message: string;
	readonly why: string;
};

/** Shadow votes on a window of the follower's history, replayed from its first staple into an offline ledger, as builds before the version-scoped run recorded them. */
export type ShadowLiveRecord = {
	readonly kind: 'shadow-live';
	readonly at: string;
	/** Staples replayed, the window's among them. */
	readonly replayed: number;
	readonly windowStaples: number;
	/** The moments of the window's first and last staples. */
	readonly windowFrom: string | null;
	readonly windowTo: string | null;
	/** Staples of the window the offline ledger voted for. */
	readonly voted: number;
	readonly explained: readonly ShadowRefusal[];
	readonly unexplained: readonly UnexplainedShadowRefusal[];
	/** Staples of the window the replay could not apply. */
	readonly deferredInWindow: readonly string[];
	/** Staples those builds refused at first for want of voting weight, and tried again as more were added. */
	readonly refusedForWeight: number;
	/** Staples before the window the replay never applied, which leave the window's ledger short of them. */
	readonly unappliedBeforeWindow: readonly string[];
};

/**
 * Which staples shadow votes decide parity on: those first voted for once
 * the release the main network's representatives run was published, whose
 * rules differ from 0.18.7's only by the classified fixes; the earlier ones
 * were voted under older rules and inform only.
 */
export type ShadowWindow = 'scoped' | 'informational';

export const SHADOW_WINDOWS: readonly ShadowWindow[] = ['scoped', 'informational'];

/** How the offline ledger answered a staple put to its vote. */
export type ShadowVoteOutcome =
	| { readonly kind: 'voted' }
	| { readonly kind: 'explained'; readonly reason: ShadowRefusalReason; readonly code: string }
	| { readonly kind: 'unexplained'; readonly code: string; readonly message: string; readonly why: string };

/** One shadow vote, as the run's journal keeps it. */
export type ShadowVoteEntry = {
	/** The staple's place in the order the follower's ledger added its staples, as decimal text. */
	readonly sequence: string;
	readonly blocksHash: string;
	readonly window: ShadowWindow;
	/** When the staple's earliest vote was made. */
	readonly votedFrom: string;
	readonly outcome: ShadowVoteOutcome;
};

/** The most refusals no classified difference explains that a window lists; the rest are counted. */
export const UNEXPLAINED_LISTED = 20;

/** What the replay found in one window. */
export type ShadowWindowTally = {
	/** Staples of the window the replay added. */
	readonly replayed: number;
	/** Of them, the staples put to a shadow vote first. */
	readonly shadowVoted: number;
	readonly voted: number;
	/** Refusals, by the classified difference that explains them. */
	readonly explained: Readonly<Partial<Record<ShadowRefusalReason, number>>>;
	readonly unexplained: number;
	/** The first of them, at most UNEXPLAINED_LISTED. */
	readonly firstUnexplained: readonly UnexplainedShadowRefusal[];
	/** When the earliest vote of the window's earliest and latest staples replayed was made. */
	readonly votedFrom: string | null;
	readonly votedTo: string | null;
};

/** What the offline ledger started from. */
export type ShadowBase = {
	/** The snapshot of the follower's database it is a copy of, or null for an empty ledger. */
	readonly database: string | null;
	/** The follower's place of the snapshot's newest staple, "0" for an empty ledger, and that staple's hash. */
	readonly sequence: string;
	readonly blocksHash: string | null;
	/** Staples of the snapshot within the scoped window, which the run cannot put to a vote. */
	readonly scopedStaples: number;
};

/** How far the run goes. */
export type ShadowTarget = {
	/** The follower's place of its newest staple when the run was started. */
	readonly sequence: string;
	readonly fixedAt: string;
	/** Whether the follower had then completed a pass and added everything it staged, so that it held every staple voted for before its reach. */
	readonly followerCaughtUp: boolean;
	readonly heldBefore: string | null;
};

/**
 * A staple the replay added that the offline ledger has not applied: one
 * deferred until the block it builds on comes, or one an earlier build,
 * which weighed the votes of each staple again, refused for want of voting
 * weight, which a run resumed from its standing applies first.
 */
export type UnappliedStaple = {
	readonly sequence: string;
	readonly blocksHash: string;
	readonly why: 'voting-weight' | 'deferred';
};

/**
 * Where a resumable shadow-vote run stands: what it replayed of the
 * follower's ledger, in the order that ledger added its staples, and what
 * the votes found, by window.
 */
export type ShadowRunState = {
	/** The release the scoped window begins with, and when it was published. */
	readonly scope: { readonly release: string; readonly from: string };
	/** One in so many staples of the informational window is put to a vote. */
	readonly informationalEvery: number;
	readonly base: ShadowBase;
	readonly target: ShadowTarget;
	/** The last staple replayed, by its place and hash; the base's at first. */
	readonly reached: { readonly sequence: string; readonly blocksHash: string | null };
	readonly scoped: ShadowWindowTally;
	readonly informational: ShadowWindowTally;
	readonly unapplied: readonly UnappliedStaple[];
};

/** What one invocation of a run cost. */
export type ShadowRunCost = {
	readonly seconds: number;
	readonly staples: number;
	readonly shadowVotes: number;
	/** The process's peak resident memory. */
	readonly maxResidentMiB: number;
};

/** A resumable run's standing after one of its invocations. */
export type ShadowRunRecord = ShadowRunState & {
	readonly kind: 'shadow-run';
	readonly at: string;
	/** Whether the run replayed up to its target. */
	readonly complete: boolean;
	readonly cost: ShadowRunCost;
};

/**
 * A refusal a run recorded as unexplained, explained since by the
 * classified difference's rule alone: the build that voted made no
 * confirming vote, and the offline ledger has moved past the staple, so
 * none can be made. It names the classification it replaces, so that a
 * later run's refusal of the same staple, classified with the confirming
 * vote, is not covered.
 */
export type ShadowExplainedRecord = {
	readonly kind: 'shadow-explained';
	readonly at: string;
	readonly blocksHash: string;
	readonly window: ShadowWindow;
	readonly code: string;
	readonly reason: ShadowRefusalReason;
	readonly basis: 'by-rule';
	/** Why the run recorded the refusal as unexplained. */
	readonly replaces: string;
};

export type ParityRecord = ChecksumRecord | BlockCountRecord | CrossCheckRecord | SweepRecord | SweepBatchRecord | APIDiffRecord | APIDiffPlanRecord | APIDiffExplainedRecord | ShadowLiveRecord | ShadowRunRecord | ShadowExplainedRecord;

/** The records a log holds, and how many of its lines were not records, as the end of a line cut short by a crash. */
export type ParityLogContents = {
	readonly records: readonly ParityRecord[];
	readonly unreadableLines: number;
};

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

function isString(value: unknown): value is string {
	return(typeof value === 'string');
}

function isStringOrNull(value: unknown): value is string | null {
	return(value === null || typeof value === 'string');
}

function isCount(value: unknown): value is number {
	return(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function readingOf(value: unknown): ChecksumReading | undefined {
	if (!isFields(value) || !isString(value['checksum']) || !isCount(value['blockCount'])) {
		return(undefined);
	}
	return({ checksum: value['checksum'], blockCount: value['blockCount'] });
}

function windowOf(value: unknown): ChecksumWindow | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'read': {
			const first = readingOf(value['first']);
			const second = readingOf(value['second']);
			if (first === undefined || second === undefined) {
				return(undefined);
			}
			return({ kind: 'read', first, second });
		}
		case 'unanswered':
			if (!isString(value['error'])) {
				return(undefined);
			}
			return({ kind: 'unanswered', error: value['error'] });
		default:
			return(undefined);
	}
}

const NOT_COMPARABLE_REASONS: readonly NotComparableReason[] = ['no-completed-pass', 'follower-moving', 'representative-moving', 'follower-unanswered', 'representative-unanswered'];

function reasonOf(value: unknown): NotComparableReason | undefined {
	return(NOT_COMPARABLE_REASONS.find(function(reason): boolean {
		return(reason === value);
	}));
}

const BLOCK_COUNT_REASONS: readonly BlockCountNotComparableReason[] = ['no-completed-pass', 'stage-not-empty', 'follower-unanswered', 'representative-unanswered', 'representative-outlier'];

function blockCountVerdictOf(value: unknown): BlockCountVerdict | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'pass':
			return({ kind: 'pass' });
		case 'fail':
			if (typeof value['difference'] !== 'number' || !Number.isSafeInteger(value['difference'])) {
				return(undefined);
			}
			return({ kind: 'fail', difference: value['difference'] });
		case 'not-comparable-yet': {
			const reasons = listOf(value['reasons'], function(reason): BlockCountNotComparableReason | undefined {
				return(BLOCK_COUNT_REASONS.find(function(known): boolean {
					return(known === reason);
				}));
			});
			if (reasons === undefined) {
				return(undefined);
			}
			return({ kind: 'not-comparable-yet', reasons });
		}
		default:
			return(undefined);
	}
}

function blockCountRecordOf(value: Fields): BlockCountRecord | undefined {
	const { at, representative, completedPass, toleranceBlocks } = value;
	const staged = value['staged'] ?? null;
	const follower = windowOf(value['follower']);
	const representativeWindow = windowOf(value['representativeWindow']);
	const verdict = blockCountVerdictOf(value['verdict']);
	if (!isString(at) || !isString(representative) || !isStringOrNull(completedPass) || !(staged === null || isCount(staged)) || !isCount(toleranceBlocks) || follower === undefined || representativeWindow === undefined || verdict === undefined) {
		return(undefined);
	}
	return({ kind: 'block-count', at, representative, completedPass, staged, follower, representativeWindow, toleranceBlocks, verdict });
}

function mismatchedStapleOf(value: unknown): MismatchedStapleRecord | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	const { sequence, blocksHash, stored, fold } = value;
	if (!isString(sequence) || !isString(blocksHash) || !isString(stored) || !isString(fold)) {
		return(undefined);
	}
	return({ sequence, blocksHash, stored, fold });
}

function crossCheckOutcomeOf(value: unknown): CrossCheckOutcome | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'equal':
			return({ kind: 'equal' });
		case 'differs': {
			const staples = listOf(value['staples'], mismatchedStapleOf);
			if (!isString(value['offset']) || staples === undefined) {
				return(undefined);
			}
			return({ kind: 'differs', offset: value['offset'], staples });
		}
		case 'unsynced': {
			const staples = listOf(value['staples'], function(staple): string | undefined {
				if (!isString(staple)) {
					return(undefined);
				}
				return(staple);
			});
			if (staples === undefined) {
				return(undefined);
			}
			return({ kind: 'unsynced', staples });
		}
		case 'lost-run': {
			const { firstSequence, lastSequence, staples, firstMoment, lastMoment } = value;
			if (!isString(firstSequence) || !isString(lastSequence) || !isCount(staples) || !isString(firstMoment) || !isString(lastMoment)) {
				return(undefined);
			}
			return({ kind: 'lost-run', firstSequence, lastSequence, staples, firstMoment, lastMoment });
		}
		case 'unexplained':
			if (!isString(value['offset'])) {
				return(undefined);
			}
			return({ kind: 'unexplained', offset: value['offset'] });
		default:
			return(undefined);
	}
}

function crossCheckRecordOf(value: Fields): CrossCheckRecord | undefined {
	const { at, stored, folded, mainBlocks } = value;
	const outcome = crossCheckOutcomeOf(value['outcome']);
	if (!isString(at) || !isString(stored) || !isString(folded) || !isCount(mainBlocks) || outcome === undefined) {
		return(undefined);
	}
	return({ kind: 'cross-check', at, stored, folded, mainBlocks, outcome });
}

function cursorOf(value: unknown): SweepCursor | undefined {
	if (!isFields(value) || !isCount(value['lap']) || !isString(value['afterRowID'])) {
		return(undefined);
	}
	return({ lap: value['lap'], afterRowID: value['afterRowID'] });
}

function divergenceOf(value: unknown): Divergence | undefined {
	if (!isFields(value) || !isString(value['account']) || !isString(value['field']) || !isStringOrNull(value['staple'])) {
		return(undefined);
	}
	return({ account: value['account'], field: value['field'], staple: value['staple'] });
}

/** A field that is null or what the reader makes of it, undefined when it is neither. */
function nullable<Value>(value: unknown, read: (value: unknown) => Value | undefined): Value | null | undefined {
	if (value === null) {
		return(null);
	}
	return(read(value));
}

function bisectOf(value: unknown): BisectAid | undefined {
	if (!isFields(value) || !isCount(value['followerBlockCount']) || !isCount(value['representativeBlockCount']) || !isFields(value['sweep'])) {
		return(undefined);
	}
	const cursor = nullable(value['sweep']['cursor'], cursorOf);
	const firstDivergence = nullable(value['sweep']['firstDivergence'], divergenceOf);
	if (cursor === undefined || firstDivergence === undefined) {
		return(undefined);
	}
	return({ followerBlockCount: value['followerBlockCount'], representativeBlockCount: value['representativeBlockCount'], sweep: { cursor, firstDivergence } });
}

/** Every element read, or nothing when the value is no list or one of its elements is unreadable. */
export function listOf<Element>(value: unknown, read: (element: unknown) => Element | undefined): Element[] | undefined {
	if (!Array.isArray(value)) {
		return(undefined);
	}
	const elements: Element[] = [];
	for (const element of value) {
		const found = read(element);
		if (found === undefined) {
			return(undefined);
		}
		elements.push(found);
	}
	return(elements);
}

function checksumVerdictOf(value: unknown): ChecksumVerdict | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'pass':
			return({ kind: 'pass' });
		case 'fail': {
			const bisect = bisectOf(value['bisect']);
			if (bisect === undefined) {
				return(undefined);
			}
			return({ kind: 'fail', bisect });
		}
		case 'not-comparable-yet': {
			const listed = value['reasons'];
			if (!Array.isArray(listed)) {
				return(undefined);
			}
			const reasons = listed.map(reasonOf).filter(function(reason): reason is NotComparableReason {
				return(reason !== undefined);
			});
			if (reasons.length !== listed.length) {
				return(undefined);
			}
			return({ kind: 'not-comparable-yet', reasons });
		}
		default:
			return(undefined);
	}
}

function checksumRecordOf(value: Fields): ChecksumRecord | undefined {
	const { at, representative, gapMilliseconds, completedPass } = value;
	const follower = windowOf(value['follower']);
	const representativeWindow = windowOf(value['representativeWindow']);
	const verdict = checksumVerdictOf(value['verdict']);
	if (!isString(at) || !isString(representative) || !isCount(gapMilliseconds) || !isStringOrNull(completedPass) || follower === undefined || representativeWindow === undefined || verdict === undefined) {
		return(undefined);
	}
	return({ kind: 'checksum', at, representative, gapMilliseconds, completedPass, follower, representativeWindow, verdict });
}

function movingSideOf(value: unknown): MovingSide | undefined {
	if (value === 'representative' || value === 'follower') {
		return(value);
	}
	return(undefined);
}

function representativeReadingOf(value: unknown): RepresentativeReading | undefined {
	if (!isFields(value) || !isString(value['representative'])) {
		return(undefined);
	}
	const { representative, kind, state, staple, detail } = value;
	switch (kind) {
		case 'agrees':
		case 'disagrees':
			if (!isStringOrNull(staple)) {
				return(undefined);
			}
			return({ representative, kind, state, staple });
		case 'unanswered':
		case 'moving':
			if (!isString(detail)) {
				return(undefined);
			}
			return({ representative, kind, detail });
		default:
			return(undefined);
	}
}

function selfCheckOf(value: unknown): SelfCheck | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'consistent':
			if (!isCount(value['tokens'])) {
				return(undefined);
			}
			return({ kind: 'consistent', tokens: value['tokens'] });
		case 'inconsistent': {
			const { token, served, fromHistory } = value;
			if (!isString(token) || !isString(served) || !isString(fromHistory)) {
				return(undefined);
			}
			return({ kind: 'inconsistent', token, served, fromHistory });
		}
		case 'unchecked':
			if (!isString(value['why'])) {
				return(undefined);
			}
			return({ kind: 'unchecked', why: value['why'] });
		default:
			return(undefined);
	}
}

function sweepOutcomeOf(value: unknown): SweepOutcome | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'match':
			if (!isStringOrNull(value['head']) || !isStringOrNull(value['staple'])) {
				return(undefined);
			}
			return({ kind: 'match', head: value['head'], staple: value['staple'] });
		case 'compared-chain': {
			const { head, representativeHead, lacking } = value;
			if (!isString(head) || !isString(representativeHead) || !isCount(lacking)) {
				return(undefined);
			}
			return({ kind: 'compared-chain', head, representativeHead, lacking });
		}
		case 'error-both':
			if (!isString(value['error'])) {
				return(undefined);
			}
			return({ kind: 'error-both', error: value['error'] });
		case 'diverged':
		case 'representative-local':
		case 'unresolved': {
			const divergence = divergenceOf(value['divergence']);
			let readings: readonly RepresentativeReading[] | undefined = [];
			if (value['readings'] !== undefined) {
				readings = listOf(value['readings'], representativeReadingOf);
			}
			const selfCheck = nullable(value['selfCheck'] ?? null, selfCheckOf);
			if (divergence === undefined || readings === undefined || selfCheck === undefined) {
				return(undefined);
			}
			return({ kind: value['kind'], divergence, follower: value['follower'], representative: value['representative'], readings, selfCheck });
		}
		case 'skipped': {
			const detail = value['detail'];
			if (!isString(detail)) {
				return(undefined);
			}
			switch (value['reason']) {
				case 'moving': {
					const side = movingSideOf(value['side']);
					if (side === undefined) {
						return(undefined);
					}
					return({ kind: 'skipped', reason: 'moving', side, detail });
				}
				case 'unanswered':
					return({ kind: 'skipped', reason: 'unanswered', detail });
				default:
					return(undefined);
			}
		}
		default:
			return(undefined);
	}
}

function accountSelfCheckOf(value: unknown): { readonly account: string; readonly check: SelfCheck } | undefined {
	if (!isFields(value) || !isString(value['account'])) {
		return(undefined);
	}
	const check = selfCheckOf(value['check']);
	if (check === undefined) {
		return(undefined);
	}
	return({ account: value['account'], check });
}

function apiSelfCheckOf(value: unknown): APISelfCheck | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'accounts': {
			const checks = listOf(value['checks'], accountSelfCheckOf);
			if (checks === undefined) {
				return(undefined);
			}
			return({ kind: 'accounts', checks });
		}
		case 'none':
			if (!isString(value['why'])) {
				return(undefined);
			}
			return({ kind: 'none', why: value['why'] });
		default:
			return(undefined);
	}
}

function apiDiffReadingOf(value: unknown): APIDiffReading | undefined {
	if (!isFields(value) || !isString(value['representative'])) {
		return(undefined);
	}
	const { representative, kind, answer, detail } = value;
	switch (kind) {
		case 'agrees':
		case 'disagrees':
			return({ representative, kind, answer });
		case 'unanswered':
		case 'moving':
			if (!isString(detail)) {
				return(undefined);
			}
			return({ representative, kind, detail });
		default:
			return(undefined);
	}
}

function stratumPopulationOf(value: unknown): StratumPopulation | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'census': {
			const requests = listOf(value['requests'], textOf);
			if (requests === undefined) {
				return(undefined);
			}
			return({ kind: 'census', requests });
		}
		case 'sample': {
			const { drawn, whole } = value;
			if (!isCount(drawn) || typeof whole !== 'boolean') {
				return(undefined);
			}
			return({ kind: 'sample', drawn, whole });
		}
		default:
			return(undefined);
	}
}

function plannedStratumOf(value: unknown): APIDiffPlanRecord['strata'][number] | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	const stratum = stratumOf(value['stratum']);
	const population = stratumPopulationOf(value['population']);
	if (stratum === undefined || population === undefined) {
		return(undefined);
	}
	return({ stratum, population });
}

function apiDiffPlanRecordOf(value: Fields): APIDiffPlanRecord | undefined {
	const { at, quietBefore, samplesPerStratum } = value;
	const strata = listOf(value['strata'], plannedStratumOf);
	if (!isString(at) || !isString(quietBefore) || !isCount(samplesPerStratum) || strata === undefined) {
		return(undefined);
	}
	return({ kind: 'api-diff-plan', at, quietBefore, samplesPerStratum, strata });
}

/** A triage recorded before triages were checked for a retest names none, and reads as unrecorded. */
function triageRetestOf(value: unknown): TriageRetest | undefined {
	if (value === undefined) {
		return({ kind: 'unrecorded' });
	}
	if (!isFields(value)) {
		return(undefined);
	}
	const { kind, why } = value;
	switch (kind) {
		case 'retested':
		case 'unrecorded':
			return({ kind });
		case 'forced':
			if (!isString(why)) {
				return(undefined);
			}
			return({ kind, why });
		default:
			return(undefined);
	}
}

function apiDiffExplainedRecordOf(value: Fields): APIDiffExplainedRecord | undefined {
	const { at, path, divergenceAt, reference } = value;
	const retest = triageRetestOf(value['retest']);
	const stratum = stratumOf(value['stratum']);
	const divergence = DIVERGENCE_CLASSES.find(function(known): boolean {
		return(known === value['divergence']);
	});
	if (!isString(at) || !isString(path) || !isString(divergenceAt) || !isString(reference) || retest === undefined || stratum === undefined || divergence === undefined) {
		return(undefined);
	}
	return({ kind: 'api-diff-explained', at, stratum, path, divergenceAt, divergence, reference, retest });
}

function apiDiffOutcomeOf(value: unknown): APIDiffOutcome | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'match': {
			const digest = value['digest'] ?? null;
			if (!isStringOrNull(digest)) {
				return(undefined);
			}
			return({ kind: 'match', digest });
		}
		case 'diverged':
		case 'representative-local':
		case 'unresolved': {
			let readings: readonly APIDiffReading[] | undefined = [];
			if (value['readings'] !== undefined) {
				readings = listOf(value['readings'], apiDiffReadingOf);
			}
			const selfCheck = nullable(value['selfCheck'] ?? null, apiSelfCheckOf);
			if (!isString(value['field']) || readings === undefined || selfCheck === undefined) {
				return(undefined);
			}
			return({ kind: value['kind'], field: value['field'], follower: value['follower'], representative: value['representative'], readings, selfCheck });
		}
		case 'skipped': {
			const skipped = sweepOutcomeOf(value);
			if (skipped?.kind !== 'skipped') {
				return(undefined);
			}
			return(skipped);
		}
		default:
			return(undefined);
	}
}

function apiDiffRecordOf(value: Fields): APIDiffRecord | undefined {
	const { at, representative, route, path } = value;
	const stratum = stratumOf(value['stratum']);
	const outcome = apiDiffOutcomeOf(value['outcome']);
	const behaviors = listOf(value['behaviors'], textOf);
	if (!isString(at) || !isString(representative) || !isString(route) || !isString(path) || behaviors === undefined || stratum === undefined || outcome === undefined) {
		return(undefined);
	}
	return({ kind: 'api-diff', at, representative, stratum, route, path, behaviors, outcome });
}

function textOf(value: unknown): string | undefined {
	if (!isString(value)) {
		return(undefined);
	}
	return(value);
}

function shadowRefusalOf(value: unknown): ShadowRefusal | undefined {
	if (!isFields(value) || !isString(value['blocksHash']) || !isString(value['code'])) {
		return(undefined);
	}
	const reason = SHADOW_REFUSAL_REASONS.find(function(known): boolean {
		return(known === value['reason']);
	});
	if (reason === undefined) {
		return(undefined);
	}
	return({ blocksHash: value['blocksHash'], reason, code: value['code'] });
}

function unexplainedShadowRefusalOf(value: unknown): UnexplainedShadowRefusal | undefined {
	if (!isFields(value) || !isString(value['blocksHash']) || !isString(value['code']) || !isString(value['message']) || !isString(value['why'])) {
		return(undefined);
	}
	return({ blocksHash: value['blocksHash'], code: value['code'], message: value['message'], why: value['why'] });
}

function shadowLiveRecordOf(value: Fields): ShadowLiveRecord | undefined {
	const { at, replayed, windowStaples, windowFrom, windowTo, voted } = value;
	const explained = listOf(value['explained'], shadowRefusalOf);
	const unexplained = listOf(value['unexplained'], unexplainedShadowRefusalOf);
	const deferredInWindow = listOf(value['deferredInWindow'], textOf);
	const unappliedBeforeWindow = listOf(value['unappliedBeforeWindow'], textOf);
	const { refusedForWeight } = value;
	if (!isString(at) || !isCount(replayed) || !isCount(windowStaples) || !isStringOrNull(windowFrom) || !isStringOrNull(windowTo) || !isCount(voted) || !isCount(refusedForWeight) || explained === undefined || unexplained === undefined || deferredInWindow === undefined || unappliedBeforeWindow === undefined) {
		return(undefined);
	}
	return({ kind: 'shadow-live', at, replayed, windowStaples, windowFrom, windowTo, voted, explained, unexplained, deferredInWindow, refusedForWeight, unappliedBeforeWindow });
}

function reasonCountsOf(value: unknown): Partial<Record<ShadowRefusalReason, number>> | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	const counts: Partial<Record<ShadowRefusalReason, number>> = {};
	for (const [name, count] of Object.entries(value)) {
		const reason = SHADOW_REFUSAL_REASONS.find(function(known): boolean {
			return(known === name);
		});
		if (reason === undefined || !isCount(count)) {
			return(undefined);
		}
		counts[reason] = count;
	}
	return(counts);
}

function shadowWindowTallyOf(value: unknown): ShadowWindowTally | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	const { replayed, shadowVoted, voted, unexplained, votedFrom, votedTo } = value;
	const explained = reasonCountsOf(value['explained']);
	const firstUnexplained = listOf(value['firstUnexplained'], unexplainedShadowRefusalOf);
	if (!isCount(replayed) || !isCount(shadowVoted) || !isCount(voted) || !isCount(unexplained) || !isStringOrNull(votedFrom) || !isStringOrNull(votedTo) || explained === undefined || firstUnexplained === undefined) {
		return(undefined);
	}
	return({ replayed, shadowVoted, voted, explained, unexplained, firstUnexplained, votedFrom, votedTo });
}

function shadowWindowOf(value: unknown): ShadowWindow | undefined {
	return(SHADOW_WINDOWS.find(function(known): boolean {
		return(known === value);
	}));
}

function shadowVoteOutcomeOf(value: unknown): ShadowVoteOutcome | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'voted':
			return({ kind: 'voted' });
		case 'explained': {
			const reason = SHADOW_REFUSAL_REASONS.find(function(known): boolean {
				return(known === value['reason']);
			});
			if (reason === undefined || !isString(value['code'])) {
				return(undefined);
			}
			return({ kind: 'explained', reason, code: value['code'] });
		}
		case 'unexplained': {
			const { code, message, why } = value;
			if (!isString(code) || !isString(message) || !isString(why)) {
				return(undefined);
			}
			return({ kind: 'unexplained', code, message, why });
		}
		default:
			return(undefined);
	}
}

/** The shadow vote a journal line holds, or nothing when it holds none this version writes. */
export function shadowVoteEntryOf(value: unknown): ShadowVoteEntry | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	const { sequence, blocksHash, votedFrom } = value;
	const window = shadowWindowOf(value['window']);
	const outcome = shadowVoteOutcomeOf(value['outcome']);
	if (!isString(sequence) || !isString(blocksHash) || !isString(votedFrom) || window === undefined || outcome === undefined) {
		return(undefined);
	}
	return({ sequence, blocksHash, window, votedFrom, outcome });
}

function shadowBaseOf(value: unknown): ShadowBase | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	const { database, sequence, blocksHash, scopedStaples } = value;
	if (!isStringOrNull(database) || !isString(sequence) || !isStringOrNull(blocksHash) || !isCount(scopedStaples)) {
		return(undefined);
	}
	return({ database, sequence, blocksHash, scopedStaples });
}

function shadowTargetOf(value: unknown): ShadowTarget | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	const { sequence, fixedAt, followerCaughtUp, heldBefore } = value;
	if (!isString(sequence) || !isString(fixedAt) || typeof followerCaughtUp !== 'boolean' || !isStringOrNull(heldBefore)) {
		return(undefined);
	}
	return({ sequence, fixedAt, followerCaughtUp, heldBefore });
}

function unappliedStapleOf(value: unknown): UnappliedStaple | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	const { sequence, blocksHash, why } = value;
	if (!isString(sequence) || !isString(blocksHash) || (why !== 'voting-weight' && why !== 'deferred')) {
		return(undefined);
	}
	return({ sequence, blocksHash, why });
}

/**
 * The state a run's cursor or record holds, or nothing when it holds none
 * this version writes. Earlier builds also counted the staples they refused
 * for want of voting weight, which no build weighs again, and that count is
 * dropped.
 */
export function shadowRunStateOf(value: unknown): ShadowRunState | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	const { scope, informationalEvery, reached } = value;
	const base = shadowBaseOf(value['base']);
	const target = shadowTargetOf(value['target']);
	const scoped = shadowWindowTallyOf(value['scoped']);
	const informational = shadowWindowTallyOf(value['informational']);
	const unapplied = listOf(value['unapplied'], unappliedStapleOf);
	if (!isFields(scope) || !isString(scope['release']) || !isString(scope['from']) || !isFields(reached) || !isString(reached['sequence']) || !isStringOrNull(reached['blocksHash'])) {
		return(undefined);
	}
	if (!isCount(informationalEvery) || informationalEvery === 0 || base === undefined || target === undefined || scoped === undefined || informational === undefined || unapplied === undefined) {
		return(undefined);
	}
	return({
		scope: { release: scope['release'], from: scope['from'] },
		informationalEvery,
		base,
		target,
		reached: { sequence: reached['sequence'], blocksHash: reached['blocksHash'] },
		scoped,
		informational,
		unapplied
	});
}

function shadowRunCostOf(value: unknown): ShadowRunCost | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	const { seconds, staples, shadowVotes, maxResidentMiB } = value;
	if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || !isCount(staples) || !isCount(shadowVotes) || !isCount(maxResidentMiB)) {
		return(undefined);
	}
	return({ seconds, staples, shadowVotes, maxResidentMiB });
}

function shadowRunRecordOf(value: Fields): ShadowRunRecord | undefined {
	const state = shadowRunStateOf(value);
	const cost = shadowRunCostOf(value['cost']);
	const { at, complete } = value;
	if (state === undefined || cost === undefined || !isString(at) || typeof complete !== 'boolean') {
		return(undefined);
	}
	return({ kind: 'shadow-run', at, ...state, complete, cost });
}

function shadowExplainedRecordOf(value: Fields): ShadowExplainedRecord | undefined {
	const { at, blocksHash, code, replaces } = value;
	const window = shadowWindowOf(value['window']);
	const reason = SHADOW_REFUSAL_REASONS.find(function(known): boolean {
		return(known === value['reason']);
	});
	if (!isString(at) || !isString(blocksHash) || !isString(code) || !isString(replaces) || window === undefined || reason === undefined || value['basis'] !== 'by-rule') {
		return(undefined);
	}
	return({ kind: 'shadow-explained', at, blocksHash, window, code, reason, basis: 'by-rule', replaces });
}

/** A record written before the walks were split names none, and compared every account one at a time. */
function recordedWalkOf(value: unknown): RecordedWalk | undefined {
	switch (value) {
		case undefined:
			return('every');
		case 'chain':
		case 'passive':
		case 'every':
			return(value);
		default:
			return(undefined);
	}
}

function sweepRecordOf(value: Fields): SweepRecord | undefined {
	const { at, representative, account, lap } = value;
	const walk = recordedWalkOf(value['walk']);
	const outcome = sweepOutcomeOf(value['outcome']);
	if (!isString(at) || !isString(representative) || !isString(account) || !isCount(lap) || walk === undefined || outcome === undefined) {
		return(undefined);
	}
	return({ kind: 'sweep', at, representative, account, lap, walk, outcome });
}

function sweepBatchRecordOf(value: Fields): SweepBatchRecord | undefined {
	const { at, representative, lap, afterRowID, throughRowID, accounts, matched, unanswered } = value;
	const skipped = listOf(value['skipped'], textOf);
	if (!isString(at) || !isString(representative) || !isCount(lap) || !isString(afterRowID) || !isString(throughRowID) || !isCount(accounts) || !isCount(matched) || skipped === undefined || !isStringOrNull(unanswered)) {
		return(undefined);
	}
	return({ kind: 'sweep-batch', at, representative, lap, afterRowID, throughRowID, accounts, matched, skipped, unanswered });
}

/** The record a line holds, or nothing when it holds none this version writes. */
export function parityRecordOf(line: string): ParityRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return(undefined);
	}
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'checksum':
			return(checksumRecordOf(value));
		case 'block-count':
			return(blockCountRecordOf(value));
		case 'cross-check':
			return(crossCheckRecordOf(value));
		case 'sweep':
			return(sweepRecordOf(value));
		case 'sweep-batch':
			return(sweepBatchRecordOf(value));
		case 'api-diff':
			return(apiDiffRecordOf(value));
		case 'api-diff-plan':
			return(apiDiffPlanRecordOf(value));
		case 'api-diff-explained':
			return(apiDiffExplainedRecordOf(value));
		case 'shadow-live':
			return(shadowLiveRecordOf(value));
		case 'shadow-run':
			return(shadowRunRecordOf(value));
		case 'shadow-explained':
			return(shadowExplainedRecordOf(value));
		default:
			return(undefined);
	}
}

/** The sweep cursor a stored value holds, or nothing when it holds none. */
export function sweepCursorOf(value: unknown): SweepCursor | undefined {
	return(cursorOf(value));
}

/** Whether the file ends a line, or holds nothing yet. */
async function endsWithLine(path: string): Promise<boolean> {
	let file: FileHandle;
	try {
		file = await open(path, 'r');
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return(true);
		}
		throw(error);
	}
	try {
		const { size } = await file.stat();
		if (size === 0) {
			return(true);
		}
		const last = Buffer.alloc(1);
		await file.read(last, 0, 1, size - 1);
		return(last[0] === LINE_FEED);
	} finally {
		await file.close();
	}
}

const LINE_FEED = 0x0a;

/** Appends whole lines only, so that a crash can cut short at most the last. */
export class ParityLog {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	async append(records: readonly ParityRecord[]): Promise<void> {
		if (records.length === 0) {
			return;
		}
		// After a line a crash cut short, the records start on a line of their own rather than run on from it.
		let separator = '';
		if (!await endsWithLine(this.path)) {
			separator = '\n';
		}
		await appendFile(this.path, separator + records.map(function(record): string {
			return(`${JSON.stringify(record)}\n`);
		}).join(''));
	}

	/** Every record, oldest first; a log not written yet holds none. */
	async read(): Promise<ParityLogContents> {
		let text: string;
		try {
			text = await readFile(this.path, 'utf8');
		} catch (error: unknown) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
				return({ records: [], unreadableLines: 0 });
			}
			throw(error);
		}
		const records: ParityRecord[] = [];
		let unreadableLines = 0;
		for (const line of text.split('\n')) {
			if (line === '') {
				continue;
			}
			const record = parityRecordOf(line);
			if (record === undefined) {
				unreadableLines++;
				continue;
			}
			records.push(record);
		}
		return({ records, unreadableLines });
	}
}

