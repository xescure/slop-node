-- Schema version 9: each row of the ledger checksum is read through its key.
--
-- The transaction that writes a staple reads and rewrites one row of
-- ledger_checksum (version 8) under serializable isolation, which records
-- what each transaction read to find the transactions it conflicts with.
-- Postgres reads a row of a table of a few pages by scanning all of them,
-- which records a read of the whole table, so that two transactions writing
-- staples at once conflicted whichever rows they folded into. Pages filled
-- to a tenth make the table large enough that the row is found through the
-- primary key, which records a read of that row alone, and leave room on its
-- page to rewrite it there, so that no index entry is written either.
CREATE TABLE ledger_checksum_spread (
	shard smallint PRIMARY KEY CHECK (shard >= 0 AND shard < 256),
	checksum bit(256) NOT NULL
) WITH (fillfactor = 10);

INSERT INTO ledger_checksum_spread (shard, checksum) SELECT shard, checksum FROM ledger_checksum;

DROP TABLE ledger_checksum;

ALTER TABLE ledger_checksum_spread RENAME TO ledger_checksum;
ALTER INDEX ledger_checksum_spread_pkey RENAME TO ledger_checksum_pkey;
ALTER TABLE ledger_checksum RENAME CONSTRAINT ledger_checksum_spread_shard_check TO ledger_checksum_shard_check;

ANALYZE ledger_checksum;
