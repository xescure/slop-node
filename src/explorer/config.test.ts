import { describe, expect, test } from 'vitest';
import { DEFAULT_INDEXER_SETTINGS } from './indexer.js';
import { DEFAULT_SQL_LIMITS } from './sql.js';
import { explorerConfigFromEnv } from './config.js';
import type { ExplorerConfig } from './config.js';

const PASSWORD = 'hunter2-secret-password';

const TOKEN = 'explorer-config-token-0123456789abcdef';

const REQUIRED = {
	SLOP_EXPLORER_WRITER_URL: `postgresql://explorer_writer:${PASSWORD}@db.internal:5432/ledger`,
	SLOP_EXPLORER_READER_URL: `postgres://explorer_reader:${PASSWORD}@db.internal:5432/ledger`,
	SLOP_EXPLORER_TOKENS: TOKEN
} as const;

const configOf = function(env: NodeJS.ProcessEnv): ExplorerConfig {
	const config = explorerConfigFromEnv(env);
	if ('refused' in config) {
		throw(new Error(config.refused.join('\n')));
	}
	return(config);
};

/** The refusals, each checked to repeat no password and no token. */
const refusalsOf = function(env: NodeJS.ProcessEnv): readonly string[] {
	const config = explorerConfigFromEnv(env);
	if (!('refused' in config)) {
		throw(new Error('the configuration was accepted'));
	}
	for (const message of config.refused) {
		expect(message).not.toContain(PASSWORD);
		expect(message).not.toContain(TOKEN.slice(0, 16));
	}
	return(config.refused);
};

describe('explorerConfigFromEnv', function() {
	test('fills every optional setting with its default', function() {
		expect(configOf(REQUIRED)).toEqual({
			writerURL: REQUIRED.SLOP_EXPLORER_WRITER_URL,
			readerURL: REQUIRED.SLOP_EXPLORER_READER_URL,
			tokens: [TOKEN],
			listen: { host: '127.0.0.1', port: 8080 },
			logFormat: 'text',
			indexer: DEFAULT_INDEXER_SETTINGS,
			sql: DEFAULT_SQL_LIMITS,
			maxConcurrentQueries: 4
		});
	});

	test('reads every setting given', function() {
		const second = 'second-explorer-token-0123456789abcdef';
		expect(configOf({
			...REQUIRED,
			SLOP_EXPLORER_TOKENS: `${TOKEN},${second}`,
			SLOP_EXPLORER_LISTEN_IP: '::',
			SLOP_EXPLORER_LISTEN_PORT: '0',
			SLOP_EXPLORER_LOG_FORMAT: 'json',
			SLOP_EXPLORER_BATCH_STAPLES: '10000',
			SLOP_EXPLORER_BATCH_PAUSE_MS: '0',
			SLOP_EXPLORER_SQL_TIMEOUT_MS: '7000',
			SLOP_EXPLORER_SQL_MAX_TIMEOUT_MS: '7000',
			SLOP_EXPLORER_SQL_ROW_CAP: '1',
			SLOP_EXPLORER_MAX_CONCURRENT_QUERIES: '8'
		})).toEqual({
			writerURL: REQUIRED.SLOP_EXPLORER_WRITER_URL,
			readerURL: REQUIRED.SLOP_EXPLORER_READER_URL,
			tokens: [TOKEN, second],
			listen: { host: '::', port: 0 },
			logFormat: 'json',
			indexer: { ...DEFAULT_INDEXER_SETTINGS, batchStaples: 10_000, batchPauseMilliseconds: 0 },
			sql: { ...DEFAULT_SQL_LIMITS, timeoutMilliseconds: 7000, maxTimeoutMilliseconds: 7000, rowCap: 1 },
			maxConcurrentQueries: 8
		});
	});

	test.each(Object.keys(REQUIRED))('refuses to run without %s', function(variable) {
		const env = Object.fromEntries(Object.entries(REQUIRED).filter(function([name]) {
			return(name !== variable);
		}));
		expect(refusalsOf(env)).toEqual([`${variable} is not set`]);
	});

	test('names every problem at once', function() {
		expect(refusalsOf({ SLOP_EXPLORER_LISTEN_PORT: '70000', SLOP_EXPLORER_LOG_FORMAT: 'xml' })).toEqual([
			'SLOP_EXPLORER_WRITER_URL is not set',
			'SLOP_EXPLORER_READER_URL is not set',
			'SLOP_EXPLORER_TOKENS is not set',
			'SLOP_EXPLORER_LISTEN_PORT must be a whole number from 0 to 65535 (it is "70000")',
			'SLOP_EXPLORER_LOG_FORMAT must be text or json (it is "xml")'
		]);
	});

	test('refuses a token shorter than a bearer token may be, without repeating it', function() {
		expect(refusalsOf({ ...REQUIRED, SLOP_EXPLORER_TOKENS: `${TOKEN},${TOKEN.slice(0, 20)}` })).toEqual([
			'SLOP_EXPLORER_TOKENS must be bearer tokens separated by commas: token 2 of 2 is shorter than 32 characters'
		]);
	});

	test('refuses a URL that is not Postgres\'s, without repeating its password', function() {
		expect(refusalsOf({ ...REQUIRED, SLOP_EXPLORER_WRITER_URL: `mysql://explorer_writer:${PASSWORD}@db.internal/ledger`, SLOP_EXPLORER_READER_URL: `${PASSWORD} is no URL` })).toEqual([
			'SLOP_EXPLORER_WRITER_URL must be a postgres:// or postgresql:// URL',
			'SLOP_EXPLORER_READER_URL must be a postgres:// or postgresql:// URL'
		]);
	});

	test('refuses an empty value rather than reading it as unset', function() {
		expect(refusalsOf({ ...REQUIRED, SLOP_EXPLORER_TOKENS: '', SLOP_EXPLORER_LOG_FORMAT: '' })).toEqual([
			'SLOP_EXPLORER_TOKENS is set but empty',
			'SLOP_EXPLORER_LOG_FORMAT is set but empty'
		]);
	});

	test('refuses a variable of its prefix that it does not read, which is most likely misspelt', function() {
		expect(refusalsOf({ ...REQUIRED, SLOP_EXPLORER_LISTEN_PROT: '80', SLOP_NODE_OTHER: 'x' })).toEqual([
			'SLOP_EXPLORER_LISTEN_PROT is not a setting of the explorer'
		]);
	});

	test('refuses a listen address that is no IP address', function() {
		expect(refusalsOf({ ...REQUIRED, SLOP_EXPLORER_LISTEN_IP: 'localhost' })).toEqual([
			'SLOP_EXPLORER_LISTEN_IP must be an IPv4 or IPv6 address (it is "localhost")'
		]);
	});

	test.each([
		['SLOP_EXPLORER_LISTEN_PORT', '-1', 'a whole number from 0 to 65535'],
		['SLOP_EXPLORER_LISTEN_PORT', '65536', 'a whole number from 0 to 65535'],
		['SLOP_EXPLORER_LISTEN_PORT', '080', 'a whole number from 0 to 65535'],
		['SLOP_EXPLORER_BATCH_STAPLES', '0', 'a whole number from 1 to 10000'],
		['SLOP_EXPLORER_BATCH_STAPLES', '10001', 'a whole number from 1 to 10000'],
		['SLOP_EXPLORER_BATCH_PAUSE_MS', '60001', 'a whole number from 0 to 60000'],
		['SLOP_EXPLORER_BATCH_PAUSE_MS', '1.5', 'a whole number from 0 to 60000'],
		['SLOP_EXPLORER_SQL_TIMEOUT_MS', '0', 'a whole number from 1 to 2147483647'],
		['SLOP_EXPLORER_SQL_MAX_TIMEOUT_MS', '2147483648', 'a whole number from 1 to 2147483647'],
		['SLOP_EXPLORER_SQL_ROW_CAP', '0', 'a whole number from 1 to 1000000'],
		['SLOP_EXPLORER_SQL_ROW_CAP', '1000001', 'a whole number from 1 to 1000000'],
		['SLOP_EXPLORER_MAX_CONCURRENT_QUERIES', '0', 'a whole number from 1 to 8'],
		['SLOP_EXPLORER_MAX_CONCURRENT_QUERIES', '9', 'a whole number from 1 to 8']
	])('refuses %s=%s', function(variable, value, expected) {
		expect(refusalsOf({ ...REQUIRED, [variable]: value })).toEqual([`${variable} must be ${expected} (it is ${JSON.stringify(value)})`]);
	});

	test('refuses a default SQL timeout over the longest an agent may ask for', function() {
		expect(refusalsOf({ ...REQUIRED, SLOP_EXPLORER_SQL_TIMEOUT_MS: '40000' })).toEqual([
			'SLOP_EXPLORER_SQL_TIMEOUT_MS must be at most SLOP_EXPLORER_SQL_MAX_TIMEOUT_MS (30000) (it is "40000")'
		]);
		expect(refusalsOf({ ...REQUIRED, SLOP_EXPLORER_SQL_MAX_TIMEOUT_MS: '1000' })).toEqual([
			'SLOP_EXPLORER_SQL_TIMEOUT_MS must be at most SLOP_EXPLORER_SQL_MAX_TIMEOUT_MS (1000) (it is "5000")'
		]);
	});
});
