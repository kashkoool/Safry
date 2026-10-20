-- The always-on maintenance job must not hold the database superuser's password. It now connects as a dedicated login
-- (created by backend/scripts/db/create-maintenance-role.sql, a member of safry_maintenance_ops) that can do exactly one thing:
-- execute the maintenance routines below. It has no privilege on any table.
--
-- The routines are SECURITY DEFINER (they run with the rights of the schema owner), with a pinned search_path, so the caller needs
-- no table, DDL or row-level-security privilege. PostgreSQL refuses COMMIT inside a SECURITY DEFINER procedure, so the batched
-- work is split: each *_batch function does ONE batch and returns the number of rows it handled; the caller (purge.sh, one psql
-- call per batch) repeats until it returns 0, so every batch commits on its own exactly as before. The owner-run procedures from
-- the previous migration keep their names and arguments and now simply loop over the same functions (one implementation).
-- Additive and backward compatible: the owner login keeps working exactly as before.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'safry_maintenance_ops') THEN
    CREATE ROLE safry_maintenance_ops NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION purge_refresh_sessions_batch(retention interval, batch_size integer DEFAULT 5000) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  removed bigint;
BEGIN
  IF retention < interval '1 day' THEN
    RAISE EXCEPTION 'refresh session retention must be at least 1 day';
  END IF;
  PERFORM set_config('app.bypass_rls', 'on', true);
  DELETE FROM "refresh_sessions"
  WHERE "id" IN (
    SELECT "id" FROM "refresh_sessions"
    WHERE "expiresAt" < now() - retention
       OR ("revokedAt" IS NOT NULL AND "revokedAt" < now() - retention)
    LIMIT batch_size
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;

CREATE OR REPLACE FUNCTION purge_credential_tokens_batch(retention interval, batch_size integer DEFAULT 5000) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  removed bigint;
BEGIN
  IF retention < interval '1 day' THEN
    RAISE EXCEPTION 'credential token retention must be at least 1 day';
  END IF;
  PERFORM set_config('app.bypass_rls', 'on', true);
  DELETE FROM "credential_tokens"
  WHERE "id" IN (
    SELECT "id" FROM "credential_tokens"
    WHERE "expiresAt" < now() - retention
       OR ("usedAt" IS NOT NULL AND "usedAt" < now() - retention)
    LIMIT batch_size
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;

CREATE OR REPLACE FUNCTION purge_login_throttles_batch(retention interval, batch_size integer DEFAULT 5000) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  removed bigint;
BEGIN
  IF retention < interval '1 hour' THEN
    RAISE EXCEPTION 'login throttle retention must be at least 1 hour';
  END IF;
  DELETE FROM "login_throttles"
  WHERE "key" IN (
    SELECT "key" FROM "login_throttles"
    WHERE "updatedAt" < now() - retention
      AND ("blockedUntil" IS NULL OR "blockedUntil" < now())
      AND ("trustedUntil" IS NULL OR "trustedUntil" < now())
    LIMIT batch_size
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;

-- Cancels up to batch_size expired PENDING bookings (across tenants, per tenant so the (tenantId, status, createdAt) index serves the
-- scan) and records one booking.expire audit event each. SKIP LOCKED leaves a booking another transaction is changing right now to
-- the next run; the status re-check keeps the sweep from touching a booking that was just confirmed.
CREATE OR REPLACE FUNCTION sweep_expired_bookings_batch(pending_ttl interval, batch_size integer DEFAULT 1000) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid;
  remaining integer := batch_size;
  swept bigint;
  total bigint := 0;
BEGIN
  IF pending_ttl < interval '1 hour' THEN
    RAISE EXCEPTION 'pending booking lifetime must be at least 1 hour';
  END IF;
  PERFORM set_config('app.bypass_rls', 'on', true);
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    EXIT WHEN remaining <= 0;
    WITH stale AS (
      SELECT "id" FROM "bookings"
      WHERE "tenantId" = tenant AND "status" = 'PENDING' AND "createdAt" < now() - pending_ttl
      ORDER BY "createdAt"
      LIMIT remaining
      FOR UPDATE SKIP LOCKED
    ), cancelled AS (
      UPDATE "bookings" b SET "status" = 'CANCELLED', "updatedAt" = now()
      FROM stale
      WHERE b."id" = stale."id" AND b."tenantId" = tenant AND b."status" = 'PENDING'
      RETURNING b."id"
    )
    INSERT INTO "audit_events" ("id", "tenantId", "action", "entityType", "entityId", "metadata", "occurredAt")
    SELECT gen_random_uuid(), tenant, 'booking.expire', 'booking', cancelled."id"::text, '{"by": "maintenance"}'::jsonb, now()
    FROM cancelled;
    GET DIAGNOSTICS swept = ROW_COUNT;
    total := total + swept;
    remaining := remaining - swept;
  END LOOP;
  RETURN total;
END
$$;

-- The owner-run procedures keep their signatures and loop over the functions, committing after each batch.
CREATE OR REPLACE PROCEDURE purge_refresh_sessions(retention interval, batch_size integer DEFAULT 5000)
LANGUAGE plpgsql
AS $$
DECLARE
  removed bigint;
BEGIN
  LOOP
    removed := purge_refresh_sessions_batch(retention, batch_size);
    COMMIT;
    EXIT WHEN removed = 0;
  END LOOP;
END
$$;

CREATE OR REPLACE PROCEDURE purge_credential_tokens(retention interval, batch_size integer DEFAULT 5000)
LANGUAGE plpgsql
AS $$
DECLARE
  removed bigint;
BEGIN
  LOOP
    removed := purge_credential_tokens_batch(retention, batch_size);
    COMMIT;
    EXIT WHEN removed = 0;
  END LOOP;
END
$$;

CREATE OR REPLACE PROCEDURE purge_login_throttles(retention interval, batch_size integer DEFAULT 5000)
LANGUAGE plpgsql
AS $$
DECLARE
  removed bigint;
BEGIN
  LOOP
    removed := purge_login_throttles_batch(retention, batch_size);
    COMMIT;
    EXIT WHEN removed = 0;
  END LOOP;
END
$$;

CREATE OR REPLACE PROCEDURE sweep_expired_bookings(pending_ttl interval, batch_size integer DEFAULT 1000)
LANGUAGE plpgsql
AS $$
DECLARE
  swept bigint;
BEGIN
  LOOP
    swept := sweep_expired_bookings_batch(pending_ttl, batch_size);
    COMMIT;
    EXIT WHEN swept = 0;
  END LOOP;
END
$$;

-- No COMMIT in these three, so they can run with the owner's rights directly.
ALTER PROCEDURE ensure_audit_event_partitions(integer, integer) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER PROCEDURE purge_audit_events(interval) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER PROCEDURE record_maintenance_run(text, jsonb) SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION purge_refresh_sessions_batch(interval, integer) FROM PUBLIC, safry_app;
REVOKE ALL ON FUNCTION purge_credential_tokens_batch(interval, integer) FROM PUBLIC, safry_app;
REVOKE ALL ON FUNCTION purge_login_throttles_batch(interval, integer) FROM PUBLIC, safry_app;
REVOKE ALL ON FUNCTION sweep_expired_bookings_batch(interval, integer) FROM PUBLIC, safry_app;
REVOKE ALL ON PROCEDURE ensure_audit_event_partitions(integer, integer) FROM PUBLIC;
REVOKE ALL ON PROCEDURE purge_audit_events(interval) FROM PUBLIC;
REVOKE ALL ON PROCEDURE record_maintenance_run(text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION purge_refresh_sessions_batch(interval, integer) TO safry_maintenance_ops;
GRANT EXECUTE ON FUNCTION purge_credential_tokens_batch(interval, integer) TO safry_maintenance_ops;
GRANT EXECUTE ON FUNCTION purge_login_throttles_batch(interval, integer) TO safry_maintenance_ops;
GRANT EXECUTE ON FUNCTION sweep_expired_bookings_batch(interval, integer) TO safry_maintenance_ops;
GRANT EXECUTE ON PROCEDURE ensure_audit_event_partitions(integer, integer) TO safry_maintenance_ops;
GRANT EXECUTE ON PROCEDURE purge_audit_events(interval) TO safry_maintenance_ops;
GRANT EXECUTE ON PROCEDURE record_maintenance_run(text, jsonb) TO safry_maintenance_ops;
