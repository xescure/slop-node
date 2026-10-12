import { describe, expect, test } from 'vitest';
import { asPayload, optionalString, optionalStringList, PayloadError, requiredObject, requiredString, requiredStringList } from './payload.js';

/** What a read of a body throws, which the node logs under the error ID it answers with. */
function refusal(read: () => unknown): PayloadError {
	try {
		read();
	} catch (error) {
		if (error instanceof PayloadError) {
			return(error);
		}
		throw(error);
	}
	throw(new Error('the body was read'));
}

describe('a request body', function() {
	test('is a JSON object, and anything else is named as malformed', function() {
		const body = { blocks: [] };

		expect(asPayload(body)).toBe(body);
		for (const malformed of [null, [], 'blocks', 7, undefined]) {
			const error = refusal(function() {
				return(asPayload(malformed));
			});
			expect(error.name).toBe('PayloadError');
			expect(error.message).toBe('malformed request body: not a JSON object');
		}
	});

	test('a required string is read, and any other value is refused by name', function() {
		expect(requiredString({ votesAndBlocks: 'AAAA' }, 'votesAndBlocks')).toBe('AAAA');
		expect(refusal(function() {
			return(requiredString({ votesAndBlocks: 7 }, 'votesAndBlocks'));
		}).message).toBe('malformed request body: "votesAndBlocks" is not a string');
	});

	test('an optional string is read when present, and must then be a string', function() {
		expect(optionalString({}, 'quote')).toBeUndefined();
		expect(optionalString({ quote: 'AAAA' }, 'quote')).toBe('AAAA');
		expect(refusal(function() {
			return(optionalString({ quote: null }, 'quote'));
		}).message).toBe('malformed request body: "quote" is not a string');
	});

	test('a required list of strings is read, and a list of anything else is refused at its first other entry', function() {
		expect(requiredStringList({ blocks: ['AA', 'BB'] }, 'blocks')).toEqual(['AA', 'BB']);
		expect(refusal(function() {
			return(requiredStringList({ blocks: 'AA' }, 'blocks'));
		}).message).toBe('malformed request body: "blocks" is not a list');
		expect(refusal(function() {
			return(requiredStringList({ blocks: ['AA', 1, 2] }, 'blocks'));
		}).message).toBe('malformed request body: "blocks"[1] is not a string');
	});

	test('an optional list of strings is read when present, and must then be one', function() {
		expect(optionalStringList({}, 'votes')).toBeUndefined();
		expect(optionalStringList({ votes: ['AA'] }, 'votes')).toEqual(['AA']);
		expect(refusal(function() {
			return(optionalStringList({ votes: {} }, 'votes'));
		}).message).toBe('malformed request body: "votes" is not a list');
	});

	test('a required object is read, and anything else is refused by name', function() {
		const greeting = { kind: 1 };

		expect(requiredObject({ greeting }, 'greeting')).toBe(greeting);
		expect(refusal(function() {
			return(requiredObject({ greeting: [] }, 'greeting'));
		}).message).toBe('malformed request body: "greeting" is not an object');
	});
});
