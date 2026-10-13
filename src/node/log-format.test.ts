import { format, inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { LogLevel } from '@keetanetwork/keetanet-client/lib/log/index.js';
import type { LogSettings } from './config.js';
import { jsonLogLine, logTargetOf } from './log-format.js';
import type { JSONLogLevel, LogConsole } from './log-format.js';

const lib = KeetaNet.lib;

type Log = InstanceType<typeof lib.Log>;

const NOW = new Date('2026-10-12T09:30:00.000Z');

const REQUEST_ID = '6f1c2a0e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

/** A line of a stack. */
const STACK_FRAME = /^\s+at /m;

type Written = {
	readonly method: JSONLogLevel;
	/** What the console would print: its arguments formatted as console.log formats them. */
	readonly printed: string;
};

type Captured = {
	readonly log: Log;
	readonly written: Written[];
};

/** A log with the target of the settings, writing to a console that records what it is given. */
function capture(settings: Partial<LogSettings> & Pick<LogSettings, 'format'>): Captured {
	const written: Written[] = [];
	const method = function(name: JSONLogLevel) {
		return(function(...args: unknown[]): void {
			written.push({ method: name, printed: format(...args) });
		});
	};
	const console: LogConsole = { debug: method('debug'), info: method('info'), warn: method('warn'), error: method('error') };
	const log = new lib.Log();
	log.registerTarget(logTargetOf({ level: 'ALL', filter: undefined, ...settings }, console, function(): Date {
		return(NOW);
	}));
	return({ log, written });
}

const LEVELS: readonly (readonly [LogLevel, JSONLogLevel])[] = [
	['DEBUG', 'debug'],
	['INFO', 'info'],
	['WARN', 'warn'],
	['ERROR', 'error']
];

function logAt(log: Log, level: LogLevel, ...args: unknown[]): void {
	switch (level) {
		case 'DEBUG':
			log.debug({ currentRequestInfo: { id: REQUEST_ID } }, 'BOOTSTRAP', ...args);
			return;
		case 'INFO':
			log.info({ currentRequestInfo: { id: REQUEST_ID } }, 'BOOTSTRAP', ...args);
			return;
		case 'WARN':
			log.warn({ currentRequestInfo: { id: REQUEST_ID } }, 'BOOTSTRAP', ...args);
			return;
		case 'ERROR':
			log.error({ currentRequestInfo: { id: REQUEST_ID } }, 'BOOTSTRAP', ...args);
			return;
		default:
			throw(new Error(`unexpected level ${String(level)}`));
	}
}

describe('the JSON log format', function() {
	test.each(LEVELS)('writes an entry at %s as one line, on the console method of its level', async function(level, method) {
		const { log, written } = capture({ format: 'json' });
		logAt(log, level, 'caught up with', 3, 'peers', { pages: 2 });
		await log.sync();
		expect(written).toEqual([{
			method,
			printed: `{"level":"${method}","message":"caught up with 3 peers { pages: 2 }","time":"2026-10-12T09:30:00.000Z","from":"BOOTSTRAP","requestID":"${REQUEST_ID}"}`
		}]);
	});

	test('leaves out the request ID of an entry logged without one', async function() {
		const { log, written } = capture({ format: 'json' });
		log.info('API', 'listening');
		await log.sync();
		expect(written.map(function(line): unknown {
			return(JSON.parse(line.printed));
		})).toEqual([{ level: 'info', message: 'listening', time: NOW.toISOString(), from: 'API' }]);
	});

	test('leaves out the request ID of an entry logged with a null request', async function() {
		const { log, written } = capture({ format: 'json' });
		log.info({ currentRequestInfo: null }, 'API', 'listening');
		await log.sync();
		expect(written.map(function(line): unknown {
			return(JSON.parse(line.printed));
		})).toEqual([{ level: 'info', message: 'listening', time: NOW.toISOString(), from: 'API' }]);
	});

	test('keeps an error\'s message in the message, and its stack and error ID in fields of their own', async function() {
		const { log, written } = capture({ format: 'json' });
		const failure = new Error('check-ins are refused', { cause: new Error('the trigger raised') });
		log.error({ currentRequestInfo: { id: REQUEST_ID } }, 'node', `Background work failed, and the node carries on (error ID: ${REQUEST_ID}):`, failure);
		await log.sync();
		expect(written).toHaveLength(1);
		const [line] = written;
		expect(line?.method).toBe('error');
		expect(line?.printed).not.toContain('\n');
		expect(JSON.parse(line?.printed ?? '')).toEqual({
			level: 'error',
			message: `Background work failed, and the node carries on (error ID: ${REQUEST_ID}): Error: check-ins are refused`,
			time: NOW.toISOString(),
			from: 'node',
			requestID: REQUEST_ID,
			stack: inspect(failure)
		});
		expect(inspect(failure)).toMatch(STACK_FRAME);
		expect(inspect(failure)).toContain('the trigger raised');
	});

	test('writes only the entries at its level or above whose source matches its filter', async function() {
		const { log, written } = capture({ format: 'json', level: 'WARN', filter: /^ledger$/i });
		log.info('LEDGER', 'below the level');
		log.warn('P2P', 'another source');
		log.warn('LEDGER', 'written');
		await log.sync();
		expect(written.map(function(line): unknown {
			return(JSON.parse(line.printed));
		})).toEqual([{ level: 'warn', message: 'written', time: NOW.toISOString(), from: 'LEDGER' }]);
	});

	test('writes nothing at NONE', async function() {
		const { log, written } = capture({ format: 'json', level: 'NONE' });
		log.error('LEDGER', 'dropped');
		await log.sync();
		expect(written).toEqual([]);
	});

	test('puts the level, the message and the time first, ahead of the attributes', function() {
		expect(jsonLogLine('info', 'slop-node 0.0.0', NOW, { storage: 'memory', manualPeers: 0, api: null })).toBe('{"level":"info","message":"slop-node 0.0.0","time":"2026-10-12T09:30:00.000Z","storage":"memory","manualPeers":0,"api":null}');
	});
});

describe('the text log format', function() {
	test.each(LEVELS)('writes an entry at %s as upstream\'s console target does', async function(level, method) {
		const { log, written } = capture({ format: 'text' });
		logAt(log, level, 'caught up with', 3, 'peers', { pages: 2 });
		await log.sync();
		expect(written).toEqual([{ method, printed: `[${REQUEST_ID}] ${level} BOOTSTRAP: caught up with 3 peers { pages: 2 }` }]);
	});

	test('writes an error in full after the message, and an entry without a request ID without the request prefix', async function() {
		const { log, written } = capture({ format: 'text' });
		const failure = new Error('check-ins are refused');
		log.error('node', 'Background work failed:', failure);
		await log.sync();
		expect(written).toEqual([{ method: 'error', printed: format('ERROR node:', 'Background work failed:', failure) }]);
		expect(written[0]?.printed).toMatch(STACK_FRAME);
	});
});
