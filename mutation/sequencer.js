// @ts-check
import { statSync } from 'node:fs';
import { BaseSequencer } from 'vitest/node';

/**
 * Runs a module's test files smallest first: the unit tests of a file before
 * a simulation of the whole. A mutant's run ends at its first failing test,
 * and vitest's own order, longest first, would make every mutant a unit test
 * kills wait for the simulation.
 */
export class SmallestFirst extends BaseSequencer {
	/**
	 * @param {import('vitest/node').TestSpecification[]} files
	 * @returns {Promise<import('vitest/node').TestSpecification[]>}
	 */
	sort(files) {
		return(Promise.resolve([...files].sort(function(left, right) {
			return(statSync(left.moduleId).size - statSync(right.moduleId).size);
		})));
	}
}
