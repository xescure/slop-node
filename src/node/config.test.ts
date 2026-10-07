import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Networks } from '@keetanetwork/keetanet-client/config/index.js';
import { PostgresKVStorage } from '../kv/postgres.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { requireAt } from '../ledger/storage/suite/support.js';
import { deriveTestKeys, TEST_NETWORK_SEEDS } from '../testing/network.js';
import { ConfigError, getConfigFromEnv, LEDGER_WRITE_MODES, localNodeConfig, MAX_FEE_SEED_ACCOUNTS } from './config.js';
import type { ConfigProblem, Environment, EnvironmentConfig, LedgerWriteMode } from './config.js';

const lib = KeetaNet.lib;
const NetworkConfig = KeetaNet.Client.Config;

const keys = deriveTestKeys(TEST_NETWORK_SEEDS, 3);

const SEED = TEST_NETWORK_SEEDS.representative;
const FEE_SEED = TEST_NETWORK_SEEDS.user;
const TRUSTED = keys.trustedRoot.publicKeyString.get();

const { baseToken } = lib.Account.generateBaseAddresses(0n);
const USER = requireAt(keys.users, 0);
const STORAGE = USER.generateIdentifier(lib.Account.AccountKeyAlgorithm.STORAGE, undefined, 0);
const TOKEN = USER.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);

const POSTGRES_URL = 'postgresql://slop:hunter2@db.invalid:5432/ledger';

/** The least a local node needs. */
const BASE: Environment = {
	KEETANET_LOCAL_NODE_SEED: SEED,
	KEETANET_INITIAL_TRUSTED_ACCOUNT: TRUSTED
};

function parse(extra: Environment, base: Environment = BASE): EnvironmentConfig {
	return(getConfigFromEnv({ ...base, ...extra }));
}

function problemOf(extra: Environment, base: Environment = BASE): ConfigProblem {
	try {
		parse(extra, base);
	} catch (error: unknown) {
		if (error instanceof ConfigError) {
			return(error.problem);
		}
		throw(error);
	}
	throw(new Error('the configuration was accepted'));
}

function messageOf(extra: Environment, base: Environment = BASE): string {
	try {
		parse(extra, base);
	} catch (error: unknown) {
		if (error instanceof ConfigError) {
			return(error.message);
		}
		throw(error);
	}
	throw(new Error('the configuration was accepted'));
}

function keyOf(account: GenericAccount | undefined): string | undefined {
	return(account?.publicKeyString.get());
}

describe('the defaults', function() {
	test('a local representative of its seed at index 0, in memory, on the loopback interface, charging nothing', function() {
		const config = parse({});
		expect(keyOf(config.representative)).toBe(keyOf(lib.Account.fromSeed(SEED, 0)));
		expect(config.representative.hasPrivateKey).toBe(true);
		expect(keyOf(config.initialTrustedAccount)).toBe(TRUSTED);
		expect(config.network).toEqual({ kind: 'local', network: 0n });
		expect(config.ledgerWriteMode).toBe('read-write');
		expect(config.log).toEqual({ level: 'INFO', filter: undefined });
		expect(config.storage).toEqual({ kind: 'memory' });
		expect(config.listen).toEqual({ ip: '127.0.0.1', port: 0 });
		expect(config.fee).toEqual({ kind: 'free' });
		expect(config.enableTokenAdminModifyBalance).toBe(false);
	});

	test('the trusted account of a network the client knows', function() {
		const config = parse({ KEETANET_LOCAL_NODE_NETWORK: 'dev' }, { KEETANET_LOCAL_NODE_SEED: SEED });
		expect(keyOf(config.initialTrustedAccount)).toBe(keyOf(NetworkConfig.getDefaultConfig('dev').initialTrustedAccount));
	});
});

describe('KEETANET_LOCAL_NODE_SEED', function() {
	test('is required', function() {
		expect(problemOf({}, { KEETANET_INITIAL_TRUSTED_ACCOUNT: TRUSTED })).toEqual({ kind: 'missing', variable: 'KEETANET_LOCAL_NODE_SEED' });
	});

	test('may not be empty', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_SEED: '' })).toEqual({ kind: 'empty', variable: 'KEETANET_LOCAL_NODE_SEED' });
	});

	test('accepts upper-case hexadecimal', function() {
		expect(keyOf(parse({ KEETANET_LOCAL_NODE_SEED: SEED.toUpperCase() }).representative)).toBe(keyOf(lib.Account.fromSeed(SEED, 0)));
	});

	test.each([
		SEED.slice(1),
		`${SEED}0`,
		`0x${SEED}`,
		`${SEED.slice(1)}g`,
		'correct horse battery staple'
	])('refuses %j without repeating it', function(seed) {
		expect(problemOf({ KEETANET_LOCAL_NODE_SEED: seed })).toEqual({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_SEED', expected: '64 hexadecimal digits' });
		expect(messageOf({ KEETANET_LOCAL_NODE_SEED: seed })).not.toContain(seed);
	});
});

describe('KEETANET_LOCAL_NODE_SEED_INDEX', function() {
	test.each([0, 3, 4294967295])('derives the key at index %i', function(index) {
		expect(keyOf(parse({ KEETANET_LOCAL_NODE_SEED_INDEX: String(index) }).representative)).toBe(keyOf(lib.Account.fromSeed(SEED, index)));
	});

	test.each(['-1', '1.5', '1e3', ' 1', '0x10', 'one', '4294967296'])('refuses %j', function(index) {
		expect(problemOf({ KEETANET_LOCAL_NODE_SEED_INDEX: index })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_SEED_INDEX', value: index });
	});
});

describe('KEETANET_LOCAL_NODE_LOG_LEVEL and KEETANET_LOCAL_NODE_LOG_FILTER', function() {
	test.each([
		['all', 'ALL'],
		['debug', 'DEBUG'],
		['Info', 'INFO'],
		['WARN', 'WARN'],
		['error', 'ERROR'],
		['none', 'NONE']
	])('reads the level %j as %s', function(level, expected) {
		expect(parse({ KEETANET_LOCAL_NODE_LOG_LEVEL: level }).log.level).toBe(expected);
	});

	test('refuses an unknown level', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_LOG_LEVEL: 'verbose' })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_LOG_LEVEL', value: 'verbose' });
	});

	/* [Keeta TS] index.js:70820-70822 matches the filter regardless of case. */
	test('reads the filter as a pattern that ignores case', function() {
		const { filter } = parse({ KEETANET_LOCAL_NODE_LOG_FILTER: 'ledger|api' }).log;
		expect(filter?.source).toBe('ledger|api');
		expect(filter?.test('API')).toBe(true);
	});

	test('refuses a filter that is not a pattern', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_LOG_FILTER: '(' })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_LOG_FILTER', value: '(' });
	});
});

describe('KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE', function() {
	test.each(LEDGER_WRITE_MODES)('accepts %s', function(mode) {
		expect(parse({ KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode }).ledgerWriteMode).toBe(mode);
	});

	test.each(['readwrite', 'READ-ONLY', 'voting'])('refuses %j', function(mode) {
		expect(problemOf({ KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE', value: mode });
	});
});

describe('KEETANET_INITIAL_TRUSTED_ACCOUNT', function() {
	test('is required on the local network, which has no default', function() {
		expect(problemOf({}, { KEETANET_LOCAL_NODE_SEED: SEED })).toEqual({ kind: 'missing', variable: 'KEETANET_INITIAL_TRUSTED_ACCOUNT' });
	});

	test('replaces the default of a known network', function() {
		expect(keyOf(parse({ KEETANET_LOCAL_NODE_NETWORK: 'dev' }).initialTrustedAccount)).toBe(TRUSTED);
	});

	test('is public only', function() {
		expect(parse({}).initialTrustedAccount.hasPrivateKey).toBe(false);
	});

	test('refuses a seed without repeating it', function() {
		const seed = TEST_NETWORK_SEEDS.trustedRoot;
		expect(problemOf({ KEETANET_INITIAL_TRUSTED_ACCOUNT: seed })).toEqual({ kind: 'private-key-given', variable: 'KEETANET_INITIAL_TRUSTED_ACCOUNT' });
		expect(messageOf({ KEETANET_INITIAL_TRUSTED_ACCOUNT: seed })).not.toContain(seed);
	});

	test.each([
		['a token', keyOf(baseToken) ?? ''],
		['a storage account', keyOf(STORAGE) ?? ''],
		['not a key', 'keeta_xyz'],
		['upper case', TRUSTED.toUpperCase()]
	])('refuses %s', function(_ignoredLabel, value) {
		expect(problemOf({ KEETANET_INITIAL_TRUSTED_ACCOUNT: value })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_INITIAL_TRUSTED_ACCOUNT', value });
	});
});

describe('KEETANET_LOCAL_NODE_NETWORK', function() {
	test.each(NetworkConfig.networksArray)('names the %s network', function(alias) {
		expect(parse({ KEETANET_LOCAL_NODE_NETWORK: alias, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-only' }).network).toEqual({ kind: 'known', alias, network: NetworkConfig.NetworkIDs[alias] });
	});

	test.each(['local', '0', '0x0'])('reads %j as the local network', function(network) {
		expect(parse({ KEETANET_LOCAL_NODE_NETWORK: network }).network).toEqual({ kind: 'local', network: 0n });
	});

	test.each(NetworkConfig.networksArray)('reads the ID of the %s network, in decimal or hexadecimal, as that network', function(alias) {
		const id = NetworkConfig.NetworkIDs[alias];
		for (const written of [id.toString(10), `0x${id.toString(16)}`]) {
			expect(parse({ KEETANET_LOCAL_NODE_NETWORK: written, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-only' }).network).toEqual({ kind: 'known', alias, network: id });
		}
	});

	/* The client refuses to validate a block of any other network ID [Keeta TS] index.js:61337-61365. */
	test.each(['12345', '0x1', 'mainnet', 'Main', '-1', '1.5', ''])('refuses %j', function(network) {
		const problem = problemOf({ KEETANET_LOCAL_NODE_NETWORK: network });
		if (network === '') {
			expect(problem).toEqual({ kind: 'empty', variable: 'KEETANET_LOCAL_NODE_NETWORK' });
			return;
		}
		expect(problem).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_NETWORK', value: network });
	});
});

describe('the safety rule', function() {
	const PUBLIC: readonly Networks[] = ['main', 'test'];
	const VOTING: readonly LedgerWriteMode[] = ['read-write', 'no-voting'];

	const matrix = (['local', ...NetworkConfig.networksArray] as const).flatMap(function(network) {
		return(LEDGER_WRITE_MODES.map(function(mode) {
			return({ network, mode });
		}));
	});

	test.each(matrix)('$network in $mode mode', function({ network, mode }) {
		const environment: Environment = { KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode };
		if (network !== 'local' && PUBLIC.includes(network) && VOTING.includes(mode)) {
			expect(problemOf(environment)).toEqual({ kind: 'writable-on-public-network', network, ledgerWriteMode: mode });
			return;
		}
		expect(parse(environment).ledgerWriteMode).toBe(mode);
	});

	test('applies to the default write mode', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_NETWORK: 'main' })).toEqual({ kind: 'writable-on-public-network', network: 'main', ledgerWriteMode: 'read-write' });
	});

	/* Every spelling of the ID that the setting reads as that network. */
	function spellingsOf(id: bigint): string[] {
		const hex = id.toString(16);
		return([id.toString(10), `0x${hex}`, `0X${hex}`, `0x${hex.toUpperCase()}`, `0x00${hex}`]);
	}

	test.each([
		['main', ['21378', '0x5382', '0X5382', '0x005382']],
		['test', ['1413829460', '0x54455354', '0X54455354', '0x0054455354']]
	] as const)('applies to the ID of the %s network in every spelling', function(alias, written) {
		expect(spellingsOf(NetworkConfig.NetworkIDs[alias])).toEqual(expect.arrayContaining([...written]));
		for (const network of spellingsOf(NetworkConfig.NetworkIDs[alias])) {
			for (const mode of VOTING) {
				expect(problemOf({ KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode })).toEqual({ kind: 'writable-on-public-network', network: alias, ledgerWriteMode: mode });
			}
			expect(problemOf({ KEETANET_LOCAL_NODE_NETWORK: network })).toEqual({ kind: 'writable-on-public-network', network: alias, ledgerWriteMode: 'read-write' });
			expect(parse({ KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-only' }).network).toEqual({ kind: 'known', alias, network: NetworkConfig.NetworkIDs[alias] });
		}
	});

	test('says why', function() {
		expect(messageOf({ KEETANET_LOCAL_NODE_NETWORK: 'test' })).toBe('the test network is public, so the node may only follow it: set KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE to read-only or bootstrap-only (it is read-write)');
	});
});

describe('the fee accounts', function() {
	const SEEDED: Environment = {
		KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'flat:10',
		KEETANET_LOCAL_NODE_FEE_SEED: FEE_SEED,
		KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX: '2',
		KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX: '4'
	};

	test('derive from the fee seed at every index of the range, inclusive', function() {
		const { fee } = parse(SEEDED);
		if (fee.kind !== 'flat') {
			throw(new Error('the fee schedule is not flat'));
		}
		expect(fee.payTo.map(keyOf)).toEqual([2, 3, 4].map(function(index) {
			return(keyOf(lib.Account.fromSeed(FEE_SEED, index)));
		}));
		expect(fee.payTo.every(function(account) {
			return(!account.hasPrivateKey);
		})).toBe(true);
	});

	test('need the whole fee seed range', function() {
		for (const left of ['KEETANET_LOCAL_NODE_FEE_SEED', 'KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX', 'KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX'] as const) {
			expect(problemOf({ ...SEEDED, [left]: undefined })).toEqual({ kind: 'missing', variable: left });
		}
	});

	test('refuse a reversed range', function() {
		expect(problemOf({ ...SEEDED, KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX: '5' })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX', value: '4' });
	});

	test('refuse a fee seed that is not one, without repeating it', function() {
		expect(problemOf({ ...SEEDED, KEETANET_LOCAL_NODE_FEE_SEED: 'secret' })).toEqual({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_FEE_SEED', expected: '64 hexadecimal digits' });
	});

	test('refuse a range of more keys than are derived', function() {
		expect(parse({ ...SEEDED, KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX: '10', KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX: '1033' }).fee).toMatchObject({ kind: 'flat' });
		expect(problemOf({ ...SEEDED, KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX: '10', KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX: '1034' })).toEqual({ kind: 'too-many-fee-accounts', count: 1025, maximum: MAX_FEE_SEED_ACCOUNTS });
		expect(problemOf({ ...SEEDED, KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX: '0', KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX: '4294967295' })).toEqual({ kind: 'too-many-fee-accounts', count: 4294967296, maximum: MAX_FEE_SEED_ACCOUNTS });
		expect(messageOf({ ...SEEDED, KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX: '2000' })).toBe('KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX and KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX name 1999 fee accounts, but at most 1024 are derived');
	});

	test('refuse an index outside 32 bits', function() {
		expect(problemOf({ ...SEEDED, KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX: '4294967296' })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX' });
	});

	test('are listed instead, as accounts or storage accounts', function() {
		const { fee } = parse({ KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'flat:10', KEETANET_LOCAL_NODE_FEE_ACCOUNTS: ` ${keyOf(USER) ?? ''} ,${keyOf(STORAGE) ?? ''},` });
		if (fee.kind !== 'flat') {
			throw(new Error('the fee schedule is not flat'));
		}
		expect(fee.payTo.map(keyOf)).toEqual([keyOf(USER), keyOf(STORAGE)]);
	});

	test.each([
		['a token', keyOf(TOKEN) ?? ''],
		['not a key', 'keeta_xyz']
	])('refuse a listed account that is %s', function(_ignoredLabel, value) {
		expect(problemOf({ KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'flat:10', KEETANET_LOCAL_NODE_FEE_ACCOUNTS: `${keyOf(USER) ?? ''},${value}` })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_FEE_ACCOUNTS', value });
	});

	test('refuse a listed seed without repeating it', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'flat:10', KEETANET_LOCAL_NODE_FEE_ACCOUNTS: FEE_SEED })).toEqual({ kind: 'private-key-given', variable: 'KEETANET_LOCAL_NODE_FEE_ACCOUNTS' });
	});

	test('refuse an empty list', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'flat:10', KEETANET_LOCAL_NODE_FEE_ACCOUNTS: ' , ' })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_FEE_ACCOUNTS' });
	});

	test('come from the seed or the list, not both', function() {
		expect(problemOf({ ...SEEDED, KEETANET_LOCAL_NODE_FEE_ACCOUNTS: keyOf(USER) })).toEqual({ kind: 'conflicting', variables: ['KEETANET_LOCAL_NODE_FEE_SEED', 'KEETANET_LOCAL_NODE_FEE_ACCOUNTS'] });
		expect(problemOf({ KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'flat:10', KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX: '0', KEETANET_LOCAL_NODE_FEE_ACCOUNTS: keyOf(USER) })).toEqual({ kind: 'conflicting', variables: ['KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX', 'KEETANET_LOCAL_NODE_FEE_ACCOUNTS'] });
	});
});

describe('KEETANET_LOCAL_NODE_FEE_TOKEN', function() {
	test('names the token fees are paid in', function() {
		const { fee } = parse({ KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'flat:10', KEETANET_LOCAL_NODE_FEE_TOKEN: keyOf(TOKEN) });
		if (fee.kind !== 'flat') {
			throw(new Error('the fee schedule is not flat'));
		}
		expect(keyOf(fee.token)).toBe(keyOf(TOKEN));
	});

	test.each([
		['an account', keyOf(USER) ?? ''],
		['a storage account', keyOf(STORAGE) ?? '']
	])('refuses %s', function(_ignoredLabel, value) {
		expect(problemOf({ KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'flat:10', KEETANET_LOCAL_NODE_FEE_TOKEN: value })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_FEE_TOKEN', value });
	});
});

describe('KEETANET_LOCAL_NODE_FEE_SCHEDULE', function() {
	test('charges a flat amount per block to the vote issuer in the base token when nothing else is named', function() {
		expect(parse({ KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'flat:10' }).fee).toEqual({ kind: 'flat', amountPerBlock: 10n, payTo: [], token: undefined });
	});

	test('refuses an unknown schedule', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'flat:0' })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_FEE_SCHEDULE', value: 'flat:0' });
	});

	test.each(['KEETANET_LOCAL_NODE_FEE_ACCOUNTS', 'KEETANET_LOCAL_NODE_FEE_TOKEN', 'KEETANET_LOCAL_NODE_FEE_SEED'] as const)('refuses %s when nothing is charged', function(variable) {
		const values: Environment = {
			KEETANET_LOCAL_NODE_FEE_ACCOUNTS: keyOf(USER),
			KEETANET_LOCAL_NODE_FEE_TOKEN: keyOf(TOKEN),
			KEETANET_LOCAL_NODE_FEE_SEED: FEE_SEED
		};
		expect(problemOf({ [variable]: values[variable] })).toEqual({ kind: 'fee-recipient-without-fee', variable });
	});
});

describe('KEETANET_LOCAL_NODE_POSTGRES_URL', function() {
	test('keeps the ledger and the key-value store in Postgres', function() {
		expect(parse({ KEETANET_LOCAL_NODE_POSTGRES_URL: POSTGRES_URL }).storage).toEqual({ kind: 'postgres', connectionString: POSTGRES_URL });
	});

	test('accepts a socket directory and the postgres scheme', function() {
		for (const url of [`postgresql://slop@${encodeURIComponent('/tmp/slop-pg-1')}:5432/ledger`, 'postgres:///ledger?host=/run/postgresql']) {
			expect(parse({ KEETANET_LOCAL_NODE_POSTGRES_URL: url }).storage).toEqual({ kind: 'postgres', connectionString: url });
		}
	});

	test.each(['mysql://db.invalid/ledger', 'db.invalid:5432', 'postgresql//db.invalid'])('refuses %j without repeating it', function(url) {
		expect(problemOf({ KEETANET_LOCAL_NODE_POSTGRES_URL: url })).toEqual({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_POSTGRES_URL', expected: 'a postgres:// or postgresql:// URL' });
		expect(messageOf({ KEETANET_LOCAL_NODE_POSTGRES_URL: url })).not.toContain(url);
	});

	test('may not be empty, rather than falling back to memory', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_POSTGRES_URL: '' })).toEqual({ kind: 'empty', variable: 'KEETANET_LOCAL_NODE_POSTGRES_URL' });
	});
});

describe('KEETANET_LOCAL_NODE_LISTEN_IP and KEETANET_LOCAL_NODE_LISTEN_PORT', function() {
	test('listen where they say', function() {
		expect(parse({ KEETANET_LOCAL_NODE_LISTEN_IP: '::1', KEETANET_LOCAL_NODE_LISTEN_PORT: '65535' }).listen).toEqual({ ip: '::1', port: 65535 });
	});

	test.each(['localhost', '256.0.0.1', '127.0.0.1:80'])('refuse the address %j', function(ip) {
		expect(problemOf({ KEETANET_LOCAL_NODE_LISTEN_IP: ip })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_LISTEN_IP', value: ip });
	});

	test.each(['65536', '-1', '80.5', 'http', '0x50', ' 80'])('refuse the port %j', function(port) {
		expect(problemOf({ KEETANET_LOCAL_NODE_LISTEN_PORT: port })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_LISTEN_PORT', value: port });
	});
});

describe('KEETANET_LOCAL_NODE_ENABLE_TOKEN_ADMIN_MODIFY_BALANCE', function() {
	test.each([['true', true], ['false', false]] as const)('reads %j', function(value, expected) {
		expect(parse({ KEETANET_LOCAL_NODE_ENABLE_TOKEN_ADMIN_MODIFY_BALANCE: value }).enableTokenAdminModifyBalance).toBe(expected);
	});

	test.each(['1', 'yes', 'TRUE'])('refuses %j', function(value) {
		expect(problemOf({ KEETANET_LOCAL_NODE_ENABLE_TOKEN_ADMIN_MODIFY_BALANCE: value })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_ENABLE_TOKEN_ADMIN_MODIFY_BALANCE', value });
	});
});

describe('the environment as a whole', function() {
	test('refuses a variable of the node that it does not know, so a misspelling is not silently ignored', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_POSTGRES_URI: POSTGRES_URL })).toEqual({ kind: 'unknown-variable', variable: 'KEETANET_LOCAL_NODE_POSTGRES_URI' });
	});

	test('ignores everything else', function() {
		expect(parse({ PATH: '/bin', KEETANET_DEBUG: 'true' }).storage).toEqual({ kind: 'memory' });
	});
});

describe('the node configuration', function() {
	test('carries every setting to the representative', function() {
		const config = parse({
			KEETANET_LOCAL_NODE_NETWORK: 'dev',
			KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'no-voting',
			KEETANET_LOCAL_NODE_LISTEN_PORT: '7000',
			KEETANET_LOCAL_NODE_ENABLE_TOKEN_ADMIN_MODIFY_BALANCE: 'true'
		});
		const storageDriver = new MemoryLedgerStorage();
		// Opening a store connects lazily, so this one never reaches the address.
		const kv = new PostgresKVStorage({ kind: 'connection-string', connectionString: POSTGRES_URL });
		const log = new lib.Log();
		const node = localNodeConfig(config, { storageDriver, kv, log });
		expect(node.kind).toBe(lib.Node.Kind.REPRESENTATIVE);
		expect(node.network).toBe(NetworkConfig.NetworkIDs.dev);
		expect(node.networkAlias).toBe('dev');
		expect(keyOf(node.ledgerPrivateKey)).toBe(keyOf(config.representative));
		expect(keyOf(node.initialTrustedAccount)).toBe(TRUSTED);
		expect(node.ledger.storageDriver).toBe(storageDriver);
		expect(node.ledger.ledgerWriteMode).toBe('no-voting');
		expect(node.ledger.operations).toEqual({ enableTokenAdminModifyBalance: true });
		expect(node.ledger.computeFeeFromBlocks).toBeTypeOf('function');
		expect(node.stats.kv).toBe(kv);
		expect(node.p2p?.kv).toBe(kv);
		expect(node.log).toBe(log);
		expect(node.nodeOptions).toEqual({ listenIP: '127.0.0.1', listenPort: 7000 });
	});

	test('gives the local network the alias the test helpers give network 0', function() {
		const node = localNodeConfig(parse({}), { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() });
		expect(node.network).toBe(0n);
		expect(node.networkAlias).toBe('test');
		expect(node.stats.kv).toBeNull();
		expect(node.p2p).toBeUndefined();
	});
});
