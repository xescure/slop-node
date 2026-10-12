import { assertNever } from '../util/assert-never.js';
import { API_DIFF_SAMPLES_TARGET, followerDivergesOn, keyOf, requestStandings, routeAttemptsOf, routeUncovered, sampleAPI, standingCensuses, standsOnExplanation } from './api-diff.js';
import type { ExplainedDivergence, RequestStanding, RouteAttempts, SupersededDivergence } from './api-diff.js';
import type { APIDiffSetup } from './api-diff.js';
import type { APISource } from './api-source.js';
import { checksumsEqual, compareChecksums, crossCheckChecksum, heldBackRecordOf, heldStill } from './checksum.js';
import type { FollowerProgress, FollowerStore, HeldBack, KnownAccount } from './follower-store.js';
import { REPORT_REFUSED_AFTER_MILLISECONDS } from '../node/bootstrap-retry.js';
import { SHADOW_REFUSAL_REASONS, SHADOW_REFUSAL_RELEASES } from '../conformance/mainnet/shadow.js';
import type { ShadowRefusalReason } from '../conformance/mainnet/shadow.js';
import { standsDiverging, standsInPlaceOf, UNEXPLAINED_LISTED } from './log.js';
import type { APIDiffExplainedRecord, APIDiffOutcome, APIDiffPlanRecord, APIDiffRecord, BlockCountNotComparableReason, BlockCountRecord, ChecksumRecord, CrossCheckRecord, Divergence, HeldBackRecord, ParityLog, ParityLogContents, ParityRecord, ShadowBase, ShadowExplainedRecord, ShadowRunCost, ShadowRunRecord, ShadowRunState, ShadowTarget, ShadowWindow, ShadowWindowTally, UnexplainedShadowRefusal, SweepBatchRecord, SweepCursor, SweepOutcome, SweepRecord, SweepWalk } from './log.js';
import { shadowRunComplete } from './shadow-live.js';
import { STRATA } from './strata.js';
import type { Stratum } from './strata.js';
import { readSweepCursor, sweepAccounts } from './sweep.js';
import type { NeverCompared, SweepCursorPaths } from './sweep.js';
import { isoOrNull } from './values.js';

/** A signal's verdict. */
export type Verdict = 'pass' | 'fail' | 'not-comparable-yet';

/** Why a signal whose comparisons found no divergence does not pass yet. */
export type CoverageReason =
	/** Nothing was compared. */
	| 'no-sample'
	/** The sweep has not compared every account the follower knows. */
	| 'coverage-incomplete'
	/** The API diff has not covered every stratum. */
	| 'strata-uncovered'
	/** The log holds lines it could not read, which may have been records. */
	| 'log-unreadable';

/** What the comparisons support about how often a signal diverges. */
export type ConfidenceBound =
	/**
	 * No divergence in so many samples: by the rule of three, the rate of
	 * divergence is below 3 in that many, at 95% confidence.
	 */
	| { readonly kind: 'rule-of-three'; readonly samples: number; readonly level: 0.95; readonly divergenceRateBelow: number }
	/** Divergences were found, so the rate is at least what was seen and no bound below it holds. */
	| { readonly kind: 'observed'; readonly samples: number; readonly divergences: number }
	/** A comparison of the whole ledger, not a sample of it. */
	| { readonly kind: 'not-sampled' }
	/** Every request of the population was compared, and none diverged. */
	| { readonly kind: 'census'; readonly requests: number }
	/** The population holds no request at all, so nothing live was compared and the stratum needs offline evidence. */
	| { readonly kind: 'empty-population' }
	| { readonly kind: 'none'; readonly why: string };

/** The first divergence a signal holds, with the staple and account to start from where it names them. */
export type FirstDivergence = Divergence & {
	readonly at: string;
	/** The representative compared with, or null for a check of the follower against itself. */
	readonly representative: string | null;
};

export type CrossCheckPart = {
	readonly verdict: Verdict;
	readonly runs: number;
	/** The latest cross-check, which the verdict is of. */
	readonly latest: CrossCheckRecord | null;
};

export type BlockCountPart = {
	readonly verdict: Verdict;
	readonly counts: { readonly comparisons: number; readonly comparable: number; readonly passed: number; readonly failed: number };
	/** Why the latest comparisons did not count. */
	readonly notComparableReasons: readonly BlockCountNotComparableReason[];
};

/**
 * The representatives' checksums, which are statistics of their own nodes
 * and differ among them (conformance/API.md, Differences), so they inform
 * and decide nothing.
 */
export type RepresentativeChecksums = {
	readonly comparisons: number;
	/** Comparisons in which the follower and the representative held still and served the same checksum. */
	readonly agreeing: number;
	/** How many different checksums the representatives that held still served in the latest run. */
	readonly distinctInLatestRun: number;
};

/**
 * What keeps the follower from being caught up once its stage is empty: a
 * staple the ledger has refused for longer than the node waits before it
 * reports it, or one deferred behind a block no representative served in as
 * long, is the follower's divergence, which no comparison gated on its being
 * caught up would ever show; one held back for less is not decided yet.
 */
export type HeldBackPart = {
	readonly verdict: Verdict;
	readonly queued: number;
	readonly stranded: number;
	readonly refusedForGood: readonly { readonly key: string; readonly code: string | null; readonly queuedAt: string }[];
	/** Each with the earliest checksum comparison from which on every one found it stranded. */
	readonly strandedForGood: readonly { readonly blocksHash: string; readonly lacks: readonly string[]; readonly strandedSince: string }[];
};

export type ChecksumSignal = {
	readonly verdict: Verdict;
	readonly notComparableReasons: readonly CoverageReason[];
	/** The follower's stored checksum against the XOR of its main blocks. */
	readonly crossCheck: CrossCheckPart;
	readonly heldBack: HeldBackPart;
	/** The follower's block count against the representatives'. */
	readonly blockCount: BlockCountPart;
	readonly representativeChecksums: RepresentativeChecksums;
	readonly confidence: ConfidenceBound;
	readonly firstDivergence: FirstDivergence | null;
};

/** One lap of a walk of the sweep, each account counted by its latest attempt in the lap. */
export type WalkLap = {
	readonly lap: number;
	/** Whether the walk has gone past the last account of the lap. */
	readonly complete: boolean;
	readonly walked: number;
	readonly compared: number;
	readonly diverged: number;
	/** Accounts not compared in the lap: found moving, unanswered, or answered with the same error by both. */
	readonly skipped: number;
	/**
	 * Accounts of the walk the lap did not compare. For the chain walk, every
	 * account with a chain now that has no comparison in the lap, but for
	 * one whose newest staple is from after the lap's last comparison, which
	 * may have gained its chain since; for the passive walk, those skipped.
	 */
	readonly notCompared: number;
};

export type WalkCoverage = {
	readonly cursor: SweepCursor;
	readonly laps: readonly WalkLap[];
};

/** How much of what the follower knows the sweep has compared. */
export type SweepCoverage = {
	readonly knownAccounts: number;
	/** Accounts with a chain on the follower's main ledger, which the chain walk goes over; the passive walk goes over the rest. */
	readonly chainAccounts: number;
	readonly walks: Readonly<Record<SweepWalk, WalkCoverage>>;
	/**
	 * Accounts never compared: an account with a chain now without a
	 * comparison by itself in the chain walk, but for one that may have
	 * gained its chain since the last complete lap; a passive account every
	 * attempt at skipped, which no batch over its row compared since.
	 */
	readonly neverCompared: number;
	/** Of those, the accounts with a chain. */
	readonly neverComparedChain: number;
	/** The first of them, to start from. */
	readonly firstNeverCompared: readonly string[];
	/** Both walks have gone past every account at least once, and every account they went past was compared at least once. */
	readonly everyAccountCompared: boolean;
};

/**
 * Accounts the representatives apart answered apart, at least two answering
 * as the follower and every other value fewer, borne out by a check of the
 * follower's balances: an artifact of those representatives' own nodes.
 */
export type RepresentativeLocal = {
	readonly records: number;
	/** Accounts whose latest comparison is one. */
	readonly accounts: number;
	readonly byRepresentative: Readonly<Record<string, number>>;
	readonly first: FirstDivergence | null;
};

export type SweepSignal = {
	readonly verdict: Verdict;
	readonly notComparableReasons: readonly CoverageReason[];
	readonly counts: {
		/** Accounts compared by themselves at least once, each counted by its latest comparison; the passive walk's batch matches are in the coverage. */
		readonly accountsCompared: number;
		readonly matched: number;
		/** Accounts the follower disagrees with most representatives about, or that they split on, which fail the sweep. */
		readonly diverged: number;
		/** Of those, the ones the representatives split on. */
		readonly unresolved: number;
		/** Of those compared, the chain accounts moving on every attempt, compared by their chains only, which are neither among those matched nor among the samples. */
		readonly comparedByChain: number;
		/** Accounts never compared, whose latest attempt found them moving. */
		readonly skippedMoving: number;
		/** Accounts never compared, whose latest attempt went unanswered, by themselves or in a batch. */
		readonly unanswered: number;
		/** Accounts never compared, whose latest attempt found both answering the same error in a batch. */
		readonly errorBoth: number;
		/** Accounts that diverged once and matched later. */
		readonly resolvedDivergences: number;
		/** Every divergence recorded, each to be explained. */
		readonly divergenceRecords: number;
	};
	readonly coverage: SweepCoverage;
	/** Differences of one representative's own, which decide nothing about the follower. */
	readonly representativeLocal: RepresentativeLocal;
	/** Over the accounts compared by themselves and those the passive walk's batches matched, each batch of rows counted once. */
	readonly confidence: ConfidenceBound;
	readonly firstDivergence: FirstDivergence | null;
};

/** Why shadow votes do not decide yet. */
export type ShadowNotComparableReason =
	| 'no-run'
	/** The latest run has not replayed up to its target yet. */
	| 'run-incomplete'
	/** The target was fixed before the follower held every staple voted for before its reach, so the window may lack some. */
	| 'follower-not-caught-up'
	/** The run started from a snapshot holding staples of the scoped window, which it cannot put to a vote. */
	| 'base-within-window'
	/** The run met no staple of the scoped window. */
	| 'window-empty'
	/** The log holds lines it could not read, which may have been records. */
	| 'log-unreadable';

/**
 * A window's refusals by the classified difference that explains them, with
 * the release that changed the rule, as the run explained them; those
 * explained since by the rule alone apart; and the refusals left that none
 * explains.
 */
export type ShadowWindowSummary = Omit<ShadowWindowTally, 'explained' | 'firstUnexplained'> & {
	readonly explained: Readonly<Partial<Record<ShadowRefusalReason, { readonly refusals: number; readonly changedIn: string | null }>>>;
	readonly explainedByRule: readonly { readonly blocksHash: string; readonly reason: ShadowRefusalReason; readonly code: string }[];
};

/**
 * The latest run of the resumable shadow votes: the scoped window decides,
 * every staple of it voted on; the informational window is counted apart.
 */
export type ShadowVotesSignal = {
	readonly verdict: Verdict;
	readonly runs: number;
	readonly notComparableReasons: readonly ShadowNotComparableReason[];
	readonly latest: {
		/** When the invocation that recorded the standing ended, or null for one read from the run's cursor, still running or cut short. */
		readonly at: string | null;
		readonly scope: { readonly release: string; readonly from: string };
		readonly base: ShadowBase;
		readonly target: ShadowTarget;
		readonly reached: string;
		readonly complete: boolean;
		readonly scoped: ShadowWindowSummary;
		readonly informational: ShadowWindowSummary & { readonly every: number };
		readonly unapplied: number;
		readonly cost: ShadowRunCost | null;
	} | null;
	/** Of the refusals in the scoped window that no classified difference explains. */
	readonly confidence: ConfidenceBound;
	readonly firstDivergence: { readonly at: string | null; readonly staple: string | null; readonly code: string; readonly why: string } | null;
};

/** The census a stratum stands on: its every request, and how many of them were compared. */
export type APIDiffCensus = {
	readonly requests: number;
	readonly compared: number;
	readonly plannedAt: string;
};

/** A route's requests in a stratum: those compared, and those attempted and never compared. */
export type APIDiffRouteCoverage = {
	readonly route: string;
	readonly compared: number;
	readonly neverCompared: number;
};

/** Each stratum's requests, each counted by its latest comparison. */
export type APIDiffStratum = {
	readonly stratum: Stratum;
	/** Requests whose latest comparison is no divergence a triage explains: the samples its confidence bound is over. */
	readonly requestsCompared: number;
	/** Requests whose latest comparison is a divergence a triage explains, which are no sample until compared again. */
	readonly standingOnExplanation: number;
	/** Requests with a divergence no later comparison settled: the follower's, or one the representatives split on. */
	readonly diverged: number;
	/** Requests the representatives apart answered apart from the follower and at least two others. */
	readonly representativeLocal: number;
	readonly census: APIDiffCensus | null;
	/** Requests never compared, by their route and why their latest attempt was not. */
	readonly skippedByRoute: Readonly<Record<string, { readonly moving: number; readonly unanswered: number }>>;
	/** Routes of the stratum more than a tenth of whose requests attempted were never compared, the largest share first. */
	readonly routesUncovered: readonly APIDiffRouteCoverage[];
	/** Whether so many requests were compared as the done criterion asks, or the census is complete, and no route is uncovered. */
	readonly covered: boolean;
	readonly confidence: ConfidenceBound;
};

export type { ExplainedDivergence, SupersededDivergence };

export type APIDiffSignal = {
	readonly verdict: Verdict;
	readonly notComparableReasons: readonly CoverageReason[];
	readonly strata: readonly APIDiffStratum[];
	readonly counts: {
		/** Requests whose latest comparison is no divergence a triage explains. */
		readonly requestsCompared: number;
		readonly matched: number;
		/** Requests whose latest comparison is a divergence a triage explains, counted neither as matched nor as a sample until compared again. */
		readonly standingOnExplanation: number;
		readonly diverged: number;
		/** Requests never compared, whose latest attempt found an account they read moving, or went unanswered. */
		readonly skippedMoving: number;
		readonly unanswered: number;
		/** Of the diverging requests, those the representatives split on. */
		readonly unresolved: number;
		readonly representativeLocal: number;
		/** Every divergence recorded, each to be explained. */
		readonly divergenceRecords: number;
		/** Divergences a later comparison of the identical request settled, the follower answering as the representative then did. */
		readonly superseded: number;
		/** Divergences a triage record explains. */
		readonly explained: number;
	};
	/** Requests compared per stratum for its rate of divergence to be below 1% at 95%, by the rule of three. */
	readonly samplesTarget: number;
	readonly everyStratumCovered: boolean;
	/** The requests whose latest comparison left the difference to the representatives apart, by each of them. */
	readonly representativeLocal: Readonly<Record<string, number>>;
	readonly superseded: readonly SupersededDivergence[];
	/** Divergences of a state that moved on, closed by a triage record that names their class and fix. */
	readonly explained: readonly ExplainedDivergence[];
	/** Open divergences whose request a later comparison answered on another state, which settles nothing; each with that comparison. */
	readonly retestedOnAnotherState: readonly { readonly divergence: APIDiffRecord; readonly by: APIDiffRecord }[];
	/** Answers of a kind the capture set holds none of, each with a request that drew it, to be captured. */
	readonly newBehaviors: readonly { readonly behavior: string; readonly path: string }[];
	readonly firstDivergence: { readonly at: string; readonly representative: string; readonly stratum: Stratum; readonly path: string; readonly field: string } | null;
};

export type ParityReport = {
	readonly generatedAt: string;
	readonly follower: { readonly completedPass: string | null; readonly heldBefore: string | null; readonly staged: number };
	readonly logUnreadableLines: number;
	readonly signals: {
		readonly checksum: ChecksumSignal;
		readonly sweep: SweepSignal;
		readonly apiDiff: APIDiffSignal;
		readonly shadowVotes: ShadowVotesSignal;
	};
};

/** The 95% bound of the rule of three. */
const RULE_OF_THREE = 3;


/** The records of the latest run: those written at the time of the last. */
function latestRun<Record extends { readonly at: string }>(records: readonly Record[]): readonly Record[] {
	const latestAt = records.at(-1)?.at;
	return(records.filter(function(record): boolean {
		return(record.at === latestAt);
	}));
}

function representativeChecksumsOf(records: readonly ChecksumRecord[]): RepresentativeChecksums {
	const agreeing = records.filter(function(record): boolean {
		return(heldStill(record.follower) && heldStill(record.representativeWindow) && checksumsEqual(record.follower.second.checksum, record.representativeWindow.second.checksum));
	});
	const distinct = new Set<bigint>();
	for (const record of latestRun(records)) {
		if (heldStill(record.representativeWindow)) {
			distinct.add(BigInt(record.representativeWindow.second.checksum));
		}
	}
	return({ comparisons: records.length, agreeing: agreeing.length, distinctInLatestRun: distinct.size });
}

/**
 * The latest cross-check decides: the stored checksum is written with the
 * staples it covers, so only one equal to the fold passes. A record of an
 * earlier build, which kept it apart from the ledger, passed when the
 * staples it named explained the difference; it fails now, since this
 * build's next cross-check replaces it.
 */
function crossCheckPartOf(records: readonly CrossCheckRecord[]): CrossCheckPart {
	const latest = records.at(-1) ?? null;
	if (latest === null) {
		return({ verdict: 'not-comparable-yet', runs: 0, latest });
	}
	switch (latest.outcome.kind) {
		case 'equal':
			return({ verdict: 'pass', runs: records.length, latest });
		case 'differs':
		case 'unsynced':
		case 'lost-run':
		case 'unexplained':
			return({ verdict: 'fail', runs: records.length, latest });
		default:
			return(assertNever(latest.outcome));
	}
}

/** The latest run decides: it fails when the follower's count is beyond the tolerance of any representative's, and passes when it is within that of every one that counted. */
function blockCountPartOf(records: readonly BlockCountRecord[]): BlockCountPart {
	const comparable = records.filter(function(record): boolean {
		return(record.verdict.kind !== 'not-comparable-yet');
	});
	const failed = comparable.filter(function(record): boolean {
		return(record.verdict.kind === 'fail');
	}).length;
	const counts = { comparisons: records.length, comparable: comparable.length, passed: comparable.length - failed, failed };
	const latest = latestRun(records);
	const notComparableReasons = [...new Set(latest.flatMap(function(record): readonly BlockCountNotComparableReason[] {
		if (record.verdict.kind !== 'not-comparable-yet') {
			return([]);
		}
		return(record.verdict.reasons);
	}))];
	let verdict: Verdict = 'not-comparable-yet';
	if (latest.some(function(record): boolean {
		return(record.verdict.kind === 'fail');
	})) {
		verdict = 'fail';
	} else if (latest.some(function(record): boolean {
		return(record.verdict.kind === 'pass');
	})) {
		verdict = 'pass';
	}
	return({ verdict, counts, notComparableReasons });
}

/** A failing part fails the signal, and it passes only when both parts pass. */
function combined(left: Verdict, right: Verdict): Verdict {
	if (left === 'fail' || right === 'fail') {
		return('fail');
	}
	if (left === 'pass' && right === 'pass') {
		return('pass');
	}
	return('not-comparable-yet');
}

/** Since when every reading from the first that listed the staple on, the current one included, has listed it stranded. */
function strandedSince(blocksHash: string, readings: readonly HeldBackRecord[]): string | undefined {
	let since: string | undefined;
	for (const reading of readings) {
		const listed = reading.stranded.some(function(staple): boolean {
			return(staple.blocksHash === blocksHash);
		});
		if (!listed) {
			since = undefined;
		} else {
			since ??= reading.at;
		}
	}
	return(since);
}

function heldBackPartOf(records: readonly HeldBackRecord[], now: HeldBack, at: Date): HeldBackPart {
	const readings = [...records, { kind: 'held-back', at: at.toISOString(), ...now } as const];
	const longAgo = at.valueOf() - REPORT_REFUSED_AFTER_MILLISECONDS;
	const refusedForGood = now.queued.filter(function(staple): boolean {
		return(Date.parse(staple.queuedAt) <= longAgo);
	});
	const strandedForGood = now.stranded.flatMap(function(staple): HeldBackPart['strandedForGood'] {
		const since = strandedSince(staple.blocksHash, readings);
		if (since === undefined || Date.parse(since) > longAgo) {
			return([]);
		}
		return([{ blocksHash: staple.blocksHash, lacks: staple.lacks, strandedSince: since }]);
	});
	let verdict: Verdict = 'pass';
	if (refusedForGood.length > 0 || strandedForGood.length > 0) {
		verdict = 'fail';
	} else if (now.queued.length > 0 || now.stranded.length > 0) {
		verdict = 'not-comparable-yet';
	}
	return({ verdict, queued: now.queued.length, stranded: now.stranded.length, refusedForGood, strandedForGood });
}

function checksumSignalOf(records: readonly ParityRecord[], now: HeldBack, at: Date): ChecksumSignal {
	const crossCheck = crossCheckPartOf(recordsOf(records, 'cross-check'));
	const heldBack = heldBackPartOf(recordsOf(records, 'held-back'), now, at);
	const blockCounts = recordsOf(records, 'block-count');
	const blockCount = blockCountPartOf(blockCounts);
	let firstDivergence: FirstDivergence | null = null;
	const latestCrossCheck = crossCheck.latest;
	const failedCount = latestRun(blockCounts).find(function(record): boolean {
		return(record.verdict.kind === 'fail');
	});
	if (crossCheck.verdict === 'fail' && latestCrossCheck !== null) {
		firstDivergence = { at: latestCrossCheck.at, representative: null, account: '', field: 'ledgerChecksum', staple: null };
	} else if (failedCount !== undefined) {
		firstDivergence = { at: failedCount.at, representative: failedCount.representative, account: '', field: 'blockCount', staple: null };
	}
	const [refused] = heldBack.refusedForGood;
	const [stranded] = heldBack.strandedForGood;
	if (firstDivergence === null && refused !== undefined) {
		firstDivergence = { at: at.toISOString(), representative: null, account: '', field: `retryQueue: refused since ${refused.queuedAt} with ${refused.code ?? 'no code'}`, staple: refused.key };
	} else if (firstDivergence === null && stranded !== undefined) {
		firstDivergence = { at: at.toISOString(), representative: null, account: '', field: `strandedDeferred: lacking ${stranded.lacks.join(', ')} since ${stranded.strandedSince}`, staple: stranded.blocksHash };
	}
	return({
		verdict: combined(combined(crossCheck.verdict, blockCount.verdict), heldBack.verdict),
		notComparableReasons: [],
		crossCheck,
		heldBack,
		blockCount,
		representativeChecksums: representativeChecksumsOf(recordsOf(records, 'checksum')),
		confidence: { kind: 'not-sampled' },
		firstDivergence
	});
}

/** Whether the outcome counts against the follower: it disagrees with most representatives, or they split. */
export function followerDiverged(outcome: SweepOutcome): boolean {
	return(outcome.kind === 'diverged' || outcome.kind === 'unresolved');
}


/** Whether the account was compared: an outcome other than a skip or an error both sides answered. */
export function wasCompared(outcome: SweepOutcome): boolean {
	return(outcome.kind !== 'skipped' && outcome.kind !== 'error-both');
}

/** Each account's latest comparison, and its latest record of any kind, in the order the accounts were first seen. */
function latestByAccount(records: readonly SweepRecord[]): { readonly compared: Map<string, SweepRecord>; readonly attempted: Map<string, SweepRecord>; readonly everDiverged: Set<string> } {
	const compared = new Map<string, SweepRecord>();
	const attempted = new Map<string, SweepRecord>();
	const everDiverged = new Set<string>();
	for (const record of records) {
		attempted.set(record.account, record);
		if (followerDiverged(record.outcome)) {
			everDiverged.add(record.account);
		}
		if (wasCompared(record.outcome) && standsInPlaceOf(record.outcome, compared.get(record.account)?.outcome)) {
			compared.set(record.account, record);
		}
	}
	return({ compared, attempted, everDiverged });
}

/** The latest batch over each span of rows in each lap, which a crash in a batch makes the sweep walk again. */
function latestBatches(batches: readonly SweepBatchRecord[]): readonly SweepBatchRecord[] {
	const latest = new Map<string, SweepBatchRecord>();
	for (const batch of batches) {
		latest.set(`${String(batch.lap)} ${batch.afterRowID} ${batch.throughRowID}`, batch);
	}
	return([...latest.values()]);
}

/** The accounts the log names as not compared and never compared since, in the order first named: candidates for the rows the batches cover. */
export function neverComparedCandidatesOf(records: readonly ParityRecord[]): readonly string[] {
	const candidates = new Set<string>();
	const compared = new Set<string>();
	for (const record of records) {
		switch (record.kind) {
			case 'sweep':
				if (wasCompared(record.outcome)) {
					compared.add(record.account);
				} else {
					candidates.add(record.account);
				}
				break;
			case 'sweep-batch':
				for (const account of record.skipped) {
					candidates.add(account);
				}
				break;
			default:
				break;
		}
	}
	return([...candidates].filter(function(account): boolean {
		return(!compared.has(account));
	}));
}

/** A batch's span of rows, as numbers: after the first, through the last. */
type BatchSpan = { readonly after: bigint; readonly through: bigint; readonly skipped: ReadonlySet<string> };

/** Within a lap the batches' spans follow one another without overlapping, so the one holding a row is found by halving. */
function spanHolding(spans: readonly BatchSpan[], row: bigint): BatchSpan | undefined {
	let low = 0;
	let high = spans.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const span = spans[middle];
		if (span === undefined || span.through >= row) {
			high = middle;
		} else {
			low = middle + 1;
		}
	}
	const found = spans[low];
	if (found === undefined || found.after >= row) {
		return(undefined);
	}
	return(found);
}

/**
 * The passive candidates no batch compared: one compared an account when it
 * went over its row and did not name it as skipped. An account passive now
 * was passive whenever a batch went over its row, since an account never
 * loses its chain. An account the follower names no row for is never
 * compared.
 */
function passiveNeverComparedOf(candidates: readonly string[], batches: readonly SweepBatchRecord[], rowIDs: ReadonlyMap<string, string>): readonly string[] {
	const laps = new Map<number, BatchSpan[]>();
	for (const batch of batches) {
		const spans = laps.get(batch.lap) ?? [];
		spans.push({ after: BigInt(batch.afterRowID), through: BigInt(batch.throughRowID), skipped: new Set(batch.skipped) });
		laps.set(batch.lap, spans);
	}
	for (const spans of laps.values()) {
		spans.sort(function(left, right): number {
			return(Number(left.through - right.through));
		});
	}
	return(candidates.filter(function(account): boolean {
		const rowID = rowIDs.get(account);
		if (rowID === undefined) {
			return(true);
		}
		const row = BigInt(rowID);
		return(![...laps.values()].some(function(spans): boolean {
			const span = spanHolding(spans, row);
			return(span !== undefined && !span.skipped.has(account));
		}));
	}));
}

/** Each lap of the chain walk, by the records written in it. */
type ChainLapRecords = { readonly lap: number; readonly latest: ReadonlyMap<string, SweepRecord>; readonly lastAt: string };

function chainLapRecordsOf(records: readonly SweepRecord[]): readonly ChainLapRecords[] {
	const laps = new Map<number, { latest: Map<string, SweepRecord>; lastAt: string }>();
	for (const record of records) {
		if (record.walk !== 'chain') {
			continue;
		}
		const lap = laps.get(record.lap) ?? { latest: new Map<string, SweepRecord>(), lastAt: record.at };
		lap.latest.set(record.account, record);
		if (record.at > lap.lastAt) {
			lap.lastAt = record.at;
		}
		laps.set(record.lap, lap);
	}
	return([...laps].sort(function([left], [right]): number {
		return(left - right);
	}).map(function([lap, { latest, lastAt }]): ChainLapRecords {
		return({ lap, latest, lastAt });
	}));
}

/**
 * Whether the account may have gained its chain after the lap: the lap,
 * whose end compares every account with a chain it did not walk, holds no
 * record of it, and the follower holds a staple of it from after the lap's
 * last record. An account the lap attempted had its chain then, however
 * recently a staple touched it since.
 */
function chainedAfter(known: KnownAccount, lap: ChainLapRecords): boolean {
	return(!lap.latest.has(known.account) && known.newestStaple !== undefined && known.newestStaple.getTime() > Date.parse(lap.lastAt));
}

/** The chain accounts known now that the lap did not compare, but for those that may have gained their chain after it. */
function chainNotComparedIn(lap: ChainLapRecords, chainAccounts: readonly KnownAccount[]): number {
	return(chainAccounts.filter(function(known): boolean {
		const record = lap.latest.get(known.account);
		return((record === undefined || !wasCompared(record.outcome)) && !chainedAfter(known, lap));
	}).length);
}

/** Each lap of the chain walk, every account counted by its latest record in the lap. */
function chainLapsOf(laps: readonly ChainLapRecords[], cursor: SweepCursor, chainAccounts: readonly KnownAccount[]): readonly WalkLap[] {
	return(laps.map(function(lap): WalkLap {
		const latest = [...lap.latest.values()];
		const diverged = latest.filter(function(record): boolean {
			return(followerDiverged(record.outcome));
		}).length;
		const compared = latest.filter(function(record): boolean {
			return(wasCompared(record.outcome));
		}).length;
		return({ lap: lap.lap, complete: lap.lap < cursor.lap, walked: latest.length, compared, diverged, skipped: latest.length - compared, notCompared: chainNotComparedIn(lap, chainAccounts) });
	}));
}

/** Each lap of the passive walk, by its batches, with the accounts diverging by their latest record in the lap. */
function passiveLapsOf(records: readonly SweepRecord[], batches: readonly SweepBatchRecord[], cursor: SweepCursor): readonly WalkLap[] {
	const laps = new Map<number, { walked: number; skipped: number; latest: Map<string, SweepRecord> }>();
	const lapOf = function(lap: number) {
		const found = laps.get(lap) ?? { walked: 0, skipped: 0, latest: new Map<string, SweepRecord>() };
		laps.set(lap, found);
		return(found);
	};
	for (const batch of batches) {
		const lap = lapOf(batch.lap);
		lap.walked += batch.accounts;
		lap.skipped += batch.skipped.length;
	}
	for (const record of records) {
		if (record.walk === 'passive') {
			lapOf(record.lap).latest.set(record.account, record);
		}
	}
	return([...laps].sort(function([left], [right]): number {
		return(left - right);
	}).map(function([lap, tally]): WalkLap {
		const diverged = [...tally.latest.values()].filter(function(record): boolean {
			return(followerDiverged(record.outcome));
		}).length;
		return({ lap, complete: lap < cursor.lap, walked: tally.walked, compared: tally.walked - tally.skipped, diverged, skipped: tally.skipped, notCompared: tally.skipped });
	}));
}

/**
 * Who is never compared. A chain account counts by its comparisons by
 * itself in the chain walk (or the walk over every account before it) only,
 * since the passive walk's batches went over its row while it may have had
 * a chain; one the last complete lap of the chain walk holds no record of,
 * whose newest staple is from after that lap ended, may have gained its
 * chain since, and waits for the next lap. A passive account counts by any
 * comparison by itself, or by a batch over its row.
 */
function neverComparedOf(records: readonly SweepRecord[], batches: readonly SweepBatchRecord[], position: SweepPosition, chainLaps: readonly ChainLapRecords[], candidates: readonly string[]): { readonly chain: readonly string[]; readonly passive: readonly string[] } {
	const comparedInChainWalk = new Set<string>();
	for (const record of records) {
		if (record.walk !== 'passive' && wasCompared(record.outcome)) {
			comparedInChainWalk.add(record.account);
		}
	}
	const lastComplete = chainLaps.filter(function(lap): boolean {
		return(lap.lap < position.cursors.chain.lap);
	}).at(-1);
	const chain = position.chainAccounts.filter(function(known): boolean {
		return(!comparedInChainWalk.has(known.account) && (lastComplete === undefined || !chainedAfter(known, lastComplete)));
	}).map(function(known): string {
		return(known.account);
	});
	const chainSet = new Set(position.chainAccounts.map(function(known): string {
		return(known.account);
	}));
	const passive = passiveNeverComparedOf(candidates.filter(function(account): boolean {
		return(!chainSet.has(account));
	}), batches, position.rowIDs);
	return({ chain, passive });
}

/** How many accounts never compared the report names. */
const FIRST_NEVER_COMPARED_LISTED = 10;

function sweepCoverageOf(records: readonly SweepRecord[], batches: readonly SweepBatchRecord[], position: SweepPosition, neverCompared: { readonly chain: readonly string[]; readonly passive: readonly string[] }, chainLaps: readonly ChainLapRecords[]): SweepCoverage {
	const all = [...neverCompared.chain, ...neverCompared.passive];
	const walks = {
		chain: { cursor: position.cursors.chain, laps: chainLapsOf(chainLaps, position.cursors.chain, position.chainAccounts) },
		passive: { cursor: position.cursors.passive, laps: passiveLapsOf(records, batches, position.cursors.passive) }
	};
	const lapped = position.cursors.chain.lap > 0 && position.cursors.passive.lap > 0;
	return({
		knownAccounts: position.knownAccounts,
		chainAccounts: position.chainAccounts.length,
		walks,
		neverCompared: all.length,
		neverComparedChain: neverCompared.chain.length,
		firstNeverCompared: all.slice(0, FIRST_NEVER_COMPARED_LISTED),
		everyAccountCompared: lapped && all.length === 0
	});
}

/**
 * How many differences left to the representatives apart each is charged
 * with: every representative that answered apart from the follower and the
 * others, the one compared with included.
 */
function chargedByRepresentative(differences: readonly { readonly representative: string; readonly outcome: SweepOutcome | APIDiffOutcome }[]): Record<string, number> {
	const charged: Record<string, number> = {};
	for (const { representative, outcome } of differences) {
		if (outcome.kind !== 'representative-local') {
			continue;
		}
		const readings: readonly { readonly representative: string; readonly kind: string }[] = outcome.readings;
		const dissenting = [representative, ...readings.filter(function(reading): boolean {
			return(reading.kind === 'disagrees');
		}).map(function(reading): string {
			return(reading.representative);
		})];
		for (const dissenter of dissenting) {
			charged[dissenter] = (charged[dissenter] ?? 0) + 1;
		}
	}
	return(charged);
}

/** The accounts whose latest comparison left the difference to the representatives apart, by each of them, with the first such record. */
function representativeLocalOf(records: readonly SweepRecord[], localNow: readonly SweepRecord[]): RepresentativeLocal {
	const byRepresentative = chargedByRepresentative(localNow);
	const accounts = new Set(localNow.map(function(record): string {
		return(record.account);
	}));
	const first = records.find(function(record): boolean {
		return(record.outcome.kind === 'representative-local' && accounts.has(record.account));
	});
	let firstExample: FirstDivergence | null = null;
	if (first !== undefined && first.outcome.kind === 'representative-local') {
		firstExample = { ...first.outcome.divergence, at: first.at, representative: first.representative };
	}
	const recorded = records.filter(function(record): boolean {
		return(record.outcome.kind === 'representative-local');
	}).length;
	return({ records: recorded, accounts: localNow.length, byRepresentative, first: firstExample });
}

/**
 * The passive walk's batch matches among the samples: each lap's, every span
 * once, and of the laps the one that matched most, since every lap goes
 * over the same accounts.
 */
type RowSpan = { readonly after: bigint; readonly through: bigint };

/**
 * The batches of each lap that count, the latest first: a batch over rows
 * a batch recorded later went over too, as a resume parts the rows again,
 * is left out, so that no account is counted twice.
 */
function distinctBatchesOf(batches: readonly SweepBatchRecord[]): ReadonlyMap<number, { readonly matched: number; readonly spans: readonly RowSpan[] }> {
	const laps = new Map<number, { matched: number; spans: RowSpan[] }>();
	for (const batch of [...batches].reverse()) {
		const span = { after: BigInt(batch.afterRowID), through: BigInt(batch.throughRowID) };
		const lap = laps.get(batch.lap) ?? { matched: 0, spans: [] };
		const overlaps = lap.spans.some(function(other): boolean {
			return(span.after < other.through && other.after < span.through);
		});
		if (!overlaps) {
			lap.matched += batch.matched;
			lap.spans.push(span);
		}
		laps.set(batch.lap, lap);
	}
	return(laps);
}

/**
 * The accounts compared, each once: those compared by themselves, by their
 * latest comparison, and those the batches of the lap that matched most
 * matched, each batch counted as distinctBatchesOf counts it. An account
 * of the passive walk compared by itself in another lap, whose row those
 * batches went over, is left out, as one of them may have matched it; one
 * compared by itself in the same lap was not among the batch's matches.
 */
function distinctSamplesOf(comparedByThemselves: readonly SweepRecord[], batches: readonly SweepBatchRecord[], rowIDs: ReadonlyMap<string, string>): number {
	let chosen: { readonly lap: number; readonly matched: number; readonly spans: readonly RowSpan[] } | undefined;
	for (const [lap, counted] of distinctBatchesOf(batches)) {
		if (chosen === undefined || counted.matched > chosen.matched) {
			chosen = { lap, ...counted };
		}
	}
	if (chosen === undefined) {
		return(comparedByThemselves.length);
	}
	const { lap, matched, spans } = chosen;
	return(matched + comparedByThemselves.filter(function(record): boolean {
		const rowID = rowIDs.get(record.account);
		if (record.walk !== 'passive' || record.lap === lap || rowID === undefined) {
			return(true);
		}
		const row = BigInt(rowID);
		return(!spans.some(function(span): boolean {
			return(span.after < row && row <= span.through);
		}));
	}).length);
}

function sweepSignalOf(allRecords: readonly ParityRecord[], position: SweepPosition): SweepSignal {
	const records = recordsOf(allRecords, 'sweep');
	const batches = latestBatches(recordsOf(allRecords, 'sweep-batch'));
	const { compared, attempted, everDiverged } = latestByAccount(records);
	const latest = [...compared.values()];
	const divergedNow = latest.filter(function(record): boolean {
		return(standsDiverging(record.outcome));
	});
	const localNow = latest.filter(function(record): boolean {
		return(record.outcome.kind === 'representative-local' && !standsDiverging(record.outcome));
	});
	const chainLaps = chainLapRecordsOf(records);
	const neverCompared = neverComparedOf(records, batches, position, chainLaps, neverComparedCandidatesOf(allRecords));
	let skippedMoving = 0;
	let unanswered = 0;
	let errorBoth = 0;
	for (const [account, record] of attempted) {
		if (compared.has(account)) {
			continue;
		}
		switch (record.outcome.kind) {
			case 'skipped':
				if (record.outcome.reason === 'moving') {
					skippedMoving++;
				} else {
					unanswered++;
				}
				break;
			case 'error-both':
				errorBoth++;
				break;
			default:
				break;
		}
	}
	// An account an unanswered batch named, with no record of its own.
	unanswered += neverCompared.passive.filter(function(account): boolean {
		return(!attempted.has(account));
	}).length;
	const divergenceRecords = records.filter(function(record): boolean {
		return(followerDiverged(record.outcome));
	}).length;
	const byChain = latest.filter(function(record): boolean {
		return(record.outcome.kind === 'compared-chain');
	}).length;
	const counts = {
		accountsCompared: latest.length,
		matched: latest.length - divergedNow.length - localNow.length - byChain,
		diverged: divergedNow.length,
		unresolved: divergedNow.filter(function(record): boolean {
			return(record.outcome.kind === 'unresolved' || record.outcome.kind === 'representative-local');
		}).length,
		comparedByChain: byChain,
		skippedMoving,
		unanswered,
		errorBoth,
		resolvedDivergences: everDiverged.size - divergedNow.filter(function(record): boolean {
			return(followerDiverged(record.outcome));
		}).length,
		divergenceRecords
	};
	const coverage = sweepCoverageOf(records, batches, position, neverCompared, chainLaps);
	/*
	 * An account compared by its chain had neither its state nor its history
	 * compared, so it is no sample of how often those diverge.
	 */
	const samples = distinctSamplesOf(latest.filter(function(record): boolean {
		return(record.outcome.kind !== 'compared-chain');
	}), batches, position.rowIDs);
	const confidence = confidenceOf(samples, divergedNow.length, 'account');
	const representativeLocal = representativeLocalOf(records, localNow);
	if (samples === 0) {
		return({ verdict: 'not-comparable-yet', notComparableReasons: ['no-sample'], counts, coverage, representativeLocal, confidence, firstDivergence: null });
	}
	const stillDiverging = new Set(divergedNow.map(function(record): string {
		return(record.account);
	}));
	const first = records.find(function(record): boolean {
		return(standsDiverging(record.outcome) && stillDiverging.has(record.account));
	});
	if (first === undefined || (first.outcome.kind !== 'diverged' && first.outcome.kind !== 'unresolved' && first.outcome.kind !== 'representative-local')) {
		// Only every account compared shows the sweep passes; a sample shows only that it does not fail yet.
		if (!coverage.everyAccountCompared) {
			return({ verdict: 'not-comparable-yet', notComparableReasons: ['coverage-incomplete'], counts, coverage, representativeLocal, confidence, firstDivergence: null });
		}
		return({ verdict: 'pass', notComparableReasons: [], counts, coverage, representativeLocal, confidence, firstDivergence: null });
	}
	return({ verdict: 'fail', notComparableReasons: [], counts, coverage, representativeLocal, confidence, firstDivergence: { ...first.outcome.divergence, at: first.at, representative: first.representative } });
}

/** The records of one kind. */
export function recordsOf<Kind extends ParityRecord['kind']>(records: readonly ParityRecord[], kind: Kind): readonly Extract<ParityRecord, { readonly kind: Kind }>[] {
	return(records.filter(function(record): record is Extract<ParityRecord, { readonly kind: Kind }> {
		return(record.kind === kind);
	}));
}

function confidenceOf(compared: number, diverged: number, unit: string): ConfidenceBound {
	if (compared === 0) {
		return({ kind: 'none', why: `no ${unit} compared yet` });
	}
	if (diverged > 0) {
		return({ kind: 'observed', samples: compared, divergences: diverged });
	}
	return({ kind: 'rule-of-three', samples: compared, level: 0.95, divergenceRateBelow: RULE_OF_THREE / compared });
}

type RouteSkips = Record<string, { moving: number; unanswered: number }>;

/** The routes more than the tolerated share of whose requests were never compared, the largest share first. */
function routesUncoveredOf(routes: readonly RouteAttempts[]): APIDiffRouteCoverage[] {
	return(routes.filter(routeUncovered).map(function({ route, compared, neverCompared }): APIDiffRouteCoverage {
		return({ route, compared, neverCompared: neverCompared.length });
	}).sort(function(left, right): number {
		// Compares the shares never compared, left's against right's, without dividing.
		return((right.neverCompared * (left.compared + left.neverCompared)) - (left.neverCompared * (right.compared + right.neverCompared)) || left.route.localeCompare(right.route));
	}));
}

function apiDiffStratumOf(stratum: Stratum, standings: readonly RequestStanding[], onExplanation: readonly RequestStanding[], routeAttempts: readonly RouteAttempts[], census: { readonly plan: APIDiffPlanRecord; readonly requests: readonly string[] } | undefined, compared: ReadonlySet<string>): APIDiffStratum {
	const own = standings.filter(function({ latest }): boolean {
		return(latest.stratum === stratum);
	});
	const standingOnExplanation = onExplanation.filter(function({ latest }): boolean {
		return(latest.stratum === stratum);
	}).length;
	const diverged = own.filter(function({ open }): boolean {
		return(open.length > 0);
	}).length;
	const representativeLocal = own.filter(function({ latest, open }): boolean {
		return(open.length === 0 && latest.outcome.kind === 'representative-local');
	}).length;
	const routes = routeAttempts.filter(function(entry): boolean {
		return(entry.stratum === stratum);
	});
	const skippedByRoute: RouteSkips = {};
	for (const { route, neverCompared } of routes) {
		for (const { outcome } of neverCompared) {
			if (outcome.kind !== 'skipped') {
				continue;
			}
			const skips = skippedByRoute[route] ?? { moving: 0, unanswered: 0 };
			skips[outcome.reason]++;
			skippedByRoute[route] = skips;
		}
	}
	const routesUncovered = routesUncoveredOf(routes);
	let standingCensus: APIDiffCensus | null = null;
	if (census !== undefined) {
		standingCensus = {
			requests: census.requests.length,
			compared: census.requests.filter(function(path): boolean {
				return(compared.has(keyOf(stratum, path)));
			}).length,
			plannedAt: census.plan.at
		};
	}
	const censusComplete = standingCensus !== null && standingCensus.compared === standingCensus.requests;
	let confidence = confidenceOf(own.length, diverged, 'request');
	if (censusComplete && diverged === 0) {
		confidence = { kind: 'census', requests: standingCensus?.requests ?? 0 };
		if (standingCensus?.requests === 0) {
			confidence = { kind: 'empty-population' };
		}
	}
	const sampled = censusComplete || own.length >= API_DIFF_SAMPLES_TARGET;
	return({ stratum, requestsCompared: own.length, standingOnExplanation, diverged, representativeLocal, census: standingCensus, skippedByRoute, routesUncovered, covered: sampled && routesUncovered.length === 0, confidence });
}

/**
 * Each request is counted by its latest comparison, so a request drawn
 * again on a later run is one sample, and the rule of three bounds each
 * stratum's rate of divergence over its distinct requests. A divergence
 * fails until a later comparison of the identical request finds the
 * follower answering as the representative answered then, or a triage
 * record explains it; one of a state either side reached since settles
 * nothing. A settled or explained divergence is listed with what settled
 * or explains it, so that it stays to be read. A request whose latest
 * comparison is a divergence explained found no answer alike, so it is
 * counted apart, neither as matched nor as a sample nor toward a census.
 */
function apiDiffSignalOf(records: readonly APIDiffRecord[], plans: readonly APIDiffPlanRecord[], explanations: readonly APIDiffExplainedRecord[], knownBehaviors: ReadonlySet<string>): APIDiffSignal {
	const attempted = new Map<string, APIDiffRecord>();
	const newBehaviors = new Map<string, string>();
	for (const record of records) {
		attempted.set(keyOf(record.stratum, record.path), record);
		if (record.outcome.kind === 'skipped') {
			continue;
		}
		for (const behavior of record.behaviors) {
			if (!knownBehaviors.has(behavior) && !newBehaviors.has(behavior)) {
				newBehaviors.set(behavior, record.path);
			}
		}
	}
	const standingsByKey = requestStandings(records, explanations);
	const onExplanation = [...standingsByKey.values()].filter(standsOnExplanation);
	const standings = [...standingsByKey.values()].filter(function(standing): boolean {
		return(!standsOnExplanation(standing));
	});
	const compared = new Set(standings.map(function({ latest }): string {
		return(keyOf(latest.stratum, latest.path));
	}));
	const open = standings.flatMap(function(standing): readonly APIDiffRecord[] {
		return(standing.open.map(function({ divergence }): APIDiffRecord {
			return(divergence);
		}));
	});
	const diverging = standings.filter(function(standing): boolean {
		return(standing.open.length > 0);
	});
	const local = standings.filter(function({ latest, open: divergences }): boolean {
		return(divergences.length === 0 && latest.outcome.kind === 'representative-local');
	});
	const representativeLocal = chargedByRepresentative(local.map(function({ latest }): APIDiffRecord {
		return(latest);
	}));
	const superseded = [...standingsByKey.values()].flatMap(function(standing): readonly SupersededDivergence[] {
		return(standing.superseded);
	});
	const explained = [...standingsByKey.values()].flatMap(function(standing): readonly ExplainedDivergence[] {
		return(standing.explained);
	});
	const retestedOnAnotherState = standings.flatMap(function(standing): { readonly divergence: APIDiffRecord; readonly by: APIDiffRecord }[] {
		return(standing.open.flatMap(function({ divergence, retestedBy }): { readonly divergence: APIDiffRecord; readonly by: APIDiffRecord }[] {
			if (retestedBy === undefined) {
				return([]);
			}
			return([{ divergence, by: retestedBy }]);
		}));
	});
	let skippedMoving = 0;
	let unanswered = 0;
	for (const [key, record] of attempted) {
		if (compared.has(key) || record.outcome.kind !== 'skipped') {
			continue;
		}
		switch (record.outcome.reason) {
			case 'moving':
				skippedMoving++;
				break;
			case 'unanswered':
				unanswered++;
				break;
			default:
				assertNever(record.outcome);
		}
	}
	const routeAttempts = routeAttemptsOf(records, standingsByKey);
	const censuses = standingCensuses(plans);
	const strata = STRATA.map(function(stratum): APIDiffStratum {
		return(apiDiffStratumOf(stratum, standings, onExplanation, routeAttempts, censuses.get(stratum), compared));
	});
	const counts = {
		requestsCompared: standings.length,
		matched: standings.length - diverging.length - local.length,
		standingOnExplanation: onExplanation.length,
		diverged: diverging.length,
		skippedMoving,
		unanswered,
		unresolved: diverging.filter(function(standing): boolean {
			return(standing.open.some(function({ divergence }): boolean {
				return(divergence.outcome.kind !== 'diverged');
			}));
		}).length,
		representativeLocal: local.length,
		divergenceRecords: records.filter(followerDivergesOn).length,
		superseded: superseded.length,
		explained: explained.length
	};
	const behaviors = [...newBehaviors].map(function([behavior, path]) {
		return({ behavior, path });
	});
	const coverage = {
		samplesTarget: API_DIFF_SAMPLES_TARGET,
		everyStratumCovered: strata.every(function(stratum): boolean {
			return(stratum.covered);
		}),
		representativeLocal,
		superseded,
		explained,
		retestedOnAnotherState
	};
	const [first] = [...open].sort(function(left, right): number {
		return(left.at.localeCompare(right.at));
	});
	if (first !== undefined && first.outcome.kind !== 'match' && first.outcome.kind !== 'skipped') {
		return({ verdict: 'fail', notComparableReasons: [], strata, counts, ...coverage, newBehaviors: behaviors, firstDivergence: { at: first.at, representative: first.representative, stratum: first.stratum, path: first.path, field: first.outcome.field } });
	}
	if (standings.length === 0) {
		return({ verdict: 'not-comparable-yet', notComparableReasons: ['no-sample'], strata, counts, ...coverage, newBehaviors: behaviors, firstDivergence: null });
	}
	// Only every stratum covered shows the API diff passes; fewer requests show only that it does not fail yet.
	if (!coverage.everyStratumCovered) {
		return({ verdict: 'not-comparable-yet', notComparableReasons: ['strata-uncovered'], strata, counts, ...coverage, newBehaviors: behaviors, firstDivergence: null });
	}
	return({ verdict: 'pass', notComparableReasons: [], strata, counts, ...coverage, newBehaviors: behaviors, firstDivergence: null });
}

/** The refusals a window lists that a by-rule explanation covers: of the same staple, recorded unexplained for the same reason it names. */
function explainedByRuleOf(tally: ShadowWindowTally, window: ShadowWindow, byRule: readonly ShadowExplainedRecord[]): ShadowWindowSummary['explainedByRule'] {
	return(tally.firstUnexplained.flatMap(function(refused): ShadowWindowSummary['explainedByRule'] {
		const explanation = byRule.find(function(record): boolean {
			return(record.window === window && record.blocksHash === refused.blocksHash && record.replaces === refused.why);
		});
		if (explanation === undefined) {
			return([]);
		}
		return([{ blocksHash: refused.blocksHash, reason: explanation.reason, code: refused.code }]);
	}));
}

function windowSummaryOf(tally: ShadowWindowTally, window: ShadowWindow, byRule: readonly ShadowExplainedRecord[]): ShadowWindowSummary {
	const explained: Partial<Record<ShadowRefusalReason, { readonly refusals: number; readonly changedIn: string | null }>> = {};
	for (const reason of SHADOW_REFUSAL_REASONS) {
		const refusals = tally.explained[reason];
		if (refusals !== undefined) {
			explained[reason] = { refusals, changedIn: SHADOW_REFUSAL_RELEASES[reason] };
		}
	}
	const explainedByRule = explainedByRuleOf(tally, window, byRule);
	return({ replayed: tally.replayed, shadowVoted: tally.shadowVoted, voted: tally.voted, explained, explainedByRule, unexplained: tally.unexplained - explainedByRule.length, votedFrom: tally.votedFrom, votedTo: tally.votedTo });
}

/** The refusals the window lists that remain unexplained once those explained by rule are set apart. */
function stillUnexplained(tally: ShadowWindowTally, summary: ShadowWindowSummary): readonly UnexplainedShadowRefusal[] {
	return(tally.firstUnexplained.filter(function(refused): boolean {
		return(!summary.explainedByRule.some(function(explained): boolean {
			return(explained.blocksHash === refused.blocksHash);
		}));
	}));
}

/** A run's standing as the report reads it: from the record of an invocation that ended, or from the run's cursor. */
type ShadowStanding = ShadowRunState & {
	readonly at: string | null;
	readonly complete: boolean;
	readonly cost: ShadowRunCost | null;
};

function shadowNotComparableReasonsOf(latest: ShadowStanding): ShadowNotComparableReason[] {
	const reasons: ShadowNotComparableReason[] = [];
	if (!latest.complete) {
		reasons.push('run-incomplete');
	}
	if (!latest.target.followerCaughtUp) {
		reasons.push('follower-not-caught-up');
	}
	if (latest.base.scopedStaples > 0) {
		reasons.push('base-within-window');
	}
	if (latest.scoped.shadowVoted === 0) {
		reasons.push('window-empty');
	}
	return(reasons);
}

/**
 * The run as it stands: its cursor, saved after each batch, when it is of
 * a later invocation than the latest record, or further on in the same
 * one, as of an invocation still running or cut short, which records
 * nothing until it ends; the latest record otherwise.
 */
function latestStanding(records: readonly ShadowRunRecord[], cursor: ShadowRunState | null): ShadowStanding | undefined {
	const latest = records.at(-1);
	if (cursor === null) {
		return(latest);
	}
	const fromCursor = { ...cursor, at: null, complete: shadowRunComplete(cursor), cost: null };
	if (latest === undefined || cursor.target.fixedAt > latest.target.fixedAt) {
		return(fromCursor);
	}
	if (cursor.target.fixedAt === latest.target.fixedAt && BigInt(cursor.reached.sequence) > BigInt(latest.reached.sequence)) {
		return(fromCursor);
	}
	return(latest);
}

/**
 * The run as it stands decides. A refusal in the scoped window that no
 * classified difference explains fails it at once, whether listed or only
 * counted; so does a staple the replay could not apply, once the run is
 * complete, since the follower's ledger applied it there. A refusal the
 * run left unexplained that a classified difference's rule alone explains
 * since counts as explained, listed apart from those the run explained. It
 * passes only once the run has voted on every staple of the window, up to
 * a target fixed while the follower held every staple voted for before its
 * reach. The informational window decides nothing.
 */
function shadowVotesSignalOf(records: readonly ShadowRunRecord[], byRule: readonly ShadowExplainedRecord[], cursor: ShadowRunState | null): ShadowVotesSignal {
	const latest = latestStanding(records, cursor);
	if (latest === undefined) {
		return({ verdict: 'not-comparable-yet', runs: 0, notComparableReasons: ['no-run'], latest: null, confidence: { kind: 'none', why: 'no shadow-vote run yet' }, firstDivergence: null });
	}
	const scoped = windowSummaryOf(latest.scoped, 'scoped', byRule);
	const summary = {
		at: latest.at,
		scope: latest.scope,
		base: latest.base,
		target: latest.target,
		reached: latest.reached.sequence,
		complete: latest.complete,
		scoped,
		informational: { ...windowSummaryOf(latest.informational, 'informational', byRule), every: latest.informationalEvery },
		unapplied: latest.unapplied.length,
		cost: latest.cost
	};
	const confidence = confidenceOf(latest.scoped.shadowVoted, scoped.unexplained, 'staple of the scoped window');
	const notComparableReasons = shadowNotComparableReasonsOf(latest);
	const signal = { runs: records.length, notComparableReasons, latest: summary, confidence };
	if (scoped.unexplained > 0) {
		const [refused] = stillUnexplained(latest.scoped, scoped);
		if (refused === undefined) {
			return({ ...signal, verdict: 'fail', firstDivergence: { at: latest.at, staple: null, code: 'unlisted', why: `${String(scoped.unexplained)} refusals no classified difference explains, past the ${String(UNEXPLAINED_LISTED)} listed` } });
		}
		return({ ...signal, verdict: 'fail', firstDivergence: { at: latest.at, staple: refused.blocksHash, code: refused.code, why: `${refused.message}: ${refused.why}` } });
	}
	const [unapplied] = latest.unapplied;
	if (latest.complete && unapplied !== undefined) {
		return({ ...signal, verdict: 'fail', firstDivergence: { at: latest.at, staple: unapplied.blocksHash, code: unapplied.why, why: 'the replay never applied the staple, which the follower\'s ledger applied at that place' } });
	}
	if (notComparableReasons.length > 0) {
		return({ ...signal, verdict: 'not-comparable-yet', firstDivergence: null });
	}
	return({ ...signal, verdict: 'pass', firstDivergence: null });
}

/** Where the sweep stands among the accounts the follower knows. */
export type SweepPosition = {
	readonly knownAccounts: number;
	/** The accounts with a chain now, which the chain walk must have compared by themselves. */
	readonly chainAccounts: readonly KnownAccount[];
	readonly cursors: Readonly<Record<SweepWalk, SweepCursor>>;
	/** The row of each account the log names as not compared, by which a later batch of the passive walk may have compared it, and of each the passive walk compared by itself, which a batch of another lap may have matched. */
	readonly rowIDs: ReadonlyMap<string, string>;
};

export type ReportInput = {
	readonly generatedAt: Date;
	readonly progress: FollowerProgress;
	readonly sweep: SweepPosition;
	readonly log: ParityLogContents;
	/** The kinds of answer the capture set holds. */
	readonly knownBehaviors: ReadonlySet<string>;
	/** The shadow-vote run's standing in its cursor, or null when no run has saved one. */
	readonly shadowStanding: ShadowRunState | null;
	/** What keeps the follower from being caught up, read as the report is made. */
	readonly heldBack: HeldBack;
};

/**
 * A signal that passes on a log holding lines it could not read does not
 * pass yet: a line cut short or unknown may have been a divergence. One
 * that fails still fails.
 */
function withLogRead<Signal extends { readonly verdict: Verdict; readonly notComparableReasons: readonly Reason[] }, Reason>(signal: Signal, unreadableLines: number, reason: Reason): Signal {
	if (unreadableLines === 0 || signal.verdict !== 'pass') {
		return(signal);
	}
	return({ ...signal, verdict: 'not-comparable-yet', notComparableReasons: [...signal.notComparableReasons, reason] });
}

export function parityReportOf(input: ReportInput): ParityReport {
	const { records, unreadableLines } = input.log;
	return({
		generatedAt: input.generatedAt.toISOString(),
		follower: { completedPass: isoOrNull(input.progress.completedPass), heldBefore: isoOrNull(input.progress.heldBefore), staged: input.progress.staged },
		logUnreadableLines: unreadableLines,
		signals: {
			checksum: withLogRead(checksumSignalOf(records, input.heldBack, input.generatedAt), unreadableLines, 'log-unreadable'),
			sweep: withLogRead(sweepSignalOf(records, input.sweep), unreadableLines, 'log-unreadable'),
			apiDiff: withLogRead(apiDiffSignalOf(recordsOf(records, 'api-diff'), recordsOf(records, 'api-diff-plan'), recordsOf(records, 'api-diff-explained'), input.knownBehaviors), unreadableLines, 'log-unreadable'),
			shadowVotes: withLogRead(shadowVotesSignalOf(recordsOf(records, 'shadow-run'), recordsOf(records, 'shadow-explained'), input.shadowStanding), unreadableLines, 'log-unreadable')
		}
	});
}

/** The parity tool's exit code for a report: 0 only when every signal passes. */
export function exitCodeOf(report: ParityReport): 0 | 1 {
	if (Object.values(report.signals).every(function(signal): boolean {
		return(signal.verdict === 'pass');
	})) {
		return(0);
	}
	return(1);
}

/** What reporting on the log reads beside it. */
export type ReportSources = {
	readonly store: FollowerStore;
	readonly log: ParityLog;
	readonly cursorPaths: SweepCursorPaths;
	/** The kinds of answer the capture set holds. */
	readonly knownBehaviors: ReadonlySet<string>;
	/** Reads the shadow-vote run's standing from its cursor, writing nothing. */
	readonly shadowStanding: () => Promise<ShadowRunState | undefined>;
};

/** The accounts the store looks up at once, well within what a query takes as one parameter. */
const ROWS_LOOKED_UP_AT_ONCE = 10_000;

/** Where the sweep stands, read from the follower's store and the cursors, for the accounts the log names. */
export async function sweepPositionOf(sources: Pick<ReportSources, 'store' | 'cursorPaths'>, records: readonly ParityRecord[]): Promise<SweepPosition> {
	const chainAccounts = await sources.store.chainAccounts();
	const chainSet = new Set(chainAccounts.map(function(known): string {
		return(known.account);
	}));
	// The accounts the log names as not compared, and those the passive walk compared by themselves, which a batch of another lap may have matched as well.
	const comparedByThemselves = recordsOf(records, 'sweep').filter(function(record): boolean {
		return(record.walk === 'passive');
	}).map(function(record): string {
		return(record.account);
	});
	const candidates = [...new Set([...neverComparedCandidatesOf(records), ...comparedByThemselves])].filter(function(account): boolean {
		return(!chainSet.has(account));
	});
	const rowIDs = new Map<string, string>();
	for (let start = 0; start < candidates.length; start += ROWS_LOOKED_UP_AT_ONCE) {
		for (const [account, rowID] of await sources.store.rowIDsOf(candidates.slice(start, start + ROWS_LOOKED_UP_AT_ONCE))) {
			rowIDs.set(account, rowID);
		}
	}
	return({
		knownAccounts: await sources.store.accountCount(),
		chainAccounts,
		cursors: { chain: await readSweepCursor(sources.cursorPaths.chain), passive: await readSweepCursor(sources.cursorPaths.passive) },
		rowIDs
	});
}

/** The accounts no lap compared, as the report counts them, the accounts with a chain as the follower knows them. */
export function neverComparedAccountsOf(allRecords: readonly ParityRecord[], position: SweepPosition): NeverCompared {
	const records = recordsOf(allRecords, 'sweep');
	const { chain, passive } = neverComparedOf(records, latestBatches(recordsOf(allRecords, 'sweep-batch')), position, chainLapRecordsOf(records), neverComparedCandidatesOf(allRecords));
	const missed = new Set(chain);
	return({
		chain: position.chainAccounts.filter(function(known): boolean {
			return(missed.has(known.account));
		}),
		passive
	});
}

/** The report on the whole log as it stands, comparing nothing afresh. */
export async function reportOnLog(sources: ReportSources): Promise<ParityReport> {
	const log = await sources.log.read();
	const sweep = await sweepPositionOf(sources, log.records);
	return(parityReportOf({ generatedAt: new Date(), progress: await sources.store.progress(), sweep, log, knownBehaviors: sources.knownBehaviors, shadowStanding: await sources.shadowStanding() ?? null, heldBack: await sources.store.heldBack() }));
}

export type ParityRun = {
	readonly follower: APISource;
	/** Paced by the caller. */
	readonly representatives: readonly APISource[];
	readonly store: FollowerStore;
	readonly log: ParityLog;
	readonly cursorPaths: SweepCursorPaths;
	/** How many chain accounts the fresh sweep sample compares. */
	readonly sampleAccounts: number;
	/** How many passive accounts the fresh sweep sample walks past. */
	readonly passiveSampleAccounts: number;
	/** The fresh sample of the API diff: so many requests of each stratum, drawn as the seed fixes. */
	readonly apiDiff: Pick<APIDiffSetup, 'samplesPerStratum' | 'seed' | 'edgeCaseStaples' | 'knownBehaviors'>;
	readonly gapMilliseconds: number;
	readonly wait: (milliseconds: number) => Promise<void>;
	readonly stopped: AbortSignal;
	readonly shadowStanding: ReportSources['shadowStanding'];
};

/** Checks the checksum now, compares a sample of the sweep from its cursors and a sample of the API, records them, and reports on the whole log. */
export async function runParity(run: ParityRun): Promise<ParityReport> {
	const progress = await run.store.progress();
	const checksums = await compareChecksums({
		follower: run.follower,
		representatives: run.representatives,
		progress,
		gapMilliseconds: run.gapMilliseconds,
		wait: run.wait
	});
	await run.log.append([await crossCheckChecksum({ store: run.store }), await heldBackRecordOf(run.store), ...checksums.checksums, ...checksums.blockCounts]);
	await sweepAccounts({
		follower: run.follower,
		representatives: run.representatives,
		store: run.store,
		log: run.log,
		cursorPaths: run.cursorPaths,
		accounts: { chain: run.sampleAccounts, passive: run.passiveSampleAccounts },
		toLapEnd: false,
		passiveRequestsInFlight: 1,
		stopped: run.stopped
	});
	await sampleAPI({ ...run.apiDiff, follower: run.follower, representatives: run.representatives, store: run.store, log: run.log, stopped: run.stopped });
	return(await reportOnLog({ store: run.store, log: run.log, cursorPaths: run.cursorPaths, knownBehaviors: run.apiDiff.knownBehaviors, shadowStanding: run.shadowStanding }));
}
