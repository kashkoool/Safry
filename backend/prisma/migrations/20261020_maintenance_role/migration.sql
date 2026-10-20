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

-- Policy floors. The maintenance login chooses the arguments it passes, so the routines it can reach never go below a floor that only the
-- owner can change (set_maintenance_policy): a leaked password cannot shorten audit retention, expire bookings early or delete
-- sessions and links sooner than the policy. The floors default to the documented defaults; the effective value is
-- greatest(argument, floor). To keep data for a shorter time than a default, the owner lowers the floor first, for example
--   CALL set_maintenance_policy('audit_retention', interval '90 days');
CREATE TABLE "maintenance_policy" (
  "setting" VARCHAR(60) NOT NULL,
  "minimum" INTERVAL NOT NULL,
  CONSTRAINT "maintenance_policy_pkey" PRIMARY KEY ("setting")
);
REVOKE ALL ON TABLE "maintenance_policy" FROM PUBLIC, safry_app;
INSERT INTO "maintenance_policy" ("setting", "minimum") VALUES
  ('audit_retention', interval '24 months'),
  ('session_retention', interval '30 days'),
  ('credential_token_retention', interval '7 days'),
  ('login_throttle_retention', interval '24 hours'),
  ('booking_pending_ttl', interval '48 hours');

CREATE OR REPLACE FUNCTION maintenance_policy_floor(setting_name text) RETURNS interval
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT "minimum" FROM "maintenance_policy" WHERE "setting" = setting_name $$;

CREATE OR REPLACE PROCEDURE set_maintenance_policy(setting_name text, new_minimum interval)
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "maintenance_policy" SET "minimum" = new_minimum WHERE "setting" = setting_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown maintenance policy setting %', setting_name;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION maintenance_policy_floor(text) FROM PUBLIC, safry_app;
REVOKE ALL ON PROCEDURE set_maintenance_policy(text, interval) FROM PUBLIC, safry_app;

CREATE OR REPLACE FUNCTION purge_refresh_sessions_batch(retention interval, batch_size integer DEFAULT 5000) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  removed bigint;
BEGIN
  IF retention < interval '1 day' THEN
    RAISE EXCEPTION 'refresh session retention must be at least 1 day';
  END IF;
  retention := greatest(retention, maintenance_policy_floor('session_retention'));
  batch_size := least(batch_size, 100000);
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
  retention := greatest(retention, maintenance_policy_floor('credential_token_retention'));
  batch_size := least(batch_size, 100000);
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
  retention := greatest(retention, maintenance_policy_floor('login_throttle_retention'));
  batch_size := least(batch_size, 100000);
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
  remaining integer;
  swept bigint;
  total bigint := 0;
BEGIN
  IF pending_ttl < interval '1 hour' THEN
    RAISE EXCEPTION 'pending booking lifetime must be at least 1 hour';
  END IF;
  pending_ttl := greatest(pending_ttl, maintenance_policy_floor('booking_pending_ttl'));
  remaining := least(batch_size, 100000);
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

-- No COMMIT in these, so they can run with the owner's rights directly.
ALTER PROCEDURE ensure_audit_event_partitions(integer, integer) SECURITY DEFINER SET search_path = public, pg_temp;
CREATE OR REPLACE PROCEDURE purge_audit_events(retention interval DEFAULT interval '24 months')
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  cutoff timestamptz;
  r record;
  dropped text[] := '{}';
  previous text := coalesce(current_setting('app.bypass_rls', true), '');
BEGIN
  IF retention IS NULL OR retention < interval '30 days' THEN
    RAISE EXCEPTION 'audit retention must be at least 30 days';
  END IF;
  retention := greatest(retention, maintenance_policy_floor('audit_retention'));
  cutoff := now() - retention;
  PERFORM set_config('lock_timeout', '500ms', true);
  FOR r IN
    SELECT c.relname::text AS name,
           substring(pg_get_expr(c.relpartbound, c.oid) FROM 'TO \(''([^'']+)''\)')::timestamptz AS upper_bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.audit_events'::regclass
      AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
    ORDER BY 2
  LOOP
    IF r.upper_bound <= cutoff THEN
      FOR attempt IN 1 .. 5 LOOP
        BEGIN
          EXECUTE format('DROP TABLE public.%I', r.name);
          dropped := dropped || r.name;
          EXIT;
        EXCEPTION WHEN lock_not_available THEN
          IF attempt = 5 THEN
            RAISE EXCEPTION 'could not lock audit_events to drop partition % after 5 attempts: a long audit writer is open; retry later', r.name
              USING ERRCODE = 'lock_not_available';
          END IF;
          PERFORM pg_sleep(attempt);
        END;
      END LOOP;
    END IF;
  END LOOP;
  IF cardinality(dropped) > 0 THEN
    PERFORM set_config('app.bypass_rls', 'on', false);
    INSERT INTO audit_events (id, "tenantId", action, "entityType", metadata)
    VALUES (gen_random_uuid(), NULL, 'audit.retention.partitions_dropped', 'audit_events',
            jsonb_build_object('retention', retention::text, 'dropped', to_jsonb(dropped)));
    PERFORM set_config('app.bypass_rls', previous, false);
  END IF;
END
$$;
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
