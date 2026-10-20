-- The explorer's one-time setup, run by the owner of the node's tables, as
-- often as wanted. The roles are created unable to log in: their logins and
-- passwords are a step of the deploy. temp_file_limit needs a superuser.

DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'explorer_writer') THEN
		CREATE ROLE explorer_writer NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'explorer_reader') THEN
		CREATE ROLE explorer_reader NOLOGIN;
	END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS explorer AUTHORIZATION explorer_writer;

GRANT USAGE ON SCHEMA public TO explorer_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO explorer_writer;
-- Tables later node migrations add are readable without running this again.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO explorer_writer;

GRANT USAGE ON SCHEMA explorer TO explorer_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE explorer_writer IN SCHEMA explorer GRANT SELECT ON TABLES TO explorer_reader;

ALTER ROLE explorer_writer CONNECTION LIMIT 4;
ALTER ROLE explorer_writer SET idle_in_transaction_session_timeout = '60s';

ALTER ROLE explorer_reader CONNECTION LIMIT 8;
ALTER ROLE explorer_reader SET default_transaction_read_only = on;
ALTER ROLE explorer_reader SET statement_timeout = '30s';
ALTER ROLE explorer_reader SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE explorer_reader SET work_mem = '32MB';
ALTER ROLE explorer_reader SET temp_file_limit = '1GB';
ALTER ROLE explorer_reader SET search_path = explorer;
