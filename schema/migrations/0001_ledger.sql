-- Schema version 1: the ledger store of one node.
--
-- Every moment is supplied by the node (a transaction moment or a vote's
-- validity) and stored as timestamptz; nothing here reads the database clock.
-- Rows that can exist on both the main and the side ledger carry the ledger
-- they are on.

CREATE TYPE ledger_name AS ENUM ('main', 'side');

-- Block hashes, staple hashes (blocksHash), idempotent keys and certificate
-- hashes are all 32 bytes [Keeta TS] index.js:63184, 68942, 77422.
CREATE DOMAIN hash32 AS bytea CHECK (octet_length(VALUE) = 32);

-- Balances, supplies and weights are unbounded integers: a supply may reach
-- 10^200 - 1 [Keeta TS] index.js:61315, and a stored balance may be negative
-- while its funding staple is missing.
CREATE DOMAIN amount AS numeric CHECK (VALUE = trunc(VALUE));

-- A permission set is a bit field held as an unbounded integer. It travels in
-- blocks as an ASN.1 INTEGER, which decodes to a negative set when its sign
-- bit is set, and the network's validation accepts one, so the sign is kept
-- [Keeta TS] index.js:76540-76593, 64673-64696, 74662-74679, 74110-74115.
CREATE DOMAIN permission_bits AS numeric CHECK (VALUE = trunc(VALUE));

-- CACHE 1 makes every call take the next value of the one shared counter, so
-- serials issued by all processes strictly increase, and a serial taken by an
-- attempt that rolls back is never issued again.
CREATE SEQUENCE vote_serials AS bigint MINVALUE 1 START 1 CACHE 1 NO CYCLE;

-- Every account the ledger names, interned once. The public key is spelled as
-- upstream prints it; key_type is its AccountKeyAlgorithm. first_staple is the
-- first main staple that involved the account.
CREATE TABLE accounts (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	public_key text NOT NULL UNIQUE,
	key_type smallint NOT NULL,
	first_staple hash32
);

-- Main staples, keyed by the hash of their blocks, never of their bytes.
-- staple_time is the history key; moment and sequence are the catch-up key.
CREATE TABLE staples (
	blocks_hash hash32 PRIMARY KEY,
	staple_time timestamptz NOT NULL,
	moment timestamptz NOT NULL,
	sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);

CREATE INDEX staples_history ON staples (staple_time DESC, blocks_hash DESC);
CREATE INDEX staples_catch_up ON staples (moment, sequence);

-- A main block belongs to one staple, at one position in it. A side block is
-- a copy kept while a side vote covers it; promotion turns it into a main
-- block in place, so a block is never on both ledgers.
CREATE TABLE blocks (
	hash hash32 PRIMARY KEY,
	ledger ledger_name NOT NULL,
	account_id bigint NOT NULL REFERENCES accounts (id),
	previous hash32 NOT NULL,
	operation_count integer NOT NULL,
	bytes bytea NOT NULL,
	staple hash32 REFERENCES staples (blocks_hash),
	staple_position integer,
	CHECK ((ledger = 'main') = (staple IS NOT NULL)),
	CHECK ((staple IS NULL) = (staple_position IS NULL))
);

-- A confirmed block is the only confirmed successor of its previous.
CREATE UNIQUE INDEX blocks_main_successor ON blocks (previous) WHERE ledger = 'main';
CREATE INDEX blocks_previous ON blocks (previous);
CREATE UNIQUE INDEX blocks_staple_order ON blocks (staple, staple_position);

-- Each account's main chain: the zero-based height of every confirmed block.
CREATE TABLE chain (
	account_id bigint NOT NULL REFERENCES accounts (id),
	height bigint NOT NULL CHECK (height >= 0),
	block_hash hash32 NOT NULL UNIQUE REFERENCES blocks (hash),
	PRIMARY KEY (account_id, height)
);

-- The highest block of each account's main chain.
CREATE TABLE heads (
	account_id bigint PRIMARY KEY REFERENCES accounts (id),
	block_hash hash32 NOT NULL REFERENCES blocks (hash),
	height bigint NOT NULL
);

-- Main votes are kept per staple, so an equivocating issuer's vote with the
-- same identity can never replace one. Side votes are this node's own pending
-- votes, one per identity.
CREATE TABLE votes (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	ledger ledger_name NOT NULL,
	uid text NOT NULL,
	blocks_hash hash32 NOT NULL,
	issuer_id bigint NOT NULL REFERENCES accounts (id),
	validity_from timestamptz NOT NULL,
	validity_to timestamptz NOT NULL,
	permanent boolean NOT NULL,
	bytes bytea NOT NULL
);

CREATE UNIQUE INDEX votes_main ON votes (blocks_hash, uid) WHERE ledger = 'main';
CREATE UNIQUE INDEX votes_side ON votes (uid) WHERE ledger = 'side';
CREATE INDEX votes_side_staple ON votes (blocks_hash) WHERE ledger = 'side';
CREATE INDEX votes_side_expiry ON votes (validity_to) WHERE ledger = 'side' AND NOT permanent;

-- The blocks a side vote covers, in vote order. They outlive the side copies
-- of those blocks: a vote stays readable as a staple after its blocks move to
-- main.
CREATE TABLE vote_blocks (
	vote_id bigint NOT NULL REFERENCES votes (id) ON DELETE CASCADE,
	position integer NOT NULL,
	block_hash hash32 NOT NULL REFERENCES blocks (hash),
	PRIMARY KEY (vote_id, position)
);

CREATE INDEX vote_blocks_block ON vote_blocks (block_hash);

-- A main key is held by one block; side claims of one key may coexist, since
-- a claim counts only while an unexpired side vote covers its block.
CREATE TABLE idempotent_keys (
	key hash32 NOT NULL,
	ledger ledger_name NOT NULL,
	block_hash hash32 NOT NULL REFERENCES blocks (hash),
	PRIMARY KEY (key, ledger, block_hash)
);

CREATE UNIQUE INDEX idempotent_keys_main ON idempotent_keys (key) WHERE ledger = 'main';
CREATE INDEX idempotent_keys_block ON idempotent_keys (block_hash);

CREATE TABLE balances (
	account_id bigint NOT NULL REFERENCES accounts (id),
	token_id bigint NOT NULL REFERENCES accounts (id),
	balance amount NOT NULL,
	PRIMARY KEY (account_id, token_id)
);

CREATE TABLE supplies (
	token_id bigint PRIMARY KEY REFERENCES accounts (id),
	supply amount NOT NULL
);

CREATE TABLE weights (
	representative_id bigint PRIMARY KEY REFERENCES accounts (id),
	weight amount NOT NULL
);

CREATE TABLE delegations (
	account_id bigint PRIMARY KEY REFERENCES accounts (id),
	representative_id bigint NOT NULL REFERENCES accounts (id)
);

-- A missing field reads as upstream's default [Keeta TS] index.js:67742-67794.
CREATE TABLE account_info (
	account_id bigint PRIMARY KEY REFERENCES accounts (id),
	name text,
	description text,
	metadata text,
	default_base_permission permission_bits,
	default_external_permission permission_bits,
	multisig_quorum numeric CHECK (multisig_quorum = trunc(multisig_quorum)),
	CHECK ((default_base_permission IS NULL) = (default_external_permission IS NULL))
);

-- The principal is an account, or, when certificate is set, that certificate
-- as held by the account. An entity-wide row has the entity as its target.
CREATE TABLE acls (
	principal_id bigint NOT NULL REFERENCES accounts (id),
	certificate hash32,
	entity_id bigint NOT NULL REFERENCES accounts (id),
	target_id bigint NOT NULL REFERENCES accounts (id),
	base_permissions permission_bits NOT NULL,
	external_permissions permission_bits NOT NULL,
	CONSTRAINT acls_scope UNIQUE NULLS NOT DISTINCT (principal_id, certificate, entity_id, target_id)
);

CREATE INDEX acls_entity ON acls (entity_id);

-- A certificate is kept after it expires; callers judge validity themselves
-- [Keeta TS] index.js:69787-69810.
CREATE TABLE certificates (
	account_id bigint NOT NULL REFERENCES accounts (id),
	hash hash32 NOT NULL,
	certificate bytea NOT NULL,
	intermediates bytea,
	PRIMARY KEY (account_id, hash)
);

-- History lists each main staple under every account it touched, newest first
-- by (staple time, blocks hash).
CREATE TABLE history (
	account_id bigint NOT NULL REFERENCES accounts (id),
	blocks_hash hash32 NOT NULL REFERENCES staples (blocks_hash),
	staple_time timestamptz NOT NULL,
	PRIMARY KEY (account_id, blocks_hash)
);

CREATE INDEX history_order ON history (account_id, staple_time DESC, blocks_hash DESC);

-- Confirmed staples waiting on previous blocks this node lacks, and the
-- blocks each waits on; one block can release several staples. A staple's
-- votes are checked against a moment when it is decoded, and every vote is
-- valid at the latest validityFrom among them, whatever the wall clock reads.
CREATE TABLE deferred_staples (
	blocks_hash hash32 PRIMARY KEY,
	bytes bytea NOT NULL,
	latest_vote_from timestamptz NOT NULL
);

CREATE TABLE deferred_waits (
	block_hash hash32 NOT NULL,
	blocks_hash hash32 NOT NULL REFERENCES deferred_staples (blocks_hash) ON DELETE CASCADE,
	PRIMARY KEY (block_hash, blocks_hash)
);

CREATE INDEX deferred_waits_staple ON deferred_waits (blocks_hash);

-- The previous of every block of a deferred staple: once any of them has a
-- confirmed successor, the staple can never apply.
CREATE TABLE deferred_blocks (
	blocks_hash hash32 NOT NULL REFERENCES deferred_staples (blocks_hash) ON DELETE CASCADE,
	previous hash32 NOT NULL,
	PRIMARY KEY (blocks_hash, previous)
);

CREATE INDEX deferred_blocks_previous ON deferred_blocks (previous);
