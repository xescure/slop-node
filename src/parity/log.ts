import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export type SweepOutcome =
	| { readonly kind: 'match'; readonly head: string | null; readonly staple: string | null }
	| { readonly kind: 'diverged'; readonly divergence: Divergence; readonly follower: unknown; readonly representative: unknown }
	/** Not compared: the two may hold the account at different points, so it is retried on a later lap. */
	| { readonly kind: 'skipped'; readonly reason: 'moving'; readonly side: MovingSide; readonly detail: string }
	| { readonly kind: 'skipped'; readonly reason: 'unanswered'; readonly detail: string };

export type SweepRecord = {
	readonly kind: 'sweep';
	readonly at: string;
	readonly representative: string;
	readonly account: string;
	readonly lap: number;
	readonly outcome: SweepOutcome;
};

/** Why a block count comparison does not count. */
export type BlockCountNotComparableReason = Extract<NotComparableReason, 'no-completed-pass' | 'follower-unanswered' | 'representative-unanswered'>;

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
	readonly follower: ChecksumWindow;
	readonly representativeWindow: ChecksumWindow;
	/** How far apart the two counts may be and still describe the same ledger, as reckoned for this comparison. */
	readonly toleranceBlocks: number;
	readonly verdict: BlockCountVerdict;
};

/** How the follower's stored checksum stands against the XOR of the blocks on its main ledger. */
export type CrossCheckOutcome =
	| { readonly kind: 'equal' }
	/** They differ by the blocks of these staples, committed after the statistic was last written: the node had not synced them yet. */
	| { readonly kind: 'unsynced'; readonly staples: readonly string[] }
	/**
	 * They differ by exactly the blocks of a run of staples committed one
	 * after another, whose statistics the node never wrote, as a node that
	 * stops without syncing leaves them (src/node/stats.ts).
	 */
	| { readonly kind: 'lost-run'; readonly firstSequence: string; readonly lastSequence: string; readonly staples: number; readonly firstMoment: string; readonly lastMoment: string }
	| { readonly kind: 'unexplained'; readonly offset: string };

export type CrossCheckRecord = {
	readonly kind: 'cross-check';
	readonly at: string;
	/** The stored statistic and the XOR of every main block's hash, both "0x" and uppercase hexadecimal. */
	readonly stored: string;
	readonly folded: string;
	readonly mainBlocks: number;
	readonly outcome: CrossCheckOutcome;
};

/** The comparison of one sampled request's answers. */
export type APIDiffOutcome =
	| { readonly kind: 'match' }
	/** The field is the path of the first that differs once both are normalized; the answers are kept as served. */
	| { readonly kind: 'diverged'; readonly field: string; readonly follower: unknown; readonly representative: unknown }
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
	/** The kinds of behaviour the representative's answer shows, as the capture set is told apart by; none when it was not compared. */
	readonly behaviours: readonly string[];
	readonly outcome: APIDiffOutcome;
};

export type ParityRecord = ChecksumRecord | BlockCountRecord | CrossCheckRecord | SweepRecord | APIDiffRecord;

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

const BLOCK_COUNT_REASONS: readonly BlockCountNotComparableReason[] = ['no-completed-pass', 'follower-unanswered', 'representative-unanswered'];

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
	const follower = windowOf(value['follower']);
	const representativeWindow = windowOf(value['representativeWindow']);
	const verdict = blockCountVerdictOf(value['verdict']);
	if (!isString(at) || !isString(representative) || !isStringOrNull(completedPass) || !isCount(toleranceBlocks) || follower === undefined || representativeWindow === undefined || verdict === undefined) {
		return(undefined);
	}
	return({ kind: 'block-count', at, representative, completedPass, follower, representativeWindow, toleranceBlocks, verdict });
}

function crossCheckOutcomeOf(value: unknown): CrossCheckOutcome | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'equal':
			return({ kind: 'equal' });
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
		case 'diverged': {
			const divergence = divergenceOf(value['divergence']);
			if (divergence === undefined) {
				return(undefined);
			}
			return({ kind: 'diverged', divergence, follower: value['follower'], representative: value['representative'] });
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

function apiDiffOutcomeOf(value: unknown): APIDiffOutcome | undefined {
	if (!isFields(value)) {
		return(undefined);
	}
	switch (value['kind']) {
		case 'match':
			return({ kind: 'match' });
		case 'diverged':
			if (!isString(value['field'])) {
				return(undefined);
			}
			return({ kind: 'diverged', field: value['field'], follower: value['follower'], representative: value['representative'] });
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
	const behaviours = listOf(value['behaviours'], function(behaviour): string | undefined {
		if (!isString(behaviour)) {
			return(undefined);
		}
		return(behaviour);
	});
	if (!isString(at) || !isString(representative) || !isString(route) || !isString(path) || behaviours === undefined || stratum === undefined || outcome === undefined) {
		return(undefined);
	}
	return({ kind: 'api-diff', at, representative, stratum, route, path, behaviours, outcome });
}

function sweepRecordOf(value: Fields): SweepRecord | undefined {
	const { at, representative, account, lap } = value;
	const outcome = sweepOutcomeOf(value['outcome']);
	if (!isString(at) || !isString(representative) || !isString(account) || !isCount(lap) || outcome === undefined) {
		return(undefined);
	}
	return({ kind: 'sweep', at, representative, account, lap, outcome });
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
		case 'api-diff':
			return(apiDiffRecordOf(value));
		default:
			return(undefined);
	}
}

/** The sweep cursor a stored value holds, or nothing when it holds none. */
export function sweepCursorOf(value: unknown): SweepCursor | undefined {
	return(cursorOf(value));
}

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
		await appendFile(this.path, records.map(function(record): string {
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

