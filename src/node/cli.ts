import { inspect } from 'node:util';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { assertNever } from '../util/assert-never.js';
import { NODE_VERSION } from '../version.js';
import { ConfigError, GENESIS_VARIABLES, getConfigFromEnv, localNodeConfig, MAX_FEE_SEED_ACCOUNTS, NODE_VARIABLES, TRUSTED_ACCOUNT_VARIABLE } from './config.js';
import type { ConfigVariable, Environment, EnvironmentConfig, LogSettings, NetworkSelection } from './config.js';
import { LocalNodeError } from './errors.js';
import { addGenesis, GenesisError, getGenesisConfigFromEnv } from './genesis.js';
import { LocalNode } from './local.js';
import { closeStorage, nodeResourcesOf, openStorage } from './storage.js';
import type { OpenedStorage } from './storage.js';

const lib = KeetaNet.lib;

type Log = InstanceType<typeof lib.Log>;
type ConsoleTargetOptions = NonNullable<Parameters<Log['registerConsoleTarget']>[0]>;

/** 2 marks a command line that names no command, as is usual for command-line tools. */
export type ExitCode = 0 | 1 | 2;

/** Where the command writes; the process's own streams when it runs as a program. */
export type Output = {
	readonly out: (text: string) => void;
	readonly error: (text: string) => void;
};

const COMMANDS = ['run', 'genesis', 'help'] as const;

type Command = typeof COMMANDS[number];

const COMMAND_HELP: Readonly<Record<Command, string>> = {
	run: 'serve the API as a representative until SIGINT or SIGTERM',
	genesis: 'add the first staple of a new network to the ledger in Postgres',
	help: 'print this text'
};

const VARIABLE_HELP: Readonly<Record<ConfigVariable, string>> = {
	KEETANET_LOCAL_NODE_SEED: 'the representative\'s seed, 64 hexadecimal digits (required)',
	KEETANET_LOCAL_NODE_SEED_INDEX: 'the index of its key under the seed (0)',
	KEETANET_LOCAL_NODE_LOG_LEVEL: 'ALL, DEBUG, INFO, WARN, ERROR or NONE (INFO)',
	KEETANET_LOCAL_NODE_LOG_FILTER: 'log only entries matching this regular expression',
	KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-write, read-only, bootstrap-only or no-voting (read-write)',
	KEETANET_INITIAL_TRUSTED_ACCOUNT: 'the public key of the network\'s trusted account (required on local)',
	KEETANET_LOCAL_NODE_FEE_SCHEDULE: 'free, or flat:<base units per block> (free)',
	KEETANET_LOCAL_NODE_FEE_SEED: 'with the two indexes below, derives the accounts fees are paid to',
	KEETANET_LOCAL_NODE_FEE_SEED_MIN_INDEX: 'the first index of the fee accounts',
	KEETANET_LOCAL_NODE_FEE_SEED_MAX_INDEX: `the last index of the fee accounts; the range holds at most ${String(MAX_FEE_SEED_ACCOUNTS)}`,
	KEETANET_LOCAL_NODE_FEE_ACCOUNTS: 'or: the public keys fees are paid to, separated by commas (the representative)',
	KEETANET_LOCAL_NODE_FEE_TOKEN: 'the public key of the token fees are paid in (the base token)',
	KEETANET_LOCAL_NODE_NETWORK: 'local, dev, staging, test, main, or a network ID (local); test and main only read-only or bootstrap-only',
	KEETANET_LOCAL_NODE_POSTGRES_URL: 'keep the ledger in this Postgres database (in memory, lost on stop)',
	KEETANET_LOCAL_NODE_LISTEN_IP: 'the address to serve on (127.0.0.1)',
	KEETANET_LOCAL_NODE_LISTEN_PORT: 'the port to serve on (0: any free port)',
	KEETANET_LOCAL_NODE_ENABLE_TOKEN_ADMIN_MODIFY_BALANCE: 'true lets the node vote for TOKEN_ADMIN_MODIFY_BALANCE (false)',
	KEETANET_GENESIS_TRUSTED_SEED: 'the seed of the trusted account (required)',
	KEETANET_GENESIS_TRUSTED_SEED_INDEX: 'the index of its key under the seed (0)',
	KEETANET_GENESIS_SUPPLY: 'the base token supply, in base units, held by the trusted account (required)',
	KEETANET_GENESIS_DELEGATE_TO: 'the representative the supply is delegated to (this node\'s)',
	KEETANET_GENESIS_NETWORK_DEFAULT_PERMISSION: 'base flags, separated by commas, that anyone holds on the network address (STORAGE_CREATE); TOKEN_ADMIN_CREATE lets anyone create tokens'
};

const NODE_SETTINGS: readonly ConfigVariable[] = [...NODE_VARIABLES, TRUSTED_ACCOUNT_VARIABLE];

function describeVariables(variables: readonly ConfigVariable[]): string {
	const width = Math.max(...variables.map(function(variable): number {
		return(variable.length);
	}));
	return(variables.map(function(variable): string {
		return(`  ${variable.padEnd(width)}  ${VARIABLE_HELP[variable]}\n`);
	}).join(''));
}

function usage(): string {
	const commands = COMMANDS.map(function(command): string {
		return(`  ${command.padEnd(8)} ${COMMAND_HELP[command]}\n`);
	}).join('');
	return([
		'Usage: slop-node <command>\n\n',
		`Commands:\n${commands}\n`,
		`Settings, read from the environment, with defaults in parentheses:\n${describeVariables(NODE_SETTINGS)}\n`,
		`genesis also reads:\n${describeVariables(GENESIS_VARIABLES)}`
	].join(''));
}

function parseCommand(argv: readonly string[]): Command | undefined {
	const [name, ...rest] = argv;
	if (rest.length > 0) {
		return(undefined);
	}
	return(COMMANDS.find(function(command): boolean {
		return(command === name);
	}));
}

function consoleLog(settings: LogSettings): Log {
	const options: ConsoleTargetOptions = { logLevel: settings.level };
	if (settings.filter !== undefined) {
		options.filter = settings.filter;
	}
	const log = new lib.Log();
	log.registerConsoleTarget(options);
	return(log);
}

type SignalWait = {
	readonly received: Promise<NodeJS.Signals>;
	readonly release: () => void;
};

/**
 * Resolves on the first of the signals. Its handlers are removed then, so a
 * second signal ends the process at once if stopping hangs.
 */
function firstSignal(signals: readonly NodeJS.Signals[]): SignalWait {
	let resolveReceived: ((signal: NodeJS.Signals) => void) | undefined;
	const received = new Promise<NodeJS.Signals>(function(resolve) {
		resolveReceived = resolve;
	});
	const release = function(): void {
		for (const signal of signals) {
			process.off(signal, handle);
		}
	};
	const handle = function(signal: NodeJS.Signals): void {
		release();
		resolveReceived?.(signal);
	};
	for (const signal of signals) {
		process.on(signal, handle);
	}
	return({ received, release });
}

function describeNetwork(selection: NetworkSelection): string {
	switch (selection.kind) {
		case 'local':
			return('local (0)');
		case 'known':
			return(`${selection.alias} (${String(selection.network)})`);
		default:
			return(assertNever(selection));
	}
}

/** Nothing secret: the connection string may hold a password. */
function startupSummary(config: EnvironmentConfig, storage: OpenedStorage, node: LocalNode): string {
	return([
		`slop-node ${NODE_VERSION}\n`,
		`representative: ${config.representative.publicKeyString.get()}\n`,
		`network: ${describeNetwork(config.network)}\n`,
		`ledger write mode: ${config.ledgerWriteMode}\n`,
		`storage: ${storage.kind}\n`,
		`api: ${node.config.endpoints?.api ?? 'not served'}\n`
	].join(''));
}

/**
 * Serves until a signal, then stops serving, waiting for the requests in
 * flight, and closes the storage.
 */
async function run(config: EnvironmentConfig, output: Output): Promise<void> {
	const stopping = firstSignal(['SIGINT', 'SIGTERM']);
	const log = consoleLog(config.log);
	const storage = openStorage(config.storage);
	try {
		if (storage.kind === 'memory') {
			output.error('warning: the ledger is kept in memory, so it is lost when the node stops; set KEETANET_LOCAL_NODE_POSTGRES_URL to keep it\n');
		}
		const node = new LocalNode(localNodeConfig(config, nodeResourcesOf(storage, log)));
		try {
			// A database that cannot be reached or migrated fails the start rather than the first request.
			await node.ledger.getHeadBlock(node.networkAddress, 'main');
			log.startAutoSync();
			await node.run();
			output.out(startupSummary(config, storage, node));
			const signal = await stopping.received;
			output.out(`stopping on ${signal}\n`);
		} finally {
			await node.stop();
		}
	} finally {
		stopping.release();
		log.stopAutoSync();
		await log.sync();
		await closeStorage(storage);
	}
}

async function genesis(config: EnvironmentConfig, environment: Environment, output: Output): Promise<void> {
	const settings = getGenesisConfigFromEnv(environment, config);
	const log = consoleLog(config.log);
	const storage = openStorage(config.storage);
	try {
		const node = new LocalNode(localNodeConfig(config, nodeResourcesOf(storage, log)));
		try {
			const staple = await addGenesis(node, settings);
			output.out([
				`genesis: ${staple.blocksHash.toString()}\n`,
				`network: ${describeNetwork(config.network)}\n`,
				`network address: ${node.networkAddress.publicKeyString.get()}\n`,
				`base token: ${node.baseToken.publicKeyString.get()}\n`,
				`supply: ${String(settings.supply)}, held by ${settings.trustedSigner.publicKeyString.get()}, delegated to ${settings.delegateTo.publicKeyString.get()}\n`
			].join(''));
		} finally {
			await node.stop();
		}
	} finally {
		await log.sync();
		await closeStorage(storage);
	}
}

/** The refusals this node words itself are shown as they are; anything else in full, for its stack. */
function describeFailure(error: unknown): string {
	if (error instanceof ConfigError || error instanceof GenesisError || error instanceof LocalNodeError) {
		return(error.message);
	}
	return(inspect(error));
}

async function runCommand(command: Command, environment: Environment, output: Output): Promise<void> {
	switch (command) {
		case 'help':
			output.out(usage());
			return;
		case 'run':
			await run(getConfigFromEnv(environment), output);
			return;
		case 'genesis':
			await genesis(getConfigFromEnv(environment), environment, output);
			return;
		default:
			assertNever(command);
	}
}

/** Runs the command the arguments name, configured from the environment, and answers the process's exit code. */
export async function main(argv: readonly string[], environment: Environment, output: Output): Promise<ExitCode> {
	const command = parseCommand(argv);
	if (command === undefined) {
		output.error(usage());
		return(2);
	}
	try {
		await runCommand(command, environment, output);
		return(0);
	} catch (error: unknown) {
		output.error(`slop-node: ${describeFailure(error)}\n`);
		return(1);
	}
}
