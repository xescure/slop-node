import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { StapleKey } from '../keys.js';

const lib = KeetaNet.lib;

type SQLScalar = string | number | boolean | Date | Buffer | null;

/** A value pg sends as a parameter without guessing: integers wider than a double travel as text. */
export type SQLValue = SQLScalar | readonly SQLScalar[];

/** An integer column read back: pg returns bigint and numeric values as text. */
export type IntegerText = string & { readonly __integerText: never };

/**
 * One SQL statement, with the parameters it takes and the rows it returns.
 * pg prepares a named statement once per connection.
 */
export class Statement<Parameters extends readonly SQLValue[], Row extends object = Record<string, never>> {
	readonly name: string;
	readonly text: string;
	// Carries the parameter and row types; it is never assigned.
	declare readonly signature: (parameters: Parameters) => Row;

	constructor(name: string, text: string) {
		this.name = name;
		this.text = text;
	}
}

export function statement<Parameters extends readonly SQLValue[], Row extends object = Record<string, never>>(name: string, text: string): Statement<Parameters, Row> {
	return(new Statement<Parameters, Row>(`ledger_${name}`, text));
}

export function toNumeric(value: bigint): string {
	return(value.toString());
}

/** Reads a bigint or integer-valued numeric column. */
export function fromInteger(text: IntegerText): bigint {
	return(BigInt(text));
}

export function hashBytes(hash: { getBuffer(): Buffer }): Buffer {
	return(hash.getBuffer());
}

/** Staple keys are the uppercase hex of the blocks hash. */
export function stapleKeyBytes(key: StapleKey): Buffer {
	return(Buffer.from(key, 'hex'));
}

export function toBlockHash(bytes: Buffer): BlockHash {
	return(new lib.Block.Hash(bytes));
}

export function publicKeyOf(account: GenericAccount | string): string {
	return(lib.Account.toPublicKeyString(account));
}

export function bytesOf(buffer: ArrayBuffer): Buffer {
	return(Buffer.from(buffer));
}

/** An interned account's row ID, as pg returns a bigint. */
export type AccountID = IntegerText;

export type AccountIDs = ReadonlyMap<string, AccountID>;

export const internAccounts: Statement<[string[], number[]], { id: AccountID; public_key: string }> = statement('intern_accounts', `
	WITH wanted AS (
		SELECT * FROM unnest($1::text[], $2::smallint[]) AS wanted (public_key, key_type)
	), inserted AS (
		INSERT INTO accounts (public_key, key_type)
		SELECT public_key, key_type FROM wanted ORDER BY public_key
		ON CONFLICT (public_key) DO NOTHING
		RETURNING id, public_key
	)
	SELECT id, public_key FROM inserted
	UNION ALL
	SELECT accounts.id, accounts.public_key FROM accounts JOIN wanted USING (public_key)`);

export const nextSerial: Statement<[], { serial: IntegerText }> = statement('next_serial', 'SELECT nextval(\'vote_serials\') AS serial');

export type VoteColumns = { readonly bytes: Buffer; readonly validity_from: Date; readonly permanent: boolean };
