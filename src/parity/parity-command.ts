import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNever } from '../util/assert-never.js';
import { DEFAULT_CHECKSUM_GAP_MILLISECONDS } from './checksum.js';
import { defaultFollowerDirectory, optionsOf, setting } from './follower-config.js';

export type ParityCommand =
	| { readonly kind: 'checksum'; readonly directory: string; readonly gapMilliseconds: number }
	| { readonly kind: 'sweep'; readonly directory: string; readonly accounts: number }
	| { readonly kind: 'api-diff'; readonly directory: string; readonly samplesPerStratum: number; readonly seed: string | undefined }
	| { readonly kind: 'shadow'; readonly directory: string; readonly windowStaples: number; readonly storage: ShadowStorage }
	| { readonly kind: 'report'; readonly directory: string; readonly sampleAccounts: number; readonly apiSamples: number; readonly gapMilliseconds: number };

export const DEFAULT_SWEEP_ACCOUNTS = 100;

/** The fresh sweep sample of a report: a few accounts for each representative, a minute or so at their pace. */
export const DEFAULT_REPORT_SAMPLE_ACCOUNTS = 16;

/** Requests of each stratum an API diff compares: by the rule of three, a divergence rate below 6% at 95% for each. */
export const DEFAULT_API_SAMPLES = 50;

/**
 * Where the offline ledger of shadow votes keeps its state. The main
 * network's history names over a million accounts, most of them opened in
 * October 2025, and replaying it into the memory driver outgrew a 2 GiB heap
 * at 12,000 of 53,600 staples, so by default it is kept in a cluster of its
 * own, started for the run and removed after it.
 */
export type ShadowStorage = 'postgres' | 'memory';

const SHADOW_STORAGES: readonly ShadowStorage[] = ['postgres', 'memory'];

/** The staples shadow-voted on: the newest of the follower's reach, enough to hold every kind of staple a day of the main network carries. */
export const DEFAULT_SHADOW_WINDOW = 1000;

/** The fresh API diff sample of a report: a couple of requests of each stratum, a minute or so at the representatives' pace. */
export const DEFAULT_REPORT_API_SAMPLES = 2;

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
		case 'api-diff':
			valued = ['--directory', '--samples', '--seed'];
			break;
		case 'shadow':
			valued = ['--directory', '--window', '--storage'];
			break;
		case 'report':
			valued = ['--directory', '--sample', '--api-samples', '--gap-ms'];
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
		case 'api-diff': {
			const samplesPerStratum = setting(options, '--samples', Number.MAX_SAFE_INTEGER, DEFAULT_API_SAMPLES);
			if (samplesPerStratum === undefined) {
				return(undefined);
			}
			return({ kind: name, directory, samplesPerStratum, seed: options.get('--seed') });
		}
		case 'shadow': {
			const windowStaples = setting(options, '--window', Number.MAX_SAFE_INTEGER, DEFAULT_SHADOW_WINDOW);
			const named = options.get('--storage') ?? 'postgres';
			const storage = SHADOW_STORAGES.find(function(known): boolean {
				return(known === named);
			});
			if (windowStaples === undefined || storage === undefined) {
				return(undefined);
			}
			return({ kind: name, directory, windowStaples, storage });
		}
		case 'report': {
			const sampleAccounts = setting(options, '--sample', Number.MAX_SAFE_INTEGER, DEFAULT_REPORT_SAMPLE_ACCOUNTS);
			const apiSamples = setting(options, '--api-samples', Number.MAX_SAFE_INTEGER, DEFAULT_REPORT_API_SAMPLES);
			if (sampleAccounts === undefined || apiSamples === undefined || gapMilliseconds === undefined) {
				return(undefined);
			}
			return({ kind: name, directory, sampleAccounts, apiSamples, gapMilliseconds });
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
