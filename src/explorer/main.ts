#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { LogEntry, LogTarget } from '@keetanetwork/keetanet-client/lib/log/common.js';
import type { LogLevel } from '@keetanetwork/keetanet-client/lib/log/index.js';
import pg from 'pg';
import { describeError } from '../ledger/storage/errors.js';
import type { LogFormat } from '../node/config.js';
import { logTargetOf } from '../node/log-format.js';
import { close, listen } from '../node/server.js';
import type { Listening } from '../node/server.js';
import { explorerConfigFromEnv } from './config.js';
import type { ExplorerConfig } from './config.js';
import { Indexer } from './indexer-loop.js';
import { applyExplorerMigrations } from './migrations.js';
import { explorerApp } from './server.js';
import { boundedReaderOptions, messageBoundOf } from './sql.js';
import type { FailureSite } from './tools.js';

const LOG_FROM = 'explorer';

/** The indexer lock holds one of the writer's connections for the process's life, and its batches use the rest. */
const WRITER_POOL_SIZE = 4;

const CONNECTION_TIMEOUT_MILLISECONDS = 10_000;

/** Probes start after this much silence rather than the system's two hours, so a connection whose peer vanished is noticed in minutes. */
const KEEP_ALIVE_DELAY_MILLISECONDS = 10_000;

type Emit = (level: LogLevel, ...args: unknown[]) => void;

/** Logging is never allowed to fail what logs, so a target that throws or rejects is ignored. */
const emitterOf = function(target: LogTarget): Emit {
	return(function(level, ...args) {
		const entry: LogEntry = { options: {}, level, from: LOG_FROM, args };
		try {
			target.emitLogs([entry]).catch(function() {
				// A target that cannot write has nowhere to report that it cannot.
			});
		} catch {
			// As above.
		}
	});
};

const logTarget = function(format: LogFormat): LogTarget {
	return(logTargetOf({ level: 'INFO', filter: undefined, format }, console, function() {
		return(new Date());
	}));
};

type Role = 'writer' | 'reader';

/** A pool's idle connection that fails is discarded by the pool, which reports it as an error event that would otherwise end the process. */
const openPool = function(role: Role, connectionString: string, max: number, emit: Emit, options: pg.PoolConfig = {}): pg.Pool {
	const pool = new pg.Pool({
		...options,
		connectionString,
		max,
		connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
		keepAlive: true,
		keepAliveInitialDelayMillis: KEEP_ALIVE_DELAY_MILLISECONDS
	});
	pool.on('error', function(error) {
		emit('ERROR', `an idle ${role} connection failed: ${describeError(error)}`);
	});
	return(pool);
};

type SignalWait = {
	readonly received: Promise<NodeJS.Signals>;
	readonly signalled: () => boolean;
	readonly release: () => void;
};

/** As the node's: the handlers are removed on the first signal, so a second ends the process at once if stopping hangs. */
const firstSignal = function(signals: readonly NodeJS.Signals[]): SignalWait {
	let resolveReceived: ((signal: NodeJS.Signals) => void) | undefined;
	let signalled = false;
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
		signalled = true;
		resolveReceived?.(signal);
	};
	for (const signal of signals) {
		process.on(signal, handle);
	}
	return({
		received,
		signalled: function() {
			return(signalled);
		},
		release
	});
};

const originOf = function(address: AddressInfo): string {
	if (address.family === 'IPv6') {
		return(`[${address.address}]:${address.port.toString()}`);
	}
	return(`${address.address}:${address.port.toString()}`);
};

const failureOf = function(site: FailureSite): string {
	if (site.tool === null) {
		return('the explorer failed to answer a request:');
	}
	return(`the explorer's ${site.tool} tool failed:`);
};

/*
 * The server stops taking connections while the indexer stops, and both are
 * done before the pools end. A signal while the explorer starts takes effect
 * once the step under way ends.
 */
const serve = async function(config: ExplorerConfig, log: LogTarget, emit: Emit, stopping: SignalWait, writer: pg.Pool, reader: pg.Pool): Promise<number> {
	try {
		await applyExplorerMigrations(writer);
	} catch (error: unknown) {
		emit('ERROR', `the explorer migrations could not be applied: ${describeError(error)}`);
		return(1);
	}
	if (stopping.signalled()) {
		return(0);
	}
	const indexer = new Indexer(writer, config.indexer, log);
	indexer.start();
	let closed: Promise<void> | undefined;
	try {
		const { app } = explorerApp({
			reader,
			tokens: config.tokens,
			limits: config.sql,
			maxConcurrentQueries: config.maxConcurrentQueries,
			report: function(error, site) {
				emit('ERROR', failureOf(site), error);
			}
		});
		let listening: Listening;
		try {
			listening = await listen(app, config.listen);
		} catch (error: unknown) {
			emit('ERROR', `the explorer could not listen: ${describeError(error)}`);
			return(1);
		}
		emit('INFO', `listening on http://${originOf(listening.address)}`);
		const signal = await stopping.received;
		emit('INFO', `stopping on ${signal}`);
		closed = close(listening.server);
	} finally {
		await indexer.stop();
	}
	await closed;
	return(0);
};

/** The format may be what is refused, so the variable is read as it stands. */
const refusalFormat = function(env: NodeJS.ProcessEnv): LogFormat {
	if (env['SLOP_EXPLORER_LOG_FORMAT'] === 'json') {
		return('json');
	}
	return('text');
};

/** Runs the explorer until SIGINT or SIGTERM, and answers the process's exit code. */
export async function main(env: NodeJS.ProcessEnv): Promise<number> {
	const config = explorerConfigFromEnv(env);
	if ('refused' in config) {
		const emit = emitterOf(logTarget(refusalFormat(env)));
		for (const problem of config.refused) {
			emit('ERROR', problem);
		}
		return(1);
	}
	const stopping = firstSignal(['SIGINT', 'SIGTERM']);
	const log = logTarget(config.logFormat);
	const emit = emitterOf(log);
	const writer = openPool('writer', config.writerURL, WRITER_POOL_SIZE, emit);
	const reader = openPool('reader', config.readerURL, config.maxConcurrentQueries, emit, boundedReaderOptions(messageBoundOf(config.sql)));
	try {
		return(await serve(config, log, emit, stopping, writer, reader));
	} finally {
		stopping.release();
		await Promise.all([writer.end(), reader.end()]);
	}
}

// A REPL or an evaluated script has no file of its own to compare.
const isEntry = function(): boolean {
	const script = process.argv[1];
	if (script === undefined) {
		return(false);
	}
	try {
		return(realpathSync(script) === fileURLToPath(import.meta.url));
	} catch {
		return(false);
	}
};

if (isEntry()) {
	process.exitCode = await main(process.env);
}
