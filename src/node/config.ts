import { isIP } from 'node:net';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Networks } from '@keetanetwork/keetanet-client/config/index.js';
import type { Account, GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { LedgerConfig } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { LogTargetLevel } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { LocalNodeConfig } from '@keetanetwork/keetanet-client/lib/node/local.js';
import type { P2PPeerRep, P2PUpdateOptions } from '@keetanetwork/keetanet-client/lib/p2p.js';
import type { JSONSerializableObject } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import { P2PInternals } from '../upstream/internals.js';
import { assertNever } from '../util/assert-never.js';
import type { AssertNever } from '../util/assert-never.js';
import { bootstrapFrom, paceBootstrap } from './bootstrap-peers.js';
import { computeFeeFromBlocksFor, parseFeeSchedule } from './fees.js';
import type { FeeAccount, FeePolicy } from './fees.js';
import type { LimitedLocalNodeConfig } from './local.js';
import { DEFAULT_PEER_LIMITS, MAX_PEER_LIMIT } from './peer-limits.js';
import type { PeerLimits } from './peer-limits.js';
import type { PeerArena } from './peer-store.js';
import { P2P_PATH } from './peers.js';

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
	'KEETANET_LOCAL_NODE_ENDPOINT_API',
	'KEETANET_LOCAL_NODE_ENDPOINT_P2P',
	'KEETANET_LOCAL_NODE_PREFER_UPDATES',
	'KEETANET_LOCAL_NODE_MANUAL_PEERS',
	'KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS',
	'KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS',
	'KEETANET_LOCAL_NODE_MAX_PEER_SOCKETS',
	'KEETANET_LOCAL_NODE_MAX_POSTED_MESSAGES',
	'KEETANET_LOCAL_NODE_ENABLE_TOKEN_ADMIN_MODIFY_BALANCE'
] as const;

export const TRUSTED_ACCOUNT_VARIABLE = 'KEETANET_INITIAL_TRUSTED_ACCOUNT';

/** Read only by the genesis command, so that the trusted key never sits in a running node's environment. */
export const GENESIS_VARIABLES = [
	'KEETANET_GENESIS_TRUSTED_SEED',
	'KEETANET_GENESIS_TRUSTED_SEED_INDEX',
	'KEETANET_GENESIS_SUPPLY',
	'KEETANET_GENESIS_DELEGATE_TO',
	'KEETANET_GENESIS_NETWORK_DEFAULT_PERMISSION'
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

/**
 * The variables that name peers. A node with peers on one of Keeta's
 * networks takes part in it, so there too it may only follow the ledger.
 */
export type PeerVariable = Extract<ConfigVariable, 'KEETANET_LOCAL_NODE_MANUAL_PEERS' | 'KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS'>;
export const PEER_VARIABLES: readonly PeerVariable[] = ['KEETANET_LOCAL_NODE_MANUAL_PEERS', 'KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS'];

const UPDATE_PREFERENCES = ['http', 'websocket'] as const satisfies readonly P2PUpdateOptions[];

/** Fails to compile when upstream adds a way of receiving updates that the list above does not offer. */
type _EveryUpdatePreferenceListed = AssertNever<Exclude<P2PUpdateOptions, typeof UPDATE_PREFERENCES[number]>>;

/** A representative the node dials to join the network: its own signed advertisement, or the same unsigned. */
export type ManualPeer = P2PPeerRep;

/** How a manual peer is written; a node prints its own this way. */
export const MANUAL_PEER_FORM = '<keeta_ account>@<api URL>|<p2p URL>[|http or websocket[|signature]]';

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
	| { readonly kind: 'peers-on-keeta-network'; readonly network: Networks; readonly ledgerWriteMode: LedgerWriteMode; readonly variable: PeerVariable }
	| { readonly kind: 'peers-on-public-network'; readonly network: PublicNetwork }
	| { readonly kind: 'remembered-peers'; readonly network: Networks; readonly ledgerWriteMode: LedgerWriteMode; readonly arenas: readonly PeerArena[] }
	| { readonly kind: 'peers-in-memory' }
	| { readonly kind: 'history-in-memory' }
	| { readonly kind: 'automatic-peers' }
	| { readonly kind: 'peer-signature-invalid'; readonly key: string }
	| { readonly kind: 'duplicate-peer'; readonly key: string }
	| { readonly kind: 'peer-is-self'; readonly key: string }
	| { readonly kind: 'endpoints-required'; readonly listenIP: string; readonly missing: readonly ConfigVariable[] }
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
		case 'peers-on-keeta-network':
			return(`the ${problem.network} network is Keeta's, so a node with peers on it may only follow it: set KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE to ${FOLLOWING_WRITE_MODES.join(' or ')} (it is ${problem.ledgerWriteMode}), or leave ${problem.variable} unset`);
		case 'peers-on-public-network':
			return(`the ${problem.network} network is public, so the node keeps its peer-to-peer surface closed there and reads it only by its bootstrap: leave KEETANET_LOCAL_NODE_MANUAL_PEERS unset`);
		case 'remembered-peers':
			return(`the ${problem.network} network is Keeta's, and the store of KEETANET_LOCAL_NODE_POSTGRES_URL remembers peers (in ${problem.arenas.join(', ')}), which the node would reach even without KEETANET_LOCAL_NODE_MANUAL_PEERS: run "slop-node clear-peers" with the same environment to forget them${rememberedPeersRemedy(problem.network, problem.ledgerWriteMode)}`);
		case 'peers-in-memory':
			return('clear-peers needs KEETANET_LOCAL_NODE_POSTGRES_URL: a node in memory forgets its peers when it stops');
		case 'history-in-memory':
			return('reindex-history needs KEETANET_LOCAL_NODE_POSTGRES_URL: a node in memory writes its history anew each time it starts');
		case 'automatic-peers':
			return(`KEETANET_LOCAL_NODE_MANUAL_PEERS=auto is not supported: this node finds no peers by itself, so list each as ${MANUAL_PEER_FORM}`);
		case 'peer-signature-invalid':
			return(`KEETANET_LOCAL_NODE_MANUAL_PEERS gives ${problem.key} a signature that does not cover the key, endpoints and preference written with it`);
		case 'duplicate-peer':
			return(`KEETANET_LOCAL_NODE_MANUAL_PEERS names ${problem.key} more than once`);
		case 'peer-is-self':
			return(`KEETANET_LOCAL_NODE_MANUAL_PEERS names ${problem.key}, which is this node`);
		case 'endpoints-required':
			return(`the node listens on every interface (${problem.listenIP}), so it cannot tell peers where to reach it: set ${problem.missing.join(' and ')}`);
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

/** Where peers and clients reach the node; the node advertises where it listens for any left unset. */
export type AdvertisedEndpoints = {
	readonly api: string | undefined;
	readonly p2p: string | undefined;
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
	readonly endpoints: AdvertisedEndpoints;
	/** How the node asks its peers to send it staples. */
	readonly preferUpdates: P2PUpdateOptions;
	readonly manualPeers: readonly ManualPeer[];
	/** The API endpoints of representatives the node bootstraps from without dialing them. */
	readonly bootstrapPeers: readonly string[];
	/** How long each peer the node bootstraps from is left without a request between two of them; 0 leaves them as they come. */
	readonly bootstrapMinIntervalMilliseconds: number;
	readonly peerLimits: PeerLimits;
	readonly fee: FeePolicy;
	/** Off by default, as upstream has it [Keeta TS] index.js:68983. */
	readonly enableTokenAdminModifyBalance: boolean;
};

const DEFAULT_LOG_LEVEL: LogTargetLevel = 'INFO';
const DEFAULT_LEDGER_WRITE_MODE: LedgerWriteMode = 'read-write';
const DEFAULT_LISTEN: ListenAddress = { ip: '127.0.0.1', port: 0 };
/** Upstream's switch republishes over the WebSocket unless told otherwise [Keeta TS] index.js:71801. */
const DEFAULT_PREFER_UPDATES: P2PUpdateOptions = 'websocket';

/*
 * Upstream gives network 0 no alias of its own, while a node needs one; the
 * test helpers name it "test" as well. The alias only labels the node's log
 * [Keeta TS] index.js:71367.
 */
const LOCAL_NETWORK_ALIAS: Networks = 'test';

/**
 * The pacing of bootstrap requests on Keeta's networks, whose representatives
 * serve everyone: a page takes a representative a few seconds to answer, so
 * a second's rest between requests keeps one node's catch-up to well under
 * one request at a time on each. On network 0 the representatives are the
 * operator's own, so requests are not paced unless asked.
 */
export const DEFAULT_KEETA_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS = 1000;

/** A pass over a peer ends after two minutes (src/node/bootstrap-pass.ts), so a longer rest would leave it a request or two. */
export const MAX_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS = 60_000;

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
const API_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);
const P2P_PROTOCOLS: ReadonlySet<string> = new Set(['ws:', 'wss:']);

/** The forms "every interface" takes once an address is written as a URL host. */
const UNSPECIFIED_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '[::]']);

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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

function isUnspecifiedAddress(ip: string): boolean {
	let host = ip;
	if (isIP(ip) === 6) {
		host = `[${ip}]`;
	}
	return(UNSPECIFIED_HOSTS.has(new URL(`http://${host}/`).hostname));
}

function urlOf(text: string, protocols: ReadonlySet<string>): URL | undefined {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return(undefined);
	}
	if (!protocols.has(url.protocol)) {
		return(undefined);
	}
	return(url);
}

/** The characters that separate the fields of a peer and the peers of a list. */
const PEER_SEPARATORS = /[|,]/;

/** A user name, a password, or an empty user before the host. */
const USER_INFO = /^[^:]+:\/\/[^/?#]*@/;

const FIT_TO_ADVERTISE = 'without a user, password, query, fragment, "|" or ","';

/**
 * An endpoint the node advertises is printed in its peer, which another node
 * must read back, and is sent to every peer, so it holds no separator of the
 * peer form and no user or password. The client requests each route at the
 * endpoint followed by the route's path [Keeta TS] index.js:59584-59585,
 * which a query or fragment would cut off.
 */
function isFitToAdvertise(text: string, url: URL): boolean {
	return(!PEER_SEPARATORS.test(text) && !USER_INFO.test(text) && url.search === '' && url.hash === '');
}

/** A password is left out of the error, as is the rest of the endpoint, which holds it. */
function invalidEndpoint(variable: ConfigVariable, expected: string, text: string): ConfigError {
	if (USER_INFO.test(text)) {
		return(new ConfigError({ kind: 'invalid', variable, expected }));
	}
	return(invalid(variable, expected, text));
}

function parseAPIEndpoint(text: string): string {
	const url = urlOf(text, API_PROTOCOLS);
	if (url === undefined || !isFitToAdvertise(text, url)) {
		throw(invalidEndpoint('KEETANET_LOCAL_NODE_ENDPOINT_API', `an http:// or https:// URL ${FIT_TO_ADVERTISE}`, text));
	}
	return(text);
}

/** The node serves peers at one path of the API's own server, so the advertised endpoint must lead there. */
function parseP2PEndpoint(text: string): string {
	const url = urlOf(text, P2P_PROTOCOLS);
	if (url === undefined || url.pathname !== P2P_PATH || !isFitToAdvertise(text, url)) {
		throw(invalidEndpoint('KEETANET_LOCAL_NODE_ENDPOINT_P2P', `a ws:// or wss:// URL whose path is ${P2P_PATH}, where the node serves peers, ${FIT_TO_ADVERTISE}`, text));
	}
	return(text);
}

function findUpdatePreference(text: string): P2PUpdateOptions | undefined {
	return(UPDATE_PREFERENCES.find(function(candidate): boolean {
		return(candidate === text);
	}));
}

function parsePreferUpdates(text: string): P2PUpdateOptions {
	const variable = 'KEETANET_LOCAL_NODE_PREFER_UPDATES';
	const preference = findUpdatePreference(text);
	if (preference === undefined) {
		throw(invalid(variable, UPDATE_PREFERENCES.join(' or '), text));
	}
	return(preference);
}

const AUTOMATIC_PEERS = 'auto';

/** The fields after the key, which are the endpoints, then optionally the preference and the signature. */
const MIN_PEER_FIELDS = 2;
const MAX_PEER_FIELDS = 4;

/**
 * A peer in the form of upstream's peer record [Keeta TS] index.js:71911-71987.
 * A signature must be the peer's own over what is written with it, as the
 * switch checks one [Keeta TS] index.js:71828-71867; without one the record
 * carries none, which upstream's typings allow (lib/p2p.d.ts P2PPeerRep).
 */
function parseManualPeer(entry: string): ManualPeer {
	const variable = 'KEETANET_LOCAL_NODE_MANUAL_PEERS';
	const at = entry.indexOf('@');
	const fields = entry.slice(at + 1).split('|');
	if (at < 0 || fields.length < MIN_PEER_FIELDS || fields.length > MAX_PEER_FIELDS) {
		throw(invalid(variable, MANUAL_PEER_FORM, entry));
	}
	const key = parseAccountKey(variable, entry.slice(0, at));
	const [api = '', p2p = '', preferenceText = DEFAULT_PREFER_UPDATES, signature] = fields;
	const preferUpdates = findUpdatePreference(preferenceText);
	if (urlOf(api, API_PROTOCOLS) === undefined || urlOf(p2p, P2P_PROTOCOLS) === undefined || preferUpdates === undefined) {
		throw(invalid(variable, MANUAL_PEER_FORM, entry));
	}
	const unsigned = { kind: lib.Node.Kind.REPRESENTATIVE, key, endpoints: { api, p2p }, preferUpdates } as const;
	if (signature === undefined) {
		return({ ...unsigned, certificate: null });
	}
	if (!BASE64.test(signature)) {
		throw(invalid(variable, `${MANUAL_PEER_FORM}, the signature in base64`, entry));
	}
	const problem: ConfigProblem = { kind: 'peer-signature-invalid', key: key.publicKeyString.get() };
	let verified: ManualPeer | undefined;
	try {
		verified = manualPeerOf({ ...unsigned, key: key.publicKeyString.get(), signature });
	} catch (error: unknown) {
		// Upstream reads the signature as ASN.1 before verifying it, and throws for bytes that are none [Keeta TS] index.js:71837.
		throw(new ConfigError(problem, { cause: error }));
	}
	if (verified === undefined) {
		throw(new ConfigError(problem));
	}
	return(verified);
}

/** Entries are separated by commas; space around them and empty ones are ignored, as in the list of fee accounts. */
function parseManualPeers(text: string, representative: Account): ManualPeer[] {
	const variable = 'KEETANET_LOCAL_NODE_MANUAL_PEERS';
	const entries = text.split(',').map(function(entry): string {
		return(entry.trim());
	}).filter(function(entry): boolean {
		return(entry !== '');
	});
	if (entries.some(function(entry): boolean {
		return(entry.toLowerCase() === AUTOMATIC_PEERS);
	})) {
		throw(new ConfigError({ kind: 'automatic-peers' }));
	}
	if (entries.length === 0) {
		throw(invalid(variable, `a comma-separated list of ${MANUAL_PEER_FORM}`, text));
	}
	const peers = entries.map(parseManualPeer);
	const seen = new Set<string>();
	for (const peer of peers) {
		const key = peer.key.publicKeyString.get();
		if (peer.key.comparePublicKey(representative)) {
			throw(new ConfigError({ kind: 'peer-is-self', key }));
		}
		if (seen.has(key)) {
			throw(new ConfigError({ kind: 'duplicate-peer', key }));
		}
		seen.add(key);
	}
	return(peers);
}

const BOOTSTRAP_PEER_FORM = `an http:// or https:// API URL ${FIT_TO_ADVERTISE}`;

/**
 * An API endpoint, which the node requests each page at, followed by the
 * route's path, as the client does [Keeta TS] index.js:59584-59585, and names
 * in its log, so it holds no user or password.
 */
function parseBootstrapPeer(entry: string): string {
	const url = urlOf(entry, API_PROTOCOLS);
	if (url === undefined || !isFitToAdvertise(entry, url)) {
		throw(invalidEndpoint('KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS', `a comma-separated list, each ${BOOTSTRAP_PEER_FORM}`, entry));
	}
	return(entry);
}

/** Entries are separated by commas; space around them and empty ones are ignored, and so is an endpoint given twice. */
function parseBootstrapPeers(text: string): string[] {
	const entries = text.split(',').map(function(entry): string {
		return(entry.trim());
	}).filter(function(entry): boolean {
		return(entry !== '');
	});
	if (entries.length === 0) {
		throw(invalid('KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS', `a comma-separated list, each ${BOOTSTRAP_PEER_FORM}`, text));
	}
	return([...new Set(entries.map(parseBootstrapPeer))]);
}

/** A representative's advertisement, as its switch greets peers with it, if its signature holds. */
export function manualPeerOf(advertisement: JSONSerializableObject): ManualPeer | undefined {
	const peer = P2PInternals.P2PPeerFromJSO(advertisement);
	if (peer === null || peer.kind !== lib.Node.Kind.REPRESENTATIVE) {
		return(undefined);
	}
	return(peer);
}

/** The peer written as the setting reads it, with the preference always given so that a signature can follow. */
export function formatManualPeer(peer: ManualPeer): string {
	const fields = [peer.endpoints.api, peer.endpoints.p2p, peer.preferUpdates];
	if ('signature' in peer) {
		fields.push(Buffer.from(peer.signature).toString('base64'));
	}
	return(`${peer.key.publicKeyString.get()}@${fields.join('|')}`);
}

function parseBootstrapMinInterval(text: string): number {
	if (!DECIMAL.test(text) || Number(text) > MAX_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS) {
		throw(invalid('KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS', `a whole number of milliseconds from 0 to ${String(MAX_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS)}`, text));
	}
	return(Number(text));
}

function defaultBootstrapMinInterval(network: NetworkSelection): number {
	switch (network.kind) {
		case 'local':
			return(0);
		case 'known':
			return(DEFAULT_KEETA_BOOTSTRAP_MIN_INTERVAL_MILLISECONDS);
		default:
			return(assertNever(network));
	}
}

function parsePeerLimit(variable: ConfigVariable, text: string): number {
	if (!DECIMAL.test(text) || Number(text) < 1 || Number(text) > MAX_PEER_LIMIT) {
		throw(invalid(variable, `a whole number from 1 to ${String(MAX_PEER_LIMIT)}`, text));
	}
	return(Number(text));
}

function readPeerLimits(reader: EnvironmentReader): PeerLimits {
	return({
		sockets: reader.read('KEETANET_LOCAL_NODE_MAX_PEER_SOCKETS', function(text: string): number {
			return(parsePeerLimit('KEETANET_LOCAL_NODE_MAX_PEER_SOCKETS', text));
		}, DEFAULT_PEER_LIMITS.sockets),
		postedMessages: reader.read('KEETANET_LOCAL_NODE_MAX_POSTED_MESSAGES', function(text: string): number {
			return(parsePeerLimit('KEETANET_LOCAL_NODE_MAX_POSTED_MESSAGES', text));
		}, DEFAULT_PEER_LIMITS.postedMessages)
	});
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
 * Peers carry the node's staples into the network and its peers' staples into
 * the node, so on any network of Keeta's a node with peers may only follow;
 * this is that network, when the node may do more. Network 0 is this node's
 * own.
 */
function networkClosedToPeers(network: NetworkSelection, ledgerWriteMode: LedgerWriteMode): Networks | undefined {
	if (network.kind === 'local' || isFollowingWriteMode(ledgerWriteMode)) {
		return(undefined);
	}
	return(network.alias);
}

/**
 * The network the node keeps its peer-to-peer surface closed on: it serves no
 * /p2p WebSocket, refuses every message posted over HTTP, dials no peer and
 * starts with none remembered. A public network is closed to it in every
 * mode, as a node there only follows it, which its bootstrap does over HTTP
 * alone; any other as networkClosedToPeers says.
 */
export function networkClosedToP2P(network: NetworkSelection, ledgerWriteMode: LedgerWriteMode): Networks | undefined {
	return(publicNetworkOf(network) ?? networkClosedToPeers(network, ledgerWriteMode));
}

/**
 * networkClosedToP2P for a node as it was built, from its network ID. An ID
 * the client does not know names no network of Keeta's.
 */
export function nodeNetworkClosedToP2P(network: bigint, ledgerWriteMode: LedgerWriteMode): Networks | undefined {
	const selection = networkWithID(network);
	if (selection === undefined) {
		return(undefined);
	}
	return(networkClosedToP2P(selection, ledgerWriteMode));
}

/** What else a node remembering peers on the network may do: on a public network it already only follows. */
function rememberedPeersRemedy(network: Networks, ledgerWriteMode: LedgerWriteMode): string {
	if (PUBLIC_NETWORKS.some(function(candidate): boolean {
		return(candidate === network);
	})) {
		return('');
	}
	return(`, or set KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE to ${FOLLOWING_WRITE_MODES.join(' or ')} (it is ${ledgerWriteMode})`);
}

function refusePeersOnKeetaNetwork(reader: EnvironmentReader, network: NetworkSelection, ledgerWriteMode: LedgerWriteMode): void {
	const closed = networkClosedToPeers(network, ledgerWriteMode);
	if (closed === undefined) {
		return;
	}
	const variable = PEER_VARIABLES.find(function(candidate): boolean {
		return(reader.isSet(candidate));
	});
	if (variable !== undefined) {
		throw(new ConfigError({ kind: 'peers-on-keeta-network', network: closed, ledgerWriteMode, variable }));
	}
}

function refuseManualPeersOnPublicNetwork(reader: EnvironmentReader, network: NetworkSelection): void {
	const publicNetwork = publicNetworkOf(network);
	if (publicNetwork !== undefined && reader.isSet('KEETANET_LOCAL_NODE_MANUAL_PEERS')) {
		throw(new ConfigError({ kind: 'peers-on-public-network', network: publicNetwork }));
	}
}

/** A node on every interface cannot derive an address peers can reach, so both endpoints must be given. */
function readEndpoints(reader: EnvironmentReader, listen: ListenAddress): AdvertisedEndpoints {
	const endpoints: AdvertisedEndpoints = {
		api: reader.read<string | undefined>('KEETANET_LOCAL_NODE_ENDPOINT_API', parseAPIEndpoint, undefined),
		p2p: reader.read<string | undefined>('KEETANET_LOCAL_NODE_ENDPOINT_P2P', parseP2PEndpoint, undefined)
	};
	if (!isUnspecifiedAddress(listen.ip)) {
		return(endpoints);
	}
	const missing: ConfigVariable[] = [];
	if (endpoints.api === undefined) {
		missing.push('KEETANET_LOCAL_NODE_ENDPOINT_API');
	}
	if (endpoints.p2p === undefined) {
		missing.push('KEETANET_LOCAL_NODE_ENDPOINT_P2P');
	}
	if (missing.length > 0) {
		throw(new ConfigError({ kind: 'endpoints-required', listenIP: listen.ip, missing }));
	}
	return(endpoints);
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
	refusePeersOnKeetaNetwork(reader, network, ledgerWriteMode);
	refuseManualPeersOnPublicNetwork(reader, network);

	const representative = readSeedAccount(reader, 'KEETANET_LOCAL_NODE_SEED', 'KEETANET_LOCAL_NODE_SEED_INDEX');
	const listen: ListenAddress = {
		ip: reader.read('KEETANET_LOCAL_NODE_LISTEN_IP', parseListenIP, DEFAULT_LISTEN.ip),
		port: reader.read('KEETANET_LOCAL_NODE_LISTEN_PORT', parseListenPort, DEFAULT_LISTEN.port)
	};
	return({
		network,
		representative,
		initialTrustedAccount: readTrustedAccount(reader, network),
		ledgerWriteMode,
		log: {
			level: reader.read('KEETANET_LOCAL_NODE_LOG_LEVEL', parseLogLevel, DEFAULT_LOG_LEVEL),
			filter: reader.read<RegExp | undefined>('KEETANET_LOCAL_NODE_LOG_FILTER', parseLogFilter, undefined)
		},
		storage: reader.read('KEETANET_LOCAL_NODE_POSTGRES_URL', parsePostgresURL, { kind: 'memory' }),
		listen,
		endpoints: readEndpoints(reader, listen),
		preferUpdates: reader.read('KEETANET_LOCAL_NODE_PREFER_UPDATES', parsePreferUpdates, DEFAULT_PREFER_UPDATES),
		manualPeers: reader.read('KEETANET_LOCAL_NODE_MANUAL_PEERS', function(text: string): ManualPeer[] {
			return(parseManualPeers(text, representative));
		}, []),
		bootstrapPeers: reader.read('KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS', parseBootstrapPeers, []),
		bootstrapMinIntervalMilliseconds: reader.read('KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS', parseBootstrapMinInterval, defaultBootstrapMinInterval(network)),
		peerLimits: readPeerLimits(reader),
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

/** The switch greets peers with "http" when it republishes over HTTP [Keeta TS] index.js:73527. */
function usesHTTPRepublish(preference: P2PUpdateOptions): boolean {
	switch (preference) {
		case 'http':
			return(true);
		case 'websocket':
			return(false);
		default:
			return(assertNever(preference));
	}
}

/** Only the endpoints given, so that the node fills in the others from where it listens. */
function configuredEndpoints(endpoints: AdvertisedEndpoints): LocalNodeConfig['endpoints'] {
	const retval: NonNullable<LocalNodeConfig['endpoints']> = {};
	if (endpoints.api !== undefined) {
		retval.api = endpoints.api;
	}
	if (endpoints.p2p !== undefined) {
		retval.p2p = endpoints.p2p;
	}
	if (retval.api === undefined && retval.p2p === undefined) {
		return(undefined);
	}
	return(retval);
}

/** The representative the configuration describes, on the storage given. */
export function localNodeConfig(config: EnvironmentConfig, resources: NodeResources): LimitedLocalNodeConfig {
	const { storageDriver, kv, log } = resources;
	const retval: LimitedLocalNodeConfig = {
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
		p2p: { useHTTPRepublish: usesHTTPRepublish(config.preferUpdates) },
		nodeOptions: { listenIP: config.listen.ip, listenPort: config.listen.port },
		manualPeers: [...config.manualPeers],
		peerLimits: config.peerLimits
	};
	if (kv !== null) {
		retval.p2p = { ...retval.p2p, kv };
		retval.bootstrap = { kv };
	}
	bootstrapFrom(retval, config.bootstrapPeers);
	paceBootstrap(retval, config.bootstrapMinIntervalMilliseconds);
	const endpoints = configuredEndpoints(config.endpoints);
	if (endpoints !== undefined) {
		retval.endpoints = endpoints;
	}
	return(retval);
}
