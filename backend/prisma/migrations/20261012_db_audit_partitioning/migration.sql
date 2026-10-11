-- Decision: partition audit_events by month now, keep 24 months.
--
-- audit_events becomes a table partitioned by month on "occurredAt" (UTC month boundaries):
--   audit_events_legacy   everything before the retention window (MINVALUE .. start of month(now) - 24 months)
--   audit_events_YYYY_MM  one per month, from 24 months back to 12 months ahead (more via ensure_audit_event_partitions)
--   audit_events_default  safety net: a row outside every range (clock skew, far future) is still stored, never rejected
-- The primary key must contain the partition column, so it becomes (id, "occurredAt"). Retention drops whole partitions
-- (purge_audit_events, owner only) instead of deleting rows: no dead tuples, no WAL burst, no vacuum debt.
--
-- Existing rows are copied into the right partitions inside this migration (row count verified), then the old table is dropped.
-- The whole file runs as ONE transaction (Prisma applies each migration file in a single transaction), so the rename and the copy
-- hold ACCESS EXCLUSIVE on audit_events until commit: this migration needs a maintenance window on a large table. The legacy
-- partition (everything older than the retention window) is dropped by the first purge_audit_events run, so export or detach it
-- first if that history must be kept.
-- This rewrites the table: fine for the current data volume; a large production table needs a batched copy instead (see
-- backend/docs/database-operations.md). Rollback = restore from backup (the table swap is the contract step).
-- Prisma does not model partitions: schema.prisma declares the parent as an ordinary model with @@id([id, occurredAt]); child
-- partitions are ignored by `prisma migrate diff` (proven in test/db-data-migrations.int.spec.ts).
-- Session-level set_config (a transaction-local setting does not survive under prisma migrate deploy).
SELECT set_config('app.bypass_rls', 'on', false);

ALTER TABLE "audit_events" RENAME TO "audit_events_old";
CREATE TABLE "audit_events" (LIKE "audit_events_old" INCLUDING DEFAULTS) PARTITION BY RANGE ("occurredAt");

-- Creates the missing monthly partitions from `months_back` months before the current month to `months_ahead` months after it.
-- Idempotent. Rows that already sit in the default partition for a month being created are moved into it. Every partition is
-- closed to the application role: default privileges would otherwise grant DML on it, and a partition reached directly skips the
-- parent's row-level security and append-only grants.
-- Run by the owner role (daily from backend/scripts/db/purge.sh together with retention), never by the app role.
CREATE OR REPLACE PROCEDURE ensure_audit_event_partitions(months_back integer DEFAULT 0, months_ahead integer DEFAULT 6)
LANGUAGE plpgsql
AS $$
DECLARE
  base timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
  lo timestamptz;
  hi timestamptz;
  part text;
BEGIN
  IF months_ahead IS NULL OR months_ahead < 1 OR months_ahead > 60 THEN
    RAISE EXCEPTION 'months_ahead must be between 1 and 60';
  END IF;
  IF months_back IS NULL OR months_back < 0 OR months_back > 240 THEN
    RAISE EXCEPTION 'months_back must be between 0 and 240';
  END IF;
  PERFORM set_config('lock_timeout', '10s', true);
  FOR i IN -months_back .. months_ahead LOOP
    lo := (base + make_interval(months => i)) AT TIME ZONE 'UTC';
    hi := (base + make_interval(months => i + 1)) AT TIME ZONE 'UTC';
    part := 'audit_events_' || to_char(base + make_interval(months => i), 'YYYY_MM');
    CONTINUE WHEN to_regclass(format('public.%I', part)) IS NOT NULL;
    IF to_regclass('public.audit_events_default') IS NOT NULL
       AND EXISTS (SELECT 1 FROM audit_events_default WHERE "occurredAt" >= lo AND "occurredAt" < hi) THEN
      EXECUTE format('CREATE TABLE %I (LIKE audit_events INCLUDING DEFAULTS)', part);
      EXECUTE format(
        'WITH moved AS (DELETE FROM audit_events_default WHERE "occurredAt" >= %L AND "occurredAt" < %L RETURNING *) INSERT INTO %I SELECT * FROM moved',
        lo, hi, part);
      EXECUTE format('ALTER TABLE audit_events ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
    ELSE
      EXECUTE format('CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, safry_app', part);
  END LOOP;
END
$$;

CREATE TABLE "audit_events_default" PARTITION OF "audit_events" DEFAULT;
REVOKE ALL ON TABLE "audit_events_default" FROM PUBLIC, safry_app;

DO $$
DECLARE
  cutoff timestamptz := (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '24 months') AT TIME ZONE 'UTC';
BEGIN
  EXECUTE format('CREATE TABLE audit_events_legacy PARTITION OF audit_events FOR VALUES FROM (MINVALUE) TO (%L)', cutoff);
  REVOKE ALL ON TABLE audit_events_legacy FROM PUBLIC, safry_app;
END
$$;

CALL ensure_audit_event_partitions(24, 12);

DO $$
DECLARE
  before_rows bigint;
  after_rows bigint;
  in_default bigint;
BEGIN
  SELECT count(*) INTO before_rows FROM "audit_events_old";
  INSERT INTO "audit_events" SELECT * FROM "audit_events_old";
  SELECT count(*) INTO after_rows FROM "audit_events";
  IF before_rows <> after_rows THEN
    RAISE EXCEPTION 'audit_events partitioning: copied % of % rows', after_rows, before_rows;
  END IF;
  SELECT count(*) INTO in_default FROM "audit_events_default";
  RAISE NOTICE 'audit_events partitioning: % rows copied, % in the default partition', after_rows, in_default;
END
$$;

DROP TABLE "audit_events_old";

ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id", "occurredAt");
CREATE INDEX "audit_events_tenantId_occurredAt_idx" ON "audit_events"("tenantId", "occurredAt");
CREATE INDEX "audit_events_actorUserId_occurredAt_idx" ON "audit_events"("actorUserId", "occurredAt");
CREATE INDEX "audit_events_tenantId_action_occurredAt_idx" ON "audit_events"("tenantId", "action", "occurredAt");
CREATE INDEX "audit_events_tenantId_entityType_entityId_occurredAt_idx" ON "audit_events"("tenantId", "entityType", "entityId", "occurredAt");
CREATE INDEX "audit_events_occurredAt_idx" ON "audit_events"("occurredAt");
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Same row-level security and append-only grants as before (20261007_authz_rls_hardening): platform-level (NULL-tenant)
-- events can only be written from the explicit system scope.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "audit_events";
CREATE POLICY tenant_isolation ON "audit_events"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());
GRANT SELECT, INSERT ON TABLE "audit_events" TO safry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_events" FROM safry_app;

-- Retention: drop every partition that lies wholly before now() - retention (default 24 months, minimum 30 days; month
-- granularity, so rows are kept up to one month longer than the retention). The default partition is never dropped.
-- Replaces the row-by-row version from 20261007_db_audit_immutability_retention. Owner only.
DROP PROCEDURE IF EXISTS purge_audit_events(interval, integer);
CREATE OR REPLACE PROCEDURE purge_audit_events(retention interval DEFAULT interval '24 months')
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff timestamptz := now() - retention;
  r record;
  dropped text[] := '{}';
  previous text := coalesce(current_setting('app.bypass_rls', true), '');
BEGIN
  IF retention IS NULL OR retention < interval '30 days' THEN
    RAISE EXCEPTION 'audit retention must be at least 30 days';
  END IF;
  -- DROP TABLE of a partition needs ACCESS EXCLUSIVE on the parent, and every audit insert queues behind a waiting
  -- request. ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY would avoid that but PostgreSQL refuses it inside a function or
  -- procedure ("cannot be executed from a function"), so the stall is bounded instead: each attempt waits at most 500 ms for the
  -- lock, then gives the queue up and retries after a pause (5 attempts, 1..4 s apart); failure after that raises, the next
  -- daily run tries again. Writers therefore never wait more than ~500 ms behind the purge.
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

REVOKE ALL ON PROCEDURE ensure_audit_event_partitions(integer, integer) FROM PUBLIC, safry_app;
REVOKE ALL ON PROCEDURE purge_audit_events(interval) FROM PUBLIC, safry_app;

SELECT set_config('app.bypass_rls', 'off', false);
