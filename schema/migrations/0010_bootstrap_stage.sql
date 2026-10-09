-- Schema version 10: the staples a bootstrap read and has not added yet.
--
-- A node far behind reads its peers' history in ranges side by side, in no
-- order between the ranges, but adds it in the order of the staples' votes,
-- since the ledger judges each staple by the voting weight it holds when the
-- staple is added [Keeta TS] index.js:69419-69423, 69761-69779. What it read
-- waits here, as the bytes it came as, until every range before it is read
-- (schema/CONTRACT.md, section 4.3).
CREATE TABLE bootstrap_stage (
	blocks_hash hash32 PRIMARY KEY,
	first_vote_from timestamptz_ms NOT NULL,
	last_vote_from timestamptz_ms NOT NULL,
	bytes bytea NOT NULL
);

-- The order staples are added in.
CREATE INDEX bootstrap_stage_first_vote ON bootstrap_stage (first_vote_from, blocks_hash);

-- What a filter names to a peer keyed by votes from a moment.
CREATE INDEX bootstrap_stage_last_vote ON bootstrap_stage (last_vote_from, blocks_hash);
