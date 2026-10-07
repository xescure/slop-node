-- Schema version 2: the key-value store of one node, where upstream keeps its
-- statistics and peer-to-peer state [Keeta TS] index.js:72514, 72832-72835,
-- 74356-74361, 74473-74496.
--
-- An expiry is a moment of the caller's clock, passed in; nothing here reads
-- the database clock.

-- A named arena's entries, each the caller's JSON text as given. An entry
-- whose expiry has passed is absent, whether or not its row is still here.
CREATE TABLE kv_entries (
	arena text COLLATE "C" NOT NULL,
	key text COLLATE "C" NOT NULL,
	value json NOT NULL,
	expires_at timestamptz_ms,
	PRIMARY KEY (arena, key)
);

CREATE INDEX kv_entries_expiry ON kv_entries (arena, expires_at) WHERE expires_at IS NOT NULL;

-- The null arena, which only XOR writes: an accumulator per "@buffer:" key,
-- which never expires [Keeta TS] index.js:66831-66836, 66951-66968.
CREATE TABLE kv_buffers (
	key text COLLATE "C" PRIMARY KEY CHECK (starts_with(key, '@buffer:')),
	value bytea NOT NULL
);

-- The XOR of two byte strings aligned at their last byte, as long as the
-- longer: the shorter reads as if padded with leading zero bytes
-- [Keeta TS] index.js:66963-66967.
CREATE FUNCTION kv_xor(stored bytea, change bytea) RETURNS bytea
	LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
	RETURN (
		SELECT decode(coalesce(string_agg(
			lpad(to_hex(get_byte(aligned.stored, position) # get_byte(aligned.change, position)), 2, '0'),
			'' ORDER BY position), ''), 'hex')
		FROM (
			SELECT decode(repeat('00', width - length(kv_xor.stored)), 'hex') || kv_xor.stored AS stored,
				decode(repeat('00', width - length(kv_xor.change)), 'hex') || kv_xor.change AS change,
				width
			FROM (SELECT greatest(length(kv_xor.stored), length(kv_xor.change)) AS width) AS widths
		) AS aligned
		CROSS JOIN generate_series(0, aligned.width - 1) AS position
	);
