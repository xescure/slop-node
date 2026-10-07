import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { requireAt } from '../ledger/storage/suite/support.js';
import { deriveTestKeys, TEST_NETWORK_SEEDS } from '../testing/network.js';
import { ConfigError, getConfigFromEnv, localNodeConfig } from './config.js';
import type { ConfigProblem, Environment, EnvironmentConfig } from './config.js';
import { addGenesis, GenesisError, getGenesisConfigFromEnv } from './genesis.js';
import type { GenesisSettings } from './genesis.js';
import { LocalNode } from './local.js';

const lib = KeetaNet.lib;

const keys = deriveTestKeys(TEST_NETWORK_SEEDS, 2);
const TRUSTED = keys.trustedRoot.publicKeyString.get();
const REPRESENTATIVE = requireAt(keys.representatives, 0);
const OTHER_REPRESENTATIVE = requireAt(keys.representatives, 1);

const NODE: Environment = {
	KEETANET_LOCAL_NODE_SEED: TEST_NETWORK_SEEDS.representative,
	KEETANET_INITIAL_TRUSTED_ACCOUNT: TRUSTED,
	KEETANET_LOCAL_NODE_POSTGRES_URL: 'postgresql://slop@db.invalid/ledger'
};

const GENESIS: Environment = {
	KEETANET_GENESIS_TRUSTED_SEED: TEST_NETWORK_SEEDS.trustedRoot,
	KEETANET_GENESIS_SUPPLY: '1000000'
};

function settingsFor(extra: Environment, node: Environment = NODE): GenesisSettings {
	const environment = { ...node, ...GENESIS, ...extra };
	return(getGenesisConfigFromEnv(environment, getConfigFromEnv(environment)));
}

function problemOf(extra: Environment, node: Environment = NODE): ConfigProblem {
	try {
		settingsFor(extra, node);
	} catch (error: unknown) {
		if (error instanceof ConfigError) {
			return(error.problem);
		}
		throw(error);
	}
	throw(new Error('the genesis settings were accepted'));
}

describe('the genesis settings', function() {
	test('sign with the trusted key, hold the supply there and delegate it to this node', function() {
		const settings = settingsFor({});
		expect(settings.trustedSigner.publicKeyString.get()).toBe(TRUSTED);
		expect(settings.trustedSigner.hasPrivateKey).toBe(true);
		expect(settings.supply).toBe(1000000n);
		expect(settings.delegateTo.publicKeyString.get()).toBe(REPRESENTATIVE.publicKeyString.get());
		expect(settings.delegateTo.hasPrivateKey).toBe(false);
	});

	test('delegate to the representative named', function() {
		expect(settingsFor({ KEETANET_GENESIS_DELEGATE_TO: OTHER_REPRESENTATIVE.publicKeyString.get() }).delegateTo.publicKeyString.get()).toBe(OTHER_REPRESENTATIVE.publicKeyString.get());
	});

	test('derive the trusted key at the index given', function() {
		const trusted = lib.Account.fromSeed(TEST_NETWORK_SEEDS.trustedRoot, 7).publicKeyString.get();
		const settings = settingsFor({ KEETANET_GENESIS_TRUSTED_SEED_INDEX: '7' }, { ...NODE, KEETANET_INITIAL_TRUSTED_ACCOUNT: trusted });
		expect(settings.trustedSigner.publicKeyString.get()).toBe(trusted);
	});

	test('keep upstream\'s default permission of the network address unless one is named', function() {
		expect(settingsFor({}).networkDefaultPermission).toBeUndefined();
	});

	test('read the default permission as base flag names', function() {
		expect(settingsFor({ KEETANET_GENESIS_NETWORK_DEFAULT_PERMISSION: 'ACCESS, STORAGE_CREATE,TOKEN_ADMIN_CREATE' }).networkDefaultPermission).toEqual(['ACCESS', 'STORAGE_CREATE', 'TOKEN_ADMIN_CREATE']);
	});

	test.each(['access', 'ACCESS,CREATE_TOKEN', 'ACCESS,', ',', 'ACCESS;STORAGE_CREATE'])('refuse the default permission %j, naming the variable', function(permission) {
		const problem = problemOf({ KEETANET_GENESIS_NETWORK_DEFAULT_PERMISSION: permission });
		expect(problem).toMatchObject({ kind: 'invalid', variable: 'KEETANET_GENESIS_NETWORK_DEFAULT_PERMISSION', value: permission });
		expect(new ConfigError(problem).message).toContain('KEETANET_GENESIS_NETWORK_DEFAULT_PERMISSION');
	});

	test.each(['OWNER', 'ACCESS,ADMIN'])('refuse the default permission %j, which a default may not hold', function(permission) {
		expect(problemOf({ KEETANET_GENESIS_NETWORK_DEFAULT_PERMISSION: permission })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_GENESIS_NETWORK_DEFAULT_PERMISSION', expected: 'base flags that may be a default permission' });
	});

	test('need the trusted seed and the supply', function() {
		expect(problemOf({ KEETANET_GENESIS_TRUSTED_SEED: undefined })).toEqual({ kind: 'missing', variable: 'KEETANET_GENESIS_TRUSTED_SEED' });
		expect(problemOf({ KEETANET_GENESIS_SUPPLY: undefined })).toEqual({ kind: 'missing', variable: 'KEETANET_GENESIS_SUPPLY' });
	});

	test('refuse a trusted seed that is not the one the node trusts', function() {
		expect(problemOf({ KEETANET_GENESIS_TRUSTED_SEED: TEST_NETWORK_SEEDS.user })).toEqual({
			kind: 'trusted-seed-mismatch',
			derived: lib.Account.fromSeed(TEST_NETWORK_SEEDS.user, 0).publicKeyString.get(),
			trusted: TRUSTED
		});
	});

	test('refuse a trusted seed that is not one, without repeating it', function() {
		expect(problemOf({ KEETANET_GENESIS_TRUSTED_SEED: 'secret' })).toEqual({ kind: 'invalid', variable: 'KEETANET_GENESIS_TRUSTED_SEED', expected: '64 hexadecimal digits' });
	});

	test.each(['0', '-1', '1.5', '1e6', 'all'])('refuse the supply %j', function(supply) {
		expect(problemOf({ KEETANET_GENESIS_SUPPLY: supply })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_GENESIS_SUPPLY', value: supply });
	});

	test('refuse a delegate that is a seed or not an account', function() {
		expect(problemOf({ KEETANET_GENESIS_DELEGATE_TO: TEST_NETWORK_SEEDS.user })).toEqual({ kind: 'private-key-given', variable: 'KEETANET_GENESIS_DELEGATE_TO' });
		const { baseToken } = lib.Account.generateBaseAddresses(0n);
		expect(problemOf({ KEETANET_GENESIS_DELEGATE_TO: baseToken.publicKeyString.get() })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_GENESIS_DELEGATE_TO' });
	});

	test('refuse a ledger kept in memory, which the command would throw away', function() {
		const { KEETANET_LOCAL_NODE_POSTGRES_URL: _ignoredURL, ...inMemory } = NODE;
		expect(problemOf({}, inMemory)).toEqual({ kind: 'genesis-in-memory' });
	});

	test.each(['main', 'test'] as const)('refuse the %s network, whatever the write mode', function(network) {
		for (const mode of ['read-only', 'bootstrap-only'] as const) {
			expect(problemOf({}, { ...NODE, KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode })).toEqual({ kind: 'genesis-on-public-network', network });
		}
	});

	test.each(['0x5382', '0X54455354', '1413829460'])('refuse the network ID %s of a public network', function(network) {
		expect(problemOf({}, { ...NODE, KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-only' })).toMatchObject({ kind: 'genesis-on-public-network' });
	});

	test.each(['KEETANET_GENESIS_SUPPLY_AMOUNT', 'KEETANET_GENESIS_DELEGATE', 'KEETANET_GENESIS_TRUSTED_SEED_IDX'])('refuse %s, which is not a genesis setting, so a misspelling is not silently ignored', function(variable) {
		expect(problemOf({ [variable]: '1' })).toEqual({ kind: 'unknown-variable', variable });
	});

	test.each(['staging', 'dev'] as const)('allow the %s network, whose ID a private network may reuse', function(network) {
		expect(settingsFor({}, { ...NODE, KEETANET_LOCAL_NODE_NETWORK: network }).supply).toBe(1000000n);
	});
});

function nodeOf(config: EnvironmentConfig): LocalNode {
	return(new LocalNode(localNodeConfig(config, { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() })));
}

describe('adding genesis', function() {
	const environment: Environment = { ...NODE, ...GENESIS };
	const config: EnvironmentConfig = { ...getConfigFromEnv(environment), storage: { kind: 'memory' } };

	test('funds the trusted account, delegated to the representative', async function() {
		const node = nodeOf(config);
		const settings = getGenesisConfigFromEnv(environment, getConfigFromEnv(environment));
		const staple = await addGenesis(node, settings);
		const blocks = staple.blocks.map(function(block): string {
			return(block.account.publicKeyString.get());
		});
		expect(blocks).toEqual([node.networkAddress, node.baseToken, keys.trustedRoot, keys.trustedRoot].map(function(account): string {
			return(account.publicKeyString.get());
		}));
		expect(await node.ledger.getBalance(keys.trustedRoot, node.baseToken)).toBe(1000000n);
		const delegation = staple.blocks.at(-1)?.operations[0];
		if (delegation?.type !== lib.Block.OperationType.SET_REP) {
			throw(new Error('genesis does not end in a delegation'));
		}
		expect(delegation.to.publicKeyString.get()).toBe(REPRESENTATIVE.publicKeyString.get());
		await node.stop();
	});

	test('names the default permission of the network address when one is given', async function() {
		const node = nodeOf(config);
		const settings = settingsFor({ KEETANET_GENESIS_NETWORK_DEFAULT_PERMISSION: 'ACCESS,STORAGE_CREATE,TOKEN_ADMIN_CREATE' });
		const staple = await addGenesis(node, settings);
		const info = staple.blocks[0]?.operations.find(function(operation): boolean {
			return(operation.type === lib.Block.OperationType.SET_INFO);
		});
		if (info?.type !== lib.Block.OperationType.SET_INFO) {
			throw(new Error('the network address block sets no info'));
		}
		expect(info.defaultPermission?.base.flags).toEqual(expect.arrayContaining(['ACCESS', 'STORAGE_CREATE', 'TOKEN_ADMIN_CREATE']));
		expect(info.defaultPermission?.base.flags).toHaveLength(3);
		await node.stop();
	});

	test('gives the network address upstream\'s default permission otherwise', async function() {
		const node = nodeOf(config);
		const staple = await addGenesis(node, settingsFor({}));
		const info = staple.blocks[0]?.operations.find(function(operation): boolean {
			return(operation.type === lib.Block.OperationType.SET_INFO);
		});
		if (info?.type !== lib.Block.OperationType.SET_INFO) {
			throw(new Error('the network address block sets no info'));
		}
		expect(info.defaultPermission?.base.flags).toEqual(['ACCESS', 'STORAGE_CREATE']);
		await node.stop();
	});

	test('is refused once the network has it', async function() {
		const node = nodeOf(config);
		const settings = getGenesisConfigFromEnv(environment, getConfigFromEnv(environment));
		await addGenesis(node, settings);
		await expect(addGenesis(node, settings)).rejects.toThrow(GenesisError);
		await node.stop();
	});
});
