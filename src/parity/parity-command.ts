import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNever } from '../util/assert-never.js';
import { DEFAULT_CHECKSUM_GAP_MILLISECONDS } from './checksum.js';
import { defaultFollowerDirectory, optionsOf, setting } from './follower-config.js';

export type ParityCommand =
	| { readonly kind: 'checksum'; readonly directory: string; readonly gapMilliseconds: number }
	| { readonly kind: 'sweep'; readonly directory: string; readonly accounts: number; readonly toLapEnd: boolean }
	| { readonly kind: 'recheck'; readonly directory: string }
	| { readonly kind: 'api-diff'; readonly directory: string; readonly samplesPerStratum: number; readonly seed: string | undefined }
	| { readonly kind: 'shadow'; readonly directory: string; readonly base: string | undefined; readonly informationalEvery: number; readonly batchStaples: number; readonly restart: boolean }
	| {
		readonly kind: 'report';
		readonly directory: string;
		readonly sampleAccounts: number;
		readonly passiveSampleAccounts: number;
		readonly apiSamples: number;
		readonly gapMilliseconds: number;
		/** Reports on the log as it stands, comparing nothing afresh, so that it runs beside a sweep. */
		readonly logOnly: boolean;
	};

export const DEFAULT_SWEEP_ACCOUNTS = 100;

/** The fresh sweep sample of a report: a few chain accounts for each representative, a minute or so at their pace. */
export const DEFAULT_REPORT_SAMPLE_ACCOUNTS = 16;

/** The fresh sample of passive accounts of a report: one request's worth for each representative. */
export const DEFAULT_REPORT_PASSIVE_SAMPLE_ACCOUNTS = 400;

/** Requests of each stratum an API diff compares: by the rule of three, a divergence rate below 6% at 95% for each. */
export const DEFAULT_API_SAMPLES = 50;

/**
 * One in so many staples voted for before the scoped window is put to a
 * shadow vote: a vote costs about what adding the staple does, so this adds
 * a tenth to the replay of that history, and still votes on thousands of
 * staples of each month of it.
 */
export const DEFAULT_INFORMATIONAL_EVERY = 10;

/** Staples replayed between two saves of a shadow-vote run's standing. */
export const DEFAULT_SHADOW_BATCH = 500;

/** A database of the follower's cluster, as Postgres names one without quotes. */
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

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
	let flags: readonly string[] = [];
	switch (name) {
		case 'checksum':
			valued = ['--directory', '--gap-ms'];
			break;
		case 'sweep':
			valued = ['--directory', '--accounts'];
			flags = ['--lap'];
			break;
		case 'recheck':
			valued = ['--directory'];
			break;
		case 'api-diff':
			valued = ['--directory', '--samples', '--seed'];
			break;
		case 'shadow':
			valued = ['--directory', '--base', '--informational-every', '--batch'];
			flags = ['--restart'];
			break;
		case 'report':
			valued = ['--directory', '--sample', '--passive-sample', '--api-samples', '--gap-ms'];
			flags = ['--log-only'];
			break;
		default:
			return(undefined);
	}
	const options = optionsOf(rest, valued, flags);
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
			const toLapEnd = options.has('--lap');
			let fallback = DEFAULT_SWEEP_ACCOUNTS;
			if (toLapEnd) {
				fallback = Number.MAX_SAFE_INTEGER;
			}
			const accounts = setting(options, '--accounts', Number.MAX_SAFE_INTEGER, fallback);
			if (accounts === undefined) {
				return(undefined);
			}
			return({ kind: name, directory, accounts, toLapEnd });
		}
		case 'recheck':
			return({ kind: name, directory });
		case 'api-diff': {
			const samplesPerStratum = setting(options, '--samples', Number.MAX_SAFE_INTEGER, DEFAULT_API_SAMPLES);
			if (samplesPerStratum === undefined) {
				return(undefined);
			}
			return({ kind: name, directory, samplesPerStratum, seed: options.get('--seed') });
		}
		case 'shadow': {
			const informationalEvery = setting(options, '--informational-every', Number.MAX_SAFE_INTEGER, DEFAULT_INFORMATIONAL_EVERY);
			const batchStaples = setting(options, '--batch', 100_000, DEFAULT_SHADOW_BATCH);
			const base = options.get('--base');
			if (informationalEvery === undefined || batchStaples === undefined || (base !== undefined && !DATABASE_NAME.test(base))) {
				return(undefined);
			}
			return({ kind: name, directory, base, informationalEvery, batchStaples, restart: options.has('--restart') });
		}
		case 'report': {
			const sampleAccounts = setting(options, '--sample', Number.MAX_SAFE_INTEGER, DEFAULT_REPORT_SAMPLE_ACCOUNTS);
			const passiveSampleAccounts = setting(options, '--passive-sample', Number.MAX_SAFE_INTEGER, DEFAULT_REPORT_PASSIVE_SAMPLE_ACCOUNTS);
			const apiSamples = setting(options, '--api-samples', Number.MAX_SAFE_INTEGER, DEFAULT_REPORT_API_SAMPLES);
			if (sampleAccounts === undefined || passiveSampleAccounts === undefined || apiSamples === undefined || gapMilliseconds === undefined) {
				return(undefined);
			}
			return({ kind: name, directory, sampleAccounts, passiveSampleAccounts, apiSamples, gapMilliseconds, logOnly: options.has('--log-only') });
		}
		default:
			return(assertNever(name));
	}
}

/** Held by the one parity tool that may run at a time in a follower's directory. */
export const PARITY_LOCK_FILE = 'parity.lock';

/**
 * Held by the one shadow-vote run that may run at a time in a follower's
 * directory. A run sends no request to the representatives, so it does not
 * hold the parity tools' lock, and the report may read its records while it
 * runs.
 */
export const SHADOW_LOCK_FILE = 'shadow.lock';

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
export async function lockParity(directory: string, processID: number = process.pid, file: string = PARITY_LOCK_FILE): Promise<() => Promise<void>> {
	const path = join(directory, file);
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
