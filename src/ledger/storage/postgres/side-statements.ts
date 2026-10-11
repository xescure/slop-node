import { statement } from './sql.js';
import type { AccountID, IntegerText, Statement, VoteColumns } from './sql.js';

/**
 * A side vote counts until it has expired at the transaction's moment, whose
 * expiry bound, already moved back by the slop, is the given parameter (D4).
 */
function unexpiredSideVote(since: `$${number}`): string {
	return(`(votes.ledger = 'side' AND (votes.permanent OR votes.validity_to >= ${since}::timestamptz))`);
}

export const sideBlock: Statement<[Buffer, Date], { bytes: Buffer }> = statement('side_block', `
	SELECT blocks.bytes FROM blocks
	WHERE blocks.hash = $1 AND blocks.ledger = 'side' AND EXISTS (
		SELECT 1 FROM vote_blocks JOIN votes ON votes.id = vote_blocks.vote_id
		WHERE vote_blocks.block_hash = blocks.hash AND ${unexpiredSideVote('$2')})`);

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
	WHERE blocks.previous = $1 AND blocks.ledger = 'side' AND ${unexpiredSideVote('$2')}
	ORDER BY votes.validity_from DESC, blocks.hash DESC
	LIMIT 1`);

export const sideVotesOfBlock: Statement<[Buffer, Date], VoteColumns> = statement('side_votes_of_block', `
	SELECT votes.bytes, votes.validity_from, votes.permanent
	FROM vote_blocks JOIN votes ON votes.id = vote_blocks.vote_id
	WHERE vote_blocks.block_hash = $1 AND ${unexpiredSideVote('$2')}
	ORDER BY votes.id`);

/*
 * The unexpired side votes covering a block whose previous is listed, from
 * one issuer when $3 is set. A covered block may have moved to main since:
 * the vote still guards its previous.
 */
export const sideVotesOfPrevious: Statement<[Buffer[], Date, string | null], VoteColumns & { previous: Buffer; id: IntegerText }> = statement('side_votes_of_previous', `
	SELECT DISTINCT covered.previous, votes.id, votes.bytes, votes.validity_from, votes.permanent
	FROM blocks covered
	JOIN vote_blocks ON vote_blocks.block_hash = covered.hash
	JOIN votes ON votes.id = vote_blocks.vote_id
	JOIN accounts issuer ON issuer.id = votes.issuer_id
	WHERE covered.previous = ANY($1::bytea[]) AND ${unexpiredSideVote('$2')}
		AND ($3::text IS NULL OR issuer.public_key = $3::text)
	ORDER BY votes.id`);

export const sideStapleVotes: Statement<[Buffer[], Date], VoteColumns & { id: IntegerText; blocks_hash: Buffer }> = statement('side_staple_votes', `
	SELECT votes.id, votes.blocks_hash, votes.bytes, votes.validity_from, votes.permanent
	FROM votes
	WHERE votes.blocks_hash = ANY($1::bytea[]) AND ${unexpiredSideVote('$2')}
	ORDER BY votes.id`);

export const sideVoteBlocks: Statement<[IntegerText[]], { vote_id: IntegerText; bytes: Buffer }> = statement('side_vote_blocks', `
	SELECT vote_blocks.vote_id, blocks.bytes
	FROM vote_blocks JOIN blocks ON blocks.hash = vote_blocks.block_hash
	WHERE vote_blocks.vote_id = ANY($1::bigint[])
	ORDER BY vote_blocks.vote_id, vote_blocks.position`);

/*
 * A side block holds its key only while an unexpired side vote covers it;
 * of several such blocks, the lowest hash answers, so the answer never
 * depends on row order.
 */
export const sideIdempotentHolder: Statement<[Buffer, Date, Buffer | null], { block_hash: Buffer }> = statement('side_idempotent_holder', `
	SELECT claims.block_hash
	FROM idempotent_keys claims
	JOIN blocks ON blocks.hash = claims.block_hash AND blocks.ledger = 'side'
	WHERE claims.ledger = 'side' AND claims.key = $1 AND claims.block_hash IS DISTINCT FROM $3::bytea
		AND EXISTS (
			SELECT 1 FROM vote_blocks JOIN votes ON votes.id = vote_blocks.vote_id
			WHERE vote_blocks.block_hash = claims.block_hash AND ${unexpiredSideVote('$2')})
	ORDER BY claims.block_hash
	LIMIT 1`);

export const deleteSideVotes: Statement<[string[]]> = statement('delete_side_votes', 'DELETE FROM votes WHERE ledger = \'side\' AND uid = ANY($1::text[])');

// A block already stored, on either ledger, keeps its row: main answers for a main block.
export const insertSideBlocks: Statement<[Buffer[], AccountID[], Buffer[], number[], Buffer[]]> = statement('insert_side_blocks', `
	INSERT INTO blocks (hash, ledger, account_id, previous, operation_count, bytes)
	SELECT block.hash, 'side', block.account_id, block.previous, block.operation_count, block.bytes
	FROM unnest($1::bytea[], $2::bigint[], $3::bytea[], $4::integer[], $5::bytea[])
		AS block (hash, account_id, previous, operation_count, bytes)
	ON CONFLICT (hash) DO NOTHING`);

// Only a side copy claims its key on the side; a main block already holds it on main.
export const insertSideIdempotentKeys: Statement<[Buffer[], Buffer[]]> = statement('insert_side_idempotent_keys', `
	INSERT INTO idempotent_keys (key, ledger, block_hash)
	SELECT claim.key, 'side', claim.block_hash
	FROM unnest($1::bytea[], $2::bytea[]) AS claim (key, block_hash)
	JOIN blocks ON blocks.hash = claim.block_hash AND blocks.ledger = 'side'
	ON CONFLICT DO NOTHING`);

export const insertSideVote: Statement<[string, Buffer, AccountID, Date, Date, boolean, Buffer], { id: IntegerText }> = statement('insert_side_vote', `
	INSERT INTO votes (ledger, uid, blocks_hash, issuer_id, validity_from, validity_to, permanent, bytes)
	VALUES ('side', $1, $2, $3, $4, $5, $6, $7)
	RETURNING id`);

export const insertVoteBlocks: Statement<[IntegerText, Buffer[]]> = statement('insert_vote_blocks', `
	INSERT INTO vote_blocks (vote_id, position, block_hash)
	SELECT $1, covered.position - 1, covered.block_hash
	FROM unnest($2::bytea[]) WITH ORDINALITY AS covered (block_hash, position)`);

/*
 * Obsolete side votes (D6): expired at the transaction's moment, whose
 * expiry bound, moved back by the slop, is $1 (D4), or covering a block whose
 * previous has a confirmed successor, which is that block or a competitor.
 */
export const obsoleteSideVotes: Statement<[Date, number], { id: IntegerText }> = statement('obsolete_side_votes', `
	SELECT votes.id
	FROM votes
	WHERE votes.ledger = 'side' AND (
		NOT ${unexpiredSideVote('$1')}
		OR EXISTS (
			SELECT 1 FROM vote_blocks
			JOIN blocks covered ON covered.hash = vote_blocks.block_hash
			JOIN blocks successor ON successor.previous = covered.previous AND successor.ledger = 'main'
			WHERE vote_blocks.vote_id = votes.id))
	ORDER BY votes.id
	LIMIT $2`);

// The covered blocks are read before the votes, and with them their block lists, are deleted.
export const removeSideVotes: Statement<[IntegerText[]], { block_hash: Buffer }> = statement('remove_side_votes', `
	WITH covered AS (
		SELECT DISTINCT block_hash FROM vote_blocks WHERE vote_id = ANY($1::bigint[])
	), removed AS (
		DELETE FROM votes WHERE ledger = 'side' AND id = ANY($1::bigint[])
	)
	SELECT block_hash FROM covered`);

// Side claims exist only for side copies, which only side votes keep.
export const deleteUncoveredSideIdempotentKeys: Statement<[Buffer[]]> = statement('delete_uncovered_side_idempotent_keys', `
	DELETE FROM idempotent_keys
	WHERE ledger = 'side' AND block_hash = ANY($1::bytea[])
		AND NOT EXISTS (SELECT 1 FROM vote_blocks WHERE vote_blocks.block_hash = idempotent_keys.block_hash)`);

export const deleteUncoveredSideBlocks: Statement<[Buffer[]]> = statement('delete_uncovered_side_blocks', `
	DELETE FROM blocks
	WHERE ledger = 'side' AND hash = ANY($1::bytea[])
		AND NOT EXISTS (SELECT 1 FROM vote_blocks WHERE vote_blocks.block_hash = blocks.hash)`);

/*
 * Side rows that no side vote accounts for. A vote's block list outlives
 * the side copy of a block, so a block is covered by any row of vote_blocks;
 * a side claim needs a side copy that is covered.
 */
export const orphanedSideRows: Statement<[], { orphaned: IntegerText }> = statement('orphaned_side_rows', `
	SELECT (
		(SELECT count(*) FROM blocks
			WHERE blocks.ledger = 'side'
				AND NOT EXISTS (SELECT 1 FROM vote_blocks WHERE vote_blocks.block_hash = blocks.hash))
		+ (SELECT count(*) FROM idempotent_keys claims
			WHERE claims.ledger = 'side'
				AND NOT EXISTS (
					SELECT 1 FROM blocks JOIN vote_blocks ON vote_blocks.block_hash = blocks.hash
					WHERE blocks.hash = claims.block_hash AND blocks.ledger = 'side'))
	) AS orphaned`);

export type DeferredStapleColumns = {
	readonly blocks_hash: Buffer;
	readonly bytes: Buffer;
	readonly latest_vote_from: Date;
};

export const insertDeferredStaple: Statement<[Buffer, Buffer, Date]> = statement('insert_deferred_staple', `
	INSERT INTO deferred_staples (blocks_hash, bytes, latest_vote_from) VALUES ($1, $2, $3)`);

export const insertDeferredWaits: Statement<[Buffer, Buffer[]]> = statement('insert_deferred_waits', `
	INSERT INTO deferred_waits (block_hash, blocks_hash)
	SELECT DISTINCT waited.block_hash, $1::bytea FROM unnest($2::bytea[]) AS waited (block_hash)`);

export const insertDeferredBlocks: Statement<[Buffer, Buffer[]]> = statement('insert_deferred_blocks', `
	INSERT INTO deferred_blocks (blocks_hash, previous)
	SELECT DISTINCT $1::bytea, block.previous FROM unnest($2::bytea[]) AS block (previous)`);

export const deferredStaplesWaitingOn: Statement<[Buffer[]], DeferredStapleColumns> = statement('deferred_staples_waiting_on', `
	SELECT deferred_staples.blocks_hash, deferred_staples.bytes, deferred_staples.latest_vote_from
	FROM deferred_staples
	WHERE deferred_staples.blocks_hash IN (
		SELECT deferred_waits.blocks_hash FROM deferred_waits WHERE deferred_waits.block_hash = ANY($1::bytea[]))
	ORDER BY deferred_staples.blocks_hash`);

/*
 * A deferred staple dead when it is deferred is listed for gc then; one that
 * dies or is released later is listed by the confirmed write that does it
 * (listReadyDeferredStaples).
 */
export const listDeadDeferredStaple: Statement<[Buffer]> = statement('list_dead_deferred_staple', `
	INSERT INTO deferred_checks (blocks_hash)
	SELECT $1::bytea
	WHERE EXISTS (
		SELECT 1 FROM deferred_blocks
		JOIN blocks successor ON successor.previous = deferred_blocks.previous AND successor.ledger = 'main'
		WHERE deferred_blocks.blocks_hash = $1::bytea)`);

/*
 * Lists for gc the deferred staples that blocks just written to main release
 * ($1, their hashes) or kill ($2, their previous blocks). Neither state ever
 * ends, and only such a write begins one, so every released or dead staple is
 * listed. A deferral or write running beside this one that would change what
 * it lists reads or writes the same rows, which serializable isolation
 * orders.
 */
export const listReadyDeferredStaples: Statement<[Buffer[], Buffer[]]> = statement('list_ready_deferred_staples', `
	INSERT INTO deferred_checks (blocks_hash)
	SELECT waits.blocks_hash FROM deferred_waits waits
	WHERE waits.block_hash = ANY($1::bytea[])
		AND NOT EXISTS (
			SELECT 1 FROM deferred_waits other
			WHERE other.blocks_hash = waits.blocks_hash
				AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.hash = other.block_hash AND blocks.ledger = 'main'))
	UNION
	SELECT deferred_blocks.blocks_hash FROM deferred_blocks WHERE deferred_blocks.previous = ANY($2::bytea[])
	ON CONFLICT (blocks_hash) DO NOTHING`);

/*
 * gc reads only the listed staples. The listing is chosen and limited before
 * the staples are joined, so the plan cannot reach the deferred staples that
 * are not listed, whatever the planner estimates of the tables.
 */

// A deferred staple can never apply once the previous of any of its blocks has a confirmed successor (D6, D20).
/*
 * Deferred staples voted before $1 that await a block not on main, each with
 * those blocks, by their latest votes from after ($3, $4): chosen and limited
 * in the order of deferred_staples_latest_vote before their bytes and waits
 * are read, so the read costs the page, not the deferred backlog. A staple
 * whose awaited blocks are all on main is gc's to apply.
 */
export const strandedDeferredStaples: Statement<[Date, number, Date, Buffer], { readonly bytes: Buffer; readonly latest_vote_from: Date; readonly lacks: readonly Buffer[] }> = statement('stranded_deferred_staples', `
	WITH chosen AS (
		SELECT deferred_staples.blocks_hash, deferred_staples.latest_vote_from
		FROM deferred_staples
		WHERE deferred_staples.latest_vote_from < $1
			AND (deferred_staples.latest_vote_from, deferred_staples.blocks_hash) > ($3::timestamptz_ms, $4::hash32)
			-- OFFSET 0 keeps the test per staple, run in index order until the page is full, where a join would read every wait first.
			AND EXISTS (
				SELECT 1 FROM deferred_waits
				WHERE deferred_waits.blocks_hash = deferred_staples.blocks_hash
					AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.hash = deferred_waits.block_hash AND blocks.ledger = 'main')
				OFFSET 0)
		ORDER BY deferred_staples.latest_vote_from, deferred_staples.blocks_hash
		LIMIT $2
	)
	SELECT (SELECT deferred_staples.bytes FROM deferred_staples WHERE deferred_staples.blocks_hash = chosen.blocks_hash) AS bytes, chosen.latest_vote_from, ARRAY(
		SELECT deferred_waits.block_hash::bytea FROM deferred_waits
		WHERE deferred_waits.blocks_hash = chosen.blocks_hash
			AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.hash = deferred_waits.block_hash AND blocks.ledger = 'main')
		ORDER BY deferred_waits.block_hash
	) AS lacks
	FROM chosen
	ORDER BY chosen.latest_vote_from, chosen.blocks_hash`);

export const deadDeferredStaples: Statement<[number], DeferredStapleColumns> = statement('dead_deferred_staples', `
	SELECT deferred_staples.blocks_hash, deferred_staples.bytes, deferred_staples.latest_vote_from
	FROM deferred_staples
	WHERE deferred_staples.blocks_hash IN (
		SELECT deferred_checks.blocks_hash FROM deferred_checks
		WHERE EXISTS (
			SELECT 1 FROM deferred_blocks
			JOIN blocks successor ON successor.previous = deferred_blocks.previous AND successor.ledger = 'main'
			WHERE deferred_blocks.blocks_hash = deferred_checks.blocks_hash)
		ORDER BY deferred_checks.blocks_hash
		LIMIT $1)
	ORDER BY deferred_staples.blocks_hash`);

// Deferred staples, other than those in $2, whose every awaited block is on main.
export const releasedDeferredStaples: Statement<[number, Buffer[]], DeferredStapleColumns> = statement('released_deferred_staples', `
	SELECT deferred_staples.blocks_hash, deferred_staples.bytes, deferred_staples.latest_vote_from
	FROM deferred_staples
	WHERE deferred_staples.blocks_hash IN (
		SELECT deferred_checks.blocks_hash FROM deferred_checks
		WHERE deferred_checks.blocks_hash <> ALL($2::bytea[])
			AND NOT EXISTS (
				SELECT 1 FROM deferred_waits
				WHERE deferred_waits.blocks_hash = deferred_checks.blocks_hash
					AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.hash = deferred_waits.block_hash AND blocks.ledger = 'main'))
		ORDER BY deferred_checks.blocks_hash
		LIMIT $1)
	ORDER BY deferred_staples.blocks_hash`);

// Each staple's waits and recorded previous blocks are deleted with it.
export const deleteDeferredStaples: Statement<[Buffer[]]> = statement('delete_deferred_staples', 'DELETE FROM deferred_staples WHERE blocks_hash = ANY($1::bytea[])');
