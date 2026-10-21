-- The explorer's one-time setup, run by a superuser in the node's database,
-- as often as wanted. The roles are created unable to log in: their logins
-- and passwords are a step of the deploy. temp_file_limit and the privileges
-- of built-in functions need a superuser.

-- The grants below go to the owners of the node's tables, so the node's
-- migrations come first.
DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')) THEN
		RAISE EXCEPTION 'the node''s tables are not in the public schema of this database; run the node''s migrations first';
	END IF;
END
$$;

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

-- A deploy runs two explorers at once, each with up to 4 writer and 8 reader connections.
ALTER ROLE explorer_writer CONNECTION LIMIT 8;
ALTER ROLE explorer_writer SET idle_in_transaction_session_timeout = '60s';

ALTER ROLE explorer_reader CONNECTION LIMIT 16;
ALTER ROLE explorer_reader SET default_transaction_read_only = on;
ALTER ROLE explorer_reader SET statement_timeout = '30s';
ALTER ROLE explorer_reader SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE explorer_reader SET work_mem = '32MB';
ALTER ROLE explorer_reader SET temp_file_limit = '1GB';
ALTER ROLE explorer_reader SET search_path = explorer;

-- A read-only transaction can still write WAL with pg_logical_emit_message,
-- fill the shared lock table or hold the node's migration lock with the
-- advisory locks, and lift work_mem within a statement with set_config, so
-- PUBLIC loses them in this database, whose function privileges are its own.
-- The writer takes its advisory locks, and so do the owners of the node
-- tables, as the node's migrations do; a superuser bypasses the check.
-- Granting a built-in function's privileges needs a superuser, and a role
-- without them only warns, so what the reader and the writer end up allowed
-- is checked rather than assumed.
DO $$
DECLARE
	routine regprocedure;
	owner name;
BEGIN
	FOR routine IN
		SELECT oid::regprocedure FROM pg_proc
		WHERE pronamespace = 'pg_catalog'::regnamespace AND proname IN ('pg_logical_emit_message', 'set_config')
	LOOP
		EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', routine);
	END LOOP;
	FOR routine IN
		SELECT oid::regprocedure FROM pg_proc
		WHERE pronamespace = 'pg_catalog'::regnamespace AND proname ~ '^pg_(try_)?advisory_'
	LOOP
		EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', routine);
		EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO explorer_writer', routine);
		FOR owner IN
			SELECT DISTINCT pg_get_userbyid(relowner) FROM pg_class
			WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
		LOOP
			EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', routine, owner);
		END LOOP;
	END LOOP;
	FOR routine IN
		SELECT oid::regprocedure FROM pg_proc
		WHERE pronamespace = 'pg_catalog'::regnamespace AND (proname IN ('pg_logical_emit_message', 'set_config') OR proname ~ '^pg_(try_)?advisory_')
			AND has_function_privilege('explorer_reader', oid, 'EXECUTE')
	LOOP
		RAISE EXCEPTION 'explorer_reader may still run %; run this setup as a superuser', routine;
	END LOOP;
	FOR routine, owner IN
		SELECT proc.oid::regprocedure, role.rolname
		FROM pg_proc proc
		CROSS JOIN (
			SELECT 'explorer_writer'::name AS rolname
			UNION SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
		) role
		WHERE proc.pronamespace = 'pg_catalog'::regnamespace AND proc.proname ~ '^pg_(try_)?advisory_'
			AND NOT has_function_privilege(role.rolname, proc.oid, 'EXECUTE')
	LOOP
		RAISE EXCEPTION '% may not run %, which it needs; run this setup as a superuser', owner, routine;
	END LOOP;
END
$$;
