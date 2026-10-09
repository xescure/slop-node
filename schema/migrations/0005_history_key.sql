-- Schema version 5: one index orders each account's history.
--
-- history_pkey (account_id, blocks_hash) and history_order (account_id,
-- staple_time DESC, blocks_hash DESC) held every history row twice. A
-- staple's time is fixed by its blocks hash, so the history key under an
-- account is unique wherever the pair is, and one primary key on it serves a
-- page, read backward for newest first, and the look-up of a page's start by
-- the start's staple time. A staple is written into the history of every
-- account it touches, hundreds on the main network, so each index costs a
-- write to a page of its own per account.
ALTER TABLE history DROP CONSTRAINT history_pkey;

DROP INDEX history_order;

ALTER TABLE history ADD PRIMARY KEY (account_id, staple_time, blocks_hash);
