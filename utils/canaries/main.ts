import { parseArgs } from 'node:util';
import { CANARIES } from './list.js';
import type { Canary } from './list.js';
import { CanariesRefused, runCanaries } from './run.js';

const usage = 'usage: main.js [--canary <name>]... [--keep]';

class UsageError extends Error {}

function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		return(error.stack ?? error.message);
	}
	return(String(error));
}

type Options = {
	readonly canaries: readonly Canary[];
	readonly keep: boolean;
};

function parseOptions(): Options {
	let values: { readonly canary?: string[] | undefined; readonly keep?: boolean | undefined };
	try {
		({ values } = parseArgs({
			options: { canary: { type: 'string', multiple: true }, keep: { type: 'boolean', default: false } },
			strict: true,
			allowPositionals: false
		}));
	} catch (error: unknown) {
		throw(new UsageError(`${String(error)}; ${usage}`, { cause: error }));
	}
	const names = values.canary;
	if (names === undefined) {
		return({ canaries: CANARIES, keep: values.keep === true });
	}
	const canaries = names.map(function(name): Canary {
		const canary = CANARIES.find(function(candidate): boolean {
			return(candidate.name === name);
		});
		if (canary === undefined) {
			throw(new UsageError(`no canary is named ${name}; ${usage}`));
		}
		return(canary);
	});
	return({ canaries, keep: values.keep === true });
}

try {
	const options = parseOptions();
	if (!await runCanaries({ root: process.cwd(), canaries: options.canaries, keep: options.keep, write: console.log })) {
		process.exitCode = 1;
	}
} catch (error: unknown) {
	if (error instanceof UsageError || error instanceof CanariesRefused) {
		console.error(error.message);
		process.exitCode = 2;
	} else {
		console.error(describeFailure(error));
		process.exitCode = 1;
	}
}
