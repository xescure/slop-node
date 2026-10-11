// @ts-check
import { beforeEach } from 'vitest';
import { selectedModule } from './modules.js';

const selected = selectedModule().selectedCases;

/**
 * The names of the case and of every block it is declared in.
 * @param {import('vitest').TestContext['task']} task
 * @returns {string[]}
 */
function namesOf(task) {
	const names = [task.name];
	for (let suite = task.suite; suite !== undefined; suite = suite.suite) {
		names.push(suite.name);
	}
	return(names);
}

/*
 * Of a test file the module selects cases of, a case that neither it nor a
 * block it is declared in is named by is skipped before its own hooks run,
 * so it reaches no mutant, and Stryker runs it for none.
 */
beforeEach(function(context) {
	const names = selected[context.task.file.name];
	if (names !== undefined && !namesOf(context.task).some(function(name) {
		return(names.includes(name));
	})) {
		context.skip();
	}
});
