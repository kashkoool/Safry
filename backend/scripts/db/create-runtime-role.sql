-- Creates the restricted LOGIN role the application connects as.
-- Run once per database as the owner/superuser, for example:
--   psql "$DATABASE_MIGRATE_URL" -v runtime_password="$(openssl rand -base64 24)" -f scripts/db/create-runtime-role.sql
-- then point DATABASE_URL at safry_runtime and keep DATABASE_MIGRATE_URL on the owner.
-- Behaviour is unchanged: the app still drops to safry_app per transaction (SET ROLE) inside the
-- row-level-security context; safry_runtime is not the owner and not BYPASSRLS, so RLS applies to
-- it even if that switch were skipped (fail closed).
\set ON_ERROR_STOP on

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'safry_runtime') AS missing \gset
\if :missing
  CREATE ROLE safry_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT;
\endif
ALTER ROLE safry_runtime PASSWORD :'runtime_password';
GRANT safry_app TO safry_runtime;

-- Server-side guard rails for the runtime login only ().
ALTER ROLE safry_runtime SET statement_timeout = '60s';
ALTER ROLE safry_runtime SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE safry_runtime SET lock_timeout = '10s';

SELECT current_database() AS db \gset
GRANT CONNECT ON DATABASE :"db" TO safry_runtime;
