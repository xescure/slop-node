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

export const totalWeight: Statement<[], { total: IntegerText }> = statement('total_weight', 'SELECT COALESCE(sum(weight), 0) AS total FROM weights');

export const weightOf: Statement<[string[]], { total: IntegerText }> = statement('weight_of', `
	SELECT COALESCE(sum(weights.weight), 0) AS total
	FROM weights JOIN accounts ON accounts.id = weights.representative_id
	WHERE accounts.public_key = ANY($1::text[])`);

export const balanceOf: Statement<[string, string], { balance: IntegerText }> = statement('balance_of', `
	SELECT balances.balance
	FROM balances
	JOIN accounts holder ON holder.id = balances.account_id
	JOIN accounts token ON token.id = balances.token_id
	WHERE holder.public_key = $1 AND token.public_key = $2`);

export const nonZeroBalances: Statement<[string], { token: string; balance: IntegerText }> = statement('non_zero_balances', `
	SELECT token.public_key AS token, balances.balance
	FROM balances
	JOIN accounts holder ON holder.id = balances.account_id
	JOIN accounts token ON token.id = balances.token_id
	WHERE holder.public_key = $1 AND balances.balance <> 0
	ORDER BY token.public_key`);

export type AccountInfoColumns = {
	readonly name: string | null;
	readonly description: string | null;
	readonly metadata: string | null;
	readonly default_base_permission: IntegerText | null;
	readonly default_external_permission: IntegerText | null;
	readonly multisig_quorum: IntegerText | null;
	readonly supply: IntegerText | null;
};

export const accountInfoOf: Statement<[string], AccountInfoColumns> = statement('account_info_of', `
	SELECT info.name, info.description, info.metadata, info.default_base_permission,
		info.default_external_permission, info.multisig_quorum, supplies.supply
	FROM accounts
	LEFT JOIN account_info info ON info.account_id = accounts.id
	LEFT JOIN supplies ON supplies.token_id = accounts.id
	WHERE accounts.public_key = $1`);

export const representativeOf: Statement<[string], { representative: string }> = statement('representative_of', `
	SELECT representative.public_key AS representative
	FROM delegations
	JOIN accounts holder ON holder.id = delegations.account_id
	JOIN accounts representative ON representative.id = delegations.representative_id
	WHERE holder.public_key = $1`);

export type ACLColumns = {
	readonly principal: string;
	readonly certificate: Buffer | null;
	readonly entity: string;
	readonly target: string;
	readonly base_permissions: IntegerText;
	readonly external_permissions: IntegerText;
};

export const aclsOfPrincipal: Statement<[string, Buffer | null, string[] | null], ACLColumns> = statement('acls_of_principal', `
	SELECT principal.public_key AS principal, acls.certificate, entity.public_key AS entity,
		target.public_key AS target, acls.base_permissions, acls.external_permissions
	FROM acls
	JOIN accounts principal ON principal.id = acls.principal_id
	JOIN accounts entity ON entity.id = acls.entity_id
	JOIN accounts target ON target.id = acls.target_id
	WHERE principal.public_key = $1
		AND acls.certificate IS NOT DISTINCT FROM $2::bytea
		AND ($3::text[] IS NULL OR entity.public_key = ANY($3::text[]))
	ORDER BY entity.public_key, target.public_key`);

export const mainBlock: Statement<[Buffer], { bytes: Buffer }> = statement('main_block', 'SELECT bytes FROM blocks WHERE hash = $1 AND ledger = \'main\'');

// A side vote counts until it has expired at the transaction's moment (D4).
const UNEXPIRED_SIDE_VOTE = '(votes.ledger = \'side\' AND (votes.permanent OR votes.validity_to >= $2))';

export const sideBlock: Statement<[Buffer, Date], { bytes: Buffer }> = statement('side_block', `
	SELECT blocks.bytes FROM blocks
	WHERE blocks.hash = $1 AND blocks.ledger = 'side' AND EXISTS (
		SELECT 1 FROM vote_blocks JOIN votes ON votes.id = vote_blocks.vote_id
		WHERE vote_blocks.block_hash = blocks.hash AND ${UNEXPIRED_SIDE_VOTE})`);

export const mainBlockHeight: Statement<[Buffer, string], { height: IntegerText }> = statement('main_block_height', `
	SELECT chain.height FROM chain JOIN accounts ON accounts.id = chain.account_id
	WHERE chain.block_hash = $1 AND accounts.public_key = $2`);

export const headsOf: Statement<[string[]], { public_key: string; bytes: Buffer }> = statement('heads_of', `
	SELECT accounts.public_key, blocks.bytes
	FROM accounts
	JOIN heads ON heads.account_id = accounts.id
	JOIN blocks ON blocks.hash = heads.block_hash
	WHERE accounts.public_key = ANY($1::text[])`);

export const mainSuccessor: Statement<[Buffer], { bytes: Buffer }> = statement('main_successor', 'SELECT bytes FROM blocks WHERE previous = $1 AND ledger = \'main\'');

/*
 * Of the pending successors, the one named by the most recently issued vote,
 * with the greater hash breaking ties, so the answer never depends on row
 * order.
 */
export const sideSuccessor: Statement<[Buffer, Date], { bytes: Buffer }> = statement('side_successor', `
	SELECT blocks.bytes
	FROM blocks
	JOIN vote_blocks ON vote_blocks.block_hash = blocks.hash
	JOIN votes ON votes.id = vote_blocks.vote_id
	WHERE blocks.previous = $1 AND blocks.ledger = 'side' AND ${UNEXPIRED_SIDE_VOTE}
	ORDER BY votes.validity_from DESC, blocks.hash DESC
	LIMIT 1`);

export type VoteColumns = { readonly bytes: Buffer; readonly validity_from: Date };

export const mainVotesOfBlock: Statement<[Buffer], VoteColumns> = statement('main_votes_of_block', `
	SELECT votes.bytes, votes.validity_from
	FROM blocks JOIN votes ON votes.blocks_hash = blocks.staple AND votes.ledger = 'main'
	WHERE blocks.hash = $1 AND blocks.ledger = 'main'
	ORDER BY votes.id`);

export const sideVotesOfBlock: Statement<[Buffer, Date], VoteColumns> = statement('side_votes_of_block', `
	SELECT votes.bytes, votes.validity_from
	FROM vote_blocks JOIN votes ON votes.id = vote_blocks.vote_id
	WHERE vote_blocks.block_hash = $1 AND ${UNEXPIRED_SIDE_VOTE}
	ORDER BY votes.id`);

export const deferredStaplesWaitingOn: Statement<[Buffer[]], { bytes: Buffer; latest_vote_from: Date }> = statement('deferred_staples_waiting_on', `
	SELECT deferred_staples.bytes, deferred_staples.latest_vote_from
	FROM deferred_staples
	WHERE deferred_staples.blocks_hash IN (
		SELECT deferred_waits.blocks_hash FROM deferred_waits WHERE deferred_waits.block_hash = ANY($1::bytea[]))
	ORDER BY deferred_staples.blocks_hash`);

export const deleteDeferredStaple: Statement<[Buffer]> = statement('delete_deferred_staple', 'DELETE FROM deferred_staples WHERE blocks_hash = $1');

export const mainIdempotentKeys: Statement<[Buffer[]], { key: Buffer; block_hash: Buffer }> = statement('main_idempotent_keys', `
	SELECT key, block_hash FROM idempotent_keys WHERE ledger = 'main' AND key = ANY($1::bytea[])`);

export const mainBlocksOrSuccessors: Statement<[Buffer[], Buffer[]], { hash: Buffer; previous: Buffer }> = statement('main_blocks_or_successors', `
	SELECT hash, previous FROM blocks
	WHERE ledger = 'main' AND (hash = ANY($1::bytea[]) OR previous = ANY($2::bytea[]))`);

export const insertStaple: Statement<[Buffer, Date, Date]> = statement('insert_staple', `
	INSERT INTO staples (blocks_hash, staple_time, moment) VALUES ($1, $2, $3)`);

// A side copy of a block becomes the main block in place; a main block is never replaced.
export const insertMainBlocks: Statement<[Buffer[], AccountID[], Buffer[], number[], Buffer[], number[], Buffer], { hash: Buffer }> = statement('insert_main_blocks', `
	INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes, staple, staple_position)
	SELECT block.hash, 'main', block.account_id, block.previous, block.operation_count, block.bytes, $7, block.position
	FROM unnest($1::bytea[], $2::bigint[], $3::bytea[], $4::integer[], $5::bytea[], $6::integer[])
		AS block (hash, account_id, previous, operation_count, bytes, position)
	ORDER BY block.position
	ON CONFLICT (hash) DO UPDATE SET ledger = 'main', staple = EXCLUDED.staple, staple_position = EXCLUDED.staple_position
	WHERE blocks.ledger = 'side'
	RETURNING hash`);

export const insertChain: Statement<[AccountID[], string[], Buffer[]]> = statement('insert_chain', `
	INSERT INTO chain (account_id, height, block_hash)
	SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bytea[])`);

export const raiseHeads: Statement<[AccountID[], Buffer[], string[]]> = statement('raise_heads', `
	INSERT INTO heads (account_id, block_hash, height)
	SELECT * FROM unnest($1::bigint[], $2::bytea[], $3::bigint[])
	ON CONFLICT (account_id) DO UPDATE SET block_hash = EXCLUDED.block_hash, height = EXCLUDED.height
	WHERE heads.height < EXCLUDED.height`);

export const deleteSideVotes: Statement<[string[]]> = statement('delete_side_votes', 'DELETE FROM votes WHERE ledger = \'side\' AND uid = ANY($1::text[])');

export const deleteSideIdempotentKeys: Statement<[Buffer[]]> = statement('delete_side_idempotent_keys', `
	DELETE FROM idempotent_keys WHERE ledger = 'side' AND block_hash = ANY($1::bytea[])`);

export const insertMainVotes: Statement<[Buffer, string[], AccountID[], Date[], Date[], boolean[], Buffer[]]> = statement('insert_main_votes', `
	INSERT INTO votes (ledger, uid, blocks_hash, issuer_id, validity_from, validity_to, permanent, bytes)
	SELECT 'main', vote.uid, $1, vote.issuer_id, vote.validity_from, vote.validity_to, vote.permanent, vote.bytes
	FROM unnest($2::text[], $3::bigint[], $4::timestamptz[], $5::timestamptz[], $6::boolean[], $7::bytea[])
		WITH ORDINALITY AS vote (uid, issuer_id, validity_from, validity_to, permanent, bytes, position)
	ORDER BY vote.position`);

export const addBalances: Statement<[AccountID[], AccountID[], string[]]> = statement('add_balances', `
	INSERT INTO balances (account_id, token_id, balance)
	SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::numeric[])
	ON CONFLICT (account_id, token_id) DO UPDATE SET balance = balances.balance + EXCLUDED.balance`);

export const addSupplies: Statement<[AccountID[], string[]]> = statement('add_supplies', `
	INSERT INTO supplies (token_id, supply)
	SELECT * FROM unnest($1::bigint[], $2::numeric[])
	ON CONFLICT (token_id) DO UPDATE SET supply = supplies.supply + EXCLUDED.supply`);

export const addWeights: Statement<[AccountID[], string[]]> = statement('add_weights', `
	INSERT INTO weights (representative_id, weight)
	SELECT * FROM unnest($1::bigint[], $2::numeric[])
	ON CONFLICT (representative_id) DO UPDATE SET weight = weights.weight + EXCLUDED.weight`);

export const setDelegations: Statement<[AccountID[], AccountID[]]> = statement('set_delegations', `
	INSERT INTO delegations (account_id, representative_id)
	SELECT * FROM unnest($1::bigint[], $2::bigint[])
	ON CONFLICT (account_id) DO UPDATE SET representative_id = EXCLUDED.representative_id`);

export const deleteACL: Statement<[AccountID, Buffer | null, AccountID, AccountID]> = statement('delete_acl', `
	DELETE FROM acls
	WHERE principal_id = $1 AND certificate IS NOT DISTINCT FROM $2::bytea AND entity_id = $3 AND target_id = $4`);

export const setACL: Statement<[AccountID, Buffer | null, AccountID, AccountID, string, string]> = statement('set_acl', `
	INSERT INTO acls (principal_id, certificate, entity_id, target_id, base_permissions, external_permissions)
	VALUES ($1, $2, $3, $4, $5, $6)
	ON CONFLICT ON CONSTRAINT acls_scope DO UPDATE
	SET base_permissions = EXCLUDED.base_permissions, external_permissions = EXCLUDED.external_permissions`);

// A field the update lacks is null here and keeps the stored value (D11); only the quorum can be cleared.
export const mergeAccountInfo: Statement<[AccountID, string | null, string | null, string | null, string | null, string | null, string | null, boolean]> = statement('merge_account_info', `
	INSERT INTO account_info (account_id, name, description, metadata, default_base_permission, default_external_permission, multisig_quorum)
	VALUES ($1, $2, $3, $4, $5, $6, $7)
	ON CONFLICT (account_id) DO UPDATE SET
		name = COALESCE(EXCLUDED.name, account_info.name),
		description = COALESCE(EXCLUDED.description, account_info.description),
		metadata = COALESCE(EXCLUDED.metadata, account_info.metadata),
		default_base_permission = COALESCE(EXCLUDED.default_base_permission, account_info.default_base_permission),
		default_external_permission = COALESCE(EXCLUDED.default_external_permission, account_info.default_external_permission),
		multisig_quorum = CASE WHEN $8 THEN EXCLUDED.multisig_quorum ELSE account_info.multisig_quorum END`);

export const addCertificate: Statement<[AccountID, Buffer, Buffer, Buffer | null]> = statement('add_certificate', `
	INSERT INTO certificates (account_id, hash, certificate, intermediates) VALUES ($1, $2, $3, $4)
	ON CONFLICT (account_id, hash) DO UPDATE SET certificate = EXCLUDED.certificate, intermediates = EXCLUDED.intermediates`);

export const removeCertificate: Statement<[AccountID, Buffer]> = statement('remove_certificate', 'DELETE FROM certificates WHERE account_id = $1 AND hash = $2');

export const insertMainIdempotentKeys: Statement<[Buffer[], Buffer[]]> = statement('insert_main_idempotent_keys', `
	INSERT INTO idempotent_keys (key, ledger, block_hash)
	SELECT claim.key, 'main', claim.block_hash FROM unnest($1::bytea[], $2::bytea[]) AS claim (key, block_hash)`);

export const markInvolved: Statement<[AccountID[], Buffer]> = statement('mark_involved', `
	UPDATE accounts SET first_staple = $2 WHERE id = ANY($1::bigint[]) AND first_staple IS NULL`);

export const appendHistory: Statement<[AccountID[], Buffer, Date]> = statement('append_history', `
	INSERT INTO history (account_id, blocks_hash, staple_time)
	SELECT account_id, $2, $3 FROM unnest($1::bigint[]) AS involved (account_id)`);
