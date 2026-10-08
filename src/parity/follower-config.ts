import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { getConfigFromEnv } from '../node/config.js';
import type { Environment, EnvironmentConfig } from '../node/config.js';
import { assertNever } from '../util/assert-never.js';

/**
 * The API endpoints of the main network's representatives, as the client's
 * configuration of that network names them [Keeta TS] index.js:61375-61395.
 */
export const MAINNET_REPRESENTATIVE_APIS: readonly string[] = KeetaNet.Client.Config.getDefaultConfig('main').representatives.map(function(representative): string {
	return(representative.endpoints.api);
});

/** Where the node listens: never beyond this machine, so that no peer can reach it. */
export const FOLLOWER_LISTEN_IP = '127.0.0.1';

/** The Postgres socket directory within the follower's directory; the server listens on no TCP address. */
export const POSTGRES_SOCKET_DIRECTORY = 'run';

/** Names the server's socket only, since it listens on no TCP address. */
export const POSTGRES_PORT = 5432;

/** What a Unix-domain socket path may take: sun_path is 108 bytes on Linux, one of them the terminating NUL. */
const SOCKET_PATH_LIMIT_BYTES = 107;

/** Temporary directories the system may clear, besides the one Node.js reports. */
const SYSTEM_TEMPORARY_DIRECTORIES: readonly string[] = ['/tmp', '/var/tmp'];

export type FollowerSettings = {
	/** Holds the follower's seed, its Postgres cluster, its logs and its state. */
	readonly directory: string;
	/** The node's API port on the loopback interface. */
	readonly port: number;
	/** How long each representative is left without a request of the follower's between two. */
	readonly minIntervalMilliseconds: number;
	/** The node's V8 heap limit, which bounds its memory beside other work on the machine. */
	readonly maxHeapMegabytes: number;
};

export const DEFAULT_FOLLOWER_SETTINGS: Omit<FollowerSettings, 'directory'> = {
	port: 47380,
	minIntervalMilliseconds: 1000,
	maxHeapMegabytes: 1536
};

export type FollowerLog = 'node' | 'postgres';

export type FollowerCommand =
	| { readonly kind: 'up'; readonly settings: FollowerSettings }
	| { readonly kind: 'down'; readonly directory: string }
	| { readonly kind: 'status'; readonly directory: string }
	/** Forget where the node reached on each representative and its retry queue, keeping its ledger, so that it reads the history again from the beginning. */
	| { readonly kind: 'reset-cursors'; readonly directory: string }
	| { readonly kind: 'logs'; readonly directory: string; readonly log: FollowerLog; readonly lines: number; readonly follow: boolean };

export function defaultFollowerDirectory(home: string): string {
	return(join(home, '.local', 'share', 'slop-node-follower'));
}

function isWithin(parent: string, path: string): boolean {
	const fromParent = relative(parent, path);
	return(fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent)));
}

export function postgresSocketPath(directory: string): string {
	return(join(directory, POSTGRES_SOCKET_DIRECTORY, `.s.PGSQL.${String(POSTGRES_PORT)}`));
}

/**
 * The directory, made absolute. The follower's catch-up takes hours, so its
 * data is kept where the system does not clear it.
 */
export function followerDirectory(text: string, temporaryDirectory: string, workingDirectory: string = process.cwd()): string {
	const directory = resolve(workingDirectory, text);
	const temporary = [...SYSTEM_TEMPORARY_DIRECTORIES, resolve(temporaryDirectory)].find(function(candidate): boolean {
		return(isWithin(candidate, directory));
	});
	if (temporary !== undefined) {
		throw(new Error(`the follower's directory ${directory} is within the temporary directory ${temporary}, which the system may clear; choose another`));
	}
	const socketBytes = Buffer.byteLength(postgresSocketPath(directory));
	if (socketBytes > SOCKET_PATH_LIMIT_BYTES) {
		throw(new Error(`the Postgres socket path in ${directory} would take ${String(socketBytes)} bytes, over the ${String(SOCKET_PATH_LIMIT_BYTES)} a Unix socket path may; choose a shorter directory`));
	}
	return(directory);
}

/** A seed is 32 bytes [Keeta TS] index.js:61735, written in hexadecimal. */
const SEED = /^[0-9a-f]{64}$/;

/** Group and others may do nothing with the seed. */
const OWNER_ONLY = 0o600;
const PERMISSION_BITS = 0o777;

/**
 * The follower's own key, made once. It signs nothing, since a node that only
 * bootstraps never votes, but the node needs a key all the same.
 */
export async function readOrCreateSeed(path: string): Promise<string> {
	try {
		await writeFile(path, `${randomBytes(32).toString('hex')}\n`, { mode: OWNER_ONLY, flag: 'wx' });
	} catch (error: unknown) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
			throw(error);
		}
	}
	const mode = (await stat(path)).mode & PERMISSION_BITS;
	if (mode !== OWNER_ONLY) {
		throw(new Error(`${path} may be read by others (mode ${mode.toString(8)}); make it 0600`));
	}
	const seed = (await readFile(path, 'utf8')).trim();
	if (!SEED.test(seed)) {
		throw(new Error(`${path} holds no seed of 64 hexadecimal digits`));
	}
	return(seed);
}

export type FollowerNode = {
	readonly settings: FollowerSettings;
	readonly seed: string;
	readonly databaseURL: string;
};

/** The node's environment: a follower of the main network that only reads from its representatives. */
export function followerEnvironment(node: FollowerNode): Environment {
	return({
		KEETANET_LOCAL_NODE_SEED: node.seed,
		KEETANET_LOCAL_NODE_NETWORK: 'main',
		KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'bootstrap-only',
		KEETANET_LOCAL_NODE_POSTGRES_URL: node.databaseURL,
		KEETANET_LOCAL_NODE_LISTEN_IP: FOLLOWER_LISTEN_IP,
		KEETANET_LOCAL_NODE_LISTEN_PORT: String(node.settings.port),
		KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS: MAINNET_REPRESENTATIVE_APIS.join(','),
		KEETANET_LOCAL_NODE_BOOTSTRAP_MIN_INTERVAL_MS: String(node.settings.minIntervalMilliseconds),
		KEETANET_LOCAL_NODE_LOG_LEVEL: 'INFO'
	});
}

/** Why an environment does not describe a node that only reads from the main network's representatives. */
export class FollowerSafetyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FollowerSafetyError';
	}
}

/**
 * The node's configuration, once the node itself accepts it and it is shown
 * to only follow the main network: it votes on nothing and accepts no
 * publish, it bootstraps from the main network's representatives alone, at a
 * pace, it dials no one, and no one else can reach it.
 */
export function checkFollowerEnvironment(environment: Environment): EnvironmentConfig {
	const config = getConfigFromEnv(environment);
	const problems: string[] = [];
	if (config.network.kind !== 'known' || config.network.alias !== 'main') {
		problems.push('it must follow the main network');
	}
	if (config.ledgerWriteMode !== 'bootstrap-only') {
		problems.push(`its ledger write mode must be bootstrap-only (it is ${config.ledgerWriteMode})`);
	}
	if (config.manualPeers.length > 0) {
		problems.push('it may have no manual peers, which it would dial');
	}
	if (config.bootstrapPeers.length === 0) {
		problems.push('it bootstraps from no representative');
	}
	const strangers = config.bootstrapPeers.filter(function(endpoint): boolean {
		return(!MAINNET_REPRESENTATIVE_APIS.includes(endpoint));
	});
	if (strangers.length > 0) {
		problems.push(`it may bootstrap from the main network's representatives only, not ${strangers.join(', ')}`);
	}
	if (config.bootstrapMinIntervalMilliseconds === 0) {
		problems.push('its requests to the representatives must be paced');
	}
	if (config.listen.ip !== FOLLOWER_LISTEN_IP) {
		problems.push(`it must listen on ${FOLLOWER_LISTEN_IP} only (it listens on ${config.listen.ip})`);
	}
	switch (config.storage.kind) {
		case 'memory':
			problems.push('it must keep its ledger in Postgres, since its catch-up takes hours');
			break;
		case 'postgres':
			break;
		default:
			assertNever(config.storage);
	}
	if (problems.length > 0) {
		throw(new FollowerSafetyError(`the follower's node is refused: ${problems.join('; ')}`));
	}
	return(config);
}

const DECIMAL = /^[1-9][0-9]*$/;
const MAX_PORT = 65535;
const DEFAULT_LOG_LINES = 50;

/** A whole number from 1 to the maximum. */
function wholeNumber(text: string | undefined, maximum: number): number | undefined {
	if (text === undefined || !DECIMAL.test(text) || Number(text) > maximum) {
		return(undefined);
	}
	return(Number(text));
}

/** The options given, each with its value, or undefined when one is not among those allowed or lacks its value. */
function optionsOf(argv: readonly string[], valued: readonly string[], flags: readonly string[]): Map<string, string> | undefined {
	const options = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const name = argv[index] ?? '';
		if (flags.includes(name)) {
			options.set(name, 'true');
			continue;
		}
		const value = argv[index + 1];
		if (!valued.includes(name) || value === undefined) {
			return(undefined);
		}
		options.set(name, value);
		index++;
	}
	return(options);
}

/** A setting given as an option, its default when the option is absent, or undefined when it is malformed. */
function setting(options: ReadonlyMap<string, string>, name: string, maximum: number, fallback: number): number | undefined {
	const text = options.get(name);
	if (text === undefined) {
		return(fallback);
	}
	return(wholeNumber(text, maximum));
}

function parseUp(options: ReadonlyMap<string, string>, directory: string): FollowerCommand | undefined {
	const port = setting(options, '--port', MAX_PORT, DEFAULT_FOLLOWER_SETTINGS.port);
	const minIntervalMilliseconds = setting(options, '--min-interval-ms', 60_000, DEFAULT_FOLLOWER_SETTINGS.minIntervalMilliseconds);
	const maxHeapMegabytes = setting(options, '--max-heap-mb', 65_536, DEFAULT_FOLLOWER_SETTINGS.maxHeapMegabytes);
	if (port === undefined || minIntervalMilliseconds === undefined || maxHeapMegabytes === undefined) {
		return(undefined);
	}
	return({ kind: 'up', settings: { directory, port, minIntervalMilliseconds, maxHeapMegabytes } });
}

function parseLogs(options: ReadonlyMap<string, string>, directory: string): FollowerCommand | undefined {
	const lines = setting(options, '--lines', Number.MAX_SAFE_INTEGER, DEFAULT_LOG_LINES);
	if (lines === undefined) {
		return(undefined);
	}
	let log: FollowerLog = 'node';
	if (options.has('--postgres')) {
		log = 'postgres';
	}
	return({ kind: 'logs', directory, log, lines, follow: options.has('--follow') });
}

/**
 * The command the arguments name, or undefined for a command line it does
 * not understand. The directory is taken as written; followerDirectory
 * checks it.
 */
export function parseFollowerCommand(argv: readonly string[], home: string): FollowerCommand | undefined {
	const [name, ...rest] = argv;
	let options: Map<string, string> | undefined;
	switch (name) {
		case 'up':
			options = optionsOf(rest, ['--directory', '--port', '--min-interval-ms', '--max-heap-mb'], []);
			break;
		case 'logs':
			options = optionsOf(rest, ['--directory', '--lines'], ['--postgres', '--follow']);
			break;
		case 'down':
		case 'status':
		case 'reset-cursors':
			options = optionsOf(rest, ['--directory'], []);
			break;
		default:
			return(undefined);
	}
	if (options === undefined) {
		return(undefined);
	}
	const directory = options.get('--directory') ?? defaultFollowerDirectory(home);
	switch (name) {
		case 'up':
			return(parseUp(options, directory));
		case 'logs':
			return(parseLogs(options, directory));
		case 'down':
		case 'status':
		case 'reset-cursors':
			return({ kind: name, directory });
		default:
			return(assertNever(name));
	}
}
