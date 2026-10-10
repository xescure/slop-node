/**
 * The statuses of a mutant in Stryker's JSON report, which follows the
 * mutation testing report schema.
 */
export const MUTANT_STATUSES = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'CompileError', 'RuntimeError', 'Ignored', 'Pending'] as const;

export type MutantStatus = typeof MUTANT_STATUSES[number];

/** Where a mutant sits, and what it does there, as a triage entry names it. */
export type MutantPlace = string & { readonly __mutantPlace: never };

export type ReportedMutant = {
	readonly place: MutantPlace;
	readonly file: string;
	readonly status: MutantStatus;
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
	readonly equivalent: number;
	readonly harmless: number;
	readonly scoreBefore: number;
	readonly scoreAfter: number;
};

export type Assessment = {
	readonly modules: readonly ModuleAssessment[];
	/** Surviving mutants that no triage entry accounts for. */
	readonly unaccounted: readonly ReportedMutant[];
	/** Entries for a reported module that name no surviving mutant: the code moved, or a test now kills it. */
	readonly stale: readonly TriageEntry[];
};

/** The lowest score a module may have after triage. */
export const MINIMUM_SCORE = 90;

export function placeOf(file: string, line: number, column: number, mutatorName: string): MutantPlace {
	return(`${file}:${String(line)}:${String(column)} ${mutatorName}` as MutantPlace);
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
			const start = objectAt(objectAt(mutant, 'location', mutantWhere), 'start', `${mutantWhere}.location`);
			const status = stringAt(mutant, 'status', mutantWhere);
			if (!isMutantStatus(status)) {
				throw(new Error(`${mutantWhere}.status is the unknown status ${status}`));
			}
			mutants.push({
				place: placeOf(file, positiveIntegerAt(start, 'line', `${mutantWhere}.location.start`), positiveIntegerAt(start, 'column', `${mutantWhere}.location.start`), stringAt(mutant, 'mutatorName', mutantWhere)),
				file,
				status
			});
		}
	}
	return(mutants);
}

const ENTRY = /^- (?<file>[^\s:]+):(?<line>[1-9][0-9]*):(?<column>[1-9][0-9]*) (?<mutator>[A-Za-z]+) (?<triage>equivalent|harmless): (?<reason>\S.*)$/;

/**
 * The entries of a triage list: every line that starts with "- " is one, as
 * "- <file>:<line>:<column> <mutator> <equivalent|harmless>: <reason>".
 * Other lines are prose.
 */
export function parseTriage(text: string): TriageEntry[] {
	const entries: TriageEntry[] = [];
	const seen = new Set<MutantPlace>();
	for (const [index, line] of text.split('\n').entries()) {
		if (!line.startsWith('- ')) {
			continue;
		}
		const groups = ENTRY.exec(line)?.groups;
		const file = groups?.['file'];
		const lineNumber = groups?.['line'];
		const column = groups?.['column'];
		const mutator = groups?.['mutator'];
		const triage = groups?.['triage'];
		const reason = groups?.['reason'];
		if (file === undefined || lineNumber === undefined || column === undefined || mutator === undefined || reason === undefined || (triage !== 'equivalent' && triage !== 'harmless')) {
			throw(new Error(`line ${String(index + 1)} of the triage list is not "- <file>:<line>:<column> <mutator> <equivalent|harmless>: <reason>": ${line}`));
		}
		const place = placeOf(file, Number(lineNumber), Number(column), mutator);
		if (seen.has(place)) {
			throw(new Error(`line ${String(index + 1)} of the triage list names ${place} again`));
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
	return(mutant.status === 'Survived' || mutant.status === 'NoCoverage');
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
	const survived = countOf(mutants, 'Survived');
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
