import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { patchOf } from './list.js';
import type { Canary, CanaryTest } from './list.js';
import { describeName } from './report.js';
import { definesTest, titleTemplatesOf } from './titles.js';
import type { TitleTemplate } from './titles.js';

const run = promisify(execFile);

function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		const stderr: unknown = Reflect.get(error, 'stderr');
		if (typeof stderr === 'string' && stderr.trim() !== '') {
			return(stderr.trim());
		}
		return(error.message);
	}
	return(String(error));
}

/** Why the canary's patch does not apply to the tree, if it does not. */
export async function patchProblem(canary: Canary, tree: string, patch: string = join(tree, patchOf(canary))): Promise<string | undefined> {
	try {
		await run('git', ['apply', '--check', patch], { cwd: tree });
	} catch (error: unknown) {
		return(`the patch ${patchOf(canary)} no longer applies: ${describeFailure(error)}`);
	}
	return(undefined);
}

async function templatesIn(tree: string, file: string): Promise<readonly TitleTemplate[] | undefined> {
	let source: string;
	try {
		source = await readFile(join(tree, file), 'utf8');
	} catch {
		return(undefined);
	}
	return(titleTemplatesOf(source, file));
}

/** Why the tree no longer holds the named test, if it does not: its file is gone, or no titles there name it. */
export async function testProblem(test: CanaryTest, tree: string): Promise<string | undefined> {
	const templates: TitleTemplate[] = [];
	for (const file of new Set([test.file, ...test.titlesIn])) {
		const found = await templatesIn(tree, file);
		if (found === undefined) {
			return(`the test file ${file} no longer exists`);
		}
		templates.push(...found);
	}
	if (!definesTest(templates, test.name)) {
		return(`no test ${describeName(test.name)} is defined in ${[test.file, ...test.titlesIn.filter(function(file): boolean {
			return(file !== test.file);
		})].join(' or ')}`);
	}
	return(undefined);
}

/** Why the canary cannot be run against the tree: its patch does not apply, or a test it names is gone. */
export async function driftOf(canary: Canary, tree: string, patch?: string): Promise<string[]> {
	const problems: string[] = [];
	const patched = await patchProblem(canary, tree, patch);
	if (patched !== undefined) {
		problems.push(patched);
	}
	for (const test of canary.catchers) {
		const problem = await testProblem(test, tree);
		if (problem !== undefined) {
			problems.push(problem);
		}
	}
	return(problems);
}
