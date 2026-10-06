import { parseArgs } from 'node:util';
import { readReferenceSource, writeReference } from './write.js';

const usage = 'usage: main.js --package <package root> --out <output directory>';

class UsageError extends Error {}

function describeFirstLine(error: unknown): string {
	if (error instanceof Error) {
		return(error.message.replace(/\n[\s\S]*$/, ''));
	}
	return(String(error));
}

function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		return(error.stack ?? error.message);
	}
	return(String(error));
}

function parseOptions(): { readonly packageRoot: string; readonly outputRoot: string } {
	try {
		const { values } = parseArgs({
			options: { package: { type: 'string' }, out: { type: 'string' } },
			strict: true,
			allowPositionals: false
		});
		if (values.package !== undefined && values.out !== undefined) {
			return({ packageRoot: values.package, outputRoot: values.out });
		}
	} catch (error: unknown) {
		throw(new UsageError(`${describeFirstLine(error)}; ${usage}`, { cause: error }));
	}
	throw(new UsageError(usage));
}

async function run(): Promise<void> {
	const { packageRoot, outputRoot } = parseOptions();
	await writeReference(await readReferenceSource(packageRoot), outputRoot);
}

try {
	await run();
} catch (error: unknown) {
	if (error instanceof UsageError) {
		console.error(error.message);
		process.exitCode = 2;
	} else {
		console.error(describeFailure(error));
		process.exitCode = 1;
	}
}
