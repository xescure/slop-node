import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { FAUCET_BALANCE } from './genesis.js';
import type { Timeout } from './use-devnet.js';

/** The command utils/devnet runs, as "make test" builds it. */
const BUILT_COMMAND = new URL('../../build/devnet/devnet/main.js', import.meta.url);

/*
 * "up" starts four clusters and nodes twice and delegates, which took about
 * 5 s, then the test reads through a client; "down" stops it all.
 */
const UP_AND_DOWN: Timeout = { milliseconds: 240_000, reason: 'a whole devnet started, read and stopped' };

type Finished = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

function runCommand(args: readonly string[]): Promise<Finished> {
	const child = spawn(process.execPath, [BUILT_COMMAND.pathname, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', function(chunk: string) {
		stdout += chunk;
	});
	child.stderr.on('data', function(chunk: string) {
		stderr += chunk;
	});
	return(new Promise(function(resolve) {
		child.once('close', function(code) {
			resolve({ code, stdout, stderr });
		});
	}));
}

/** Whether a process with the ID exists. */
function isRunning(processID: number): boolean {
	try {
		process.kill(processID, 0);
		return(true);
	} catch {
		return(false);
	}
}

/** The nodes' processes, which their logs record, and Postgres', which its data directories record, in the devnet's directory. */
async function devnetProcessIDs(directory: string): Promise<number[]> {
	const processIDs: number[] = [];
	for (const entry of await readdir(directory, { recursive: true })) {
		const path = join(directory, entry);
		if (/(^|\/)node-\d+\.log$/.test(entry)) {
			for (const [, processID = ''] of (await readFile(path, 'utf8')).matchAll(/, process (\d+)$/gm)) {
				processIDs.push(Number(processID));
			}
		}
		if (/(^|\/)postmaster\.pid$/.test(entry)) {
			processIDs.push(Number((await readFile(path, 'utf8')).split('\n')[0]));
		}
	}
	return(processIDs);
}

describe('utils/devnet', function() {
	const directories: string[] = [];

	afterAll(async function() {
		for (const directory of directories) {
			// A failed test may have left a devnet running.
			await runCommand(['down', join(directory, 'state')]);
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('explains itself when given no command', async function() {
		const finished = await runCommand([]);
		expect(finished.code).toBe(2);
		expect(finished.stderr).toMatch(/^Usage: .*up.*down/m);
	});

	test('says so when no devnet is up in the directory', async function() {
		const directory = await mkdtemp(join(tmpdir(), 'slop-devnet-'));
		directories.push(directory);
		const finished = await runCommand(['down', directory]);
		expect(finished.code).toBe(1);
		expect(finished.stderr).toContain(`no devnet is up in ${directory}`);
	});

	test('refuses a directory whose control socket path is too long for a Unix socket', async function() {
		const directory = join(tmpdir(), 'd'.repeat(120));
		for (const command of ['up', 'down']) {
			const finished = await runCommand([command, directory]);
			expect(finished.code).toBe(1);
			expect(finished.stderr).toMatch(/control socket path would take \d+ bytes, over the 107/);
			expect(finished.stderr).not.toContain('EINVAL');
		}
		expect(existsSync(directory)).toBe(false);
	});

	test('brings a devnet up that a client reaches as printed, and takes it down', async function() {
		const parent = await mkdtemp(join(tmpdir(), 'slop-devnet-'));
		directories.push(parent);
		// The devnet makes the directory it is given.
		const directory = join(parent, 'state');

		const up = await runCommand(['up', directory]);
		expect(up).toMatchObject({ code: 0, stderr: '' });
		const representatives = [...up.stdout.matchAll(/^representative \d: (keeta_\w+) api (\S+) p2p (\S+)/gm)].map(function([, key = '', api = '', p2p = '']) {
			return({ key: KeetaNet.lib.Account.fromPublicKeyString(key).assertAccount(), endpoints: { api, p2p } });
		});
		expect(representatives).toHaveLength(4);
		const faucetSeed = up.stdout.match(/^faucet seed: ([0-9a-f]{64})$/m)?.[1];
		expect(faucetSeed).toBeDefined();

		const client = new KeetaNet.UserClient({
			client: new KeetaNet.Client(representatives),
			signer: KeetaNet.lib.Account.fromSeed(faucetSeed ?? '', 0),
			usePublishAid: false,
			network: 0n,
			networkAlias: 'test'
		});
		try {
			expect(await client.balance(client.baseToken)).toBe(FAUCET_BALANCE);
		} finally {
			await client.destroy();
		}
		expect((await runCommand(['up', directory])).stderr).toContain(`a devnet is already up in ${directory}`);

		const processIDs = await devnetProcessIDs(directory);
		// Four nodes and four Postgres servers; the genesis run has ended.
		expect(processIDs.filter(isRunning).length).toBeGreaterThanOrEqual(8);

		const down = await runCommand(['down', directory]);
		expect(down).toMatchObject({ code: 0, stderr: '' });
		expect(processIDs.filter(isRunning)).toEqual([]);
		expect(existsSync(join(directory, 'control.sock'))).toBe(false);
		expect((await runCommand(['down', directory])).code).toBe(1);
	}, UP_AND_DOWN.milliseconds);
});
