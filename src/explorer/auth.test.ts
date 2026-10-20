import { describe, expect, test } from 'vitest';
import { authorized, authorizer, MINIMUM_TOKEN_LENGTH, parseBearerTokens } from './auth.js';
import type { BearerToken } from './auth.js';

const FIRST = 'a'.repeat(MINIMUM_TOKEN_LENGTH);

const SECOND = `${'Zq3-_.~+/'.repeat(4)}==`;

const tokensOf = function(input: string): readonly BearerToken[] {
	const parsed = parseBearerTokens(input);
	if ('refused' in parsed) {
		throw(new Error(`Expected tokens, got ${parsed.refused}`));
	}
	return(parsed);
};

describe('parseBearerTokens', function() {
	test('reads one token or several separated by commas', function() {
		expect(tokensOf(FIRST)).toEqual([FIRST]);
		expect(tokensOf(`${FIRST},${SECOND}`)).toEqual([FIRST, SECOND]);
	});

	test('refuses a token shorter than the minimum, an empty list, an empty entry and whitespace', function() {
		for (const input of ['a'.repeat(MINIMUM_TOKEN_LENGTH - 1), '', `${FIRST},`, `,${FIRST}`, `${FIRST}, ${SECOND}`, ` ${FIRST}`, `${FIRST.slice(1)}\t`]) {
			expect(parseBearerTokens(input), JSON.stringify(input)).toHaveProperty('refused');
		}
	});

	test('names the shortest length in its refusal of a short token, without the token', function() {
		const short = 'b'.repeat(MINIMUM_TOKEN_LENGTH - 1);
		const parsed = parseBearerTokens(`${FIRST},${short}`);
		if (!('refused' in parsed)) {
			throw(new Error('Expected a refusal'));
		}
		expect(parsed.refused).toContain(String(MINIMUM_TOKEN_LENGTH));
		expect(parsed.refused).not.toContain(short);
	});
});

describe('authorized', function() {
	const tokens = tokensOf(`${FIRST},${SECOND}`);

	test('accepts exactly Bearer and one of the tokens', function() {
		expect(authorized(`Bearer ${FIRST}`, tokens)).toBe(true);
		expect(authorized(`Bearer ${SECOND}`, tokens)).toBe(true);
	});

	test('refuses no header, a wrong token, a prefix, one more character, a lower-case scheme and two spaces', function() {
		for (const header of [undefined, '', 'Bearer', 'Bearer ', `Bearer ${'c'.repeat(MINIMUM_TOKEN_LENGTH)}`, `Bearer ${FIRST.slice(1)}`, `Bearer ${FIRST}a`, `bearer ${FIRST}`, `Bearer  ${FIRST}`, `Basic ${FIRST}`, `Bearer ${FIRST},${SECOND}`, FIRST]) {
			expect(authorized(header, tokens), JSON.stringify(header)).toBe(false);
		}
	});

	test('refuses everything when there are no tokens', function() {
		expect(authorized(`Bearer ${FIRST}`, [])).toBe(false);
	});

	test('answers as authorized does once its digests are computed', function() {
		const check = authorizer(tokens);
		for (const header of [`Bearer ${FIRST}`, `Bearer ${SECOND}`, `Bearer ${FIRST}a`, undefined]) {
			expect(check(header), JSON.stringify(header)).toBe(authorized(header, tokens));
		}
	});
});
