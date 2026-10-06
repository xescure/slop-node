import { describe, expect, test } from 'vitest';
import { createLedgerError } from '../ledger/storage/errors.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { caseErrorOf } from './runner.js';

/** An error as Ledger.run hands it on: after the driver's evaluateError. */
async function throughDriver(error: unknown): Promise<unknown> {
	const evaluated: unknown = await new MemoryLedgerStorage().evaluateError(error);
	return(evaluated);
}

/** The driver's wrapping, built by hand around any cause. */
function wrapping(cause: unknown): Error {
	const wrapped = createLedgerError('LEDGER_OTHER', 'wrapped');
	wrapped.cause = cause;
	return(wrapped);
}

describe('recorded errors', function() {
	test('a plain error the driver wraps is recorded as upstream raised it', async function() {
		const recorded = caseErrorOf(await throughDriver(new Error('Cannot vote on block, no private key loaded')));

		expect(recorded).toEqual({ type: 'plain', message: 'Cannot vote on block, no private key loaded' });
	});

	test('a coded error passes the driver unwrapped and keeps its code', async function() {
		const recorded = caseErrorOf(await throughDriver(createLedgerError('LEDGER_INVALID_BALANCE', 'short')));

		expect(recorded).toEqual({ type: 'coded', code: 'LEDGER_INVALID_BALANCE' });
	});

	test('a wrapping around a coded error records the coded error', function() {
		expect(caseErrorOf(wrapping(createLedgerError('LEDGER_MISSING_BLOCKS', 'none')))).toEqual({ type: 'coded', code: 'LEDGER_MISSING_BLOCKS' });
	});

	test.each([
		['a TypeError', new TypeError('not a function'), /the ledger threw a TypeError: not a function/],
		['no cause', undefined, /a LEDGER_OTHER without a cause: wrapped/],
		['a non-error', 'text', /the ledger threw a non-error: text/],
		['another wrapping', wrapping(new Error('inner')), /a LEDGER_OTHER wraps another: wrapped/]
	])('a wrapping around %s is a fault, not an outcome', function(_name, cause, message) {
		expect(function() {
			return(caseErrorOf(wrapping(cause)));
		}).toThrow(message);
	});

	test('an error of another class outside any wrapping is a fault', function() {
		expect(function() {
			return(caseErrorOf(new RangeError('out of range')));
		}).toThrow(/the ledger threw a RangeError: out of range/);
	});
});
