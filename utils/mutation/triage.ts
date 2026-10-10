/**
 * The statuses of a mutant in Stryker's JSON report, which follows the
 * mutation testing report schema.
 */
export const MUTANT_STATUSES = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'CompileError', 'RuntimeError', 'Ignored', 'Pending'] as const;

export type MutantStatus = typeof MUTANT_STATUSES[number];

/**
 * Which mutant an entry names: where its replaced code starts and ends, its
 * mutator, and its replacement, so that no other mutant of the same mutator
 * at the same place can pass under the entry's reason.
 */
export type MutantPlace = string & { readonly __mutantPlace: never };

/** A position in a source file, as Stryker reports it: both one-based. */
export type SourcePosition = {
	readonly line: number;
	readonly column: number;
};

export type MutantIdentity = {
	readonly file: string;
	readonly start: SourcePosition;
	readonly end: SourcePosition;
	readonly mutatorName: string;
	readonly replacement: string;
};

export type ReportedMutant = {
	readonly place: MutantPlace;
	readonly file: string;
	readonly status: MutantStatus;
	/**
	 * A survivor of a run that completed no test, of code that runs as its
	 * module loads. Under such a mutant every test file can fail to load, and
	 * Stryker 10.0.0's vitest runner then reports the mutant as surviving the
	 * empty run, though no test ran to let it survive. Any other survivor of
	 * an empty run is one whose covering tests the runner failed to select,
	 * so it stays unjudged and needs an entry.
	 */
	readonly ranNoTest: boolean;
};

export type TriageClass = 'equivalent' | 'harmless';

export type TriageEntry = {
	readonly place: MutantPlace;
	readonly file: string;
	readonly triage: TriageClass;
	readonly reason: string;
};

/** A module's counts, and its score before and after triage, in percent. */
export type ModuleAssessment = {
	readonly file: string;
	readonly killed: number;
	readonly timedOut: number;
	readonly survived: number;
	readonly noCoverage: number;
	readonly ranNoTest: number;
	readonly equivalent: number;
	readonly harmless: number;
	readonly scoreBefore: number;
	readonly scoreAfter: number;
};

export type Assessment = {
	readonly modules: readonly ModuleAssessment[];
	/** Surviving mutants that no triage entry accounts for. */
	readonly unaccounted: readonly ReportedMutant[];
	/** Mutants reported as surviving a run that completed no test, which the scores leave out as Stryker leaves out a run that failed. */
	readonly ranNoTest: readonly ReportedMutant[];
	/** Entries for a reported module that name no surviving mutant: the code moved, or a test now kills it. */
	readonly stale: readonly TriageEntry[];
};

/** The lowest score a module may have after triage. */
export const MINIMUM_SCORE = 90;

function positionText({ line, column }: SourcePosition): string {
	return(`${String(line)}:${String(column)}`);
}

/** The mutant as an entry spells it, the replacement as a JSON string. */
export function placeOf({ file, start, end, mutatorName, replacement }: MutantIdentity): MutantPlace {
	return(`${file}:${positionText(start)}-${positionText(end)} ${mutatorName} ${JSON.stringify(replacement)}` as MutantPlace);
}

type JSONObject = { readonly [key: string]: unknown };

function isObject(value: unknown): value is JSONObject {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

function field(object: JSONObject, name: string, where: string): unknown {
	if (!(name in object)) {
		throw(new Error(`${where} has no ${name}`));
	}
	return(object[name]);
}

function objectAt(object: JSONObject, name: string, where: string): JSONObject {
	const value = field(object, name, where);
	if (!isObject(value)) {
		throw(new Error(`${where}.${name} is not an object`));
	}
	return(value);
}

function positiveIntegerAt(object: JSONObject, name: string, where: string): number {
	const value = field(object, name, where);
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw(new Error(`${where}.${name} is not a positive integer`));
	}
	return(value);
}

function stringAt(object: JSONObject, name: string, where: string): string {
	const value = field(object, name, where);
	if (typeof value !== 'string' || value === '') {
		throw(new Error(`${where}.${name} is not a non-empty string`));
	}
	return(value);
}

// A replacement may be empty, as when a statement is removed.
function textAt(object: JSONObject, name: string, where: string): string {
	const value = field(object, name, where);
	if (typeof value !== 'string') {
		throw(new Error(`${where}.${name} is not a string`));
	}
	return(value);
}

function testsCompletedAt(object: JSONObject, where: string): number | undefined {
	if (!('testsCompleted' in object)) {
		return(undefined);
	}
	const value = object['testsCompleted'];
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw(new Error(`${where}.testsCompleted is not a whole number`));
	}
	return(value);
}

function staticAt(object: JSONObject, where: string): boolean {
	if (!('static' in object)) {
		return(false);
	}
	const value = object['static'];
	if (typeof value !== 'boolean') {
		throw(new Error(`${where}.static is not a boolean`));
	}
	return(value);
}

function positionAt(object: JSONObject, name: string, where: string): SourcePosition {
	const position = objectAt(object, name, where);
	const positionWhere = `${where}.${name}`;
	return({ line: positiveIntegerAt(position, 'line', positionWhere), column: positiveIntegerAt(position, 'column', positionWhere) });
}

function isMutantStatus(value: string): value is MutantStatus {
	return(MUTANT_STATUSES.some(function(status): boolean {
		return(status === value);
	}));
}

/** The mutants of a Stryker JSON report, each with its place and status. */
export function parseReport(report: unknown): ReportedMutant[] {
	if (!isObject(report)) {
		throw(new Error('the report is not an object'));
	}
	const mutants: ReportedMutant[] = [];
	for (const [file, entry] of Object.entries(objectAt(report, 'files', 'the report'))) {
		const where = `the report's ${file}`;
		if (!isObject(entry)) {
			throw(new Error(`${where} is not an object`));
		}
		const listed = field(entry, 'mutants', where);
		if (!Array.isArray(listed)) {
			throw(new Error(`${where}.mutants is not a list`));
		}
		for (const [index, mutant] of listed.entries()) {
			const mutantWhere = `${where}.mutants[${String(index)}]`;
			if (!isObject(mutant)) {
				throw(new Error(`${mutantWhere} is not an object`));
			}
			const location = objectAt(mutant, 'location', mutantWhere);
			const status = stringAt(mutant, 'status', mutantWhere);
			if (!isMutantStatus(status)) {
				throw(new Error(`${mutantWhere}.status is the unknown status ${status}`));
			}
			mutants.push({
				ranNoTest: status === 'Survived' && testsCompletedAt(mutant, mutantWhere) === 0 && staticAt(mutant, mutantWhere),
				place: placeOf({
					file,
					start: positionAt(location, 'start', `${mutantWhere}.location`),
					end: positionAt(location, 'end', `${mutantWhere}.location`),
					mutatorName: stringAt(mutant, 'mutatorName', mutantWhere),
					replacement: textAt(mutant, 'replacement', mutantWhere)
				}),
				file,
				status
			});
		}
	}
	return(mutants);
}

const POSITION = '([1-9][0-9]*):([1-9][0-9]*)';

const ENTRY = new RegExp(`^- ([^\\s:]+):${POSITION}-${POSITION} ([A-Za-z]+) ("(?:[^"\\\\]|\\\\.)*") (equivalent|harmless): (\\S.*)$`);

function triageClassOf(text: string | undefined): TriageClass | undefined {
	switch (text) {
		case 'equivalent':
		case 'harmless':
			return(text);
		default:
			return(undefined);
	}
}

function replacementOf(json: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return(undefined);
	}
	if (typeof parsed !== 'string') {
		return(undefined);
	}
	return(parsed);
}

/**
 * The entries of a triage list: every line that starts with "- " is one, as
 * "- <file>:<line>:<column>-<line>:<column> <mutator> <replacement as a JSON
 * string> <equivalent|harmless>: <reason>". Other lines are prose.
 */
export function parseTriage(text: string): TriageEntry[] {
	const entries: TriageEntry[] = [];
	const seen = new Set<MutantPlace>();
	for (const [index, line] of text.split('\n').entries()) {
		if (!line.startsWith('- ')) {
			continue;
		}
		const where = `line ${String(index + 1)} of the triage list`;
		const [, file, startLine, startColumn, endLine, endColumn, mutatorName, replacement, triageText, reason] = ENTRY.exec(line) ?? [];
		const triage = triageClassOf(triageText);
		if (file === undefined || startLine === undefined || startColumn === undefined || endLine === undefined || endColumn === undefined || mutatorName === undefined || replacement === undefined || triage === undefined || reason === undefined) {
			throw(new Error(`${where} is not "- <file>:<line>:<column>-<line>:<column> <mutator> <replacement as a JSON string> <equivalent|harmless>: <reason>": ${line}`));
		}
		const parsedReplacement = replacementOf(replacement);
		if (parsedReplacement === undefined) {
			throw(new Error(`${where} has a replacement that is not a JSON string: ${line}`));
		}
		const place = placeOf({
			file,
			start: { line: Number(startLine), column: Number(startColumn) },
			end: { line: Number(endLine), column: Number(endColumn) },
			mutatorName,
			replacement: parsedReplacement
		});
		if (seen.has(place)) {
			throw(new Error(`${where} names ${place} again`));
		}
		seen.add(place);
		entries.push({ place, file, triage, reason });
	}
	return(entries);
}

function percent(detected: number, valid: number): number {
	if (valid === 0) {
		return(100);
	}
	return(100 * detected / valid);
}

function countOf(mutants: readonly ReportedMutant[], status: MutantStatus): number {
	return(mutants.filter(function(mutant): boolean {
		return(mutant.status === status);
	}).length);
}

function isSurvivor(mutant: ReportedMutant): boolean {
	return((mutant.status === 'Survived' && !mutant.ranNoTest) || mutant.status === 'NoCoverage');
}

/*
 * The score is Stryker's: the detected mutants among those that ran.
 * Equivalent mutants behave as the original does, so no test can detect them
 * and they leave the count after triage; harmless ones change behavior that
 * no caller depends on, and stay in it as undetected.
 */
function assessModule(file: string, mutants: readonly ReportedMutant[], entries: ReadonlyMap<MutantPlace, TriageEntry>): ModuleAssessment {
	const killed = countOf(mutants, 'Killed');
	const timedOut = countOf(mutants, 'Timeout');
	const ranNoTest = mutants.filter(function(mutant): boolean {
		return(mutant.ranNoTest);
	}).length;
	const survived = countOf(mutants, 'Survived') - ranNoTest;
	const noCoverage = countOf(mutants, 'NoCoverage');
	let equivalent = 0;
	let harmless = 0;
	for (const mutant of mutants.filter(isSurvivor)) {
		const triage = entries.get(mutant.place)?.triage;
		if (triage === 'equivalent') {
			equivalent++;
		} else if (triage === 'harmless') {
			harmless++;
		}
	}
	const detected = killed + timedOut;
	const valid = detected + survived + noCoverage;
	return({
		file,
		killed,
		timedOut,
		survived,
		noCoverage,
		ranNoTest,
		equivalent,
		harmless,
		scoreBefore: percent(detected, valid),
		scoreAfter: percent(detected, valid - equivalent)
	});
}

export function assess(mutants: readonly ReportedMutant[], entries: readonly TriageEntry[]): Assessment {
	const byPlace = new Map<MutantPlace, TriageEntry>(entries.map(function(entry): [MutantPlace, TriageEntry] {
		return([entry.place, entry]);
	}));
	const files = [...new Set(mutants.map(function(mutant): string {
		return(mutant.file);
	}))].sort();
	const surviving = new Set<MutantPlace>(mutants.filter(isSurvivor).map(function(mutant): MutantPlace {
		return(mutant.place);
	}));
	return({
		modules: files.map(function(file): ModuleAssessment {
			return(assessModule(file, mutants.filter(function(mutant): boolean {
				return(mutant.file === file);
			}), byPlace));
		}),
		unaccounted: mutants.filter(function(mutant): boolean {
			return(isSurvivor(mutant) && !byPlace.has(mutant.place));
		}),
		ranNoTest: mutants.filter(function(mutant): boolean {
			return(mutant.ranNoTest);
		}),
		stale: entries.filter(function(entry): boolean {
			return(files.includes(entry.file) && !surviving.has(entry.place));
		})
	});
}

/** Whether the module passes: every survivor triaged, no stale entry, and every module at the minimum score. */
export function passes(assessment: Assessment): boolean {
	return(assessment.unaccounted.length === 0 && assessment.stale.length === 0 && assessment.modules.every(function(module): boolean {
		return(module.scoreAfter >= MINIMUM_SCORE);
	}));
}
