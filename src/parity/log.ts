import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

export type ParityRecord = ChecksumRecord | SweepRecord;

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
		case 'sweep':
			return(sweepRecordOf(value));
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

