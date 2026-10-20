-- Explorer schema version 1: the decoded blocks and operations of the node's
-- staples, and a copy of its balances.
--
-- Account ids are public.accounts.id. No foreign key reaches into public:
-- checking one would lock the node's rows.

CREATE TABLE explorer.progress (
	singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
	watermark bigint NOT NULL DEFAULT 0,
	paused_reason text
);

INSERT INTO explorer.progress DEFAULT VALUES;

CREATE TABLE explorer.indexed_staples (
	blocks_hash bytea PRIMARY KEY,
	sequence bigint NOT NULL,
	staple_time timestamptz NOT NULL,
	block_count integer NOT NULL,
	indexed_at timestamptz NOT NULL
);

CREATE INDEX indexed_staples_sequence ON explorer.indexed_staples (sequence);

CREATE TABLE explorer.blocks (
	hash bytea PRIMARY KEY,
	account_id bigint NOT NULL,
	height bigint NOT NULL,
	date timestamptz NOT NULL,
	version smallint NOT NULL,
	purpose smallint NOT NULL,
	signer_id bigint NOT NULL,
	staple bytea NOT NULL,
	staple_time timestamptz NOT NULL,
	position integer NOT NULL,
	operation_count integer NOT NULL
);

CREATE INDEX blocks_account_height ON explorer.blocks (account_id, height DESC);

CREATE TABLE explorer.operations (
	block_hash bytea NOT NULL,
	idx integer NOT NULL,
	type text NOT NULL,
	account_id bigint NOT NULL,
	counterparty_id bigint,
	token_id bigint,
	amount numeric,
	staple_time timestamptz NOT NULL,
	details jsonb NOT NULL,
	PRIMARY KEY (block_hash, idx)
);

CREATE INDEX operations_account_time ON explorer.operations (account_id, staple_time DESC);
CREATE INDEX operations_counterparty_time ON explorer.operations (counterparty_id, staple_time DESC) WHERE counterparty_id IS NOT NULL;
CREATE INDEX operations_token_time ON explorer.operations (token_id, staple_time DESC) WHERE token_id IS NOT NULL;

CREATE TABLE explorer.holdings (
	token_id bigint NOT NULL,
	account_id bigint NOT NULL,
	balance numeric NOT NULL,
	PRIMARY KEY (account_id, token_id)
);

CREATE INDEX holdings_token_balance ON explorer.holdings (token_id, balance DESC);
