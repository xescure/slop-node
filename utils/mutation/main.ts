import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { MINIMUM_SCORE, assess, mutatedRangesOf, parseReport, parseTriage, passes } from './triage.js';
import type { Assessment, ModuleAssessment } from './triage.js';

const usage = 'usage: main.js --report <Stryker JSON report> --triage <triage list>';

class UsageError extends Error {}

function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		return(error.stack ?? error.message);
	}
	return(String(error));
}

function parseOptions(): { readonly report: string; readonly triage: string } {
	try {
		const { values } = parseArgs({
			options: { report: { type: 'string' }, triage: { type: 'string' } },
			strict: true,
			allowPositionals: false
		});
		if (values.report !== undefined && values.triage !== undefined) {
			return({ report: values.report, triage: values.triage });
		}
	} catch (error: unknown) {
		throw(new UsageError(`${String(error)}; ${usage}`, { cause: error }));
	}
	throw(new UsageError(usage));
}

function describeModule(module: ModuleAssessment): string {
	const counts = [
		`${String(module.killed)} killed`,
		`${String(module.timedOut)} timed out`,
		`${String(module.survived)} survived`,
		`${String(module.noCoverage)} not covered`,
		`${String(module.ranNoTest)} ran no test`,
		`${String(module.equivalent)} equivalent`,
		`${String(module.harmless)} harmless`
	];
	return(`${module.file}: ${module.scoreBefore.toFixed(2)}% before triage, ${module.scoreAfter.toFixed(2)}% after (${counts.join(', ')})`);
}

function describe(assessment: Assessment): string[] {
	const lines = assessment.modules.map(describeModule);
	for (const mutant of assessment.ranNoTest) {
		lines.push(`ran no test, so left out of the score: ${mutant.place}`);
	}
	for (const mutant of assessment.unaccounted) {
		lines.push(`unaccounted: ${mutant.place} (${mutant.status})`);
	}
	for (const entry of assessment.stale) {
		lines.push(`stale triage entry, no such surviving mutant: ${entry.place}`);
	}
	for (const module of assessment.modules) {
		if (module.scoreAfter < MINIMUM_SCORE) {
			lines.push(`below ${String(MINIMUM_SCORE)}% after triage: ${module.file}`);
		}
	}
	return(lines);
}

async function run(): Promise<boolean> {
	const options = parseOptions();
	const report: unknown = JSON.parse(await readFile(options.report, 'utf-8'));
	const assessment = assess(parseReport(report), parseTriage(await readFile(options.triage, 'utf-8')), mutatedRangesOf(report));
	for (const line of describe(assessment)) {
		console.log(line);
	}
	return(passes(assessment));
}

try {
	if (!await run()) {
		process.exitCode = 1;
	}
} catch (error: unknown) {
	if (error instanceof UsageError) {
		console.error(error.message);
		process.exitCode = 2;
	} else {
		console.error(describeFailure(error));
		process.exitCode = 1;
	}
}
