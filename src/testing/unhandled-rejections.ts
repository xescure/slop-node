import { onTestFinished } from 'vitest';

export type UnhandledRejections = {
	/** The reason of every rejection that nothing handled, in order. */
	readonly reasons: readonly unknown[];
	/** Resolves with the reason of the first rejection that nothing handles from now on. */
	readonly next: () => Promise<unknown>;
};

/**
 * Until the test ends, records the rejections nothing handles in place of
 * the process's own listeners, vitest's among them, which would otherwise
 * fail the run for the rejection the test means to observe.
 */
export function captureUnhandledRejections(): UnhandledRejections {
	const previous = process.listeners('unhandledRejection');
	const reasons: unknown[] = [];
	let waiting: ((reason: unknown) => void)[] = [];
	const record = function(reason: unknown): void {
		reasons.push(reason);
		const resolvers = waiting;
		waiting = [];
		for (const resolve of resolvers) {
			resolve(reason);
		}
	};
	process.removeAllListeners('unhandledRejection');
	process.on('unhandledRejection', record);
	onTestFinished(function() {
		process.off('unhandledRejection', record);
		for (const listener of previous) {
			process.on('unhandledRejection', listener);
		}
	});
	return({
		reasons,
		next: function(): Promise<unknown> {
			return(new Promise<unknown>(function(resolve) {
				waiting.push(resolve);
			}));
		}
	});
}
