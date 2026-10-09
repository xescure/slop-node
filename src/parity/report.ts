import { assertNever } from '../util/assert-never.js';
import { sampleAPI } from './api-diff.js';
import type { APIDiffSetup } from './api-diff.js';
import type { APISource } from './api-source.js';
import { checksumsEqual, compareChecksums, crossCheckChecksum } from './checksum.js';
import type { FollowerProgress, FollowerStore } from './follower-store.js';
import type { APIDiffRecord, BlockCountNotComparableReason, BlockCountRecord, ChecksumRecord, ChecksumWindow, CrossCheckRecord, Divergence, ParityLog, ParityLogContents, ParityRecord, SweepCursor, SweepPointer, SweepRecord } from './log.js';
import { STRATA } from './strata.js';
import type { Stratum } from './strata.js';
import { readSweepCursor, sweepAccounts } from './sweep.js';

/** A signal's verdict; a signal whose tool does not exist yet reports so rather than passing. */
export type Verdict = 'pass' | 'fail' | 'not-comparable-yet' | 'not-implemented';

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

/** A verdict of a signal or a part of one. */
export type SignalVerdict = Exclude<Verdict, 'not-implemented'>;

export type CrossCheckPart = {
	readonly verdict: SignalVerdict;
	readonly runs: number;
	/** The latest cross-check, which the verdict is of. */
	readonly latest: CrossCheckRecord | null;
};

export type BlockCountPart = {
	readonly verdict: SignalVerdict;
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
	readonly verdict: SignalVerdict;
	/** The follower's stored checksum against the XOR of its main blocks. */
	readonly crossCheck: CrossCheckPart;
	/** The follower's block count against the representatives'. */
	readonly blockCount: BlockCountPart;
	readonly representativeChecksums: RepresentativeChecksums;
	readonly confidence: ConfidenceBound;
	readonly firstDivergence: FirstDivergence | null;
};

export type SweepSignal = {
	readonly verdict: Exclude<Verdict, 'not-implemented'>;
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

export type PendingSignal = { readonly verdict: 'not-implemented' };

/** Each stratum's requests, each counted by its latest comparison. */
export type APIDiffStratum = {
	readonly stratum: Stratum;
	readonly requestsCompared: number;
	readonly diverged: number;
	readonly confidence: ConfidenceBound;
};

export type APIDiffSignal = {
	readonly verdict: SignalVerdict;
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
	readonly newBehaviours: readonly { readonly behaviour: string; readonly path: string }[];
	readonly firstDivergence: { readonly at: string; readonly representative: string; readonly stratum: Stratum; readonly path: string; readonly field: string } | null;
};

export type ParityReport = {
	readonly generatedAt: string;
	readonly follower: { readonly completedPass: string | null; readonly heldBefore: string | null };
	readonly logUnreadableLines: number;
	readonly signals: {
		readonly checksum: ChecksumSignal;
		readonly sweep: SweepSignal;
		readonly apiDiff: APIDiffSignal;
		/** Shadow votes on live history (P5), not implemented yet. */
		readonly shadowVotes: PendingSignal;
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
 * The latest cross-check decides: a stored checksum equal to the fold, or
 * apart from it only by staples it explains, passes.
 */
function crossCheckPartOf(records: readonly CrossCheckRecord[]): CrossCheckPart {
	const latest = records.at(-1) ?? null;
	if (latest === null) {
		return({ verdict: 'not-comparable-yet', runs: 0, latest });
	}
	switch (latest.outcome.kind) {
		case 'equal':
		case 'unsynced':
		case 'lost-run':
			return({ verdict: 'pass', runs: records.length, latest });
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
	let verdict: SignalVerdict = 'not-comparable-yet';
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
function combined(left: SignalVerdict, right: SignalVerdict): SignalVerdict {
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
function apiDiffSignalOf(records: readonly APIDiffRecord[], knownBehaviours: ReadonlySet<string>): APIDiffSignal {
	const compared = new Map<string, APIDiffRecord>();
	const attempted = new Map<string, APIDiffRecord>();
	const newBehaviours = new Map<string, string>();
	for (const record of records) {
		const key = `${record.stratum} ${record.path}`;
		attempted.set(key, record);
		if (record.outcome.kind === 'skipped') {
			continue;
		}
		compared.set(key, record);
		for (const behaviour of record.behaviours) {
			if (!knownBehaviours.has(behaviour) && !newBehaviours.has(behaviour)) {
				newBehaviours.set(behaviour, record.path);
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
	const behaviours = [...newBehaviours].map(function([behaviour, path]) {
		return({ behaviour, path });
	});
	const first = diverging[0];
	if (first?.outcome.kind === 'diverged') {
		return({ verdict: 'fail', strata, counts, newBehaviours: behaviours, firstDivergence: { at: first.at, representative: first.representative, stratum: first.stratum, path: first.path, field: first.outcome.field } });
	}
	let verdict: SignalVerdict = 'not-comparable-yet';
	if (latest.length > 0) {
		verdict = 'pass';
	}
	return({ verdict, strata, counts, newBehaviours: behaviours, firstDivergence: null });
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
	readonly knownBehaviours: ReadonlySet<string>;
};

export function parityReportOf(input: ReportInput): ParityReport {
	const { records } = input.log;
	return({
		generatedAt: input.generatedAt.toISOString(),
		follower: { completedPass: isoOrNull(input.progress.completedPass), heldBefore: isoOrNull(input.progress.heldBefore) },
		logUnreadableLines: input.log.unreadableLines,
		signals: {
			checksum: checksumSignalOf(records),
			sweep: sweepSignalOf(recordsOf(records, 'sweep'), input.sweep),
			apiDiff: apiDiffSignalOf(recordsOf(records, 'api-diff'), input.knownBehaviours),
			shadowVotes: { verdict: 'not-implemented' }
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
	readonly apiDiff: Pick<APIDiffSetup, 'samplesPerStratum' | 'seed' | 'edgeCaseStaples' | 'knownBehaviours'>;
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
	await run.log.append([await crossCheckChecksum({ follower: run.follower, store: run.store }), ...checksums.checksums, ...checksums.blockCounts]);
	await sweepAccounts({ follower: run.follower, representatives: run.representatives, store: run.store, log: run.log, cursorPath: run.cursorPath, accounts: run.sampleAccounts, stopped: run.stopped });
	await sampleAPI({ ...run.apiDiff, follower: run.follower, representatives: run.representatives, store: run.store, log: run.log, stopped: run.stopped });
	const cursor = await readSweepCursor(run.cursorPath);
	const sweep = { knownAccounts: await run.store.accountCount(), cursor, walkedThisLap: await run.store.accountsUpTo(cursor.afterRowID) };
	return(parityReportOf({ generatedAt: new Date(), progress: await run.store.progress(), sweep, log: await run.log.read(), knownBehaviours: run.apiDiff.knownBehaviours }));
}
