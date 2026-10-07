import { describe, expect, inject, onTestFinished, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Environment } from './node/config.js';
import { API_LINE, startCLI } from './testing/cli.js';
import { createDatabase } from './testing/postgres.js';
import { deriveTestKeys, TEST_NETWORK_SEEDS } from './testing/network.js';
import { NODE_VERSION } from './version.js';

const lib = KeetaNet.lib;

const keys = deriveTestKeys(TEST_NETWORK_SEEDS, 1);
const TRUSTED = keys.trustedRoot.publicKeyString.get();

const NODE: Environment = {
	KEETANET_LOCAL_NODE_SEED: TEST_NETWORK_SEEDS.representative,
	KEETANET_INITIAL_TRUSTED_ACCOUNT: TRUSTED,
	KEETANET_LOCAL_NODE_LISTEN_PORT: '0'
};

const GENESIS: Environment = {
	KEETANET_GENESIS_TRUSTED_SEED: TEST_NETWORK_SEEDS.trustedRoot,
	KEETANET_GENESIS_SUPPLY: '1000000'
};

async function getJSON(url: string): Promise<unknown> {
	const response = await fetch(url);
	expect(response.status).toBe(200);
	return(await response.json());
}

async function createTestDatabaseURL(): Promise<string> {
	const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	onTestFinished(function() {
		return(database.drop());
	});
	return(database.connectionString);
}

describe('slop-node run', function() {
	test.each(['SIGTERM', 'SIGINT'] as const)('serves the API from memory until %s, then exits cleanly', async function(signal) {
		const cli = startCLI(['run'], NODE);
		const [, api] = await cli.printed(API_LINE);
		expect(await getJSON(`${api ?? ''}/node/version`)).toEqual({ node: NODE_VERSION });
		cli.signal(signal);
		expect(await cli.exited).toEqual({ code: 0, signal: null });
		expect(cli.stderr()).toContain('the ledger is kept in memory, so it is lost when the node stops');
	});

	test('names what it serves', async function() {
		const cli = startCLI(['run'], NODE);
		await cli.printed(API_LINE);
		cli.signal('SIGTERM');
		await cli.exited;
		expect(cli.stdout()).toContain(`representative: ${lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 0).publicKeyString.get()}\n`);
		expect(cli.stdout()).toContain('network: local (0)\n');
		expect(cli.stdout()).toContain('storage: memory\n');
	});

	test.each(['main', 'test'] as const)('refuses to vote on the %s network before it starts', async function(network) {
		const cli = startCLI(['run'], { ...NODE, KEETANET_LOCAL_NODE_NETWORK: network });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stdout()).toBe('');
		expect(cli.stderr()).toContain(`the ${network} network is public, so the node may only follow it`);
	});

	test('refuses a configuration it cannot read, naming the variable', async function() {
		const cli = startCLI(['run'], { ...NODE, KEETANET_LOCAL_NODE_LISTEN_PORT: 'eighty' });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toContain('KEETANET_LOCAL_NODE_LISTEN_PORT');
	});
});

describe('slop-node genesis', function() {
	test('creates the network in Postgres, where the node then serves it', async function() {
		const environment: Environment = { ...NODE, KEETANET_LOCAL_NODE_POSTGRES_URL: await createTestDatabaseURL() };
		const genesis = startCLI(['genesis'], { ...environment, ...GENESIS });
		expect(await genesis.exited).toEqual({ code: 0, signal: null });
		expect(genesis.stdout()).toMatch(/^genesis: [0-9A-F]{64}$/m);

		const run = startCLI(['run'], environment);
		const [, api] = await run.printed(API_LINE);
		const { baseToken } = lib.Account.generateBaseAddresses(0n);
		const balance = await getJSON(`${api ?? ''}/node/ledger/account/${TRUSTED}/balance/${baseToken.publicKeyString.get()}`);
		expect(balance).toMatchObject({ balance: lib.Utils.Conversion.toJSONSerializable(1000000n) });
		expect(run.stdout()).toContain('storage: postgres\n');
		expect(run.stderr()).not.toContain('memory');
		run.signal('SIGTERM');
		expect(await run.exited).toEqual({ code: 0, signal: null });

		const again = startCLI(['genesis'], { ...environment, ...GENESIS });
		expect(await again.exited).toEqual({ code: 1, signal: null });
		expect(again.stderr()).toContain('the network already has its genesis');
	});

	test('is refused in memory', async function() {
		const cli = startCLI(['genesis'], { ...NODE, ...GENESIS });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toContain('genesis needs KEETANET_LOCAL_NODE_POSTGRES_URL');
	});

	test.each(['main', 'test'] as const)('is refused on the %s network', async function(network) {
		const environment: Environment = {
			...NODE,
			...GENESIS,
			KEETANET_LOCAL_NODE_NETWORK: network,
			KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-only',
			KEETANET_LOCAL_NODE_POSTGRES_URL: 'postgresql://slop@db.invalid/ledger'
		};
		const cli = startCLI(['genesis'], environment);
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toContain(`the ${network} network is public and already has its genesis`);
	});
});

describe('slop-node', function() {
	test('explains itself when asked', async function() {
		const cli = startCLI(['help'], {});
		expect(await cli.exited).toEqual({ code: 0, signal: null });
		expect(cli.stdout()).toContain('Usage: slop-node <command>');
		expect(cli.stdout()).toContain('KEETANET_LOCAL_NODE_POSTGRES_URL');
		expect(cli.stdout()).toContain('KEETANET_GENESIS_TRUSTED_SEED');
	});

	test.each([[[]], [['serve']], [['run', 'now']]])('refuses the arguments %j with its usage', async function(args) {
		const cli = startCLI(args, NODE);
		expect(await cli.exited).toEqual({ code: 2, signal: null });
		expect(cli.stderr()).toContain('Usage: slop-node <command>');
	});
});
