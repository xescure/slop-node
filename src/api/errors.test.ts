import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { APIDocument } from '../conformance/api/document.js';
import { createIdempotentKeyError, createLedgerError } from '../ledger/storage/errors.js';
import { answerError, parseErrorID } from './errors.js';
import type { ErrorAnswer, ErrorID } from './errors.js';

const lib = KeetaNet.lib;

const api = new APIDocument();

const FIXED_ERROR_ID = '0f8e2c34-5b1a-4d6e-9c7f-2a3b4c5d6e7f';

function fixedErrorID(): ErrorID {
	return(parseErrorID(FIXED_ERROR_ID));
}

function answer(error: unknown): ErrorAnswer {
	return(answerError(error, fixedErrorID));
}

/** The one form of the Error envelope a body takes, or the violations of both. */
function envelopeForm(body: unknown): 'refusal' | 'internal' | readonly string[] {
	const asRefusal = api.schemaViolations('ErrorRefusal', body);
	const asInternal = api.schemaViolations('ErrorInternal', body);
	expect(api.schemaViolations('Error', body)).toEqual([]);
	if (asRefusal.length === 0 && asInternal.length > 0) {
		return('refusal');
	}
	if (asInternal.length === 0 && asRefusal.length > 0) {
		return('internal');
	}
	return([...asRefusal, ...asInternal]);
}

const SECRET = 'postgres://slop:hunter2@db.invalid/ledger';

describe('a KeetaNet error the node raises is answered as a refusal', function() {
	test('a ledger error names its type, code and message', function() {
		const result = answer(createLedgerError('LEDGER_INVALID_BALANCE', 'Balance would go negative'));
		expect(result).toEqual({
			kind: 'refusal',
			body: { error: true, type: 'LEDGER', code: 'LEDGER_INVALID_BALANCE', message: 'Balance would go negative' }
		});
		expect(envelopeForm(result.body)).toBe('refusal');
	});

	test('a vote error names the accounts party to the conflict', function() {
		const account = lib.Account.fromSeed(lib.Account.generateRandomSeed(), 0);
		const publicKey = account.publicKeyString.get();
		const error = lib.Error.fromJSON({ type: 'LEDGER', code: 'LEDGER_NOT_SUCCESSOR', message: 'Not a successor', accounts: [publicKey] });
		const result = answer(error);
		expect(result).toEqual({
			kind: 'refusal',
			body: { error: true, type: 'LEDGER', code: 'LEDGER_NOT_SUCCESSOR', message: 'Not a successor', accounts: [publicKey] }
		});
		expect(envelopeForm(result.body)).toBe('refusal');
	});

	test('an idempotent-key error names the account, the key and both blocks', function() {
		const account = lib.Account.fromSeed(lib.Account.generateRandomSeed(), 0);
		const blockHash = new lib.Block.Hash('A'.repeat(64));
		const existingBlockHash = new lib.Block.Hash('B'.repeat(64));
		const idempotent = Buffer.from('payment-1');
		const result = answer(createIdempotentKeyError({ blockHash, existingBlockHash, account, idempotent }));
		expect(result.kind).toBe('refusal');
		expect(result.body).toMatchObject({
			error: true,
			type: 'LEDGER',
			code: 'LEDGER_IDEMPOTENT_KEY_EXISTS',
			account: account.publicKeyString.get(),
			idempotentKey: idempotent.toString('base64'),
			blockhash: blockHash.toString(),
			existingBlockhash: existingBlockHash.toString()
		});
		expect(envelopeForm(result.body)).toBe('refusal');
	});

	test('an error of another family keeps its own type', function() {
		const error = lib.Error.fromJSON({ type: 'API', code: 'API_LIMIT_NOT_NUMBER', message: 'Limit must be a number' });
		const result = answer(error);
		expect(result.body).toEqual({ error: true, type: 'API', code: 'API_LIMIT_NOT_NUMBER', message: 'Limit must be a number' });
		expect(envelopeForm(result.body)).toBe('refusal');
	});
});

/** A KeetaNet error that writes the JSON given in place of its own. */
function writingJSON(json: unknown): Error {
	const error = lib.Error.fromJSON({ type: 'LEDGER', code: 'LEDGER_INVALID_BALANCE', message: 'Balance would go negative' });
	return(Object.assign(error, {
		toJSON: function(): unknown {
			return(json);
		}
	}));
}

describe('a refusal names only what the error\'s JSON writes as the client reads it', function() {
	const refused = { type: 'LEDGER', code: 'LEDGER_NOT_SUCCESSOR', message: 'Not a successor' };

	test('a list of accounts that holds anything but strings is left out', function() {
		expect(answer(writingJSON({ ...refused, accounts: ['keeta_a', 7] })).body).toStrictEqual({ error: true, ...refused });
	});

	test('a field that is not a string is left out, and no field is written that the JSON lacks', function() {
		expect(answer(writingJSON({ ...refused, account: 7, idempotentKey: null, blockhash: 'AB', existingBlockhash: ['CD'] })).body).toStrictEqual({ error: true, ...refused, blockhash: 'AB' });
		expect(answer(writingJSON(refused)).body).toStrictEqual({ error: true, ...refused });
	});

	test.each([
		{ name: 'no object', json: 'LEDGER_NOT_SUCCESSOR' },
		{ name: 'null', json: null },
		{ name: 'no type', json: { code: refused.code, message: refused.message } },
		{ name: 'no code', json: { type: refused.type, message: refused.message } },
		{ name: 'no message', json: { type: refused.type, code: refused.code } }
	])('an error whose JSON is $name is answered as an internal failure', function({ json }) {
		expect(answer(writingJSON(json))).toEqual({
			kind: 'internal',
			errorID: FIXED_ERROR_ID,
			body: { error: true, message: `Internal error occurred (error ID: ${FIXED_ERROR_ID})` }
		});
	});
});

/** The error the request's timing raises for a section named as given. */
function timingError(section: string): unknown {
	try {
		new lib.Timing.RequestTiming().startTime(section);
	} catch (error) {
		return(error);
	}
	throw(new Error(`the timing accepts the section name ${section}`));
}

describe('any other failure is answered with only an error ID', function() {
	const internalFailures: readonly { readonly name: string; readonly error: unknown }[] = [
		{ name: 'a ledger error a driver wrapped', error: createLedgerError('LEDGER_OTHER', `connect ECONNREFUSED ${SECRET}`) },
		{ name: 'a plain Error', error: new Error(`could not reach ${SECRET}`) },
		{ name: 'a thrown string', error: SECRET },
		{ name: 'an object that only carries a KeetaNet code', error: { code: 'LEDGER_INVALID_BALANCE', message: SECRET } },
		{ name: 'an Error whose code is not a KeetaNet code', error: Object.assign(new Error(SECRET), { code: 'ECONNREFUSED' }) },
		{ name: 'a timing error naming a section that is no token', error: timingError(`api-${SECRET}`) }
	];

	test.each(internalFailures)('$name', function({ error }) {
		const result = answer(error);
		expect(result).toEqual({
			kind: 'internal',
			errorID: FIXED_ERROR_ID,
			body: { error: true, message: `Internal error occurred (error ID: ${FIXED_ERROR_ID})` }
		});
		expect(JSON.stringify(result.body)).not.toContain('hunter2');
		expect(envelopeForm(result.body)).toBe('internal');
	});

	test('an error ID is a UUID, and nothing more', function() {
		expect(parseErrorID(FIXED_ERROR_ID)).toBe(FIXED_ERROR_ID);
		for (const text of ['not-a-uuid', `${FIXED_ERROR_ID}0`, `0${FIXED_ERROR_ID}`]) {
			expect(function() {
				return(parseErrorID(text));
			}).toThrow(`not an error ID: ${text}`);
		}
	});

	test('each failure gets an error ID of its own', function() {
		const first = answerError(new Error('first'));
		const second = answerError(new Error('second'));
		if (first.kind !== 'internal' || second.kind !== 'internal') {
			throw(new Error('a plain Error was refused'));
		}
		expect(first.errorID).not.toBe(second.errorID);
		expect(envelopeForm(first.body)).toBe('internal');
	});
});
