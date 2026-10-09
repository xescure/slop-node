import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNever } from '../util/assert-never.js';
import { DEFAULT_CHECKSUM_GAP_MILLISECONDS } from './checksum.js';
import { defaultFollowerDirectory, optionsOf, setting } from './follower-config.js';

export type ParityCommand =
	| { readonly kind: 'checksum'; readonly directory: string; readonly gapMilliseconds: number }
	| { readonly kind: 'sweep'; readonly directory: string; readonly accounts: number }
	| { readonly kind: 'report'; readonly directory: string; readonly sampleAccounts: number; readonly gapMilliseconds: number };

export const DEFAULT_SWEEP_ACCOUNTS = 100;

/** The fresh sweep sample of a report: a few accounts for each representative, a minute or so at their pace. */
export const DEFAULT_REPORT_SAMPLE_ACCOUNTS = 16;

const MAX_GAP_MILLISECONDS = 600_000;

/**
 * The command the arguments name, or undefined for a command line it does
 * not understand. The directory is taken as written; followerDirectory
 * checks it.
 */
export function parseParityCommand(argv: readonly string[], home: string): ParityCommand | undefined {
	const [name, ...rest] = argv;
	let valued: readonly string[];
	switch (name) {
		case 'checksum':
			valued = ['--directory', '--gap-ms'];
			break;
		case 'sweep':
			valued = ['--directory', '--accounts'];
			break;
		case 'report':
			valued = ['--directory', '--sample', '--gap-ms'];
			break;
		default:
			return(undefined);
	}
	const options = optionsOf(rest, valued, []);
	if (options === undefined) {
		return(undefined);
	}
	const directory = options.get('--directory') ?? defaultFollowerDirectory(home);
	const gapMilliseconds = setting(options, '--gap-ms', MAX_GAP_MILLISECONDS, DEFAULT_CHECKSUM_GAP_MILLISECONDS);
	switch (name) {
		case 'checksum':
			if (gapMilliseconds === undefined) {
				return(undefined);
			}
			return({ kind: name, directory, gapMilliseconds });
		case 'sweep': {
			const accounts = setting(options, '--accounts', Number.MAX_SAFE_INTEGER, DEFAULT_SWEEP_ACCOUNTS);
			if (accounts === undefined) {
				return(undefined);
			}
			return({ kind: name, directory, accounts });
		}
		case 'report': {
			const sampleAccounts = setting(options, '--sample', Number.MAX_SAFE_INTEGER, DEFAULT_REPORT_SAMPLE_ACCOUNTS);
			if (sampleAccounts === undefined || gapMilliseconds === undefined) {
				return(undefined);
			}
			return({ kind: name, directory, sampleAccounts, gapMilliseconds });
		}
		default:
			return(assertNever(name));
	}
}

/** Held by the one parity tool that may run at a time in a follower's directory. */
export const PARITY_LOCK_FILE = 'parity.lock';

function isAlive(processID: number): boolean {
	try {
		process.kill(processID, 0);
		return(true);
	} catch (error: unknown) {
		// EPERM: the process exists, under another user.
		return(error instanceof Error && 'code' in error && error.code === 'EPERM');
	}
}

/**
 * Takes the lock, or fails while another parity tool holds it. The tools
 * pace their requests to each representative within one process, so only
 * one may run at a time for the pace to hold across all of them. A lock
 * left by a process that has exited is taken over.
 */
export async function lockParity(directory: string, processID: number = process.pid): Promise<() => Promise<void>> {
	const path = join(directory, PARITY_LOCK_FILE);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const file = await open(path, 'wx');
			await file.write(`${String(processID)}\n`);
			await file.close();
			return(async function(): Promise<void> {
				await rm(path, { force: true });
			});
		} catch (error: unknown) {
			if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
				throw(error);
			}
		}
		const holder = Number((await readFile(path, 'utf8')).trim());
		if (Number.isSafeInteger(holder) && holder > 0 && isAlive(holder)) {
			throw(new Error(`another parity tool (process ${String(holder)}) is running in ${directory}`));
		}
		await rm(path, { force: true });
	}
	throw(new Error(`could not take ${path}`));
}
