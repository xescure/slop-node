-- Schema version 12: each main block's decoded header and operations, in
-- tables of their own.
--
-- A staple's blocks are kept as the bytes they came as. block_details holds a
-- block's header, and operations one row per operation, with the accounts and
-- the token it names, the amount it moves and the rest of its fields as json,
-- so that the operations of an account, against a counterparty or on a token
-- are read by their time without decoding blocks. They are written with the
-- staple (schema/CONTRACT.md, persistConfirmedStaple) and have no foreign
-- keys: a heavy block has hundreds of operations, and checking each would lock
-- the rows of the accounts it names.
CREATE TABLE block_details (
	hash hash32 PRIMARY KEY,
	date timestamptz_ms NOT NULL,
	version smallint NOT NULL,
	purpose smallint NOT NULL,
	signer_id bigint NOT NULL
);

CREATE TABLE operations (
	block_hash hash32 NOT NULL,
	idx integer NOT NULL,
	type smallint NOT NULL,
	account_id bigint NOT NULL,
	counterparty_id bigint,
	token_id bigint,
	amount amount,
	staple_time timestamptz_ms NOT NULL,
	details jsonb NOT NULL,
	PRIMARY KEY (block_hash, idx)
);

CREATE INDEX operations_account_time ON operations (account_id, staple_time DESC);
CREATE INDEX operations_counterparty_time ON operations (counterparty_id, staple_time DESC) WHERE counterparty_id IS NOT NULL;
CREATE INDEX operations_token_time ON operations (token_id, staple_time DESC) WHERE token_id IS NOT NULL;

-- complete_from is the lowest staple sequence from which every main staple has
-- its rows. The migration records the cutover, as the staples written before
-- it have none; only a backfill of them lowers it, so applying a staple never
-- touches this row. A staple an older build stores beside this one, after the
-- cutover, has no rows either; swept_through is the highest sequence up to
-- which a backfill has looked for such staples, or null before one has.
CREATE TABLE projection_backfill (
	singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
	complete_from bigint NOT NULL,
	swept_through bigint
);

INSERT INTO projection_backfill (complete_from)
SELECT coalesce((SELECT max(sequence) FROM staples), 0) + 1;

-- The holders of a token, largest first.
CREATE INDEX balances_token_holders ON balances (token_id, balance DESC) WHERE balance <> 0;
