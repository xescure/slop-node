import { randomUUID } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { ApiErrorResponse } from '@keetanetwork/keetanet-client/lib/node/local.js';
import type { AssertNever } from '../util/assert-never.js';

const lib = KeetaNet.lib;

/**
 * The status of every failure of a whole request, a refusal as well as an
 * internal failure: the client gives up on any status of 500 or more instead
 * of retrying [Keeta TS] index.js:59658-59671.
 */
export const ERROR_STATUS = 500;

/** The ID an internal failure is answered and logged under. */
export type ErrorID = string & { readonly __errorID: never };

const ERROR_ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseErrorID(value: string): ErrorID {
	if (!ERROR_ID_FORMAT.test(value)) {
		throw(new Error(`not an error ID: ${value}`));
	}
	// The brand marks a string that passed the UUID format check.
	return(value as ErrorID);
}

export function newErrorID(): ErrorID {
	return(parseErrorID(randomUUID()));
}

/**
 * A request the node refuses, as the KeetaNet error it raised: the fields the
 * error's own JSON writes, which the client rebuilds the error from
 * [Keeta TS] index.js:66067-66073, 66533-66540, 66575-66590, 66334-66410.
 */
export type RefusalBody = {
	readonly error: true;
	readonly type: string;
	readonly code: string;
	readonly message: string;
	readonly accounts?: readonly string[];
	readonly account?: string;
	readonly idempotentKey?: string;
	readonly blockhash?: string;
	readonly existingBlockhash?: string;
};

/** A failure the node did not anticipate, named only by the ID its details are logged under. */
export type InternalFailureBody = {
	readonly error: true;
	readonly message: `Internal error occurred (error ID: ${string})`;
};

export type ErrorBody = RefusalBody | InternalFailureBody;

export type ErrorAnswer =
	| { readonly kind: 'refusal'; readonly body: RefusalBody }
	| { readonly kind: 'internal'; readonly errorID: ErrorID; readonly body: InternalFailureBody };

/**
 * The code a storage driver wraps a failure in when it has no KeetaNet code
 * of its own; its message is the underlying failure's, which may name the
 * database and its credentials, so it is never echoed.
 */
const DRIVER_WRAPPING_CODE = 'LEDGER_OTHER';

type RefusalOptionalFields = Omit<RefusalBody, 'error' | 'type' | 'code' | 'message'>;

function stringField(json: object, name: string): string | undefined {
	const value: unknown = Reflect.get(json, name);
	if (typeof value === 'string') {
		return(value);
	}
	return(undefined);
}

function stringListField(json: object, name: string): readonly string[] | undefined {
	const value: unknown = Reflect.get(json, name);
	if (!Array.isArray(value)) {
		return(undefined);
	}
	const strings = value.filter(function(entry): entry is string {
		return(typeof entry === 'string');
	});
	if (strings.length !== value.length) {
		return(undefined);
	}
	return(strings);
}

function optionalFields(json: object): RefusalOptionalFields {
	const fields: { -readonly [Name in keyof RefusalOptionalFields]: RefusalOptionalFields[Name] } = {};
	const accounts = stringListField(json, 'accounts');
	if (accounts !== undefined) {
		fields.accounts = accounts;
	}
	for (const name of ['account', 'idempotentKey', 'blockhash', 'existingBlockhash'] as const) {
		const value = stringField(json, name);
		if (value !== undefined) {
			fields[name] = value;
		}
	}
	return(fields);
}

/** The refusal a KeetaNet error is answered with, or undefined for anything that is not one. */
function refusalOf(error: unknown): RefusalBody | undefined {
	if (!(error instanceof Error) || !lib.Error.isInstance(error)) {
		return(undefined);
	}
	const json: unknown = error.toJSON();
	if (typeof json !== 'object' || json === null) {
		return(undefined);
	}
	const type = stringField(json, 'type');
	const code = stringField(json, 'code');
	const message = stringField(json, 'message');
	if (type === undefined || code === undefined || message === undefined || code === DRIVER_WRAPPING_CODE) {
		return(undefined);
	}
	return({ error: true, type, code, message, ...optionalFields(json) });
}

/**
 * How a failed request is answered: a KeetaNet error as the refusal it
 * describes, and anything else only by a fresh error ID, so that no detail of
 * an unanticipated failure reaches the client.
 */
export function answerError(error: unknown, nextErrorID: () => ErrorID = newErrorID): ErrorAnswer {
	const refusal = refusalOf(error);
	if (refusal !== undefined) {
		return({ kind: 'refusal', body: refusal });
	}
	const errorID = nextErrorID();
	return({ kind: 'internal', errorID, body: { error: true, message: `Internal error occurred (error ID: ${errorID})` } });
}

type _ErrorBodyIsDeclared = AssertNever<ErrorBody extends ApiErrorResponse ? never : ErrorBody>;
