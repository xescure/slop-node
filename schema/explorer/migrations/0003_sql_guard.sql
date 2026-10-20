-- Explorer schema version 3: the guard the sql tool wraps an agent's query in.
--
-- pg turns each field of a row into a string as the row arrives, and a field
-- longer than the longest string the client's runtime can hold ends the
-- process outside any query's error handling. So a row is measured where it is
-- made, and one over the cap stops the query before any of it is sent. The
-- SQLSTATE is the one the runner maps to its byte-cap refusal.
CREATE FUNCTION explorer.row_fits(bytes bigint, cap bigint) RETURNS boolean
	LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
	SET search_path = pg_catalog
AS $$
BEGIN
	IF bytes > cap THEN
		RAISE EXCEPTION USING
			ERRCODE = 'XE001',
			MESSAGE = format('a row of %s bytes is over the cap of %s bytes', bytes, cap);
	END IF;
	RETURN true;
END
$$;
