-- Decision: dev data only; count first, delete, then NOT NULL.
-- Bookings created before the service date became mandatory have serviceDate NULL; the application has required it on every
-- create and update since then, so a NULL row is by definition a legacy row that can not be backfilled (no date to infer).
-- Only those rows are removed. Valid rows are never touched.
--
-- Pre-flight: a legacy row that was CONFIRMED may be a real commitment. Such rows stop the migration with a readable message;
-- after reviewing them the operator cancels or deletes them deliberately (the message gives the statement), marks this migration
-- rolled back and deploys again. (A database-level setting can not serve as confirmation: a hosted owner role may not set it.)
-- PENDING and CANCELLED legacy rows are removed without a prompt. Nothing references bookings (no foreign key points at it), so no
-- dependent row can be orphaned; the audit trail keeps its history.
-- Rollback-safe: the previous image always writes a date, so NOT NULL never rejects its inserts.
SELECT set_config('app.bypass_rls', 'on', false);

DO $$
DECLARE
  total bigint;
  settled bigint;
  by_status jsonb;
  removed bigint;
BEGIN
  SELECT coalesce(sum(n), 0), coalesce(sum(n) FILTER (WHERE status = 'CONFIRMED'), 0), coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
    INTO total, settled, by_status
  FROM (SELECT status::text AS status, count(*) AS n FROM "bookings" WHERE "serviceDate" IS NULL GROUP BY status) s;
  RAISE NOTICE 'bookings legacy rows without serviceDate: % (by status: %)', total, by_status;

  IF settled > 0 THEN
    RAISE EXCEPTION 'bookings pre-flight: % legacy booking(s) without serviceDate are CONFIRMED and would be deleted. Review them; if they are development data run: UPDATE bookings SET status = ''CANCELLED'' WHERE "serviceDate" IS NULL AND status = ''CONFIRMED'' (with app.bypass_rls = on), then mark this migration rolled back (prisma migrate resolve --rolled-back 20261012_db_bookings_service_date_required) and deploy again.', settled;
  END IF;

  IF total > 0 THEN
    DELETE FROM "bookings" WHERE "serviceDate" IS NULL;
    GET DIAGNOSTICS removed = ROW_COUNT;
    IF removed <> total THEN
      RAISE EXCEPTION 'bookings: counted % legacy rows but deleted %', total, removed;
    END IF;
    INSERT INTO "audit_events" (id, "tenantId", "actorUserId", action, "entityType", metadata)
    VALUES (gen_random_uuid(), NULL, NULL, 'booking.legacy_null_service_date_deleted', 'booking',
            jsonb_build_object('deleted', removed, 'byStatus', by_status, 'migration', '20261012_db_bookings_service_date_required'));
  END IF;
END
$$;

SELECT set_config('app.bypass_rls', 'off', false);

-- Pattern of a validated CHECK before SET NOT NULL (lets PostgreSQL skip the second table scan). Note: this file is ONE transaction,
-- so the ACCESS EXCLUSIVE lock from ADD CONSTRAINT is held until commit and the VALIDATE scan runs under it: harmless at the
-- current data volume, but on a large table run it in a maintenance window.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_date_present" CHECK ("serviceDate" IS NOT NULL) NOT VALID;
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_service_date_present";
ALTER TABLE "bookings" ALTER COLUMN "serviceDate" SET NOT NULL;
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_service_date_present";
