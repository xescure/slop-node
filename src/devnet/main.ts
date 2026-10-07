#!/usr/bin/env node
import { fork } from 'node:child_process';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { sweepAbandonedClusters } from '../testing/postgres.js';
import { assertNever } from '../util/assert-never.js';
import { FAUCET, FAUCET_BALANCE, FAUCET_SEED, FEES } from './genesis.js';
import { Devnet } from './harness.js';
import { logTail, nodeCommandOf } from './process.js';

/** The built node, which utils/devnet builds before it runs this. */
const BUILT_CLI = new URL('../../../dist/main.js', import.meta.url);

const DEFAULT_DIRECTORY = '/tmp/slop-devnet';

const CONTROL_SOCKET = 'control.sock';
const SUPERVISOR_LOG = 'supervisor.log';
/** What "up" printed, kept while the devnet runs. */
const SUMMARY_FILE = 'devnet.txt';

/** What the command answers, as programs conventionally do: 2 for a command line it does not understand. */
type ExitCode = 0 | 1 | 2;

type Command =
	| { readonly kind: 'up'; readonly directory: string }
	| { readonly kind: 'down'; readonly directory: string }
	| { readonly kind: 'serve'; readonly directory: string };

/** What the supervisor tells "up" once the devnet has started or failed to. */
type StartReport =
	| { readonly kind: 'ready'; readonly summary: string }
	| { readonly kind: 'failed'; readonly message: string };

const USAGE = [
	'Usage: utils/devnet up|down [directory]',
	'',
	'  up    start four representatives of network 0, each with its own Postgres,',
	'        and print how to reach them; the devnet keeps running in the background',
	'  down  stop the devnet that "up" started in the directory',
	'',
	`The directory holds the devnet's databases and logs (${DEFAULT_DIRECTORY}).`,
	''
].join('\n');

function parseCommand(argv: readonly string[]): Command | undefined {
	const [name, directoryText = DEFAULT_DIRECTORY, ...rest] = argv;
	if (rest.length > 0) {
		return(undefined);
	}
	const directory = resolve(directoryText);
	switch (name) {
		case 'up':
		case 'down':
		case 'serve':
			return({ kind: name, directory });
		default:
			return(undefined);
	}
}

function isStartReport(message: unknown): message is StartReport {
	return(typeof message === 'object' && message !== null && 'kind' in message && (message.kind === 'ready' || message.kind === 'failed'));
}

function hasCode(error: unknown, codes: readonly string[]): boolean {
	return(error instanceof Error && 'code' in error && typeof error.code === 'string' && codes.includes(error.code));
}

/** A connection to the supervisor of the devnet in the directory, or undefined when none is up. */
function controlConnection(directory: string): Promise<Socket | undefined> {
	return(new Promise(function(resolveConnection, reject) {
		const socket = connect(join(directory, CONTROL_SOCKET));
		socket.once('connect', function() {
			resolveConnection(socket);
		});
		socket.once('error', function(error) {
			if (hasCode(error, ['ENOENT', 'ECONNREFUSED'])) {
				resolveConnection(undefined);
				return;
			}
			reject(error);
		});
	}));
}

/** How to reach the devnet: each representative, the faucet, and a client of the SDK. */
function summaryOf(devnet: Devnet, directory: string): string {
	const representatives = devnet.all.map(function(node): string {
		return(`representative ${String(node.index)}: ${node.representative.publicKeyString.get()} api ${node.apiURL} p2p ${node.p2pURL} fee ${String(FEES[node.index].amountPerBlock)} per block\n`);
	}).join('');
	const reps = devnet.all.map(function(node): string {
		return(`\t\t{ key: KeetaNet.lib.Account.fromPublicKeyString('${node.representative.publicKeyString.get()}').assertAccount(), endpoints: { api: '${node.apiURL}', p2p: '${node.p2pURL}' } },\n`);
	}).join('');
	const { baseToken } = KeetaNet.lib.Account.generateBaseAddresses(0n);
	return([
		`devnet up in ${directory}: network 0, four representatives, any three of which confirm a staple\n`,
		representatives,
		`base token: ${baseToken.publicKeyString.get()}\n`,
		`faucet: ${FAUCET.publicKeyString.get()}, holding ${String(FAUCET_BALANCE)} base units\n`,
		`faucet seed: ${FAUCET_SEED}\n`,
		'\nA client of the official SDK, signing as the faucet:\n\n',
		'const client = new KeetaNet.UserClient({\n',
		'\tclient: new KeetaNet.Client([\n',
		reps,
		'\t]),\n',
		`\tsigner: KeetaNet.lib.Account.fromSeed('${FAUCET_SEED}', 0),\n`,
		'\tusePublishAid: false,\n',
		'\tnetwork: 0n,\n',
		'\tnetworkAlias: \'test\'\n',
		'});\n\n',
		`Logs: ${directory}/node-<index>.log. Stop it with: utils/devnet down ${directory}\n`
	].join(''));
}

/**
 * Starts the supervisor in the background, with its output in its log, and
 * prints how to reach the devnet once it reports that it has started.
 */
async function up(directory: string): Promise<ExitCode> {
	const running = await controlConnection(directory);
	if (running !== undefined) {
		running.destroy();
		process.stderr.write(`a devnet is already up in ${directory}\n`);
		return(1);
	}
	await mkdir(directory, { recursive: true });
	const logPath = join(directory, SUPERVISOR_LOG);
	const log = await open(logPath, 'a');
	try {
		const supervisor = fork(new URL(import.meta.url).pathname, ['serve', directory], { detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'] });
		const report = await new Promise<StartReport>(function(resolveReport) {
			supervisor.once('message', function(message: unknown) {
				if (isStartReport(message)) {
					resolveReport(message);
					return;
				}
				resolveReport({ kind: 'failed', message: `the supervisor sent ${JSON.stringify(message)}` });
			});
			supervisor.once('exit', function(code, signal) {
				resolveReport({ kind: 'failed', message: `the supervisor exited (${JSON.stringify({ code, signal })})` });
			});
		});
		// The supervisor lets go of the channel itself once it has reported.
		if (supervisor.connected) {
			supervisor.disconnect();
		}
		supervisor.unref();
		switch (report.kind) {
			case 'ready':
				process.stdout.write(report.summary);
				return(0);
			case 'failed':
				process.stderr.write(`the devnet did not start: ${report.message}\n${await logTail(logPath, 40)}\n`);
				return(1);
			default:
				return(assertNever(report));
		}
	} finally {
		await log.close();
	}
}

/** Asks the supervisor to stop the devnet, and waits for its answer. */
async function down(directory: string): Promise<ExitCode> {
	const connection = await controlConnection(directory);
	if (connection === undefined) {
		// A supervisor that was killed leaves its clusters running; their owner has died, so they are swept.
		await sweepAbandonedClusters(directory).catch(function() {
			// A directory that does not exist holds no cluster.
		});
		process.stderr.write(`no devnet is up in ${directory}\n`);
		return(1);
	}
	const answer = await new Promise<string>(function(resolveAnswer) {
		let text = '';
		connection.setEncoding('utf8');
		connection.on('data', function(chunk: string) {
			text += chunk;
		});
		connection.on('error', function() {
			// The answer so far is what the supervisor managed to say.
		});
		connection.once('close', function() {
			resolveAnswer(text);
		});
		connection.write('stop\n');
	});
	if (answer !== 'stopped\n') {
		process.stderr.write(`stopping the devnet failed: ${answer}\n`);
		return(1);
	}
	process.stdout.write(`devnet in ${directory} stopped\n`);
	return(0);
}

function listen(server: Server, path: string): Promise<void> {
	return(new Promise(function(resolveListening, reject) {
		server.once('error', reject);
		server.listen(path, function() {
			server.off('error', reject);
			resolveListening();
		});
	}));
}

/**
 * Runs the devnet until "down" asks over the control socket, or a signal
 * arrives, then stops it and exits.
 */
async function serve(directory: string): Promise<ExitCode> {
	const send = function(report: StartReport): void {
		process.send?.(report);
	};
	let devnet: Devnet;
	try {
		devnet = await Devnet.start({ directory, clusterParent: directory, command: nodeCommandOf(process.env, BUILT_CLI) });
	} catch (error: unknown) {
		send({ kind: 'failed', message: String(error) });
		return(1);
	}
	const socketPath = join(directory, CONTROL_SOCKET);
	await rm(socketPath, { force: true });
	const requesters: Socket[] = [];
	let requestStop = function(): void {
		// Replaced as the promise is made.
	};
	const stopRequested = new Promise<void>(function(resolveStop) {
		requestStop = resolveStop;
	});
	const server = createServer(function(socket) {
		socket.on('error', function() {
			// A requester that went away is not answered.
		});
		socket.once('data', function() {
			requesters.push(socket);
			requestStop();
		});
	});
	process.once('SIGTERM', requestStop);
	process.once('SIGINT', requestStop);
	await listen(server, socketPath);
	const summary = summaryOf(devnet, directory);
	await writeFile(join(directory, SUMMARY_FILE), summary);
	send({ kind: 'ready', summary });
	// "up" waits for this report only; the devnet keeps running without it.
	if (process.connected) {
		process.disconnect();
	}
	await stopRequested;
	server.close();
	let answer = 'stopped\n';
	let code: ExitCode = 0;
	try {
		await devnet.stop();
	} catch (error: unknown) {
		answer = `${String(error)}\n`;
		code = 1;
	}
	await rm(socketPath, { force: true });
	await rm(join(directory, SUMMARY_FILE), { force: true });
	for (const requester of requesters) {
		requester.end(answer);
	}
	process.stdout.write(answer);
	return(code);
}

async function main(argv: readonly string[]): Promise<ExitCode> {
	const command = parseCommand(argv);
	if (command === undefined) {
		process.stderr.write(USAGE);
		return(2);
	}
	switch (command.kind) {
		case 'up':
			return(await up(command.directory));
		case 'down':
			return(await down(command.directory));
		case 'serve':
			return(await serve(command.directory));
		default:
			return(assertNever(command));
	}
}

process.exitCode = await main(process.argv.slice(2));
