-- Schema version 8: the ledger checksum is kept folded, so that reading it
-- reads a fixed number of rows rather than every staple.
--
-- The ledger checksum is the XOR of the hash of every block on the main
-- ledger (schema/CONTRACT.md, D19), which each staple's checksum holds for its
-- blocks (version 7). The XOR of every staple's checksum is kept in 256 rows,
-- one for the staples whose blocks hash begins with each byte; the
-- transaction that writes a staple's blocks folds its checksum into its row.
-- Two transactions that write staples at once conflict only when both
-- staples' blocks hashes begin with the same byte, as two writes of one row
-- under serializable isolation do.
CREATE TABLE ledger_checksum (
	shard smallint PRIMARY KEY CHECK (shard >= 0 AND shard < 256),
	checksum bit(256) NOT NULL
);

INSERT INTO ledger_checksum (shard, checksum)
SELECT shard, repeat('0', 256)::bit(256) FROM generate_series(0, 255) AS shard;

UPDATE ledger_checksum SET checksum = folded.checksum
FROM (
	SELECT get_byte(blocks_hash, 0) AS shard, bit_xor(checksum) AS checksum
	FROM staples
	GROUP BY get_byte(blocks_hash, 0)
) AS folded
WHERE ledger_checksum.shard = folded.shard;
