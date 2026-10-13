import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';
import { fillIntegrity, formatLock, parseLock, specOf, uncheckedEntries } from './lock.js';
import type { PinnedPackage } from './lock.js';

const usage = 'usage: main.js --lock <package-lock.json> [--check]';

/** Each lookup is an npm process of its own, which spends most of its time waiting on the registry. */
const LOOKUP_CONCURRENCY = 8;

class UsageError extends Error {}

function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		return(error.stack ?? error.message);
	}
	return(String(error));
}

function parseOptions(): { readonly lock: string; readonly check: boolean } {
	try {
		const { values } = parseArgs({
			options: { lock: { type: 'string' }, check: { type: 'boolean', default: false } },
			strict: true,
			allowPositionals: false
		});
		if (values.lock !== undefined) {
			return({ lock: values.lock, check: values.check });
		}
	} catch (error: unknown) {
		throw(new UsageError(`${String(error)}; ${usage}`, { cause: error }));
	}
	throw(new UsageError(usage));
}

const run = promisify(execFile);

/** What npm, under its own configuration, reads from the registry as the package's integrity. */
async function registryIntegrity(pinned: PinnedPackage): Promise<string> {
	const { stdout } = await run('npm', ['view', specOf(pinned), 'dist.integrity']);
	return(stdout.trim());
}

async function check(path: string): Promise<boolean> {
	const unchecked = uncheckedEntries(parseLock(await readFile(path, 'utf-8')));
	if (unchecked.length === 0) {
		return(true);
	}
	console.error(`Error: ${path} has entries without integrity; "make lock-integrity" fills them from the registry:`);
	for (const entry of unchecked) {
		console.error(specOf(entry));
	}
	return(false);
}

async function fill(path: string): Promise<void> {
	const lock = parseLock(await readFile(path, 'utf-8'));
	const count = uncheckedEntries(lock).length;
	await writeFile(path, formatLock(await fillIntegrity(lock, registryIntegrity, LOOKUP_CONCURRENCY)));
	console.log(`filled the integrity of ${String(count)} entries of ${path}`);
}

try {
	const options = parseOptions();
	if (options.check) {
		if (!await check(options.lock)) {
			process.exitCode = 1;
		}
	} else {
		await fill(options.lock);
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
