import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { lockParity, PARITY_LOCK_FILE, parseParityCommand } from './parity-command.js';

const HOME = '/home/slop';
const DIRECTORY = '/home/slop/.local/share/slop-node-follower';

describe('the parity command line', function() {
	test('names each command with its defaults', function() {
		expect(parseParityCommand(['checksum'], HOME)).toEqual({ kind: 'checksum', directory: DIRECTORY, gapMilliseconds: 10_000 });
		expect(parseParityCommand(['sweep'], HOME)).toEqual({ kind: 'sweep', directory: DIRECTORY, accounts: 100 });
		expect(parseParityCommand(['shadow'], HOME)).toEqual({ kind: 'shadow', directory: DIRECTORY, windowStaples: 1000 });
		expect(parseParityCommand(['shadow', '--window', '50'], HOME)).toEqual({ kind: 'shadow', directory: DIRECTORY, windowStaples: 50 });
		expect(parseParityCommand(['api-diff'], HOME)).toEqual({ kind: 'api-diff', directory: DIRECTORY, samplesPerStratum: 50, seed: undefined });
		expect(parseParityCommand(['report'], HOME)).toEqual({ kind: 'report', directory: DIRECTORY, sampleAccounts: 16, apiSamples: 2, gapMilliseconds: 10_000 });
	});

	test('takes the options each command has', function() {
		expect(parseParityCommand(['sweep', '--accounts', '300', '--directory', '/data/follower'], HOME)).toEqual({ kind: 'sweep', directory: '/data/follower', accounts: 300 });
		expect(parseParityCommand(['report', '--sample', '4', '--api-samples', '1', '--gap-ms', '5000'], HOME)).toEqual({ kind: 'report', directory: DIRECTORY, sampleAccounts: 4, apiSamples: 1, gapMilliseconds: 5000 });
		expect(parseParityCommand(['api-diff', '--samples', '300', '--seed', 'run-1'], HOME)).toEqual({ kind: 'api-diff', directory: DIRECTORY, samplesPerStratum: 300, seed: 'run-1' });
	});

	test('refuses what it does not understand', function() {
		expect(parseParityCommand([], HOME)).toBeUndefined();
		expect(parseParityCommand(['publish'], HOME)).toBeUndefined();
		expect(parseParityCommand(['sweep', '--gap-ms', '5000'], HOME)).toBeUndefined();
		expect(parseParityCommand(['sweep', '--accounts', '0'], HOME)).toBeUndefined();
		expect(parseParityCommand(['checksum', '--gap-ms'], HOME)).toBeUndefined();
		expect(parseParityCommand(['api-diff', '--samples', '0'], HOME)).toBeUndefined();
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

	test('is taken over from a process that has exited', async function() {
		const directory = await scratch();
		// No process has the largest ID Linux can give.
		await writeFile(join(directory, PARITY_LOCK_FILE), '4194304\n');
		const release = await lockParity(directory);
		await release();
	});
});
