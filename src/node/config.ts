import { isIP } from 'node:net';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Networks } from '@keetanetwork/keetanet-client/config/index.js';
import type { Account, GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { LedgerConfig } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { LogTargetLevel } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { LocalNodeConfig } from '@keetanetwork/keetanet-client/lib/node/local.js';
import { assertNever } from '../util/assert-never.js';
import type { AssertNever } from '../util/assert-never.js';
import { computeFeeFromBlocksFor, parseFeeSchedule } from './fees.js';
import type { FeeAccount, FeePolicy } from './fees.js';

const lib = KeetaNet.lib;
const NetworkConfig = KeetaNet.Client.Config;

/** The process environment, or any stand-in for it. */
export type Environment = Readonly<Record<string, string | undefined>>;

const NODE_PREFIX = 'KEETANET_LOCAL_NODE_';
const GENESIS_PREFIX = 'KEETANET_GENESIS_';

/**
 * Every variable of the node. The seed, log, write mode, trusted account and
 * fee account variables carry the names upstream's node reads; the rest are
 * this node's own.
 * [node-lite] adapted from getConfigFromEnv and getFeeConfigFromEnv.
 */
export const NODE_VARIABLES = [
	'KEETANET_LOCAL_NODE_SEED',
	'KEETANET_LOCAL_NODE_SEED_INDEX',
	'KEETANET_LOCAL_NODE_LOG_LEVEL',
	'KEETANET_LOCAL_NODE_LOG_FILTER',
	'KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE',
	'KEETANET_LOCAL_NODE_FEE_SEED',
	'KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX',
	'KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX',
	'KEETANET_LOCAL_NODE_FEE_ACCOUNTS',
	'KEETANET_LOCAL_NODE_FEE_TOKEN',
	'KEETANET_LOCAL_NODE_FEE_SCHEDULE',
	'KEETANET_LOCAL_NODE_NETWORK',
	'KEETANET_LOCAL_NODE_POSTGRES_URL',
	'KEETANET_LOCAL_NODE_LISTEN_IP',
	'KEETANET_LOCAL_NODE_LISTEN_PORT',
	'KEETANET_LOCAL_NODE_ENABLE_TOKEN_ADMIN_MODIFY_BALANCE'
] as const;

export const TRUSTED_ACCOUNT_VARIABLE = 'KEETANET_INITIAL_TRUSTED_ACCOUNT';

/** Read only by the genesis command, so that the trusted key never sits in a running node's environment. */
export const GENESIS_VARIABLES = [
	'KEETANET_GENESIS_TRUSTED_SEED',
	'KEETANET_GENESIS_TRUSTED_SEED_INDEX',
	'KEETANET_GENESIS_SUPPLY',
	'KEETANET_GENESIS_DELEGATE_TO'
] as const;

export type ConfigVariable = typeof NODE_VARIABLES[number] | typeof TRUSTED_ACCOUNT_VARIABLE | typeof GENESIS_VARIABLES[number];

/** Variables whose values are never repeated in an error, since they hold keys or passwords. */
const SECRET_VARIABLES: ReadonlySet<ConfigVariable> = new Set<ConfigVariable>([
	'KEETANET_LOCAL_NODE_SEED',
	'KEETANET_LOCAL_NODE_FEE_SEED',
	'KEETANET_LOCAL_NODE_POSTGRES_URL',
	'KEETANET_GENESIS_TRUSTED_SEED'
]);

export type LedgerWriteMode = NonNullable<LedgerConfig['ledgerWriteMode']>;

const WRITE_MODES = ['read-write', 'read-only', 'bootstrap-only', 'no-voting'] as const satisfies readonly LedgerWriteMode[];

/** Fails to compile when upstream adds a write mode that the list above does not offer. */
type _EveryWriteModeListed = AssertNever<Exclude<LedgerWriteMode, typeof WRITE_MODES[number]>>;

export const LEDGER_WRITE_MODES: readonly LedgerWriteMode[] = WRITE_MODES;

/**
 * The public networks. A node there may only follow the ledger: in
 * these modes it never votes [Keeta TS] index.js:70172-70174 and adds nothing
 * but what it bootstraps [Keeta TS] index.js:69363-69375.
 */
export type PublicNetwork = Extract<Networks, 'main' | 'test'>;
export const PUBLIC_NETWORKS: readonly PublicNetwork[] = ['main', 'test'];

export type FollowingWriteMode = Extract<LedgerWriteMode, 'read-only' | 'bootstrap-only'>;
export const FOLLOWING_WRITE_MODES: readonly FollowingWriteMode[] = ['read-only', 'bootstrap-only'];

const LOG_LEVELS = ['ALL', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'NONE'] as const satisfies readonly LogTargetLevel[];

/** Fails to compile when upstream adds a log level that the list above does not offer. */
type _EveryLogLevelListed = AssertNever<Exclude<LogTargetLevel, typeof LOG_LEVELS[number]>>;

/** Why the environment does not describe a node this process may run. */
export type ConfigProblem =
	| { readonly kind: 'unknown-variable'; readonly variable: string }
	| { readonly kind: 'missing'; readonly variable: ConfigVariable }
	| { readonly kind: 'empty'; readonly variable: ConfigVariable }
	/** The value is left out when the variable is secret. */
	| { readonly kind: 'invalid'; readonly variable: ConfigVariable; readonly expected: string; readonly value?: string }
	| { readonly kind: 'private-key-given'; readonly variable: ConfigVariable }
	| { readonly kind: 'conflicting'; readonly variables: readonly [ConfigVariable, ConfigVariable] }
	| { readonly kind: 'fee-recipient-without-fee'; readonly variable: ConfigVariable }
	| { readonly kind: 'too-many-fee-accounts'; readonly count: number; readonly maximum: number }
	| { readonly kind: 'writable-on-public-network'; readonly network: PublicNetwork; readonly ledgerWriteMode: LedgerWriteMode }
	| { readonly kind: 'genesis-on-public-network'; readonly network: PublicNetwork }
	| { readonly kind: 'genesis-in-memory' }
	| { readonly kind: 'trusted-seed-mismatch'; readonly derived: string; readonly trusted: string };

function describeProblem(problem: ConfigProblem): string {
	switch (problem.kind) {
		case 'unknown-variable':
			return(`${problem.variable} is not a setting of this node`);
		case 'missing':
			return(`${problem.variable} is not set`);
		case 'empty':
			return(`${problem.variable} is set but empty`);
		case 'invalid':
			if (problem.value === undefined) {
				return(`${problem.variable} must be ${problem.expected}`);
			}
			return(`${problem.variable} must be ${problem.expected} (it is ${JSON.stringify(problem.value)})`);
		case 'private-key-given':
			return(`${problem.variable} holds a seed; give the public key (keeta_...) instead`);
		case 'conflicting':
			return(`${problem.variables[0]} and ${problem.variables[1]} cannot both be set`);
		case 'fee-recipient-without-fee':
			return(`${problem.variable} says where fees go, but KEETANET_LOCAL_NODE_FEE_SCHEDULE charges nothing`);
		case 'too-many-fee-accounts':
			return(`KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX and KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX name ${String(problem.count)} fee accounts, but at most ${String(problem.maximum)} are derived`);
		case 'writable-on-public-network':
			return(`the ${problem.network} network is public, so the node may only follow it: set KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE to ${FOLLOWING_WRITE_MODES.join(' or ')} (it is ${problem.ledgerWriteMode})`);
		case 'genesis-on-public-network':
			return(`the ${problem.network} network is public and already has its genesis`);
		case 'genesis-in-memory':
			return('genesis needs KEETANET_LOCAL_NODE_POSTGRES_URL: a ledger in memory is gone when the command ends');
		case 'trusted-seed-mismatch':
			return(`KEETANET_GENESIS_TRUSTED_SEED derives ${problem.derived}, but the node trusts ${problem.trusted}`);
		default:
			return(assertNever(problem));
	}
}

export class ConfigError extends Error {
	readonly problem: ConfigProblem;

	constructor(problem: ConfigProblem, options?: ErrorOptions) {
		super(describeProblem(problem), options);
		this.name = 'ConfigError';
		this.problem = problem;
	}
}

/** The network the node keeps the ledger of. */
export type NetworkSelection =
	/** Network 0, which the client validates without a configuration of its own [Keeta TS] index.js:61350-61352. */
	| { readonly kind: 'local'; readonly network: 0n }
	| { readonly kind: 'known'; readonly alias: Networks; readonly network: bigint };

export type LogSettings = {
	readonly level: LogTargetLevel;
	/** Only entries matching it are written. */
	readonly filter: RegExp | undefined;
};

export type StorageChoice =
	/** Nothing survives the process. */
	| { readonly kind: 'memory' }
	/** The ledger and the key-value store, in one database. */
	| { readonly kind: 'postgres'; readonly connectionString: string };

export type ListenAddress = {
	readonly ip: string;
	/** 0 lets the operating system choose. */
	readonly port: number;
};

/** A node as the environment describes it. */
export type EnvironmentConfig = {
	readonly network: NetworkSelection;
	/** The key the node votes with. */
	readonly representative: Account;
	/** Public only, as upstream requires [Keeta TS] index.js:71338-71340. */
	readonly initialTrustedAccount: Account;
	readonly ledgerWriteMode: LedgerWriteMode;
	readonly log: LogSettings;
	readonly storage: StorageChoice;
	readonly listen: ListenAddress;
	readonly fee: FeePolicy;
	/** Off by default, as upstream has it [Keeta TS] index.js:68983. */
	readonly enableTokenAdminModifyBalance: boolean;
};

const DEFAULT_LOG_LEVEL: LogTargetLevel = 'INFO';
const DEFAULT_LEDGER_WRITE_MODE: LedgerWriteMode = 'read-write';
const DEFAULT_LISTEN: ListenAddress = { ip: '127.0.0.1', port: 0 };

/*
 * Upstream gives network 0 no alias of its own, while a node needs one; the
 * test helpers name it "test" as well. The alias only labels the node's log
 * [Keeta TS] index.js:71367.
 */
const LOCAL_NETWORK_ALIAS: Networks = 'test';

/** A seed is 32 bytes [Keeta TS] index.js:61735, written in hexadecimal. */
const SEED = /^[0-9a-f]{64}$/i;
const SEED_EXPECTED = '64 hexadecimal digits';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEXADECIMAL = /^0x[0-9a-f]+$/i;

/** Seed indexes fit in 32 bits [Keeta TS] index.js:61739-61741. */
const MAX_SEED_INDEX = 0xffffffff;

/*
 * Every key of the fee seed range is derived as the configuration is read,
 * at about half a millisecond each, so the whole 32-bit range would take
 * weeks; this many take about half a second. A vote pays one of them, picked
 * at random [Keeta TS] index.js:70267-70280, so more only spread the fees
 * thinner.
 */
export const MAX_FEE_SEED_ACCOUNTS = 1024;
const MAX_PORT = 65535;

const POSTGRES_PROTOCOLS: ReadonlySet<string> = new Set(['postgres:', 'postgresql:']);

/** A secret value is left out of the error, and so is the cause, which may quote it. */
function invalid(variable: ConfigVariable, expected: string, value: string, options?: ErrorOptions): ConfigError {
	if (SECRET_VARIABLES.has(variable)) {
		return(new ConfigError({ kind: 'invalid', variable, expected }));
	}
	return(new ConfigError({ kind: 'invalid', variable, expected, value }, options));
}

/**
 * Reads variables of the environment. An empty value is refused rather than
 * read as unset, since it usually means a value was meant and lost.
 */
export class EnvironmentReader {
	readonly #environment: Environment;

	constructor(environment: Environment) {
		this.#environment = environment;
	}

	optional(variable: ConfigVariable): string | undefined {
		const value = this.#environment[variable];
		if (value === '') {
			throw(new ConfigError({ kind: 'empty', variable }));
		}
		return(value);
	}

	required(variable: ConfigVariable): string {
		const value = this.optional(variable);
		if (value === undefined) {
			throw(new ConfigError({ kind: 'missing', variable }));
		}
		return(value);
	}

	/** The parsed value of the variable, or the fallback when it is unset. */
	read<Value>(variable: ConfigVariable, parse: (text: string) => Value, fallback: Value): Value {
		const text = this.optional(variable);
		if (text === undefined) {
			return(fallback);
		}
		return(parse(text));
	}

	isSet(variable: ConfigVariable): boolean {
		return(this.optional(variable) !== undefined);
	}

	/** A name of the node's own prefix that it does not read, which is most likely a misspelling. */
	unknownNodeVariable(): string | undefined {
		return(this.#unknownVariable(NODE_PREFIX, NODE_VARIABLES));
	}

	/** A name of the genesis command's prefix that it does not read. */
	unknownGenesisVariable(): string | undefined {
		return(this.#unknownVariable(GENESIS_PREFIX, GENESIS_VARIABLES));
	}

	#unknownVariable(prefix: string, variables: readonly ConfigVariable[]): string | undefined {
		const known: ReadonlySet<string> = new Set(variables);
		return(Object.keys(this.#environment).find(function(name): boolean {
			return(name.startsWith(prefix) && !known.has(name));
		}));
	}
}

export function parseSeed(variable: ConfigVariable, text: string): string {
	if (!SEED.test(text)) {
		throw(invalid(variable, SEED_EXPECTED, text));
	}
	return(text.toLowerCase());
}

export function parseSeedIndex(variable: ConfigVariable, text: string): number {
	if (!DECIMAL.test(text) || Number(text) > MAX_SEED_INDEX) {
		throw(invalid(variable, `a whole number from 0 to ${String(MAX_SEED_INDEX)}`, text));
	}
	return(Number(text));
}

/** The key at the seed's index, holding its private key. */
export function readSeedAccount(reader: EnvironmentReader, seedVariable: ConfigVariable, indexVariable: ConfigVariable): Account {
	const seed = parseSeed(seedVariable, reader.required(seedVariable));
	const index = parseSeedIndex(indexVariable, reader.optional(indexVariable) ?? '0');
	return(lib.Account.fromSeed(seed, index));
}

/** The public half of a key, so that a private key is held only where it signs. */
export function publicOnly(account: Account): Account {
	return(lib.Account.fromPublicKeyString(account.publicKeyString.get()).assertAccount());
}

function parsePublicKey(variable: ConfigVariable, text: string): GenericAccount {
	if (SEED.test(text)) {
		throw(new ConfigError({ kind: 'private-key-given', variable }));
	}
	try {
		return(lib.Account.fromPublicKeyString(text));
	} catch (error: unknown) {
		throw(invalid(variable, 'a public key (keeta_...)', text, { cause: error }));
	}
}

export function parseAccountKey(variable: ConfigVariable, text: string): Account {
	const key = parsePublicKey(variable, text);
	if (!key.isAccount()) {
		throw(invalid(variable, 'the public key of an account, not of an identifier', text));
	}
	return(key);
}

function parseLogLevel(text: string): LogTargetLevel {
	const level = LOG_LEVELS.find(function(candidate): boolean {
		return(candidate === text.toUpperCase());
	});
	if (level === undefined) {
		throw(invalid('KEETANET_LOCAL_NODE_LOG_LEVEL', `one of ${LOG_LEVELS.join(', ')}`, text));
	}
	return(level);
}

/** Matched regardless of case, as upstream matches its own log filter [Keeta TS] index.js:70820-70822. */
function parseLogFilter(text: string): RegExp {
	try {
		return(new RegExp(text, 'i'));
	} catch (error: unknown) {
		throw(invalid('KEETANET_LOCAL_NODE_LOG_FILTER', 'a regular expression', text, { cause: error }));
	}
}

function parseLedgerWriteMode(text: string): LedgerWriteMode {
	const mode = LEDGER_WRITE_MODES.find(function(candidate): boolean {
		return(candidate === text);
	});
	if (mode === undefined) {
		throw(invalid('KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE', `one of ${LEDGER_WRITE_MODES.join(', ')}`, text));
	}
	return(mode);
}

function networkWithID(id: bigint): NetworkSelection | undefined {
	if (id === 0n) {
		return({ kind: 'local', network: 0n });
	}
	const alias = NetworkConfig.networksArray.find(function(candidate): boolean {
		return(NetworkConfig.NetworkIDs[candidate] === id);
	});
	if (alias === undefined) {
		return(undefined);
	}
	return({ kind: 'known', alias, network: id });
}

/**
 * A name, or a network ID in decimal or hexadecimal. Only the IDs the client
 * knows are accepted: it validates the blocks of no other network
 * [Keeta TS] index.js:61337-61365.
 */
function parseNetwork(text: string): NetworkSelection {
	if (text === 'local') {
		return({ kind: 'local', network: 0n });
	}
	if (NetworkConfig.isNetwork(text)) {
		return({ kind: 'known', alias: text, network: NetworkConfig.NetworkIDs[text] });
	}
	let selection: NetworkSelection | undefined;
	if (DECIMAL.test(text) || HEXADECIMAL.test(text)) {
		selection = networkWithID(BigInt(text));
	}
	if (selection === undefined) {
		throw(invalid('KEETANET_LOCAL_NODE_NETWORK', `local, ${NetworkConfig.networksArray.join(', ')}, or the ID of one of them`, text));
	}
	return(selection);
}

export function publicNetworkOf(selection: NetworkSelection): PublicNetwork | undefined {
	switch (selection.kind) {
		case 'local':
			return(undefined);
		case 'known':
			return(PUBLIC_NETWORKS.find(function(network): boolean {
				return(network === selection.alias);
			}));
		default:
			return(assertNever(selection));
	}
}

function isFollowingWriteMode(mode: LedgerWriteMode): boolean {
	return(FOLLOWING_WRITE_MODES.some(function(candidate): boolean {
		return(candidate === mode);
	}));
}

function readTrustedAccount(reader: EnvironmentReader, network: NetworkSelection): Account {
	const text = reader.optional(TRUSTED_ACCOUNT_VARIABLE);
	if (text !== undefined) {
		return(parseAccountKey(TRUSTED_ACCOUNT_VARIABLE, text));
	}
	switch (network.kind) {
		case 'local':
			throw(new ConfigError({ kind: 'missing', variable: TRUSTED_ACCOUNT_VARIABLE }));
		case 'known':
			return(NetworkConfig.getDefaultConfig(network.alias).initialTrustedAccount);
		default:
			return(assertNever(network));
	}
}

function parsePostgresURL(text: string): StorageChoice {
	const expected = 'a postgres:// or postgresql:// URL';
	let url: URL;
	try {
		url = new URL(text);
	} catch (error: unknown) {
		throw(invalid('KEETANET_LOCAL_NODE_POSTGRES_URL', expected, text, { cause: error }));
	}
	if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
		throw(invalid('KEETANET_LOCAL_NODE_POSTGRES_URL', expected, text));
	}
	return({ kind: 'postgres', connectionString: text });
}

function parseListenIP(text: string): string {
	if (isIP(text) === 0) {
		throw(invalid('KEETANET_LOCAL_NODE_LISTEN_IP', 'an IPv4 or IPv6 address', text));
	}
	return(text);
}

function parseListenPort(text: string): number {
	if (!DECIMAL.test(text) || Number(text) > MAX_PORT) {
		throw(invalid('KEETANET_LOCAL_NODE_LISTEN_PORT', `a port from 0 to ${String(MAX_PORT)}`, text));
	}
	return(Number(text));
}

function parseBoolean(variable: ConfigVariable, text: string): boolean {
	switch (text) {
		case 'true':
			return(true);
		case 'false':
			return(false);
		default:
			throw(invalid(variable, 'true or false', text));
	}
}

const FEE_SEED_VARIABLES = ['KEETANET_LOCAL_NODE_FEE_SEED', 'KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX', 'KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX'] as const satisfies readonly ConfigVariable[];
const FEE_RECIPIENT_VARIABLES = [...FEE_SEED_VARIABLES, 'KEETANET_LOCAL_NODE_FEE_ACCOUNTS', 'KEETANET_LOCAL_NODE_FEE_TOKEN'] as const satisfies readonly ConfigVariable[];

/** Accounts or storage accounts, as upstream pays fees to [Keeta TS] index.js:70267. [node-lite] adapted from getFeeConfigFromEnv. */
function parseFeeAccountList(text: string): FeeAccount[] {
	const variable = 'KEETANET_LOCAL_NODE_FEE_ACCOUNTS';
	const entries = text.split(',').map(function(entry): string {
		return(entry.trim());
	}).filter(function(entry): boolean {
		return(entry !== '');
	});
	if (entries.length === 0) {
		throw(invalid(variable, 'a comma-separated list of public keys', text));
	}
	return(entries.map(function(entry): FeeAccount {
		const key = parsePublicKey(variable, entry);
		if (key.isAccount() || key.isStorage()) {
			return(key);
		}
		throw(invalid(variable, 'public keys of accounts or storage accounts', entry));
	}));
}

/** The public keys at every index of the range, both ends included. [node-lite] adapted from getFeeConfigFromEnv. */
function readFeeSeedAccounts(reader: EnvironmentReader): FeeAccount[] {
	const seed = parseSeed('KEETANET_LOCAL_NODE_FEE_SEED', reader.required('KEETANET_LOCAL_NODE_FEE_SEED'));
	const first = parseSeedIndex('KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX', reader.required('KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX'));
	const lastText = reader.required('KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX');
	const last = parseSeedIndex('KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX', lastText);
	if (last < first) {
		throw(invalid('KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX', `at least KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX (${String(first)})`, lastText));
	}
	const count = last - first + 1;
	if (count > MAX_FEE_SEED_ACCOUNTS) {
		throw(new ConfigError({ kind: 'too-many-fee-accounts', count, maximum: MAX_FEE_SEED_ACCOUNTS }));
	}
	const accounts: FeeAccount[] = [];
	for (let index = first; index <= last; index++) {
		accounts.push(publicOnly(lib.Account.fromSeed(seed, index)));
	}
	return(accounts);
}

function readFeeAccounts(reader: EnvironmentReader): FeeAccount[] {
	const seedVariable = FEE_SEED_VARIABLES.find(function(variable): boolean {
		return(reader.isSet(variable));
	});
	const list = reader.optional('KEETANET_LOCAL_NODE_FEE_ACCOUNTS');
	if (seedVariable !== undefined && list !== undefined) {
		throw(new ConfigError({ kind: 'conflicting', variables: [seedVariable, 'KEETANET_LOCAL_NODE_FEE_ACCOUNTS'] }));
	}
	if (list !== undefined) {
		return(parseFeeAccountList(list));
	}
	if (seedVariable !== undefined) {
		return(readFeeSeedAccounts(reader));
	}
	return([]);
}

function readFeeToken(reader: EnvironmentReader): TokenAddress | undefined {
	const variable = 'KEETANET_LOCAL_NODE_FEE_TOKEN';
	const text = reader.optional(variable);
	if (text === undefined) {
		return(undefined);
	}
	const key = parsePublicKey(variable, text);
	if (!key.isToken()) {
		throw(invalid(variable, 'the public key of a token', text));
	}
	return(key);
}

function readFeePolicy(reader: EnvironmentReader): FeePolicy {
	const scheduleText = reader.optional('KEETANET_LOCAL_NODE_FEE_SCHEDULE') ?? 'free';
	const schedule = parseFeeSchedule(scheduleText);
	if (schedule === undefined) {
		throw(invalid('KEETANET_LOCAL_NODE_FEE_SCHEDULE', 'free, or flat:<base units per block>', scheduleText));
	}
	switch (schedule.kind) {
		case 'free': {
			const recipient = FEE_RECIPIENT_VARIABLES.find(function(variable): boolean {
				return(reader.isSet(variable));
			});
			if (recipient !== undefined) {
				throw(new ConfigError({ kind: 'fee-recipient-without-fee', variable: recipient }));
			}
			return(schedule);
		}
		case 'flat':
			return({ ...schedule, payTo: readFeeAccounts(reader), token: readFeeToken(reader) });
		default:
			return(assertNever(schedule));
	}
}

/**
 * The node the environment describes. A representative on a public network
 * is refused unless it only follows the ledger there, so that it can never
 * vote or accept a publish on it.
 */
export function getConfigFromEnv(environment: Environment): EnvironmentConfig {
	const reader = new EnvironmentReader(environment);
	const unknown = reader.unknownNodeVariable();
	if (unknown !== undefined) {
		throw(new ConfigError({ kind: 'unknown-variable', variable: unknown }));
	}

	const network = reader.read('KEETANET_LOCAL_NODE_NETWORK', parseNetwork, { kind: 'local', network: 0n });
	const ledgerWriteMode = reader.read('KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE', parseLedgerWriteMode, DEFAULT_LEDGER_WRITE_MODE);
	const publicNetwork = publicNetworkOf(network);
	if (publicNetwork !== undefined && !isFollowingWriteMode(ledgerWriteMode)) {
		throw(new ConfigError({ kind: 'writable-on-public-network', network: publicNetwork, ledgerWriteMode }));
	}

	return({
		network,
		representative: readSeedAccount(reader, 'KEETANET_LOCAL_NODE_SEED', 'KEETANET_LOCAL_NODE_SEED_INDEX'),
		initialTrustedAccount: readTrustedAccount(reader, network),
		ledgerWriteMode,
		log: {
			level: reader.read('KEETANET_LOCAL_NODE_LOG_LEVEL', parseLogLevel, DEFAULT_LOG_LEVEL),
			filter: reader.read<RegExp | undefined>('KEETANET_LOCAL_NODE_LOG_FILTER', parseLogFilter, undefined)
		},
		storage: reader.read('KEETANET_LOCAL_NODE_POSTGRES_URL', parsePostgresURL, { kind: 'memory' }),
		listen: {
			ip: reader.read('KEETANET_LOCAL_NODE_LISTEN_IP', parseListenIP, DEFAULT_LISTEN.ip),
			port: reader.read('KEETANET_LOCAL_NODE_LISTEN_PORT', parseListenPort, DEFAULT_LISTEN.port)
		},
		fee: readFeePolicy(reader),
		enableTokenAdminModifyBalance: reader.read('KEETANET_LOCAL_NODE_ENABLE_TOKEN_ADMIN_MODIFY_BALANCE', function(text: string): boolean {
			return(parseBoolean('KEETANET_LOCAL_NODE_ENABLE_TOKEN_ADMIN_MODIFY_BALANCE', text));
		}, false)
	});
}

/** What the storage choice opens, and where the node logs. */
export type NodeResources = {
	readonly storageDriver: LocalNodeConfig['ledger']['storageDriver'];
	/** Null keeps the statistics and peers in memory [Keeta TS] index.js:72514, 74357-74360. */
	readonly kv: LocalNodeConfig['stats']['kv'];
	readonly log: NonNullable<LocalNodeConfig['log']>;
};

function networkAliasOf(selection: NetworkSelection): Networks {
	switch (selection.kind) {
		case 'local':
			return(LOCAL_NETWORK_ALIAS);
		case 'known':
			return(selection.alias);
		default:
			return(assertNever(selection));
	}
}

/** The representative the configuration describes, on the storage given. */
export function localNodeConfig(config: EnvironmentConfig, resources: NodeResources): LocalNodeConfig {
	const { storageDriver, kv, log } = resources;
	const retval: LocalNodeConfig = {
		kind: lib.Node.Kind.REPRESENTATIVE,
		log,
		initialTrustedAccount: config.initialTrustedAccount,
		ledgerPrivateKey: config.representative,
		network: config.network.network,
		networkAlias: networkAliasOf(config.network),
		ledger: {
			storageDriver,
			computeFeeFromBlocks: computeFeeFromBlocksFor(config.fee),
			ledgerWriteMode: config.ledgerWriteMode,
			operations: { enableTokenAdminModifyBalance: config.enableTokenAdminModifyBalance }
		},
		stats: { kv },
		nodeOptions: { listenIP: config.listen.ip, listenPort: config.listen.port }
	};
	if (kv !== null) {
		retval.p2p = { kv };
	}
	return(retval);
}
