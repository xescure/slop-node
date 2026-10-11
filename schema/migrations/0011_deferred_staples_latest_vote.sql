-- Schema version 11: deferred staples in the order of their latest votes.
--
-- A bootstrap reads, after an update that completed, the deferred staples
-- that await a block the main ledger lacks, by their latest votes, a page at
-- a time from after the last it read (schema/CONTRACT.md,
-- listStrandedDeferredStaples). A catch-up far behind defers tens of
-- thousands of staples, which the page must not sort whole.
CREATE INDEX deferred_staples_latest_vote ON deferred_staples (latest_vote_from, blocks_hash);
