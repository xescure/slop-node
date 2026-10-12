import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Networks } from '@keetanetwork/keetanet-client/config/index.js';
import type { P2PPeerRep } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { JSONSerializableObject } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { PostgresKVStorage } from '../kv/postgres.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { requireAt } from '../ledger/storage/suite/support.js';
import { deriveTestKeys, TEST_NETWORK_SEEDS } from '../testing/network.js';
import { bootstrapEndpointsOf, bootstrapPacingOf } from './bootstrap-peers.js';
import { ConfigError, DEFAULT_KEETA_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS, formatManualPeer, getConfigFromEnv, LEDGER_WRITE_MODES, localNodeConfig, MAX_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS, MAX_FEE_SEED_ACCOUNTS } from './config.js';
import type { ConfigProblem, Environment, EnvironmentConfig, LedgerWriteMode } from './config.js';
import { LocalNode } from './local.js';
import { MAX_PEER_LIMIT } from './peer-limits.js';

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

/** Another representative of the seed, which the node under test names as its peer. */
const PEER_ACCOUNT = lib.Account.fromSeed(SEED, 1);
const PEER_KEY = PEER_ACCOUNT.publicKeyString.get();
const PEER_API = 'http://127.0.0.1:7001/api';
const PEER_P2P = 'ws://127.0.0.1:7001/p2p';
const PEER = `${PEER_KEY}@${PEER_API}|${PEER_P2P}`;

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
		expect(config.endpoints).toEqual({ api: undefined, p2p: undefined });
		expect(config.preferUpdates).toBe('websocket');
		expect(config.manualPeers).toEqual([]);
		expect(config.peerLimits).toEqual({ sockets: 512, postedMessages: 256 });
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

/** An unset variable is one whose value is undefined, as in the process's environment. */
function peerSetting(peers: boolean): string | undefined {
	if (peers) {
		return(PEER);
	}
	return(undefined);
}

describe('the safety rule', function() {
	const PUBLIC: readonly Networks[] = ['main', 'test'];
	const VOTING: readonly LedgerWriteMode[] = ['read-write', 'no-voting'];

	const matrix = (['local', ...NetworkConfig.networksArray] as const).flatMap(function(network) {
		return(LEDGER_WRITE_MODES.flatMap(function(mode) {
			return([false, true].map(function(peers) {
				return({ network, mode, peers });
			}));
		}));
	});

	test.each(matrix)('$network in $mode mode, with peers: $peers', function({ network, mode, peers }) {
		const environment: Environment = { KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode, KEETANET_LOCAL_NODE_MANUAL_PEERS: peerSetting(peers) };
		if (network !== 'local' && PUBLIC.includes(network) && VOTING.includes(mode)) {
			expect(problemOf(environment)).toEqual({ kind: 'writable-on-public-network', network, ledgerWriteMode: mode });
			return;
		}
		if (network !== 'local' && peers && VOTING.includes(mode)) {
			expect(problemOf(environment)).toEqual({ kind: 'peers-on-keeta-network', network, ledgerWriteMode: mode, variable: 'KEETANET_LOCAL_NODE_MANUAL_PEERS' });
			return;
		}
		// Its peer-to-peer surface closed, a node following a public network has no peer to dial.
		if (network !== 'local' && peers && PUBLIC.includes(network)) {
			expect(problemOf(environment)).toEqual({ kind: 'peers-on-public-network', network });
			return;
		}
		const config = parse(environment);
		expect(config.ledgerWriteMode).toBe(mode);
		expect(config.manualPeers.length > 0).toBe(peers);
	});

	test.each(matrix)('$network in $mode mode, bootstrapping from peers: $peers', function({ network, mode, peers }) {
		let bootstrapPeers: string | undefined;
		if (peers) {
			bootstrapPeers = PEER_API;
		}
		const environment: Environment = { KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: mode, KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: bootstrapPeers };
		if (network !== 'local' && PUBLIC.includes(network) && VOTING.includes(mode)) {
			expect(problemOf(environment)).toEqual({ kind: 'writable-on-public-network', network, ledgerWriteMode: mode });
			return;
		}
		if (network !== 'local' && peers && VOTING.includes(mode)) {
			expect(problemOf(environment)).toEqual({ kind: 'peers-on-keeta-network', network, ledgerWriteMode: mode, variable: 'KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS' });
			return;
		}
		expect(parse(environment).bootstrapPeers.length > 0).toBe(peers);
	});

	test('says why a node following main or test names no peer', function() {
		expect(messageOf({ KEETANET_LOCAL_NODE_NETWORK: 'main', KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'bootstrap-only', KEETANET_LOCAL_NODE_MANUAL_PEERS: PEER })).toBe('the main network is public, so the node keeps its peer-to-peer surface closed there and reads it only by its bootstrap: leave KEETANET_LOCAL_NODE_MANUAL_PEERS unset');
	});

	test('says why bootstrapping from peers makes a node only follow dev and staging', function() {
		expect(messageOf({ KEETANET_LOCAL_NODE_NETWORK: 'dev', KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'no-voting', KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: PEER_API })).toBe('the dev network is Keeta\'s, so a node with peers on it may only follow it: set KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE to read-only or bootstrap-only (it is no-voting), or leave KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS unset');
	});

	test('applies to peers on the ID of a network as on its name', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_NETWORK: `0x${NetworkConfig.NetworkIDs.dev.toString(16)}`, KEETANET_LOCAL_NODE_MANUAL_PEERS: PEER })).toEqual({ kind: 'peers-on-keeta-network', network: 'dev', ledgerWriteMode: 'read-write', variable: 'KEETANET_LOCAL_NODE_MANUAL_PEERS' });
	});

	test('says why peers make a node only follow dev and staging', function() {
		expect(messageOf({ KEETANET_LOCAL_NODE_NETWORK: 'staging', KEETANET_LOCAL_NODE_MANUAL_PEERS: PEER })).toBe('the staging network is Keeta\'s, so a node with peers on it may only follow it: set KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE to read-only or bootstrap-only (it is read-write), or leave KEETANET_LOCAL_NODE_MANUAL_PEERS unset');
	});

	/* A network alias names upstream's own representatives [Keeta TS] index.js:61369-61466; none of them becomes a peer unless listed. */
	test.each(['local', ...NetworkConfig.networksArray])('derives no peer from the %s network', function(network) {
		const config = parse({ KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-only' });
		expect(config.manualPeers).toEqual([]);
		expect(config.bootstrapPeers).toEqual([]);
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

describe('KEETANET_LOCAL_NODE_MAX_PEER_SOCKETS and KEETANET_LOCAL_NODE_MAX_POSTED_MESSAGES', function() {
	test('limit what the node takes from peers at once', function() {
		expect(parse({ KEETANET_LOCAL_NODE_MAX_PEER_SOCKETS: '1', KEETANET_LOCAL_NODE_MAX_POSTED_MESSAGES: String(MAX_PEER_LIMIT) }).peerLimits).toEqual({ sockets: 1, postedMessages: MAX_PEER_LIMIT });
	});

	test('are each read alone, the other keeping its default', function() {
		expect(parse({ KEETANET_LOCAL_NODE_MAX_POSTED_MESSAGES: '64' }).peerLimits).toEqual({ sockets: 512, postedMessages: 64 });
	});

	const variables = ['KEETANET_LOCAL_NODE_MAX_PEER_SOCKETS', 'KEETANET_LOCAL_NODE_MAX_POSTED_MESSAGES'] as const;
	const refused = ['0', '-1', '1.5', '1e3', '0x10', ' 8', '08', 'many', String(MAX_PEER_LIMIT + 1)];

	test.each(variables.flatMap(function(variable) {
		return(refused.map(function(value) {
			return([variable, value] as const);
		}));
	}))('%s refuses %j', function(variable, value) {
		expect(problemOf({ [variable]: value })).toEqual({ kind: 'invalid', variable, expected: `a whole number from 1 to ${String(MAX_PEER_LIMIT)}`, value });
	});
});

/** What a peer record says, with its key written out. */
function describePeer(peer: P2PPeerRep): object {
	if ('signature' in peer) {
		return({ key: keyOf(peer.key), endpoints: peer.endpoints, preferUpdates: peer.preferUpdates, signature: Buffer.from(peer.signature).toString('base64') });
	}
	return({ key: keyOf(peer.key), endpoints: peer.endpoints, preferUpdates: peer.preferUpdates, certificate: peer.certificate });
}

/** The advertisement a node of that environment signs and greets its peers with. */
async function advertisementOf(environment: Environment): Promise<JSONSerializableObject> {
	const node = new LocalNode(localNodeConfig(parse(environment), { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() }));
	try {
		return(await node.switch.getOutgoingGreetingInfo());
	} finally {
		await node.stop();
	}
}

const PEER_NODE: Environment = {
	KEETANET_LOCAL_NODE_SEED_INDEX: '1',
	KEETANET_LOCAL_NODE_ENDPOINT_API: PEER_API,
	KEETANET_LOCAL_NODE_ENDPOINT_P2P: PEER_P2P
};

function stringField(record: JSONSerializableObject, name: string): string {
	const value = record[name];
	if (typeof value !== 'string') {
		throw(new Error(`the advertisement has no ${name}`));
	}
	return(value);
}

describe('KEETANET_LOCAL_NODE_MANUAL_PEERS', function() {
	test('names a peer by its key and endpoints, which it updates over the WebSocket unless it says otherwise', function() {
		const peers = parse({ KEETANET_LOCAL_NODE_MANUAL_PEERS: PEER }).manualPeers;
		expect(peers).toHaveLength(1);
		expect(requireAt(peers, 0).kind).toBe(lib.Node.Kind.REPRESENTATIVE);
		expect(describePeer(requireAt(peers, 0))).toEqual({ key: PEER_KEY, endpoints: { api: PEER_API, p2p: PEER_P2P }, preferUpdates: 'websocket', certificate: null });
	});

	test('lists peers separated by commas, each with how it prefers updates, keeping each endpoint as written', function() {
		const other = lib.Account.fromSeed(SEED, 2).publicKeyString.get();
		const peers = parse({ KEETANET_LOCAL_NODE_MANUAL_PEERS: ` ${PEER}|http , ${other}@https://rep.example:8443|wss://rep.example:8443/p2p|websocket, ` }).manualPeers;
		expect(peers.map(describePeer)).toEqual([
			{ key: PEER_KEY, endpoints: { api: PEER_API, p2p: PEER_P2P }, preferUpdates: 'http', certificate: null },
			{ key: other, endpoints: { api: 'https://rep.example:8443', p2p: 'wss://rep.example:8443/p2p' }, preferUpdates: 'websocket', certificate: null }
		]);
	});

	test('takes the advertisement a peer signs, as the peer itself writes it', async function() {
		const advertisement = await advertisementOf({ ...PEER_NODE, KEETANET_LOCAL_NODE_PREFER_UPDATES: 'http' });
		const signature = stringField(advertisement, 'signature');
		const written = `${PEER}|http|${signature}`;
		const peer = requireAt(parse({ KEETANET_LOCAL_NODE_MANUAL_PEERS: written }).manualPeers, 0);
		expect(describePeer(peer)).toEqual({ key: PEER_KEY, endpoints: { api: PEER_API, p2p: PEER_P2P }, preferUpdates: 'http', signature });
		expect(formatManualPeer(peer)).toBe(written);
	});

	test.each([
		{ change: 'its endpoints', written: (signature: string) => `${PEER_KEY}@${PEER_API}|ws://127.0.0.1:7002/p2p|websocket|${signature}` },
		{ change: 'how it prefers updates', written: (signature: string) => `${PEER}|http|${signature}` },
		{ change: 'its key', written: (signature: string) => `${lib.Account.fromSeed(SEED, 2).publicKeyString.get()}@${PEER_API}|${PEER_P2P}|websocket|${signature}` }
	])('refuses a signed advertisement that differs in $change', async function({ written }) {
		const signature = stringField(await advertisementOf(PEER_NODE), 'signature');
		const text = written(signature);
		const key = text.slice(0, text.indexOf('@'));
		expect(problemOf({ KEETANET_LOCAL_NODE_MANUAL_PEERS: text })).toEqual({ kind: 'peer-signature-invalid', key });
	});

	test.each(['AAAA', '////'])('refuses the signature %j, which is base64 but no signature', function(signature) {
		expect(problemOf({ KEETANET_LOCAL_NODE_MANUAL_PEERS: `${PEER}|websocket|${signature}` })).toEqual({ kind: 'peer-signature-invalid', key: PEER_KEY });
	});

	test.each(['auto', 'AUTO', ` auto `, `${PEER},auto`])('refuses %j: this node finds no peers by itself', function(value) {
		expect(problemOf({ KEETANET_LOCAL_NODE_MANUAL_PEERS: value })).toEqual({ kind: 'automatic-peers' });
		expect(messageOf({ KEETANET_LOCAL_NODE_MANUAL_PEERS: value })).toBe('KEETANET_LOCAL_NODE_MANUAL_PEERS=auto is not supported: this node finds no peers by itself, so list each as <keeta_ account>@<api URL>|<p2p URL>[|http or websocket[|signature]]');
	});

	test.each([
		['no key', `${PEER_API}|${PEER_P2P}`],
		['no p2p endpoint', `${PEER_KEY}@${PEER_API}`],
		['an empty endpoint', `${PEER_KEY}@${PEER_API}|`],
		['too many fields', `${PEER}|websocket|c2ln|more`],
		['an unknown preference', `${PEER}|HTTP`],
		['an empty signature', `${PEER}|websocket|`],
		['a signature that is no base64', `${PEER}|websocket|not base64!`],
		['an API endpoint that is no URL', `${PEER_KEY}@127.0.0.1:7001|${PEER_P2P}`],
		['an API endpoint over the WebSocket', `${PEER_KEY}@ws://127.0.0.1:7001/api|${PEER_P2P}`],
		['a p2p endpoint over HTTP', `${PEER_KEY}@${PEER_API}|http://127.0.0.1:7001/p2p`],
		['the key of a token', `${TOKEN.publicKeyString.get()}@${PEER_API}|${PEER_P2P}`]
	])('refuses a peer with %s', function(_ignored, value) {
		expect(problemOf({ KEETANET_LOCAL_NODE_MANUAL_PEERS: value })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_MANUAL_PEERS' });
	});

	test('says what a peer is written as', function() {
		expect(messageOf({ KEETANET_LOCAL_NODE_MANUAL_PEERS: PEER_API })).toBe(`KEETANET_LOCAL_NODE_MANUAL_PEERS must be <keeta_ account>@<api URL>|<p2p URL>[|http or websocket[|signature]] (it is ${JSON.stringify(PEER_API)})`);
	});

	test('refuses a list of no peers', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_MANUAL_PEERS: ' , ' })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_MANUAL_PEERS', value: ' , ' });
	});

	test('refuses a seed for a key without repeating it', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_MANUAL_PEERS: `${FEE_SEED}@${PEER_API}|${PEER_P2P}` })).toEqual({ kind: 'private-key-given', variable: 'KEETANET_LOCAL_NODE_MANUAL_PEERS' });
	});

	/* The switch keys its peers by account [Keeta TS] index.js:72088-72092, so a second entry would replace the first. */
	test('refuses a peer named twice', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_MANUAL_PEERS: `${PEER},${PEER_KEY}@https://elsewhere.example/api|wss://elsewhere.example/p2p` })).toEqual({ kind: 'duplicate-peer', key: PEER_KEY });
	});

	/* The switch drops a greeting from itself [Keeta TS] index.js:73556-73561. */
	test('refuses the node itself as its peer', function() {
		const own = lib.Account.fromSeed(SEED, 0).publicKeyString.get();
		expect(problemOf({ KEETANET_LOCAL_NODE_MANUAL_PEERS: `${own}@${PEER_API}|${PEER_P2P}` })).toEqual({ kind: 'peer-is-self', key: own });
	});
});

describe('KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS', function() {
	test('lists API endpoints separated by commas, each once and as written', function() {
		expect(parse({ KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: ` ${PEER_API} ,, https://rep.example:8443/keeta/api,${PEER_API}, ` }).bootstrapPeers).toEqual([PEER_API, 'https://rep.example:8443/keeta/api']);
	});

	test.each(['127.0.0.1:7001/api', 'ws://127.0.0.1:7001/p2p', 'http://127.0.0.1:7001/api?x=1', 'http://127.0.0.1:7001/api#top', 'http://127.0.0.1:7001/a|b', PEER])('refuses the endpoint %j', function(value) {
		expect(problemOf({ KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: value })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS' });
	});

	test('says what an endpoint is written as', function() {
		expect(messageOf({ KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: 'ws://127.0.0.1:7001/p2p' })).toBe('KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS must be a comma-separated list, each an http:// or https:// API URL without a user, password, query, fragment, "|" or "," (it is "ws://127.0.0.1:7001/p2p")');
	});

	test('refuses a list of no endpoints', function() {
		expect(problemOf({ KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: ' , ' })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS', value: ' , ' });
	});

	test('refuses a user or password, without repeating it', function() {
		const problem = problemOf({ KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: 'https://slop:hunter2@rep.example/api' });
		expect(problem).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS' });
		expect(problem).not.toHaveProperty('value');
		expect(messageOf({ KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: 'https://slop:hunter2@rep.example/api' })).not.toContain('hunter2');
	});
});

describe('KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS', function() {
	test('is 0 on the local network, whose representatives are the operator\'s own', function() {
		expect(parse({}).bootstrapMinIntervalMilliseconds).toBe(0);
	});

	test.each<Networks>(['main', 'test', 'dev', 'staging'])('is a second on the %s network, whose representatives are Keeta\'s', function(network) {
		expect(DEFAULT_KEETA_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS).toBe(1000);
		expect(parse({ KEETANET_LOCAL_NODE_NETWORK: network, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'bootstrap-only' }, { KEETANET_LOCAL_NODE_SEED: SEED }).bootstrapMinIntervalMilliseconds).toBe(1000);
	});

	test('takes whole milliseconds, 0 turning pacing off on any network', function() {
		expect(parse({ KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: '250' }).bootstrapMinIntervalMilliseconds).toBe(250);
		expect(parse({ KEETANET_LOCAL_NODE_NETWORK: 'main', KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'bootstrap-only', KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: '0' }, { KEETANET_LOCAL_NODE_SEED: SEED }).bootstrapMinIntervalMilliseconds).toBe(0);
		expect(parse({ KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: String(MAX_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS) }).bootstrapMinIntervalMilliseconds).toBe(MAX_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS);
	});

	test.each(['-1', '1.5', '1e3', '01', ' 5', String(MAX_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS + 1), 'second'])('refuses %j', function(value) {
		expect(problemOf({ KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: value })).toEqual({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS', expected: `a whole number of milliseconds from 0 to ${String(MAX_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS)}`, value });
	});

	test('is carried to the node\'s bootstrap client', function() {
		const node = localNodeConfig(parse({ KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: '750' }), { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() });
		expect(bootstrapPacingOf(node)).toBe(750);
	});
});

describe('KEETANET_LOCAL_NODE_ENDPOINT_API and KEETANET_LOCAL_NODE_ENDPOINT_P2P', function() {
	test('advertise where peers and clients reach the node, as written', function() {
		const endpoints = { KEETANET_LOCAL_NODE_ENDPOINT_API: 'https://rep.example/keeta/api', KEETANET_LOCAL_NODE_ENDPOINT_P2P: 'wss://rep.example:8443/p2p' };
		expect(parse(endpoints).endpoints).toEqual({ api: 'https://rep.example/keeta/api', p2p: 'wss://rep.example:8443/p2p' });
	});

	test('may be given one at a time when the node listens on one address', function() {
		expect(parse({ KEETANET_LOCAL_NODE_ENDPOINT_API: 'http://127.0.0.1:7000/api' }).endpoints).toEqual({ api: 'http://127.0.0.1:7000/api', p2p: undefined });
	});

	test.each(['127.0.0.1:7000/api', 'ws://127.0.0.1:7000/api', 'ftp://rep.example/api', 'http://127.0.0.1:7000/api?x=1', 'http://127.0.0.1:7000/api#top'])('refuse the API endpoint %j', function(value) {
		expect(problemOf({ KEETANET_LOCAL_NODE_ENDPOINT_API: value })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_ENDPOINT_API', value });
	});

	test.each(['http://127.0.0.1:7000/p2p', 'ws://127.0.0.1:7000', 'ws://127.0.0.1:7000/', 'ws://127.0.0.1:7000/p2p/', 'wss://rep.example/keeta/p2p', 'ws://127.0.0.1:7000/p2p?x=1'])('refuse the p2p endpoint %j, since the node serves peers on /p2p only', function(value) {
		expect(problemOf({ KEETANET_LOCAL_NODE_ENDPOINT_P2P: value })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_ENDPOINT_P2P', value });
	});

	test('names the path the node serves peers on', function() {
		expect(messageOf({ KEETANET_LOCAL_NODE_ENDPOINT_P2P: 'ws://127.0.0.1:7000/peers' })).toBe('KEETANET_LOCAL_NODE_ENDPOINT_P2P must be a ws:// or wss:// URL whose path is /p2p, where the node serves peers, without a user, password, query, fragment, "|" or "," (it is "ws://127.0.0.1:7000/peers")');
	});

	/* The node prints its endpoints in its peer, which another node reads back, and sends them to every peer. */
	test.each([
		['KEETANET_LOCAL_NODE_ENDPOINT_API', 'http://127.0.0.1:7000/a|b'],
		['KEETANET_LOCAL_NODE_ENDPOINT_API', 'http://127.0.0.1:7000/a,b'],
		['KEETANET_LOCAL_NODE_ENDPOINT_P2P', 'ws://rep,example:7000/p2p']
	] as const)('refuse %s %j, which a peer could not read back', function(variable, value) {
		expect(problemOf({ [variable]: value })).toMatchObject({ kind: 'invalid', variable, value });
		expect(messageOf({ [variable]: value })).toContain('"|" or ","');
	});

	test.each([
		['KEETANET_LOCAL_NODE_ENDPOINT_API', 'http://slop:hunter2@127.0.0.1:7000/api'],
		['KEETANET_LOCAL_NODE_ENDPOINT_API', 'https://slop@rep.example/api'],
		['KEETANET_LOCAL_NODE_ENDPOINT_API', 'http://@127.0.0.1:7000/api'],
		['KEETANET_LOCAL_NODE_ENDPOINT_P2P', 'wss://slop:hunter2@rep.example/p2p']
	] as const)('refuse %s %j, which would advertise a user or password, without repeating it', function(variable, value) {
		const problem = problemOf({ [variable]: value });
		expect(problem).toMatchObject({ kind: 'invalid', variable });
		expect(problem).not.toHaveProperty('value');
		expect(messageOf({ [variable]: value })).toContain('without a user, password');
		expect(messageOf({ [variable]: value })).not.toContain('hunter2');
	});

	test('are signed into the advertisement the node greets its peers with', async function() {
		const advertisement = await advertisementOf(PEER_NODE);
		expect(advertisement).toMatchObject({ key: PEER_KEY, endpoints: { api: PEER_API, p2p: PEER_P2P }, preferUpdates: 'websocket' });
	});
});

describe('listening on every interface', function() {
	const BOTH = { KEETANET_LOCAL_NODE_ENDPOINT_API: 'https://rep.example/api', KEETANET_LOCAL_NODE_ENDPOINT_P2P: 'wss://rep.example/p2p' };

	test.each(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0'])('on %j is allowed with both endpoints', function(ip) {
		expect(parse({ ...BOTH, KEETANET_LOCAL_NODE_LISTEN_IP: ip }).listen.ip).toBe(ip);
	});

	test.each(['0.0.0.0', '::'])('on %j is refused without them, since peers cannot be sent to it', function(ip) {
		expect(problemOf({ KEETANET_LOCAL_NODE_LISTEN_IP: ip })).toEqual({ kind: 'endpoints-required', listenIP: ip, missing: ['KEETANET_LOCAL_NODE_ENDPOINT_API', 'KEETANET_LOCAL_NODE_ENDPOINT_P2P'] });
		expect(problemOf({ KEETANET_LOCAL_NODE_LISTEN_IP: ip, KEETANET_LOCAL_NODE_ENDPOINT_API: BOTH.KEETANET_LOCAL_NODE_ENDPOINT_API })).toEqual({ kind: 'endpoints-required', listenIP: ip, missing: ['KEETANET_LOCAL_NODE_ENDPOINT_P2P'] });
	});

	test('says which endpoint is missing', function() {
		expect(messageOf({ KEETANET_LOCAL_NODE_LISTEN_IP: '0.0.0.0', KEETANET_LOCAL_NODE_ENDPOINT_P2P: BOTH.KEETANET_LOCAL_NODE_ENDPOINT_P2P })).toBe('the node listens on every interface (0.0.0.0), so it cannot tell peers where to reach it: set KEETANET_LOCAL_NODE_ENDPOINT_API');
	});
});

describe('KEETANET_LOCAL_NODE_PREFER_UPDATES', function() {
	test.each(['http', 'websocket'] as const)('reads %j', function(value) {
		expect(parse({ KEETANET_LOCAL_NODE_PREFER_UPDATES: value }).preferUpdates).toBe(value);
	});

	test.each(['HTTP', 'ws', 'https'])('refuses %j', function(value) {
		expect(problemOf({ KEETANET_LOCAL_NODE_PREFER_UPDATES: value })).toMatchObject({ kind: 'invalid', variable: 'KEETANET_LOCAL_NODE_PREFER_UPDATES', value });
	});

	test('is what the node tells its peers', async function() {
		expect(await advertisementOf({ ...PEER_NODE, KEETANET_LOCAL_NODE_PREFER_UPDATES: 'http' })).toMatchObject({ preferUpdates: 'http' });
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
		expect(node.p2p).toEqual({ kv, useHTTPRepublish: false });
		expect(node.p2p?.kv).toBe(kv);
		expect(node.log).toBe(log);
		expect(node.nodeOptions).toEqual({ listenIP: '127.0.0.1', listenPort: 7000 });
		expect(node.endpoints).toBeUndefined();
		expect(node.manualPeers).toEqual([]);
		expect(node.bootstrap).toEqual({ kv });
		expect(node.bootstrap?.kv).toBe(kv);
		expect(bootstrapEndpointsOf(node)).toEqual([]);
		expect(node.peerLimits).toEqual({ sockets: 512, postedMessages: 256 });
	});

	test('carries the peer limits', function() {
		const config = parse({ KEETANET_LOCAL_NODE_MAX_PEER_SOCKETS: '2048', KEETANET_LOCAL_NODE_MAX_POSTED_MESSAGES: '32' });
		const node = localNodeConfig(config, { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() });
		expect(node.peerLimits).toEqual({ sockets: 2048, postedMessages: 32 });
	});

	test('carries the peers, the advertised endpoints and the preference for HTTP updates', function() {
		const config = parse({
			KEETANET_LOCAL_NODE_ENDPOINT_API: 'https://rep.example/api',
			KEETANET_LOCAL_NODE_ENDPOINT_P2P: 'wss://rep.example/p2p',
			KEETANET_LOCAL_NODE_PREFER_UPDATES: 'http',
			KEETANET_LOCAL_NODE_MANUAL_PEERS: PEER
		});
		const node = localNodeConfig(config, { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() });
		expect(node.endpoints).toEqual({ api: 'https://rep.example/api', p2p: 'wss://rep.example/p2p' });
		expect(node.p2p).toEqual({ useHTTPRepublish: true });
		expect(node.manualPeers?.map(function(peer): string | undefined {
			if (peer.kind !== lib.Node.Kind.REPRESENTATIVE) {
				return(undefined);
			}
			return(formatManualPeer(peer));
		})).toEqual([`${PEER}|websocket`]);
	});

	test('carries the endpoints the node bootstraps from, and keeps its cursors in memory when it keeps nothing else in a store', function() {
		const node = localNodeConfig(parse({ KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: `${PEER_API},https://rep.example/api` }), { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() });
		expect(bootstrapEndpointsOf(node)).toEqual([PEER_API, 'https://rep.example/api']);
		expect(node.bootstrap).toBeUndefined();
	});

	test('carries one advertised endpoint alone, leaving the other to the node', function() {
		const node = localNodeConfig(parse({ KEETANET_LOCAL_NODE_ENDPOINT_P2P: 'ws://127.0.0.1:7000/p2p' }), { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() });
		expect(node.endpoints).toEqual({ p2p: 'ws://127.0.0.1:7000/p2p' });
	});

	test('gives the local network the alias the test helpers give network 0', function() {
		const node = localNodeConfig(parse({}), { storageDriver: new MemoryLedgerStorage(), kv: null, log: new lib.Log() });
		expect(node.network).toBe(0n);
		expect(node.networkAlias).toBe('test');
		expect(node.stats.kv).toBeNull();
		// Without a store of its own the switch keeps its peers in memory [Keeta TS] index.js:72510-72515.
		expect(node.p2p).toEqual({ useHTTPRepublish: false });
	});
});
