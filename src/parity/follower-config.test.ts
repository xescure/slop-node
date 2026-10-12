import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { getConfigFromEnv } from '../node/config.js';
import type { Environment } from '../node/config.js';
import { checkFollowerEnvironment, DEFAULT_FOLLOWER_SETTINGS, defaultFollowerDirectory, followerDirectory, followerEnvironment, MAINNET_REPRESENTATIVE_APIS, parseFollowerCommand, readOrCreateSeed } from './follower-config.js';
import type { FollowerSettings } from './follower-config.js';

const SEED = '6a1fc1bb5c0b0e2d4f6b8d0a2c4e6f8a0b2d4f6a8c0e2a4c6e8a0c2e4a6c8e0a';
const DATABASE_URL = 'postgresql://slop@%2Fhome%2Fslop%2F.local%2Fshare%2Fslop-node-follower%2Frun:5432/follower';

const SETTINGS: FollowerSettings = { ...DEFAULT_FOLLOWER_SETTINGS, directory: '/home/slop/.local/share/slop-node-follower' };

const MAINNET_APIS = [
	'https://rep1.main.network.api.keeta.com/api',
	'https://rep2.main.network.api.keeta.com/api',
	'https://rep3.main.network.api.keeta.com/api',
	'https://rep4.main.network.api.keeta.com/api'
];

function environment(): Environment {
	return(followerEnvironment({ settings: SETTINGS, seed: SEED, databaseURL: DATABASE_URL }));
}

function refusal(changed: Environment): string {
	try {
		checkFollowerEnvironment(changed);
	} catch (error: unknown) {
		if (error instanceof Error) {
			return(`${error.name}: ${error.message}`);
		}
		throw(error);
	}
	throw(new Error('the environment was accepted'));
}

const scratch: string[] = [];

async function scratchDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'slop-follower-test-'));
	scratch.push(directory);
	return(directory);
}

afterEach(async function() {
	for (const directory of scratch.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe('the follower\'s node', function() {
	test('bootstraps from the API endpoints of the four representatives the client knows for the main network', function() {
		expect(MAINNET_REPRESENTATIVE_APIS).toEqual(MAINNET_APIS);
		expect(KeetaNet.Client.Config.getDefaultConfig('main').representatives.map(function(representative): string {
			return(representative.endpoints.api);
		})).toEqual(MAINNET_APIS);
	});

	test('follows main in bootstrap-only mode, from those four, paced, on the loopback interface, in its Postgres, with no peers', function() {
		expect(environment()).toEqual({
			KEETANET_LOCAL_NODE_SEED: SEED,
			KEETANET_LOCAL_NODE_NETWORK: 'main',
			KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'bootstrap-only',
			KEETANET_LOCAL_NODE_POSTGRES_URL: DATABASE_URL,
			KEETANET_LOCAL_NODE_LISTEN_IP: '127.0.0.1',
			KEETANET_LOCAL_NODE_LISTEN_PORT: String(SETTINGS.port),
			KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: MAINNET_APIS.join(','),
			KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: '1000',
			KEETANET_LOCAL_NODE_LOG_LEVEL: 'INFO'
		});
	});

	test('is a node the node itself accepts, trusting the main network\'s own trusted account', function() {
		const config = checkFollowerEnvironment(environment());
		expect(config.network).toEqual({ kind: 'known', alias: 'main', network: KeetaNet.Client.Config.NetworkIDs.main });
		expect(config.ledgerWriteMode).toBe('bootstrap-only');
		expect(config.manualPeers).toEqual([]);
		expect(config.bootstrapPeers).toEqual(MAINNET_APIS);
		expect(config.bootstrapMinIntervalMilliseconds).toBe(1000);
		expect(config.listen).toEqual({ ip: '127.0.0.1', port: SETTINGS.port });
		expect(config.initialTrustedAccount.publicKeyString.get()).toBe('keeta_aabk62tezl4whordlviamlx3zrdgux6lk63cghay45vkzdatyemzvqqjuj5resa');
		expect(getConfigFromEnv(environment())).toEqual(config);
	});

	test.each<[string, Environment, RegExp]>([
		['a network other than main', { KEETANET_LOCAL_NODE_NETWORK: 'test' }, /FollowerSafetyError: .*main network/],
		['a voting mode', { KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-write' }, /ConfigError: .*may only follow/],
		['read-only, which adds nothing', { KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-only' }, /bootstrap-only/],
		['manual peers', { KEETANET_LOCAL_NODE_MANUAL_PEERS: `keeta_aabwip6zeo2fnzfxp5hssrrqtascs2277w2zk7vqd6d3k3m4dkt2flcbca2mqki@https://rep1.main.network.api.keeta.com/api|wss://rep1.main.network.api.keeta.com/p2p` }, /manual peers|MANUAL_PEERS/],
		['a source that is no mainnet representative', { KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: 'https://rep.example/api' }, /https:\/\/rep\.example\/api/],
		['no sources', { KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: undefined }, /bootstraps from no representative/],
		['every interface', { KEETANET_LOCAL_NODE_LISTEN_IP: '0.0.0.0', KEETANET_LOCAL_NODE_ENDPOINT_API: 'http://follower.example/api', KEETANET_LOCAL_NODE_ENDPOINT_P2P: 'ws://follower.example/p2p' }, /127\.0\.0\.1/],
		['requests that are not paced', { KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: '0' }, /pac/],
		['a ledger in memory', { KEETANET_LOCAL_NODE_POSTGRES_URL: undefined }, /Postgres/]
	])('refuses %s', function(_ignoredName, change, message) {
		expect(refusal({ ...environment(), ...change })).toMatch(message);
	});

	test('never sets a variable that would make it vote, publish, dial or advertise', function() {
		const names = Object.keys(environment());
		for (const name of ['KEETANET_LOCAL_NODE_MANUAL_PEERS', 'KEETANET_LOCAL_NODE_ENDPOINT_API', 'KEETANET_LOCAL_NODE_ENDPOINT_P2P', 'KEETANET_LOCAL_NODE_FEE_SCHEDULE', 'KEETANET_INITIAL_TRUSTED_ACCOUNT']) {
			expect(names).not.toContain(name);
		}
	});
});

describe('the follower\'s directory', function() {
	test('is kept under the user\'s data directory by default', function() {
		expect(defaultFollowerDirectory('/home/slop')).toBe('/home/slop/.local/share/slop-node-follower');
	});

	test.each(['/tmp', '/tmp/follower', '/var/tmp/follower', '/scratch/run/follower'])('may not be the temporary directory %j or below it, which the system clears', function(directory) {
		expect(function() {
			followerDirectory(directory, '/scratch/run');
		}).toThrow(/temporary/);
	});

	test('is resolved to an absolute path', function() {
		expect(followerDirectory('data/follower', '/tmp', '/home/slop')).toBe('/home/slop/data/follower');
	});

	test('holds the socket of its Postgres only within the length a socket path may have', function() {
		expect(function() {
			followerDirectory(`/home/slop/${'d'.repeat(100)}`, '/tmp');
		}).toThrow(/socket/);
	});
});

describe('the follower\'s seed', function() {
	test('is made once, readable by its owner alone, and the same seed is read again', async function() {
		const directory = await scratchDirectory();
		const path = join(directory, 'seed');
		const made = await readOrCreateSeed(path);
		expect(made).toMatch(/^[0-9a-f]{64}$/);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await readOrCreateSeed(path)).toBe(made);
		expect((await readFile(path, 'utf8')).trim()).toBe(made);
	});

	test('is refused when others may read it', async function() {
		const directory = await scratchDirectory();
		const path = join(directory, 'seed');
		await writeFile(path, `${SEED}\n`, { mode: 0o644 });
		await expect(readOrCreateSeed(path)).rejects.toThrow(/0600/);
	});

	test('is refused when the file holds no seed', async function() {
		const directory = await scratchDirectory();
		const path = join(directory, 'seed');
		await writeFile(path, 'not a seed\n', { mode: 0o600 });
		await expect(readOrCreateSeed(path)).rejects.toThrow(/64 hexadecimal digits/);
	});
});

describe('the follower\'s command line', function() {
	const home = '/home/slop';

	test('defaults every setting', function() {
		expect(parseFollowerCommand(['up'], home)).toEqual({ kind: 'up', settings: { ...DEFAULT_FOLLOWER_SETTINGS, directory: defaultFollowerDirectory(home) } });
		expect(DEFAULT_FOLLOWER_SETTINGS.minIntervalMilliseconds).toBe(1000);
		expect(DEFAULT_FOLLOWER_SETTINGS.maxHeapMegabytes).toBe(768);
	});

	test('takes the directory, port, pacing and heap of "up"', function() {
		expect(parseFollowerCommand(['up', '--directory', '/srv/follower', '--port', '47001', '--min-interval-ms', '2000', '--max-heap-mb', '1024'], home)).toEqual({
			kind: 'up',
			settings: { directory: '/srv/follower', port: 47001, minIntervalMilliseconds: 2000, maxHeapMegabytes: 1024 }
		});
	});

	test('takes the directory of the other commands, and what "logs" shows', function() {
		expect(parseFollowerCommand(['status', '--directory', '/srv/follower'], home)).toEqual({ kind: 'status', directory: '/srv/follower' });
		expect(parseFollowerCommand(['down'], home)).toEqual({ kind: 'down', directory: defaultFollowerDirectory(home) });
		expect(parseFollowerCommand(['reset-cursors'], home)).toEqual({ kind: 'reset-cursors', directory: defaultFollowerDirectory(home) });
		expect(parseFollowerCommand(['reset-cursors', '--directory', '/srv/follower'], home)).toEqual({ kind: 'reset-cursors', directory: '/srv/follower' });
		expect(parseFollowerCommand(['reindex-history'], home)).toEqual({ kind: 'reindex-history', directory: defaultFollowerDirectory(home) });
		expect(parseFollowerCommand(['restage'], home)).toEqual({ kind: 'restage', directory: defaultFollowerDirectory(home) });
		expect(parseFollowerCommand(['snapshot', '--directory', '/srv/follower'], home)).toEqual({ kind: 'snapshot', directory: '/srv/follower' });
		expect(parseFollowerCommand(['logs'], home)).toEqual({ kind: 'logs', directory: defaultFollowerDirectory(home), log: 'node', lines: 50, follow: false });
		expect(parseFollowerCommand(['logs', '--postgres', '--lines', '10', '--follow'], home)).toEqual({ kind: 'logs', directory: defaultFollowerDirectory(home), log: 'postgres', lines: 10, follow: true });
	});

	test.each([[[]], [['sideways']], [['up', '--port', '0']], [['up', '--port', 'many']], [['up', '--min-interval-ms', '0']], [['status', '--port', '47001']], [['up', '--directory']], [['up', 'extra']], [['reset-cursors', '--port', '47001']], [['snapshot', 'now']]])('refuses %j', function(argv) {
		expect(parseFollowerCommand(argv, home)).toBeUndefined();
	});
});
