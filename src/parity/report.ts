import { assertNever } from '../util/assert-never.js';
import { sampleAPI } from './api-diff.js';
import type { APIDiffSetup } from './api-diff.js';
import type { APISource } from './api-source.js';
import { checksumsEqual, compareChecksums, crossCheckChecksum } from './checksum.js';
import type { FollowerProgress, FollowerStore } from './follower-store.js';
import { SHADOW_REFUSAL_REASONS, SHADOW_REFUSAL_RELEASES } from '../conformance/mainnet/shadow.js';
import type { ShadowRefusalReason } from '../conformance/mainnet/shadow.js';
import type { APIDiffRecord, BlockCountNotComparableReason, BlockCountRecord, ChecksumRecord, ChecksumWindow, CrossCheckRecord, Divergence, ParityLog, ParityLogContents, ParityRecord, ShadowBase, ShadowRunCost, ShadowRunRecord, ShadowTarget, ShadowWindowTally, SweepCursor, SweepPointer, SweepRecord } from './log.js';
import { STRATA } from './strata.js';
import type { Stratum } from './strata.js';
import { readSweepCursor, sweepAccounts } from './sweep.js';

/** A signal's verdict. */
export type Verdict = 'pass' | 'fail' | 'not-comparable-yet';

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

export type ChecksumSignal = {
	readonly verdict: Verdict;
	/** The follower's stored checksum against the XOR of its main blocks. */
	readonly crossCheck: CrossCheckPart;
	/** The follower's block count against the representatives'. */
	readonly blockCount: BlockCountPart;
	readonly representativeChecksums: RepresentativeChecksums;
	readonly confidence: ConfidenceBound;
	readonly firstDivergence: FirstDivergence | null;
};

export type SweepSignal = {
	readonly verdict: Verdict;
	readonly counts: {
		readonly knownAccounts: number;
		/** The lap the sweep is on, and how many accounts it has walked past in it. */
		readonly lap: number;
		readonly walkedThisLap: number;
		/** Accounts compared at least once, each counted by its latest comparison. */
		readonly accountsCompared: number;
		readonly matched: number;
		readonly diverged: number;
		/** Accounts never compared, whose latest attempt found them moving. */
		readonly skippedMoving: number;
		/** Accounts never compared, whose latest attempt went unanswered. */
		readonly unanswered: number;
		/** Accounts that diverged once and matched later. */
		readonly resolvedDivergences: number;
		/** Every divergence recorded, each to be explained. */
		readonly divergenceRecords: number;
	};
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
	| 'window-empty';

/** A window's refusals by the classified difference that explains them, with the release that changed the rule. */
export type ShadowWindowSummary = Omit<ShadowWindowTally, 'explained' | 'firstUnexplained'> & {
	readonly explained: Readonly<Partial<Record<ShadowRefusalReason, { readonly refusals: number; readonly changedIn: string | null }>>>;
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
		readonly at: string;
		readonly scope: { readonly release: string; readonly from: string };
		readonly base: ShadowBase;
		readonly target: ShadowTarget;
		readonly reached: string;
		readonly complete: boolean;
		readonly scoped: ShadowWindowSummary;
		readonly informational: ShadowWindowSummary & { readonly every: number };
		readonly refusedForWeight: number;
		readonly unapplied: number;
		readonly cost: ShadowRunCost;
	} | null;
	/** Of the refusals in the scoped window that no classified difference explains. */
	readonly confidence: ConfidenceBound;
	readonly firstDivergence: { readonly at: string; readonly staple: string; readonly code: string; readonly why: string } | null;
};

/** Each stratum's requests, each counted by its latest comparison. */
export type APIDiffStratum = {
	readonly stratum: Stratum;
	readonly requestsCompared: number;
	readonly diverged: number;
	readonly confidence: ConfidenceBound;
};

export type APIDiffSignal = {
	readonly verdict: Verdict;
	readonly strata: readonly APIDiffStratum[];
	readonly counts: {
		readonly requestsCompared: number;
		readonly matched: number;
		readonly diverged: number;
		/** Requests never compared, whose latest attempt found an account they read moving, or went unanswered. */
		readonly skippedMoving: number;
		readonly unanswered: number;
		/** Every divergence recorded, each to be explained. */
		readonly divergenceRecords: number;
	};
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

function isoOrNull(moment: Date | undefined): string | null {
	if (moment === undefined) {
		return(null);
	}
	return(moment.toISOString());
}

function heldStill(window: ChecksumWindow): window is Extract<ChecksumWindow, { kind: 'read' }> {
	return(window.kind === 'read' && window.first.blockCount === window.second.blockCount && checksumsEqual(window.first.checksum, window.second.checksum));
}

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

function checksumSignalOf(records: readonly ParityRecord[]): ChecksumSignal {
	const crossCheck = crossCheckPartOf(recordsOf(records, 'cross-check'));
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
	return({
		verdict: combined(crossCheck.verdict, blockCount.verdict),
		crossCheck,
		blockCount,
		representativeChecksums: representativeChecksumsOf(recordsOf(records, 'checksum')),
		confidence: { kind: 'not-sampled' },
		firstDivergence
	});
}

/** Each account's latest comparison, and its latest record of any kind, in the order the accounts were first seen. */
function latestByAccount(records: readonly SweepRecord[]): { readonly compared: Map<string, SweepRecord>; readonly attempted: Map<string, SweepRecord>; readonly everDiverged: Set<string> } {
	const compared = new Map<string, SweepRecord>();
	const attempted = new Map<string, SweepRecord>();
	const everDiverged = new Set<string>();
	for (const record of records) {
		attempted.set(record.account, record);
		switch (record.outcome.kind) {
			case 'diverged':
				everDiverged.add(record.account);
				compared.set(record.account, record);
				break;
			case 'match':
				compared.set(record.account, record);
				break;
			case 'skipped':
				break;
			default:
				assertNever(record.outcome);
		}
	}
	return({ compared, attempted, everDiverged });
}


function sweepSignalOf(records: readonly SweepRecord[], position: SweepPosition): SweepSignal {
	const { compared, attempted, everDiverged } = latestByAccount(records);
	const latest = [...compared.values()];
	const divergedNow = latest.filter(function(record): boolean {
		return(record.outcome.kind === 'diverged');
	});
	let skippedMoving = 0;
	let unanswered = 0;
	for (const [account, record] of attempted) {
		if (compared.has(account) || record.outcome.kind !== 'skipped') {
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
	const divergenceRecords = records.filter(function(record): boolean {
		return(record.outcome.kind === 'diverged');
	}).length;
	const counts = {
		knownAccounts: position.knownAccounts,
		lap: position.cursor.lap,
		walkedThisLap: position.walkedThisLap,
		accountsCompared: latest.length,
		matched: latest.length - divergedNow.length,
		diverged: divergedNow.length,
		skippedMoving,
		unanswered,
		resolvedDivergences: everDiverged.size - divergedNow.length,
		divergenceRecords
	};
	const confidence = confidenceOf(latest.length, divergedNow.length, 'account');
	if (latest.length === 0) {
		return({ verdict: 'not-comparable-yet', counts, confidence, firstDivergence: null });
	}
	const stillDiverging = new Set(divergedNow.map(function(record): string {
		return(record.account);
	}));
	const first = records.find(function(record): boolean {
		return(record.outcome.kind === 'diverged' && stillDiverging.has(record.account));
	});
	if (first?.outcome.kind !== 'diverged') {
		return({ verdict: 'pass', counts, confidence, firstDivergence: null });
	}
	return({ verdict: 'fail', counts, confidence, firstDivergence: { ...first.outcome.divergence, at: first.at, representative: first.representative } });
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

/**
 * Each request is counted by its latest comparison, so a request drawn
 * again on a later run is one sample, and the rule of three bounds each
 * stratum's rate of divergence over its distinct requests.
 */
function apiDiffSignalOf(records: readonly APIDiffRecord[], knownBehaviors: ReadonlySet<string>): APIDiffSignal {
	const compared = new Map<string, APIDiffRecord>();
	const attempted = new Map<string, APIDiffRecord>();
	const newBehaviors = new Map<string, string>();
	for (const record of records) {
		const key = `${record.stratum} ${record.path}`;
		attempted.set(key, record);
		if (record.outcome.kind === 'skipped') {
			continue;
		}
		compared.set(key, record);
		for (const behavior of record.behaviors) {
			if (!knownBehaviors.has(behavior) && !newBehaviors.has(behavior)) {
				newBehaviors.set(behavior, record.path);
			}
		}
	}
	const latest = [...compared.values()];
	const diverging = latest.filter(function(record): boolean {
		return(record.outcome.kind === 'diverged');
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
	const strata = STRATA.map(function(stratum): APIDiffStratum {
		const own = latest.filter(function(record): boolean {
			return(record.stratum === stratum);
		});
		const diverged = own.filter(function(record): boolean {
			return(record.outcome.kind === 'diverged');
		}).length;
		return({ stratum, requestsCompared: own.length, diverged, confidence: confidenceOf(own.length, diverged, 'request') });
	});
	const counts = {
		requestsCompared: latest.length,
		matched: latest.length - diverging.length,
		diverged: diverging.length,
		skippedMoving,
		unanswered,
		divergenceRecords: records.filter(function(record): boolean {
			return(record.outcome.kind === 'diverged');
		}).length
	};
	const behaviors = [...newBehaviors].map(function([behavior, path]) {
		return({ behavior, path });
	});
	const first = diverging[0];
	if (first?.outcome.kind === 'diverged') {
		return({ verdict: 'fail', strata, counts, newBehaviors: behaviors, firstDivergence: { at: first.at, representative: first.representative, stratum: first.stratum, path: first.path, field: first.outcome.field } });
	}
	let verdict: Verdict = 'not-comparable-yet';
	if (latest.length > 0) {
		verdict = 'pass';
	}
	return({ verdict, strata, counts, newBehaviors: behaviors, firstDivergence: null });
}

function windowSummaryOf(tally: ShadowWindowTally): ShadowWindowSummary {
	const explained: Partial<Record<ShadowRefusalReason, { readonly refusals: number; readonly changedIn: string | null }>> = {};
	for (const reason of SHADOW_REFUSAL_REASONS) {
		const refusals = tally.explained[reason];
		if (refusals !== undefined) {
			explained[reason] = { refusals, changedIn: SHADOW_REFUSAL_RELEASES[reason] };
		}
	}
	return({ replayed: tally.replayed, shadowVoted: tally.shadowVoted, voted: tally.voted, explained, unexplained: tally.unexplained, votedFrom: tally.votedFrom, votedTo: tally.votedTo });
}

function shadowNotComparableReasonsOf(latest: ShadowRunRecord): ShadowNotComparableReason[] {
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
 * The latest run decides. A refusal in the scoped window that no classified
 * difference explains fails it at once; so does a staple the replay could
 * not apply, once the run is complete, since the follower's ledger applied
 * it there. It passes only once the run has voted on every staple of the
 * window, up to a target fixed while the follower held every staple voted
 * for before its reach. The informational window decides nothing.
 */
function shadowVotesSignalOf(records: readonly ShadowRunRecord[]): ShadowVotesSignal {
	const latest = records.at(-1);
	if (latest === undefined) {
		return({ verdict: 'not-comparable-yet', runs: 0, notComparableReasons: ['no-run'], latest: null, confidence: { kind: 'none', why: 'no shadow-vote run yet' }, firstDivergence: null });
	}
	const summary = {
		at: latest.at,
		scope: latest.scope,
		base: latest.base,
		target: latest.target,
		reached: latest.reached.sequence,
		complete: latest.complete,
		scoped: windowSummaryOf(latest.scoped),
		informational: { ...windowSummaryOf(latest.informational), every: latest.informationalEvery },
		refusedForWeight: latest.refusedForWeight,
		unapplied: latest.unapplied.length,
		cost: latest.cost
	};
	const confidence = confidenceOf(latest.scoped.shadowVoted, latest.scoped.unexplained, 'staple of the scoped window');
	const notComparableReasons = shadowNotComparableReasonsOf(latest);
	const signal = { runs: records.length, notComparableReasons, latest: summary, confidence };
	const [refused] = latest.scoped.firstUnexplained;
	if (refused !== undefined) {
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
	readonly cursor: SweepCursor;
	readonly walkedThisLap: number;
};

export type ReportInput = {
	readonly generatedAt: Date;
	readonly progress: FollowerProgress;
	readonly sweep: SweepPosition;
	readonly log: ParityLogContents;
	/** The kinds of answer the capture set holds. */
	readonly knownBehaviors: ReadonlySet<string>;
};

export function parityReportOf(input: ReportInput): ParityReport {
	const { records } = input.log;
	return({
		generatedAt: input.generatedAt.toISOString(),
		follower: { completedPass: isoOrNull(input.progress.completedPass), heldBefore: isoOrNull(input.progress.heldBefore), staged: input.progress.staged },
		logUnreadableLines: input.log.unreadableLines,
		signals: {
			checksum: checksumSignalOf(records),
			sweep: sweepSignalOf(recordsOf(records, 'sweep'), input.sweep),
			apiDiff: apiDiffSignalOf(recordsOf(records, 'api-diff'), input.knownBehaviors),
			shadowVotes: shadowVotesSignalOf(recordsOf(records, 'shadow-run'))
		}
	});
}

/** Where the sweep stands: its cursor, and the first divergence it recorded. */
export async function sweepPointerOf(log: ParityLog, cursorPath: string): Promise<SweepPointer> {
	const first = recordsOf((await log.read()).records, 'sweep').find(function(record): boolean {
		return(record.outcome.kind === 'diverged');
	});
	let firstDivergence: Divergence | null = null;
	if (first?.outcome.kind === 'diverged') {
		firstDivergence = first.outcome.divergence;
	}
	return({ cursor: await readSweepCursor(cursorPath), firstDivergence });
}

export type ParityRun = {
	readonly follower: APISource;
	/** Paced by the caller. */
	readonly representatives: readonly APISource[];
	readonly store: FollowerStore;
	readonly log: ParityLog;
	readonly cursorPath: string;
	/** How many accounts the fresh sweep sample compares. */
	readonly sampleAccounts: number;
	/** The fresh sample of the API diff: so many requests of each stratum, drawn as the seed fixes. */
	readonly apiDiff: Pick<APIDiffSetup, 'samplesPerStratum' | 'seed' | 'edgeCaseStaples' | 'knownBehaviors'>;
	readonly gapMilliseconds: number;
	readonly wait: (milliseconds: number) => Promise<void>;
	readonly stopped: AbortSignal;
};

/** Checks the checksum now, compares a sample of the sweep from its cursor and a sample of the API, records them, and reports on the whole log. */
export async function runParity(run: ParityRun): Promise<ParityReport> {
	const progress = await run.store.progress();
	const checksums = await compareChecksums({
		follower: run.follower,
		representatives: run.representatives,
		progress,
		gapMilliseconds: run.gapMilliseconds,
		wait: run.wait,
		sweep() {
			return(sweepPointerOf(run.log, run.cursorPath));
		}
	});
	await run.log.append([await crossCheckChecksum({ store: run.store }), ...checksums.checksums, ...checksums.blockCounts]);
	await sweepAccounts({ follower: run.follower, representatives: run.representatives, store: run.store, log: run.log, cursorPath: run.cursorPath, accounts: run.sampleAccounts, stopped: run.stopped });
	await sampleAPI({ ...run.apiDiff, follower: run.follower, representatives: run.representatives, store: run.store, log: run.log, stopped: run.stopped });
	const cursor = await readSweepCursor(run.cursorPath);
	const sweep = { knownAccounts: await run.store.accountCount(), cursor, walkedThisLap: await run.store.accountsUpTo(cursor.afterRowID) };
	return(parityReportOf({ generatedAt: new Date(), progress: await run.store.progress(), sweep, log: await run.log.read(), knownBehaviors: run.apiDiff.knownBehaviors }));
}
