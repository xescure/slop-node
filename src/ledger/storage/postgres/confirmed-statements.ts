import { statement } from './sql.js';
import type { AccountID, IntegerText, Statement, VoteColumns } from './sql.js';

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

// $2 selects certificate principals when true, account principals when false, and both when null.
export const aclsOfEntity: Statement<[string, boolean | null], ACLColumns> = statement('acls_of_entity', `
	SELECT principal.public_key AS principal, acls.certificate, entity.public_key AS entity,
		target.public_key AS target, acls.base_permissions, acls.external_permissions
	FROM acls
	JOIN accounts principal ON principal.id = acls.principal_id
	JOIN accounts entity ON entity.id = acls.entity_id
	JOIN accounts target ON target.id = acls.target_id
	WHERE entity.public_key = $1
		AND ($2::boolean IS NULL OR (acls.certificate IS NOT NULL) = $2::boolean)
	ORDER BY principal.public_key, acls.certificate NULLS FIRST, target.public_key`);

/*
 * Bit 1 of a base set is OWNER, read in two's complement as upstream's bit
 * field reads a bigint [Keeta TS] index.js:74864-74866, 77717-77719. A decoded
 * set holding OWNER also holds ACCESS, so has(['OWNER']) is that bit alone
 * [Keeta TS] index.js:75179-75193, 75299-75311. Dividing by two with floor
 * shifts a negative set as well, and the truncating remainder of an odd
 * quotient is 1 or -1, never 0.
 */
export const ownersOf: Statement<[string, string | null], { principal: string }> = statement('owners_of', `
	SELECT DISTINCT principal.public_key AS principal
	FROM acls
	JOIN accounts principal ON principal.id = acls.principal_id
	JOIN accounts entity ON entity.id = acls.entity_id
	JOIN accounts target ON target.id = acls.target_id
	WHERE entity.public_key = $1
		AND acls.certificate IS NULL
		AND ($2::text IS NULL OR target.public_key = $2::text)
		AND mod(floor(acls.base_permissions / 2), 2) <> 0
	ORDER BY principal.public_key`);

export type CertificateColumns = {
	readonly certificate: Buffer;
	readonly intermediates: Buffer | null;
};

export const certificatesOf: Statement<[string], CertificateColumns> = statement('certificates_of', `
	SELECT certificates.certificate, certificates.intermediates
	FROM certificates JOIN accounts ON accounts.id = certificates.account_id
	WHERE accounts.public_key = $1
	ORDER BY certificates.hash`);

export const certificateOf: Statement<[string, Buffer], CertificateColumns> = statement('certificate_of', `
	SELECT certificates.certificate, certificates.intermediates
	FROM certificates JOIN accounts ON accounts.id = certificates.account_id
	WHERE accounts.public_key = $1 AND certificates.hash = $2`);

export const mainBlock: Statement<[Buffer], { bytes: Buffer }> = statement('main_block', 'SELECT bytes FROM blocks WHERE hash = $1 AND ledger = \'main\'');

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

export const mainVotesOfBlock: Statement<[Buffer], VoteColumns> = statement('main_votes_of_block', `
	SELECT votes.bytes, votes.validity_from, votes.permanent
	FROM blocks JOIN votes ON votes.blocks_hash = blocks.staple AND votes.ledger = 'main'
	WHERE blocks.hash = $1 AND blocks.ledger = 'main'
	ORDER BY votes.id`);

/** The votes of the staple holding each previous's confirmed successor, from one issuer when $2 is set. */
export const mainSuccessorVotes: Statement<[Buffer[], string | null], VoteColumns & { previous: Buffer }> = statement('main_successor_votes', `
	SELECT successor.previous, votes.bytes, votes.validity_from, votes.permanent
	FROM blocks successor
	JOIN votes ON votes.blocks_hash = successor.staple AND votes.ledger = 'main'
	JOIN accounts issuer ON issuer.id = votes.issuer_id
	WHERE successor.ledger = 'main' AND successor.previous = ANY($1::bytea[])
		AND ($2::text IS NULL OR issuer.public_key = $2::text)
	ORDER BY votes.id`);

/** The bytes each staple was received as, NULL for one stored before they were kept. */
export const mainStapleBytes: Statement<[Buffer[]], { blocks_hash: Buffer; bytes: Buffer | null }> = statement('main_staple_bytes', `
	SELECT blocks_hash, bytes FROM staples WHERE blocks_hash = ANY($1::bytea[])`);

/** The staple holding each main block, the blocks named by no main row left out. */
export const mainBlockStaples: Statement<[Buffer[]], { hash: Buffer; staple: Buffer }> = statement('main_block_staples', `
	SELECT hash, staple FROM blocks WHERE ledger = 'main' AND hash = ANY($1::bytea[])`);

export const mainStapleBlocks: Statement<[Buffer[]], { staple: Buffer; bytes: Buffer }> = statement('main_staple_blocks', `
	SELECT staple, bytes FROM blocks
	WHERE ledger = 'main' AND staple = ANY($1::bytea[])
	ORDER BY staple, staple_position`);

// Votes were inserted in staple order, so their IDs keep it.
export const mainStapleVotes: Statement<[Buffer[]], VoteColumns & { blocks_hash: Buffer }> = statement('main_staple_votes', `
	SELECT blocks_hash, bytes, validity_from, permanent FROM votes
	WHERE ledger = 'main' AND blocks_hash = ANY($1::bytea[])
	ORDER BY id`);

/*
 * History is listed newest first by (staple time, blocks hash). A page after
 * a start continues below the start's own key, by row comparison against a
 * value computed once, so the index range starts there. The start's time is
 * its staple's, and the start must be listed in the same history under that
 * whole key, which history_pkey finds without reading the account's other
 * rows: a start that is not listed there leaves the time null, the comparison
 * is then never true, and the page is empty (D8).
 */
export const accountHistory: Statement<[string, number], { blocks_hash: Buffer }> = statement('account_history', `
	SELECT history.blocks_hash
	FROM history
	WHERE history.account_id = (SELECT id FROM accounts WHERE public_key = $1)
	ORDER BY history.staple_time DESC, history.blocks_hash DESC
	LIMIT $2`);

export const accountHistoryAfter: Statement<[string, Buffer, number], { blocks_hash: Buffer }> = statement('account_history_after', `
	SELECT history.blocks_hash
	FROM history
	WHERE history.account_id = (SELECT id FROM accounts WHERE public_key = $1)
		AND (history.staple_time, history.blocks_hash) < (
			(SELECT start.staple_time FROM history start
				WHERE start.account_id = (SELECT id FROM accounts WHERE public_key = $1)
					AND start.staple_time = (SELECT staples.staple_time FROM staples WHERE staples.blocks_hash = $2)
					AND start.blocks_hash = $2),
			$2::bytea)
	ORDER BY history.staple_time DESC, history.blocks_hash DESC
	LIMIT $3`);

/** Whether the staple is an entry of the account's history, under its whole key, which history_pkey finds. */
export const accountHistoryLists: Statement<[string, Buffer], { listed: boolean }> = statement('account_history_lists', `
	SELECT EXISTS (
		SELECT 1 FROM history start
		WHERE start.account_id = (SELECT id FROM accounts WHERE public_key = $1)
			AND start.staple_time = (SELECT staples.staple_time FROM staples WHERE staples.blocks_hash = $2)
			AND start.blocks_hash = $2
	) AS listed`);

export const allHistory: Statement<[number], { blocks_hash: Buffer }> = statement('all_history', `
	SELECT blocks_hash FROM staples
	ORDER BY staple_time DESC, blocks_hash DESC
	LIMIT $1`);

export const allHistoryAfter: Statement<[Buffer, number], { blocks_hash: Buffer }> = statement('all_history_after', `
	SELECT blocks_hash FROM staples
	WHERE (staple_time, blocks_hash) < ((SELECT start.staple_time FROM staples start WHERE start.blocks_hash = $1), $1::bytea)
	ORDER BY staple_time DESC, blocks_hash DESC
	LIMIT $2`);

export type CatchUpVoteColumns = VoteColumns & { readonly id: IntegerText };

/** Main votes made at or after $1, in catch-up order (D8), through votes_catch_up. */
export const catchUpVotes: Statement<[Date, number], CatchUpVoteColumns> = statement('catch_up_votes', `
	SELECT id, bytes, validity_from, permanent FROM votes
	WHERE ledger = 'main' AND validity_from >= $1
	ORDER BY validity_from, id
	LIMIT $2`);

/** The same, resuming after the vote at ($2, $3). */
export const catchUpVotesAfter: Statement<[Date, Date, string, number], CatchUpVoteColumns> = statement('catch_up_votes_after', `
	SELECT id, bytes, validity_from, permanent FROM votes
	WHERE ledger = 'main' AND validity_from >= $1 AND (validity_from, id) > ($2::timestamptz, $3::bigint)
	ORDER BY validity_from, id
	LIMIT $4`);

export const mainIdempotentKeys: Statement<[Buffer[]], { key: Buffer; block_hash: Buffer }> = statement('main_idempotent_keys', `
	SELECT key, block_hash FROM idempotent_keys WHERE ledger = 'main' AND key = ANY($1::bytea[])`);

export const mainIdempotentHolder: Statement<[Buffer, Buffer | null], { block_hash: Buffer }> = statement('main_idempotent_holder', `
	SELECT block_hash FROM idempotent_keys
	WHERE ledger = 'main' AND key = $1 AND block_hash IS DISTINCT FROM $2::bytea`);

/*
 * One statement, so one snapshot of the committed main ledger, without a
 * transaction (D19).
 */
export type LedgerCountsColumns = {
	readonly block_count: IntegerText;
	readonly transaction_count: IntegerText;
	readonly representative_count: IntegerText;
};

export const mainLedgerCounts: Statement<[], LedgerCountsColumns> = statement('main_ledger_counts', `
	SELECT
		(SELECT count(*) FROM blocks WHERE ledger = 'main') AS block_count,
		(SELECT COALESCE(sum(operation_count), 0) FROM blocks WHERE ledger = 'main') AS transaction_count,
		(SELECT count(*) FROM weights WHERE weight > 0) AS representative_count`);

/** The ledger checksum's 256 bits, as text, folded from its rows in one statement, so one snapshot (D19). */
export const readLedgerChecksum: Statement<[], { readonly ledger_checksum: string }> = statement('read_ledger_checksum', `
	SELECT bit_xor(checksum)::text AS ledger_checksum FROM ledger_checksum`);

/**
 * Folds a staple's checksum, as 64 hexadecimal digits, into the row of the
 * ledger checksum for the first byte of its blocks hash.
 */
export const foldLedgerChecksum: Statement<[number, string]> = statement('fold_ledger_checksum', `
	UPDATE ledger_checksum SET checksum = checksum # ('x' || $2)::bit(256) WHERE shard = $1`);

export const mainBlocksOrSuccessors: Statement<[Buffer[], Buffer[]], { hash: Buffer; previous: Buffer }> = statement('main_blocks_or_successors', `
	SELECT hash, previous FROM blocks
	WHERE ledger = 'main' AND (hash = ANY($1::bytea[]) OR previous = ANY($2::bytea[]))`);

/** The checksum is given as 64 hexadecimal digits. */
export const insertStaple: Statement<[Buffer, Date, Date, Buffer, string]> = statement('insert_staple', `
	INSERT INTO staples (blocks_hash, staple_time, moment, bytes, checksum) VALUES ($1, $2, $3, $4, ('x' || $5)::bit(256))`);

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

export type ReindexedStaple = { readonly sequence: IntegerText; readonly blocks_hash: Buffer; readonly blocks: Buffer[] };

/** Where a history reindex under a rule reached, as the node's store keeps it (PostgresLedgerStorage.reindexHistory). */
export const historyReindexCursor: Statement<[string, string], { readonly value: unknown }> = statement('history_reindex_cursor', `
	SELECT value FROM kv_entries WHERE arena = $1 AND key = $2`);

export const keepHistoryReindexCursor: Statement<[string, string, string]> = statement('keep_history_reindex_cursor', `
	INSERT INTO kv_entries (arena, key, value) VALUES ($1, $2, $3::json)
	ON CONFLICT (arena, key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL`);

/** The main staples after a sequence number, each with its blocks in staple order. */
export const staplesToReindex: Statement<[string, number], ReindexedStaple> = statement('staples_to_reindex', `
	WITH batch AS (
		SELECT sequence, blocks_hash FROM staples WHERE sequence > $1 ORDER BY sequence LIMIT $2
	)
	SELECT batch.sequence, batch.blocks_hash, array_agg(blocks.bytes ORDER BY blocks.staple_position) AS blocks
	FROM batch JOIN blocks ON blocks.staple = batch.blocks_hash
	GROUP BY batch.sequence, batch.blocks_hash
	ORDER BY batch.sequence`);

/** Removes the history rows of the staples and accounts given in pairs, found by the history's own key. */
export const removeHistoryRows: Statement<[Buffer[], string[]], { removed: IntegerText }> = statement('remove_history_rows', `
	WITH removed AS (
		DELETE FROM history
		USING unnest($1::bytea[], $2::text[]) AS gone (blocks_hash, public_key)
		JOIN accounts ON accounts.public_key = gone.public_key
		JOIN staples ON staples.blocks_hash = gone.blocks_hash
		WHERE history.account_id = accounts.id AND history.staple_time = staples.staple_time AND history.blocks_hash = gone.blocks_hash
		RETURNING 1
	)
	SELECT count(*) AS removed FROM removed`);

/** Adds the history rows of the staples and accounts given in pairs that are missing, under each staple's time; every account a staple touches has a row. */
export const addHistoryRows: Statement<[Buffer[], string[]], { added: IntegerText }> = statement('add_history_rows', `
	WITH added AS (
		INSERT INTO history (account_id, blocks_hash, staple_time)
		SELECT accounts.id, wanted.blocks_hash, staples.staple_time
		FROM unnest($1::bytea[], $2::text[]) AS wanted (blocks_hash, public_key)
		JOIN accounts ON accounts.public_key = wanted.public_key
		JOIN staples ON staples.blocks_hash = wanted.blocks_hash
		ON CONFLICT DO NOTHING
		RETURNING 1
	)
	SELECT count(*) AS added FROM added`);
