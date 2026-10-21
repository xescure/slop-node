import { isIP } from 'node:net';
import { LOG_FORMATS } from '../node/config.js';
import type { LogFormat } from '../node/config.js';
import type { ListenTarget } from '../node/server.js';
import { assertNever } from '../util/assert-never.js';
import { parseBearerTokens } from './auth.js';
import type { BearerToken } from './auth.js';
import { DEFAULT_INDEXER_SETTINGS } from './indexer.js';
import type { IndexerSettings } from './indexer.js';
import { DEFAULT_SQL_LIMITS } from './sql.js';
import type { SQLLimits } from './sql.js';

const PREFIX = 'SLOP_EXPLORER_';

export const EXPLORER_VARIABLES = [
	'SLOP_EXPLORER_WRITER_URL',
	'SLOP_EXPLORER_READER_URL',
	'SLOP_EXPLORER_TOKENS',
	'SLOP_EXPLORER_LISTEN_IP',
	'SLOP_EXPLORER_LISTEN_PORT',
	'SLOP_EXPLORER_LOG_FORMAT',
	'SLOP_EXPLORER_BATCH_STAPLES',
	'SLOP_EXPLORER_BATCH_PAUSE_MS',
	'SLOP_EXPLORER_SQL_TIMEOUT_MS',
	'SLOP_EXPLORER_SQL_MAX_TIMEOUT_MS',
	'SLOP_EXPLORER_SQL_ROW_CAP',
	'SLOP_EXPLORER_MAX_CONCURRENT_QUERIES'
] as const;

export type ExplorerVariable = typeof EXPLORER_VARIABLES[number];

/** The connection URLs may hold a password and the tokens are the keys, so their values are never repeated. */
const SECRET_VARIABLES: ReadonlySet<ExplorerVariable> = new Set(['SLOP_EXPLORER_WRITER_URL', 'SLOP_EXPLORER_READER_URL', 'SLOP_EXPLORER_TOKENS']);

export type ExplorerConfig = {
	readonly writerURL: string;
	readonly readerURL: string;
	readonly tokens: readonly BearerToken[];
	readonly listen: ListenTarget;
	readonly logFormat: LogFormat;
	readonly indexer: IndexerSettings;
	readonly sql: SQLLimits;
	readonly maxConcurrentQueries: number;
};

export type ExplorerConfigProblem =
	| { readonly kind: 'unknown-variable'; readonly variable: string }
	| { readonly kind: 'missing'; readonly variable: ExplorerVariable }
	| { readonly kind: 'empty'; readonly variable: ExplorerVariable }
	/** The value is left out when the variable is secret. */
	| { readonly kind: 'invalid'; readonly variable: ExplorerVariable; readonly expected: string; readonly value?: string }
	| { readonly kind: 'tokens-refused'; readonly reason: string };

export function describeExplorerConfigProblem(problem: ExplorerConfigProblem): string {
	switch (problem.kind) {
		case 'unknown-variable':
			return(`${problem.variable} is not a setting of the explorer`);
		case 'missing':
			return(`${problem.variable} is not set`);
		case 'empty':
			return(`${problem.variable} is set but empty`);
		case 'invalid':
			if (problem.value === undefined) {
				return(`${problem.variable} must be ${problem.expected}`);
			}
			return(`${problem.variable} must be ${problem.expected} (it is ${JSON.stringify(problem.value)})`);
		case 'tokens-refused':
			return(`SLOP_EXPLORER_TOKENS must be bearer tokens separated by commas: ${problem.reason}`);
		default:
			return(assertNever(problem));
	}
}

type Parsed<Value> =
	| { readonly kind: 'parsed'; readonly value: Value }
	| { readonly kind: 'refused'; readonly problem: ExplorerConfigProblem };

const parsed = function<Value>(value: Value): Parsed<Value> {
	return({ kind: 'parsed', value });
};

const invalid = function<Value>(variable: ExplorerVariable, expected: string, value: string): Parsed<Value> {
	if (SECRET_VARIABLES.has(variable)) {
		return({ kind: 'refused', problem: { kind: 'invalid', variable, expected } });
	}
	return({ kind: 'refused', problem: { kind: 'invalid', variable, expected, value } });
};

type Parser<Value> = (variable: ExplorerVariable, text: string) => Parsed<Value>;

const POSTGRES_PROTOCOLS: ReadonlySet<string> = new Set(['postgres:', 'postgresql:']);

const parsePostgresURL: Parser<string> = function(variable, text) {
	let protocol: string;
	try {
		protocol = new URL(text).protocol;
	} catch {
		return(invalid(variable, 'a postgres:// or postgresql:// URL', text));
	}
	if (!POSTGRES_PROTOCOLS.has(protocol)) {
		return(invalid(variable, 'a postgres:// or postgresql:// URL', text));
	}
	return(parsed(text));
};

/** pg turns TLS on for any of these in a URL. */
const SSL_PARAMETERS = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation'] as const;

/*
 * The reader bounds each message the server sends by reading the frames as
 * they arrive, which TLS would hide, so a reader URL that asks for TLS is
 * refused rather than run unbounded.
 */
const parseReaderURL: Parser<string> = function(variable, text) {
	const url = parsePostgresURL(variable, text);
	if (url.kind === 'refused') {
		return(url);
	}
	const parameters = new URL(text).searchParams;
	const asked = SSL_PARAMETERS.find(function(parameter) {
		return(parameters.has(parameter));
	});
	if (asked !== undefined) {
		return(invalid(variable, `a URL without ${SSL_PARAMETERS.join(', ')} (it names ${asked}): the reader bounds the size of the server's messages, which it can read only on a connection without TLS`, text));
	}
	return(url);
};

const parseTokens: Parser<readonly BearerToken[]> = function(_variable, text) {
	const tokens = parseBearerTokens(text);
	if ('refused' in tokens) {
		return({ kind: 'refused', problem: { kind: 'tokens-refused', reason: tokens.refused } });
	}
	return(parsed(tokens));
};

const parseListenIP: Parser<string> = function(variable, text) {
	if (isIP(text) === 0) {
		return(invalid(variable, 'an IPv4 or IPv6 address', text));
	}
	return(parsed(text));
};

const parseLogFormat: Parser<LogFormat> = function(variable, text) {
	const format = LOG_FORMATS.find(function(candidate) {
		return(candidate === text);
	});
	if (format === undefined) {
		return(invalid(variable, LOG_FORMATS.join(' or '), text));
	}
	return(parsed(format));
};

const DECIMAL = /^(0|[1-9][0-9]*)$/;

const integerFrom = function(minimum: number, maximum: number): Parser<number> {
	return(function(variable, text) {
		if (!DECIMAL.test(text) || Number(text) < minimum || Number(text) > maximum) {
			return(invalid(variable, `a whole number from ${minimum.toString()} to ${maximum.toString()}`, text));
		}
		return(parsed(Number(text)));
	});
};

const MAX_PORT = 65535;

/** A batch's staples are listed at once and its watermark advances only at its end, so a larger one waits longer to show its progress. */
const MAX_BATCH_STAPLES = 2000;

const MAX_BATCH_PAUSE_MILLISECONDS = 60_000;

/** An agent's query holds one of the few reader connections, a snapshot and its locks on the node tables for as long as it runs. */
const MAX_SQL_TIMEOUT_MILLISECONDS = 60_000;

const MAX_ROW_CAP = 1_000_000;

/** The reader's role allows 16 connections, and during a deploy two processes hold theirs at once. */
export const MAX_CONCURRENT_QUERIES = 8;

const DEFAULT_LISTEN_IP = '127.0.0.1';

const DEFAULT_LISTEN_PORT = 8080;

const DEFAULT_LOG_FORMAT: LogFormat = 'text';

const DEFAULT_MAX_CONCURRENT_QUERIES = 4;

/** Reads every variable, so that one refusal names every problem at once. */
class EnvironmentReading {
	readonly problems: ExplorerConfigProblem[] = [];
	readonly #env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv) {
		this.#env = env;
		const known: ReadonlySet<string> = new Set(EXPLORER_VARIABLES);
		for (const name of Object.keys(env)) {
			if (name.startsWith(PREFIX) && !known.has(name)) {
				this.problems.push({ kind: 'unknown-variable', variable: name });
			}
		}
	}

	#read<Value>(variable: ExplorerVariable, parse: Parser<Value>, text: string): Value | undefined {
		const result = parse(variable, text);
		switch (result.kind) {
			case 'parsed':
				return(result.value);
			case 'refused':
				this.problems.push(result.problem);
				return(undefined);
			default:
				return(assertNever(result));
		}
	}

	// An empty value is refused rather than read as unset, since it usually means a value was meant and lost.
	#text(variable: ExplorerVariable): string | undefined {
		const text = this.#env[variable];
		if (text === '') {
			this.problems.push({ kind: 'empty', variable });
			return(undefined);
		}
		return(text);
	}

	required<Value>(variable: ExplorerVariable, parse: Parser<Value>): Value | undefined {
		if (this.#env[variable] === undefined) {
			this.problems.push({ kind: 'missing', variable });
			return(undefined);
		}
		const text = this.#text(variable);
		if (text === undefined) {
			return(undefined);
		}
		return(this.#read(variable, parse, text));
	}

	optional<Value>(variable: ExplorerVariable, parse: Parser<Value>, fallback: Value): Value | undefined {
		const text = this.#text(variable);
		if (text === undefined) {
			if (this.#env[variable] === undefined) {
				return(fallback);
			}
			return(undefined);
		}
		return(this.#read(variable, parse, text));
	}
}

/** The explorer as the environment describes it, or every reason it does not; no reason repeats a password or a token. */
export function explorerConfigFromEnv(env: NodeJS.ProcessEnv): ExplorerConfig | { readonly refused: readonly string[] } {
	const reading = new EnvironmentReading(env);
	const writerURL = reading.required('SLOP_EXPLORER_WRITER_URL', parsePostgresURL);
	const readerURL = reading.required('SLOP_EXPLORER_READER_URL', parseReaderURL);
	const tokens = reading.required('SLOP_EXPLORER_TOKENS', parseTokens);
	const host = reading.optional('SLOP_EXPLORER_LISTEN_IP', parseListenIP, DEFAULT_LISTEN_IP);
	const port = reading.optional('SLOP_EXPLORER_LISTEN_PORT', integerFrom(0, MAX_PORT), DEFAULT_LISTEN_PORT);
	const logFormat = reading.optional('SLOP_EXPLORER_LOG_FORMAT', parseLogFormat, DEFAULT_LOG_FORMAT);
	const batchStaples = reading.optional('SLOP_EXPLORER_BATCH_STAPLES', integerFrom(1, MAX_BATCH_STAPLES), DEFAULT_INDEXER_SETTINGS.batchStaples);
	const batchPause = reading.optional('SLOP_EXPLORER_BATCH_PAUSE_MS', integerFrom(0, MAX_BATCH_PAUSE_MILLISECONDS), DEFAULT_INDEXER_SETTINGS.batchPauseMilliseconds);
	const timeout = reading.optional('SLOP_EXPLORER_SQL_TIMEOUT_MS', integerFrom(1, MAX_SQL_TIMEOUT_MILLISECONDS), DEFAULT_SQL_LIMITS.timeoutMilliseconds);
	const maxTimeout = reading.optional('SLOP_EXPLORER_SQL_MAX_TIMEOUT_MS', integerFrom(1, MAX_SQL_TIMEOUT_MILLISECONDS), DEFAULT_SQL_LIMITS.maxTimeoutMilliseconds);
	const rowCap = reading.optional('SLOP_EXPLORER_SQL_ROW_CAP', integerFrom(1, MAX_ROW_CAP), DEFAULT_SQL_LIMITS.rowCap);
	const maxConcurrentQueries = reading.optional('SLOP_EXPLORER_MAX_CONCURRENT_QUERIES', integerFrom(1, MAX_CONCURRENT_QUERIES), DEFAULT_MAX_CONCURRENT_QUERIES);
	if (timeout !== undefined && maxTimeout !== undefined && timeout > maxTimeout) {
		reading.problems.push({ kind: 'invalid', variable: 'SLOP_EXPLORER_SQL_TIMEOUT_MS', expected: `at most SLOP_EXPLORER_SQL_MAX_TIMEOUT_MS (${maxTimeout.toString()})`, value: timeout.toString() });
	}
	if (writerURL === undefined || readerURL === undefined || tokens === undefined || host === undefined || port === undefined || logFormat === undefined || batchStaples === undefined || batchPause === undefined || timeout === undefined || maxTimeout === undefined || rowCap === undefined || maxConcurrentQueries === undefined || reading.problems.length > 0) {
		return({ refused: reading.problems.map(describeExplorerConfigProblem) });
	}
	return({
		writerURL,
		readerURL,
		tokens,
		listen: { host, port },
		logFormat,
		indexer: { ...DEFAULT_INDEXER_SETTINGS, batchStaples, batchPauseMilliseconds: batchPause },
		sql: { ...DEFAULT_SQL_LIMITS, timeoutMilliseconds: timeout, maxTimeoutMilliseconds: maxTimeout, rowCap },
		maxConcurrentQueries
	});
}
