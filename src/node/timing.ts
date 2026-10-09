import type { RequestTiming } from '@keetanetwork/keetanet-client/lib/node/timing.js';

function recordNothing(): void {
	// No section was recorded, so ending one has nothing to change.
}

/**
 * Makes the timing record no section of work, for a node that lives as long
 * as its process. A request's timing is read from the copy of the node the
 * request runs on, which upstream builds with a timing of its own
 * [Keeta TS] index.js:71310-71311; a long-lived node's is never read, yet
 * every transaction of the work it does itself, catching up, its garbage
 * collection, messages from peers, a replay, would add sections to it until
 * the process ends [Keeta TS] index.js:69397-69409, 70297, 70339,
 * 71538-71560, 71578-71584, 71630-71637: about 20,000 a minute while a node
 * catches up on the main network.
 */
export function recordNoTiming(timing: RequestTiming): void {
	timing.startTime = function(section) {
		return({ id: Symbol(section), end: recordNothing, [Symbol.dispose]: recordNothing });
	};
	timing.runTimer = function<Result>(_section: string, code: () => Promise<Result>): Promise<Result> {
		return(code());
	};
}
