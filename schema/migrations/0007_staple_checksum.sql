-- Schema version 7: the ledger checksum is written with the staples it covers.
--
-- The ledger checksum is the XOR of the hash of every block on the main
-- ledger (schema/CONTRACT.md, D19). Upstream's ledger folds each staple it adds
-- into a node statistic once the transaction has committed, and the node
-- writes its statistics to its store later [Keeta TS] index.js:69001-69006,
-- 69413-69417, 71377-71383, so a node stopped in between holds the staples and
-- has lost their part of the checksum. Each staple now keeps the XOR of its
-- blocks' hashes, written in the transaction that writes its blocks, and the
-- ledger checksum is the XOR of those of every staple. No row is written by
-- every staple, so staples written at once do not conflict over one.
ALTER TABLE staples ADD COLUMN checksum bit(256);

UPDATE staples SET checksum = (
	SELECT bit_xor(('x' || encode(blocks.hash, 'hex'))::bit(256))
	FROM blocks
	WHERE blocks.staple = staples.blocks_hash
);

ALTER TABLE staples ALTER COLUMN checksum SET NOT NULL;

-- The statistic the node kept until this version, which no reader uses now.
DELETE FROM kv_buffers WHERE key = '@buffer:ledgerChecksum';
