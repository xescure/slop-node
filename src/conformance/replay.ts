import { isDeepStrictEqual } from 'node:util';
import { vi } from 'vitest';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { freezeClock } from '../testing/network.js';
import { momentDate } from './case.js';
import type { CaseExpectation, VoteCase } from './case.js';
import { CaseRunner } from './runner.js';

export type ReplayFailure = {
	readonly caseID: string;
	readonly step: number;
	readonly expected: CaseExpectation;
	readonly actual: string;
};

/**
 * Executes a case from its data alone: the network is rebuilt from the
 * case's seeds and weights, every step runs with the clock frozen at its
 * moment, and every step's outcome is compared with its expectation. A step
 * that cannot be judged, such as one that references a vote an earlier step
 * failed to produce, ends the case.
 */
export async function replayVoteCase(voteCase: VoteCase, createDriver: () => Promise<LedgerStorageDriverBase>): Promise<readonly ReplayFailure[]> {
	const failures: ReplayFailure[] = [];
	const [first] = voteCase.steps;
	if (first === undefined) {
		return(failures);
	}
	try {
		freezeClock(momentDate(first.moment));
		const runner = await CaseRunner.start(voteCase, createDriver);
		for (const [index, step] of voteCase.steps.entries()) {
			freezeClock(momentDate(step.moment));
			const result = await runner.run(step.actor, step.action);
			if (result.kind === 'broken') {
				failures.push({ caseID: voteCase.id, step: index, expected: step.expect, actual: `broken: ${result.reason}` });
				break;
			}
			if (!isDeepStrictEqual(result.observed, step.expect)) {
				failures.push({ caseID: voteCase.id, step: index, expected: step.expect, actual: JSON.stringify(result.observed) });
			}
		}
	} finally {
		vi.useRealTimers();
	}
	return(failures);
}
