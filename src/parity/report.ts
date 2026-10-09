import { assertNever } from '../util/assert-never.js';
import type { APISource } from './api-source.js';
import { checksumsEqual, compareChecksums } from './checksum.js';
import type { FollowerProgress, FollowerStore } from './follower-store.js';
import type { ChecksumRecord, Divergence, NotComparableReason, ParityLog, ParityLogContents, ParityRecord, SweepCursor, SweepPointer, SweepRecord } from './log.js';
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
	readonly representative: string;
};

export type ChecksumSignal = {
	readonly verdict: Exclude<Verdict, 'not-implemented'>;
	readonly counts: { readonly comparisons: number; readonly comparable: number; readonly matched: number; readonly mismatched: number };
	readonly confidence: ConfidenceBound;
	/** Why the latest comparisons did not count. */
	readonly notComparableReasons: readonly NotComparableReason[];
	/** How many different checksums the representatives that held still served in the latest run; more than one shows their statistics apart. */
	readonly representativeChecksums: number;
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

export type ParityReport = {
	readonly generatedAt: string;
	readonly follower: { readonly completedPass: string | null; readonly heldBefore: string | null };
	readonly logUnreadableLines: number;
	readonly signals: {
		readonly checksum: ChecksumSignal;
		readonly sweep: SweepSignal;
		/** The sampled API diff (P4), not implemented yet. */
		readonly apiDiff: PendingSignal;
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

function counted(record: ChecksumRecord): boolean {
	return(record.verdict.kind !== 'not-comparable-yet');
}

/** The distinct values among the checksums of the representatives that held still across their windows. */
function distinctChecksums(records: readonly ChecksumRecord[]): number {
	const values = new Set<bigint>();
	for (const record of records) {
		const window = record.representativeWindow;
		if (window.kind === 'read' && window.first.blockCount === window.second.blockCount && checksumsEqual(window.first.checksum, window.second.checksum)) {
			values.add(BigInt(window.second.checksum));
		}
	}
	return(values.size);
}

/**
 * The verdict of the latest run in which a comparison counted: it passes
 * when the follower agreed with any representative it compared with. A
 * representative's checksum is a statistic of its own, which it folds in
 * after each commit and keeps apart from its ledger
 * [Keeta TS] index.js:69411-69416, 69001-69006, 74473-74497, and on the
 * main network the representatives served four different checksums and
 * block counts that held still for minutes (conformance/API.md,
 * Differences), so a disagreement with one is no evidence against the
 * follower while it agrees with another.
 */
function checksumSignalOf(records: readonly ChecksumRecord[]): ChecksumSignal {
	const comparable = records.filter(counted);
	const mismatched = comparable.filter(function(record): boolean {
		return(record.verdict.kind === 'fail');
	});
	const counts = { comparisons: records.length, comparable: comparable.length, matched: comparable.length - mismatched.length, mismatched: mismatched.length };
	const latestAt = records.at(-1)?.at;
	const latest = records.filter(function(record): boolean {
		return(record.at === latestAt);
	});
	const notComparableReasons = [...new Set(latest.flatMap(function(record): readonly NotComparableReason[] {
		if (record.verdict.kind !== 'not-comparable-yet') {
			return([]);
		}
		return(record.verdict.reasons);
	}))];
	const confidence: ConfidenceBound = { kind: 'not-sampled' };
	const summary = { counts, confidence, notComparableReasons, representativeChecksums: distinctChecksums(latest) };
	const latestCounted = comparable.at(-1)?.at;
	if (latestCounted === undefined) {
		return({ verdict: 'not-comparable-yet', ...summary, firstDivergence: null });
	}
	const agreed = comparable.some(function(record): boolean {
		return(record.at === latestCounted && record.verdict.kind === 'pass');
	});
	if (agreed) {
		return({ verdict: 'pass', ...summary, firstDivergence: null });
	}
	let firstDivergence: FirstDivergence | null = null;
	const first = mismatched[0];
	if (first?.verdict.kind === 'fail') {
		const traced = first.verdict.bisect.sweep.firstDivergence;
		firstDivergence = { at: first.at, representative: first.representative, field: 'checksum', account: traced?.account ?? '', staple: traced?.staple ?? null };
	}
	return({ verdict: 'fail', ...summary, firstDivergence });
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

function sweepConfidenceOf(compared: number, diverged: number): ConfidenceBound {
	if (compared === 0) {
		return({ kind: 'none', why: 'no account compared yet' });
	}
	if (diverged > 0) {
		return({ kind: 'observed', samples: compared, divergences: diverged });
	}
	return({ kind: 'rule-of-three', samples: compared, level: 0.95, divergenceRateBelow: RULE_OF_THREE / compared });
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
	const confidence = sweepConfidenceOf(latest.length, divergedNow.length);
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

function checksumRecords(records: readonly ParityRecord[]): readonly ChecksumRecord[] {
	return(records.filter(function(record): record is ChecksumRecord {
		return(record.kind === 'checksum');
	}));
}

function sweepRecords(records: readonly ParityRecord[]): readonly SweepRecord[] {
	return(records.filter(function(record): record is SweepRecord {
		return(record.kind === 'sweep');
	}));
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
};

export function parityReportOf(input: ReportInput): ParityReport {
	const { records } = input.log;
	return({
		generatedAt: input.generatedAt.toISOString(),
		follower: { completedPass: isoOrNull(input.progress.completedPass), heldBefore: isoOrNull(input.progress.heldBefore) },
		logUnreadableLines: input.log.unreadableLines,
		signals: {
			checksum: checksumSignalOf(checksumRecords(records)),
			sweep: sweepSignalOf(sweepRecords(records), input.sweep),
			apiDiff: { verdict: 'not-implemented' },
			shadowVotes: { verdict: 'not-implemented' }
		}
	});
}

/** Where the sweep stands: its cursor, and the first divergence it recorded. */
export async function sweepPointerOf(log: ParityLog, cursorPath: string): Promise<SweepPointer> {
	const first = sweepRecords((await log.read()).records).find(function(record): boolean {
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
	readonly gapMilliseconds: number;
	readonly wait: (milliseconds: number) => Promise<void>;
	readonly stopped: AbortSignal;
};

/** Compares the checksum now and a sample of the sweep from its cursor, records both, and reports on the whole log. */
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
	await run.log.append(checksums);
	await sweepAccounts({ follower: run.follower, representatives: run.representatives, store: run.store, log: run.log, cursorPath: run.cursorPath, accounts: run.sampleAccounts, stopped: run.stopped });
	const cursor = await readSweepCursor(run.cursorPath);
	const sweep = { knownAccounts: await run.store.accountCount(), cursor, walkedThisLap: await run.store.accountsUpTo(cursor.afterRowID) };
	return(parityReportOf({ generatedAt: new Date(), progress: await run.store.progress(), sweep, log: await run.log.read() }));
}
