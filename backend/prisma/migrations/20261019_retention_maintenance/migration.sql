-- Retention maintenance, additive and backward compatible (the previous application version keeps working on this schema).
--
-- 1. maintenance_runs: one heartbeat row per scheduled job. The maintenance job writes it after every successful run; the API
--    reads it and exports the age as a metric, so a stopped or failing job raises an alert. A baseline row is inserted now, so
--    "never ran" shows up as stale 36 hours after this migration, whatever restarts happen in between.
-- 2. purge_login_throttles: removes idle attempt counters (same conditions as the pruning the API does on login traffic).
-- 3. sweep_expired_bookings: moves PENDING bookings older than the pending lifetime to CANCELLED and records it. The rule is the
--    one the API computes (bookings.service.ts / booking-limits.ts: status PENDING and createdAt older than
--    BOOKING_PENDING_TTL_HOURS); the lifetime is passed in by the caller, so that setting stays the single source of truth.
-- 4. audit_default_partition_rows: exact row count of the safety-net audit partition for the API (the partition itself is closed to
--    the application role), so a stopped job that lets audit rows spill into it can be alerted on.
-- 5. Autovacuum settings for the three tables whose rows are created and deleted all day. Defaults wait until 20% of a table is dead.
CREATE TABLE "maintenance_runs" (
  "job" VARCHAR(60) NOT NULL,
  "lastSuccessAt" TIMESTAMPTZ(3) NOT NULL,
  "details" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "maintenance_runs_pkey" PRIMARY KEY ("job")
);
REVOKE ALL ON TABLE "maintenance_runs" FROM PUBLIC, safry_app;
GRANT SELECT ON TABLE "maintenance_runs" TO safry_app;
INSERT INTO "maintenance_runs" ("job", "lastSuccessAt", "details") VALUES ('purge', now(), '{"baseline": true}');

CREATE OR REPLACE PROCEDURE record_maintenance_run(job_name text, run_details jsonb DEFAULT '{}')
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "maintenance_runs" ("job", "lastSuccessAt", "details") VALUES (job_name, now(), run_details)
  ON CONFLICT ("job") DO UPDATE SET "lastSuccessAt" = now(), "details" = EXCLUDED."details";
END
$$;

CREATE OR REPLACE PROCEDURE purge_login_throttles(retention interval, batch_size integer DEFAULT 5000)
LANGUAGE plpgsql
AS $$
DECLARE
  removed bigint;
BEGIN
  IF retention < interval '1 hour' THEN
    RAISE EXCEPTION 'login throttle retention must be at least 1 hour';
  END IF;
  LOOP
    DELETE FROM "login_throttles"
    WHERE "key" IN (
      SELECT "key" FROM "login_throttles"
      WHERE "updatedAt" < now() - retention
        AND ("blockedUntil" IS NULL OR "blockedUntil" < now())
        AND ("trustedUntil" IS NULL OR "trustedUntil" < now())
      LIMIT batch_size
    );
    GET DIAGNOSTICS removed = ROW_COUNT;
    COMMIT;
    EXIT WHEN removed = 0;
  END LOOP;
END
$$;

CREATE OR REPLACE PROCEDURE sweep_expired_bookings(pending_ttl interval, batch_size integer DEFAULT 1000)
LANGUAGE plpgsql
AS $$
DECLARE
  tenant_ids uuid[];
  tenant uuid;
  swept bigint;
BEGIN
  IF pending_ttl < interval '1 hour' THEN
    RAISE EXCEPTION 'pending booking lifetime must be at least 1 hour';
  END IF;
  PERFORM set_config('app.bypass_rls', 'on', false);
  SELECT coalesce(array_agg("id"), ARRAY[]::uuid[]) INTO tenant_ids FROM "tenants";
  FOREACH tenant IN ARRAY tenant_ids LOOP
    LOOP
      -- Per tenant, so the (tenantId, status, createdAt) index serves the scan. SKIP LOCKED leaves a booking another transaction is
      -- changing right now to the next run; the status re-check keeps the sweep from touching a booking that was just confirmed.
      WITH stale AS (
        SELECT "id" FROM "bookings"
        WHERE "tenantId" = tenant AND "status" = 'PENDING' AND "createdAt" < now() - pending_ttl
        ORDER BY "createdAt"
        LIMIT batch_size
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
      COMMIT;
      EXIT WHEN swept = 0;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.bypass_rls', 'off', false);
END
$$;

CREATE OR REPLACE FUNCTION audit_default_partition_rows() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT count(*) FROM "audit_events_default" $$;

REVOKE ALL ON PROCEDURE record_maintenance_run(text, jsonb) FROM PUBLIC, safry_app;
REVOKE ALL ON PROCEDURE purge_login_throttles(interval, integer) FROM PUBLIC, safry_app;
REVOKE ALL ON PROCEDURE sweep_expired_bookings(interval, integer) FROM PUBLIC, safry_app;
REVOKE ALL ON FUNCTION audit_default_partition_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_default_partition_rows() TO safry_app;

-- Autovacuum: vacuum these tables after about 2% of their rows are dead (default 20%), so rows removed by the maintenance job or by
-- the app are reusable within minutes and the files stop growing. ALTER TABLE ... SET takes a brief SHARE UPDATE EXCLUSIVE lock
-- and rewrites nothing.
ALTER TABLE "refresh_sessions" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE "credential_tokens" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 500, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE "login_throttles" SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 200, autovacuum_analyze_scale_factor = 0.1);
