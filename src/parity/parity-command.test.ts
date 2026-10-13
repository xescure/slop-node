import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { lockParity, PARITY_LOCK_FILE, parseParityCommand, SHADOW_LOCK_FILE } from './parity-command.js';

const HOME = '/home/slop';
const DIRECTORY = '/home/slop/.local/share/slop-node-follower';

const PACING = { concurrency: 4, gapMilliseconds: 0 };

describe('the parity command line', function() {
	test('names each command with its defaults', function() {
		expect(parseParityCommand(['checksum'], HOME)).toEqual({ kind: 'checksum', directory: DIRECTORY, gapMilliseconds: 10_000, pacing: PACING });
		expect(parseParityCommand(['sweep'], HOME)).toEqual({ kind: 'sweep', directory: DIRECTORY, accounts: 100, toLapEnd: false, pacing: PACING });
		expect(parseParityCommand(['recheck'], HOME)).toEqual({ kind: 'recheck', directory: DIRECTORY, pacing: PACING });
		expect(parseParityCommand(['sweep', '--lap'], HOME)).toEqual({ kind: 'sweep', directory: DIRECTORY, accounts: Number.MAX_SAFE_INTEGER, toLapEnd: true, pacing: PACING });
		expect(parseParityCommand(['shadow'], HOME)).toEqual({ kind: 'shadow', directory: DIRECTORY, base: undefined, informationalEvery: 10, batchStaples: 500, restart: false });
		expect(parseParityCommand(['explain-shadow'], HOME)).toEqual({ kind: 'explain-shadow', directory: DIRECTORY });
		expect(parseParityCommand(['explain-shadow', '--force', 'why'], HOME)).toBeUndefined();
		expect(parseParityCommand(['shadow', '--base', 'follower_snapshot_20261010061500', '--informational-every', '1', '--batch', '50', '--restart'], HOME)).toEqual({ kind: 'shadow', directory: DIRECTORY, base: 'follower_snapshot_20261010061500', informationalEvery: 1, batchStaples: 50, restart: true });
		expect(parseParityCommand(['shadow', '--base', 'follower; DROP DATABASE follower'], HOME)).toBeUndefined();
		expect(parseParityCommand(['shadow', '--informational-every', '0'], HOME)).toBeUndefined();
		expect(parseParityCommand(['api-diff'], HOME)).toEqual({ kind: 'api-diff', directory: DIRECTORY, samplesPerStratum: 300, seed: undefined, pacing: PACING });
		expect(parseParityCommand(['report'], HOME)).toEqual({ kind: 'report', directory: DIRECTORY, sampleAccounts: 16, passiveSampleAccounts: 400, apiSamples: 2, gapMilliseconds: 10_000, logOnly: false, pacing: PACING });
		expect(parseParityCommand(['keying'], HOME)).toEqual({ kind: 'keying', directory: DIRECTORY, staples: 8, pacing: PACING });
	});

	test('takes the options each command has', function() {
		expect(parseParityCommand(['sweep', '--accounts', '300', '--directory', '/data/follower'], HOME)).toEqual({ kind: 'sweep', directory: '/data/follower', accounts: 300, toLapEnd: false, pacing: PACING });
		expect(parseParityCommand(['sweep', '--accounts', '300', '--lap'], HOME)).toEqual({ kind: 'sweep', directory: DIRECTORY, accounts: 300, toLapEnd: true, pacing: PACING });
		expect(parseParityCommand(['report', '--sample', '4', '--passive-sample', '100', '--api-samples', '1', '--gap-ms', '5000'], HOME)).toEqual({ kind: 'report', directory: DIRECTORY, sampleAccounts: 4, passiveSampleAccounts: 100, apiSamples: 1, gapMilliseconds: 5000, logOnly: false, pacing: PACING });
		expect(parseParityCommand(['report', '--log-only'], HOME)).toMatchObject({ kind: 'report', logOnly: true });
		expect(parseParityCommand(['sweep', '--lap', '--rep-concurrency', '2', '--rep-gap-ms', '1000'], HOME)).toMatchObject({ kind: 'sweep', pacing: { concurrency: 2, gapMilliseconds: 1000 } });
		expect(parseParityCommand(['recheck', '--rep-gap-ms', '0'], HOME)).toMatchObject({ pacing: PACING });
		expect(parseParityCommand(['api-diff', '--samples', '300', '--seed', 'run-1'], HOME)).toEqual({ kind: 'api-diff', directory: DIRECTORY, samplesPerStratum: 300, seed: 'run-1', pacing: PACING });
		expect(parseParityCommand(['keying', '--staples', '3', '--rep-concurrency', '1', '--rep-gap-ms', '500'], HOME)).toEqual({ kind: 'keying', directory: DIRECTORY, staples: 3, pacing: { concurrency: 1, gapMilliseconds: 500 } });
	});

	test('names a triage of an API divergence with every part of it', function() {
		const path = '/node/ledger/account/keeta_x/history?limit=1';
		expect(parseParityCommand(['explain', '--stratum', 'token', '--path', path, '--at', '2026-10-09T08:40:27.413Z', '--class', 'our-bug', '--reference', 'fixed by e27cc4e'], HOME)).toEqual({ kind: 'explain', directory: DIRECTORY, stratum: 'token', path, divergenceAt: '2026-10-09T08:40:27.413Z', divergence: 'our-bug', reference: 'fixed by e27cc4e', untestedBecause: null });
		expect(parseParityCommand(['explain', '--stratum', 'token', '--path', path, '--at', '2026-10-09T08:40:27.413Z', '--class', 'our-bug', '--reference', 'fixed by e27cc4e', '--force', 'every node refuses it now'], HOME)).toMatchObject({ untestedBecause: 'every node refuses it now' });
		expect(parseParityCommand(['explain', '--stratum', 'token', '--path', path, '--at', '2026-10-09T08:40:27.413Z', '--class', 'our-bug', '--reference', 'fixed by e27cc4e', '--force', ' '], HOME)).toBeUndefined();
		expect(parseParityCommand(['explain', '--stratum', 'token', '--path', path, '--at', '2026-10-09T08:40:27.413Z', '--class', 'our-bug', '--reference', ' '], HOME)).toBeUndefined();
		expect(parseParityCommand(['explain', '--stratum', 'token', '--path', path, '--at', '2026-10-09T08:40:27.413Z', '--class', 'our-bug'], HOME)).toBeUndefined();
		expect(parseParityCommand(['explain', '--stratum', 'tokens', '--path', path, '--at', '2026-10-09T08:40:27.413Z', '--class', 'our-bug', '--reference', 'x'], HOME)).toBeUndefined();
		expect(parseParityCommand(['explain', '--stratum', 'token', '--path', path, '--at', '2026-10-09T08:40:27.413Z', '--class', 'a-guess', '--reference', 'x'], HOME)).toBeUndefined();
	});

	test('refuses what it does not understand', function() {
		expect(parseParityCommand([], HOME)).toBeUndefined();
		expect(parseParityCommand(['publish'], HOME)).toBeUndefined();
		expect(parseParityCommand(['sweep', '--gap-ms', '5000'], HOME)).toBeUndefined();
		expect(parseParityCommand(['sweep', '--accounts', '0'], HOME)).toBeUndefined();
		expect(parseParityCommand(['checksum', '--gap-ms'], HOME)).toBeUndefined();
		expect(parseParityCommand(['api-diff', '--samples', '0'], HOME)).toBeUndefined();
		expect(parseParityCommand(['sweep', '--rep-concurrency', '0'], HOME)).toBeUndefined();
		expect(parseParityCommand(['sweep', '--rep-concurrency', '65'], HOME)).toBeUndefined();
		expect(parseParityCommand(['sweep', '--rep-gap-ms', '-1'], HOME)).toBeUndefined();
		expect(parseParityCommand(['shadow', '--rep-concurrency', '2'], HOME)).toBeUndefined();
		expect(parseParityCommand(['keying', '--staples', '0'], HOME)).toBeUndefined();
		expect(parseParityCommand(['keying', '--staples', '101'], HOME)).toBeUndefined();
	});
});

const directories: string[] = [];

afterEach(async function() {
	await Promise.all(directories.splice(0).map(function(directory) {
		return(rm(directory, { recursive: true, force: true }));
	}));
});

async function scratch(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'slop-parity-lock-'));
	directories.push(directory);
	return(directory);
}

describe('the parity lock', function() {
	test('is held by one tool at a time', async function() {
		const directory = await scratch();
		const release = await lockParity(directory);
		expect(await readFile(join(directory, PARITY_LOCK_FILE), 'utf8')).toBe(`${String(process.pid)}\n`);
		await expect(lockParity(directory)).rejects.toThrow(`another parity tool (process ${String(process.pid)}) is running`);
		await release();
		const again = await lockParity(directory);
		await again();
	});

	test('of a shadow-vote run is apart from the parity tools\'', async function() {
		const directory = await scratch();
		const release = await lockParity(directory);
		const shadow = await lockParity(directory, process.pid, SHADOW_LOCK_FILE);
		await expect(lockParity(directory, process.pid, SHADOW_LOCK_FILE)).rejects.toThrow('is running');
		await shadow();
		await release();
	});

	test('is taken over from a process that has exited', async function() {
		const directory = await scratch();
		// No process has the largest ID Linux can give.
		await writeFile(join(directory, PARITY_LOCK_FILE), '4194304\n');
		const release = await lockParity(directory);
		await release();
	});
});
