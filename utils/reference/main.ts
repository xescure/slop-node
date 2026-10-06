import { parseArgs } from 'node:util';
import { readReferenceSource, writeReference } from './write.js';

const usage = 'usage: main.js --package <package root> --out <output directory>';

async function run(): Promise<void> {
	const { values } = parseArgs({
		options: { package: { type: 'string' }, out: { type: 'string' } },
		strict: true,
		allowPositionals: false
	});
	if (values.package === undefined || values.out === undefined) {
		throw(new Error(usage));
	}
	await writeReference(await readReferenceSource(values.package), values.out);
}

function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		return(error.message.split('\n')[0] ?? usage);
	}
	return(String(error));
}

try {
	await run();
} catch (error: unknown) {
	console.error(describeFailure(error));
	process.exitCode = 1;
}
