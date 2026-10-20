-- Creates the LOGIN role the always-on maintenance job (purge.sh) connects as. Run once per database as the owner/superuser, like
-- create-runtime-role.sql, for example:
--   psql "$DATABASE_MIGRATE_URL" -v maintenance_password="$(openssl rand -hex 24)" -f scripts/db/create-maintenance-role.sql
-- then set DATABASE_MAINTENANCE_URL for the job. Needs migration 20261020_maintenance_role (it creates safry_maintenance_ops and
-- grants it EXECUTE on the seven maintenance procedures, which run with the owner's rights).
-- The login is NOSUPERUSER NOBYPASSRLS, owns nothing and holds no table privilege: a leaked password can run the retention
-- procedures (delete expired rows, cancel expired PENDING bookings, drop old audit partitions) and nothing else.
\set ON_ERROR_STOP on

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'safry_maintenance') AS missing \gset
\if :missing
  CREATE ROLE safry_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT;
\endif
ALTER ROLE safry_maintenance PASSWORD :'maintenance_password';
GRANT safry_maintenance_ops TO safry_maintenance;
ALTER ROLE safry_maintenance SET lock_timeout = '10s';
ALTER ROLE safry_maintenance SET statement_timeout = '30min';

SELECT current_database() AS db \gset
GRANT CONNECT ON DATABASE :"db" TO safry_maintenance;
