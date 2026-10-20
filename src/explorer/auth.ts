import { createHash, timingSafeEqual } from 'node:crypto';

export type BearerToken = string & { readonly __bearerToken: never };

export const MINIMUM_TOKEN_LENGTH = 32;

const SCHEME = 'Bearer ';

/** The characters RFC 6750 allows in a bearer token, which leaves out whitespace and the comma that separates tokens. */
const TOKEN_CHARACTERS = /^[A-Za-z0-9\-._~+/]+=*$/;

/** Reads the comma-separated tokens of the environment; a refusal never repeats a token. */
export function parseBearerTokens(input: string): readonly BearerToken[] | { readonly refused: string } {
	const entries = input.split(',');
	const tokens: BearerToken[] = [];
	for (const [index, entry] of entries.entries()) {
		const position = `token ${(index + 1).toString()} of ${entries.length.toString()}`;
		if (entry.length < MINIMUM_TOKEN_LENGTH) {
			return({ refused: `${position} is shorter than ${MINIMUM_TOKEN_LENGTH.toString()} characters` });
		}
		if (!TOKEN_CHARACTERS.test(entry)) {
			return({ refused: `${position} holds a character a bearer token cannot, such as whitespace` });
		}
		tokens.push(entry as BearerToken);
	}
	return(tokens);
}

const digestOf = function(text: string): Buffer {
	return(createHash('sha256').update(text, 'utf-8').digest());
};

/*
 * Digests have one length whatever the token's, so comparing them takes the
 * same time for every candidate, and every token is compared, so the time
 * says nothing of which one matched.
 */
const matchesAny = function(header: string | undefined, digests: readonly Buffer[]): boolean {
	if (header === undefined || !header.startsWith(SCHEME)) {
		return(false);
	}
	const candidate = digestOf(header.slice(SCHEME.length));
	let matched = false;
	for (const digest of digests) {
		if (timingSafeEqual(candidate, digest)) {
			matched = true;
		}
	}
	return(matched);
};

/** A check of Authorization headers against the tokens, whose digests it computes once. */
export function authorizer(tokens: readonly BearerToken[]): (header: string | undefined) => boolean {
	const digests = tokens.map(digestOf);
	return(function(header) {
		return(matchesAny(header, digests));
	});
}

export function authorized(header: string | undefined, tokens: readonly BearerToken[]): boolean {
	return(authorizer(tokens)(header));
}
