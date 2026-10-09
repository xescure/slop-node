-- Schema version 6: gc reads only the deferred staples that may apply or be
-- dropped.
--
-- A deferred staple is released once every block it waits on is on the main
-- ledger, and dead once the previous of any of its blocks has a confirmed
-- successor; neither ever ends, and each begins only when a block is written
-- to the main ledger, or, for a staple dead when it is deferred, with the
-- deferral. The writes that begin either list the staple in deferred_checks,
-- and gc reads the listed staples instead of every deferred one, which a
-- catch-up far behind its peers counts in tens of thousands. A listing goes
-- with its staple.
CREATE TABLE deferred_checks (
	blocks_hash hash32 PRIMARY KEY REFERENCES deferred_staples (blocks_hash) ON DELETE CASCADE
);

-- The deferred staples a confirmed block makes dead: those with a block that
-- extends the same previous.
CREATE INDEX deferred_blocks_previous ON deferred_blocks (previous);

INSERT INTO deferred_checks (blocks_hash)
SELECT deferred_staples.blocks_hash
FROM deferred_staples
WHERE NOT EXISTS (
		SELECT 1 FROM deferred_waits
		WHERE deferred_waits.blocks_hash = deferred_staples.blocks_hash
			AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.hash = deferred_waits.block_hash AND blocks.ledger = 'main'))
	OR EXISTS (
		SELECT 1 FROM deferred_blocks
		JOIN blocks successor ON successor.previous = deferred_blocks.previous AND successor.ledger = 'main'
		WHERE deferred_blocks.blocks_hash = deferred_staples.blocks_hash);
