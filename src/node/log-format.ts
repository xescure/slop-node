import { inspect } from 'node:util';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { LogEntry, LogEntryFilled, LogTarget } from '@keetanetwork/keetanet-client/lib/log/common.js';
import type { LogLevel, LogTargetLevel } from '@keetanetwork/keetanet-client/lib/log/index.js';
import { assertNever } from '../util/assert-never.js';
import type { LogSettings } from './config.js';

const lib = KeetaNet.lib;

/**
 * Where a log target writes. The console sends debug and info to standard
 * output and warn and error to standard error, so both formats write each
 * level to the same stream.
 */
export type LogConsole = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

/** The levels Railway colors and filters by, in the lower case it reads [Railway] docs.railway.com/guides/logs. */
export type JSONLogLevel = keyof LogConsole;

const JSON_LOG_LEVELS: Readonly<Record<LogLevel, JSONLogLevel>> = {
	DEBUG: 'debug',
	INFO: 'info',
	WARN: 'warn',
	ERROR: 'error'
};

/** Railway keeps every field but the level and the message as an attribute that its log search can query. */
export type JSONLogAttributes = {
	readonly [name: string]: string | number | null;
} & {
	readonly level?: never;
	readonly message?: never;
	readonly time?: never;
};

/** One JSON object, on one line, since Railway parses a structured log only when it is. */
export function jsonLogLine(level: JSONLogLevel, message: string, time: Date, attributes: JSONLogAttributes): string {
	return(JSON.stringify({ level, message, time: time.toISOString(), ...attributes }));
}

/** Upstream's order of the levels [Keeta TS] index.js:70620-70637. */
const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
	DEBUG: 0,
	INFO: 1,
	WARN: 2,
	ERROR: 3
};

function writesLevel(targetLevel: LogTargetLevel, level: LogLevel): boolean {
	switch (targetLevel) {
		case 'ALL':
			return(true);
		case 'NONE':
			return(false);
		case 'DEBUG':
		case 'INFO':
		case 'WARN':
		case 'ERROR':
			return(LEVEL_ORDER[level] >= LEVEL_ORDER[targetLevel]);
		default:
			return(assertNever(targetLevel));
	}
}

function isError(value: unknown): value is Error {
	return(value instanceof Error);
}

/**
 * The entry's arguments as the text format joins them after its prefix, an
 * error by its first line only, since its stack has a field of its own.
 */
export function logMessageOf(args: readonly unknown[]): string {
	return(args.map(function(arg): string {
		if (typeof arg === 'string') {
			return(arg);
		}
		if (isError(arg)) {
			return(String(arg));
		}
		return(inspect(arg));
	}).join(' '));
}

/**
 * Each error as the text format prints it, through inspect, which adds the
 * error's cause and own properties to its stack.
 */
function stackOf(args: readonly unknown[]): string | undefined {
	const stacks = args.filter(isError).map(function(error): string {
		return(inspect(error));
	});
	if (stacks.length === 0) {
		return(undefined);
	}
	return(stacks.join('\n'));
}

/** What the text format prints besides the message: its prefix [Keeta TS] index.js:71230-71233, the errors' stacks and the trace. */
function attributesOf(entry: LogEntry): JSONLogAttributes {
	const attributes: { [name: string]: string } = { from: entry.from };
	const requestID = entry.options.currentRequestInfo?.id;
	if (requestID !== undefined) {
		attributes['requestID'] = requestID;
	}
	const stack = stackOf(entry.args);
	if (stack !== undefined) {
		attributes['stack'] = stack;
	}
	if (entry.trace !== undefined) {
		attributes['trace'] = entry.trace;
	}
	return(attributes);
}

type JSONLogTargetConfig = {
	readonly logLevel: LogTargetLevel;
	readonly filter: RegExp | null;
	readonly console: LogConsole;
	/**
	 * Upstream's entries carry no time, and reach a target in batches up to
	 * its sync interval after they were logged, so the time is when the
	 * entry is written.
	 */
	readonly now: () => Date;
};

/** Writes each entry as one JSON object, filtered by level and source as upstream's console target filters them [Keeta TS] index.js:70638-70645. */
export class JSONLogTarget implements LogTarget {
	readonly logLevel: LogTargetLevel;
	readonly filter: RegExp | null;
	readonly #console: LogConsole;
	readonly #now: () => Date;

	constructor(config: JSONLogTargetConfig) {
		this.logLevel = config.logLevel;
		this.filter = config.filter;
		this.#console = config.console;
		this.#now = config.now;
	}

	emitLogs(logs: (LogEntry | LogEntryFilled)[]): Promise<void> {
		for (const entry of logs) {
			if (!writesLevel(this.logLevel, entry.level) || (this.filter !== null && !this.filter.test(entry.from))) {
				continue;
			}
			const level = JSON_LOG_LEVELS[entry.level];
			this.#console[level](jsonLogLine(level, logMessageOf(entry.args), this.#now(), attributesOf(entry)));
		}
		return(Promise.resolve());
	}
}

/** The target of the format the settings name, writing to the console given. */
export function logTargetOf(settings: LogSettings, console: LogConsole, now: () => Date): LogTarget {
	switch (settings.format) {
		case 'text': {
			const options: NonNullable<ConstructorParameters<typeof lib.Log.ConsoleTarget>[0]> = { logLevel: settings.level, console };
			if (settings.filter !== undefined) {
				options.filter = settings.filter;
			}
			return(new lib.Log.ConsoleTarget(options));
		}
		case 'json':
			return(new JSONLogTarget({ logLevel: settings.level, filter: settings.filter ?? null, console, now }));
		default:
			return(assertNever(settings.format));
	}
}
