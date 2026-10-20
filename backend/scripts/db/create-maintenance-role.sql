-- Creates the LOGIN role the always-on maintenance job (purge.sh) connects as. Run once per database as the owner/superuser, like
-- create-runtime-role.sql, for example:
--   psql "$DATABASE_MIGRATE_URL" -v maintenance_password="$(openssl rand -hex 24)" -f scripts/db/create-maintenance-role.sql
-- then set DATABASE_MAINTENANCE_URL for the job. Needs migration 20261020_maintenance_role (it creates safry_maintenance_ops and
-- grants it EXECUTE on the seven maintenance procedures, which run with the owner's rights).
-- The login is NOSUPERUSER NOBYPASSRLS, owns nothing and holds no table privilege: a leaked password can run the retention
-- routines, which never go below the owner-set policy floors (maintenance_policy): delete rows that are already due, cancel PENDING
-- bookings that are already expired, drop audit partitions older than the policy. It can also write a false heartbeat.
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

-- The booking sweep floor follows the lifetime the API uses (BOOKING_PENDING_TTL_HOURS): pass it with -v booking_ttl_hours=48 (the compose
-- db-roles job does). Run this script again whenever BOOKING_PENDING_TTL_HOURS changes; without it the floor stays at the last value
-- (default 48 h), which only ever makes the sweep more cautious when the TTL is lower and is overridden by the job's own larger argument.
\if :{?booking_ttl_hours}
  CALL set_maintenance_policy('booking_pending_ttl', make_interval(hours => (:'booking_ttl_hours')::integer));
\endif
