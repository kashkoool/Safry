-- Personal-data erasure for deleted accounts and IP-address retention for the audit trail. Additive and backward compatible
-- (the previous application version ignores the new column and the new routines).
--
-- 1. users."anonymisedAt": marks an account whose personal data was removed. The row itself stays (bookings, payment records and the
--    audit trail keep resolving to it); only the personal columns are replaced.
-- 2. anonymise_deleted_users_batch: ONE batch (returns the number of users handled). For every user soft-deleted (deletedAt) longer ago
--    than the retention: e-mail becomes a unique tombstone, phone and display name are blanked, the password hash and the MFA state are
--    replaced or cleared, refresh sessions and credential links are deleted, and the free-text / personal keys are stripped from the
--    metadata of the audit rows that name the user. The audit rows themselves are kept (action, time, entity), as are bookings and memberships.
-- 3. scrub_audit_ip_addresses_batch: ONE batch. Clears audit_events."ipAddress" once a row is older than the retention, for ALL users.
--    The application role still has no UPDATE or DELETE on the audit table (migration 20261007_db_audit_immutability_retention is
--    unchanged); the routine runs with the owner's rights. No row is removed.
-- 4. The two batch functions follow the maintenance-login design of 20261020_maintenance_role: SECURITY DEFINER, pinned search_path,
--    a policy floor (maintenance_policy: the effective cutoff is the OLDER of now()-argument and now()-floor, so the login cannot anonymise
--    sooner or clear IP addresses sooner than the owner allowed), a batch cap, and EXECUTE granted to safry_maintenance_ops only. Two count
--    functions serve the dry run. The owner-run procedures anonymise_deleted_users / scrub_audit_ip_addresses keep working: they loop over
--    the functions and commit per batch.
-- 5. A partial index so the IP scrub finds the remaining rows without reading the whole history every night.
-- 6. erasure_overdue_counts: read by the API for the "erasure job is not keeping up" metric.
ALTER TABLE "users" ADD COLUMN "anonymisedAt" TIMESTAMPTZ(3);

CREATE INDEX "audit_events_occurredAt_with_ip_idx" ON "audit_events"("occurredAt") WHERE "ipAddress" IS NOT NULL;

-- Floors default to the proposed defaults (counsel must confirm): to erase sooner, the owner lowers the floor first, e.g.
--   CALL set_maintenance_policy('user_anonymisation', interval '14 days');
INSERT INTO "maintenance_policy" ("setting", "minimum") VALUES
  ('user_anonymisation', interval '30 days'),
  ('audit_ip_retention', interval '90 days');

CREATE OR REPLACE FUNCTION anonymise_deleted_users_batch(retention interval, batch_size integer DEFAULT 500) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  ids uuid[];
  cutoff timestamptz;
  anonymised bigint;
  -- Keys that can hold personal data or free text in audit metadata (platform operator reasons, profile before-values).
  pii_keys CONSTANT text[] := ARRAY['reason', 'email', 'displayName', 'phone', 'name'];
BEGIN
  IF retention IS NULL OR retention < interval '1 day' THEN
    RAISE EXCEPTION 'anonymisation delay must be at least 1 day';
  END IF;
  cutoff := least(now() - retention, now() - maintenance_policy_floor('user_anonymisation'));
  batch_size := least(greatest(coalesce(batch_size, 500), 1), 10000);
  PERFORM set_config('app.bypass_rls', 'on', true);
  -- SKIP LOCKED: an account being restored or edited right now is left to the next run.
  SELECT array_agg(s."id") INTO ids FROM (
    SELECT "id" FROM "users"
    WHERE "deletedAt" IS NOT NULL AND "deletedAt" < cutoff AND "anonymisedAt" IS NULL
    ORDER BY "deletedAt"
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  ) s;
  IF ids IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM "refresh_sessions" WHERE "userId" = ANY(ids);
  DELETE FROM "credential_tokens" WHERE "userId" = ANY(ids);
  UPDATE "audit_events"
  SET "metadata" = (CASE WHEN jsonb_typeof("metadata" -> 'before') = 'object' THEN "metadata" - 'before' ELSE "metadata" END) - pii_keys
  WHERE ("actorUserId" = ANY(ids) OR ("entityType" = 'user' AND "entityId" = ANY(ids::text[])))
    AND ("metadata" ?| pii_keys OR jsonb_typeof("metadata" -> 'before') = 'object');
  UPDATE "users"
  SET "email" = 'deleted-' || "id"::text || '@anonymised.invalid',
      "emailNormalized" = 'deleted-' || "id"::text || '@anonymised.invalid',
      "displayName" = 'Deleted user',
      "phone" = NULL,
      -- Not a valid password hash: verification fails for every input. The account is also DISABLED.
      "passwordHash" = '!anonymised',
      "mfaSecretEnc" = NULL,
      "mfaEnabledAt" = NULL,
      "mfaLastStep" = NULL,
      "mfaRecoveryHashes" = '[]'::jsonb,
      "mfaRecoveryRegenerationRequired" = false,
      "mfaChallengeHash" = NULL,
      "status" = 'DISABLED',
      "authVersion" = "authVersion" + 1,
      "anonymisedAt" = now(),
      "updatedAt" = now()
  WHERE "id" = ANY(ids);
  GET DIAGNOSTICS anonymised = ROW_COUNT;
  RETURN anonymised;
END
$$;

CREATE OR REPLACE FUNCTION anonymise_deleted_users_count(retention interval) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  cutoff timestamptz;
  pending bigint;
BEGIN
  IF retention IS NULL OR retention < interval '1 day' THEN
    RAISE EXCEPTION 'anonymisation delay must be at least 1 day';
  END IF;
  cutoff := least(now() - retention, now() - maintenance_policy_floor('user_anonymisation'));
  PERFORM set_config('app.bypass_rls', 'on', true);
  SELECT count(*) INTO pending FROM "users" WHERE "deletedAt" IS NOT NULL AND "deletedAt" < cutoff AND "anonymisedAt" IS NULL;
  RETURN pending;
END
$$;

CREATE OR REPLACE FUNCTION scrub_audit_ip_addresses_batch(retention interval, batch_size integer DEFAULT 5000) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  cutoff timestamptz;
  changed bigint;
BEGIN
  IF retention IS NULL OR retention < interval '1 day' THEN
    RAISE EXCEPTION 'audit IP retention must be at least 1 day';
  END IF;
  cutoff := least(now() - retention, now() - maintenance_policy_floor('audit_ip_retention'));
  batch_size := least(greatest(coalesce(batch_size, 5000), 1), 100000);
  PERFORM set_config('app.bypass_rls', 'on', true);
  UPDATE "audit_events" a SET "ipAddress" = NULL
  FROM (
    SELECT "id", "occurredAt" FROM "audit_events"
    WHERE "ipAddress" IS NOT NULL AND "occurredAt" < cutoff
    LIMIT batch_size
  ) s
  WHERE a."id" = s."id" AND a."occurredAt" = s."occurredAt";
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$$;

CREATE OR REPLACE FUNCTION scrub_audit_ip_addresses_count(retention interval) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  cutoff timestamptz;
  pending bigint;
BEGIN
  IF retention IS NULL OR retention < interval '1 day' THEN
    RAISE EXCEPTION 'audit IP retention must be at least 1 day';
  END IF;
  cutoff := least(now() - retention, now() - maintenance_policy_floor('audit_ip_retention'));
  PERFORM set_config('app.bypass_rls', 'on', true);
  SELECT count(*) INTO pending FROM "audit_events" WHERE "ipAddress" IS NOT NULL AND "occurredAt" < cutoff;
  RETURN pending;
END
$$;

-- The owner-run procedures keep their signatures; dry_run only counts and reports (RAISE NOTICE).
CREATE OR REPLACE PROCEDURE anonymise_deleted_users(retention interval, batch_size integer DEFAULT 500, dry_run boolean DEFAULT false)
LANGUAGE plpgsql
AS $$
DECLARE
  handled bigint;
  total bigint := 0;
BEGIN
  IF dry_run THEN
    RAISE NOTICE 'anonymise_deleted_users dry run: % user(s) would be anonymised', anonymise_deleted_users_count(retention);
    RETURN;
  END IF;
  LOOP
    handled := anonymise_deleted_users_batch(retention, batch_size);
    total := total + handled;
    COMMIT;
    EXIT WHEN handled = 0;
  END LOOP;
  RAISE NOTICE 'anonymise_deleted_users: % user(s) anonymised', total;
END
$$;

CREATE OR REPLACE PROCEDURE scrub_audit_ip_addresses(retention interval, batch_size integer DEFAULT 5000, dry_run boolean DEFAULT false)
LANGUAGE plpgsql
AS $$
DECLARE
  handled bigint;
  total bigint := 0;
BEGIN
  IF dry_run THEN
    RAISE NOTICE 'scrub_audit_ip_addresses dry run: % audit row(s) would lose their IP address', scrub_audit_ip_addresses_count(retention);
    RETURN;
  END IF;
  LOOP
    handled := scrub_audit_ip_addresses_batch(retention, batch_size);
    total := total + handled;
    COMMIT;
    EXIT WHEN handled = 0;
  END LOOP;
  RAISE NOTICE 'scrub_audit_ip_addresses: % audit row(s) lost their IP address', total;
END
$$;

-- Rows the erasure job should already have handled (older than the cutoff the caller passes). A cutoff of 0 days = that part disabled.
CREATE OR REPLACE FUNCTION erasure_overdue_counts(user_cutoff_days integer, ip_cutoff_days integer)
RETURNS TABLE (users_pending bigint, audit_ip_pending bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  users_pending := 0;
  audit_ip_pending := 0;
  IF user_cutoff_days > 0 THEN
    SELECT count(*) INTO users_pending FROM "users"
    WHERE "deletedAt" IS NOT NULL AND "deletedAt" < now() - make_interval(days => user_cutoff_days) AND "anonymisedAt" IS NULL;
  END IF;
  IF ip_cutoff_days > 0 THEN
    SELECT count(*) INTO audit_ip_pending FROM (
      SELECT 1 FROM "audit_events" WHERE "ipAddress" IS NOT NULL AND "occurredAt" < now() - make_interval(days => ip_cutoff_days) LIMIT 1000
    ) x;
  END IF;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION anonymise_deleted_users_batch(interval, integer) FROM PUBLIC, safry_app;
REVOKE ALL ON FUNCTION anonymise_deleted_users_count(interval) FROM PUBLIC, safry_app;
REVOKE ALL ON FUNCTION scrub_audit_ip_addresses_batch(interval, integer) FROM PUBLIC, safry_app;
REVOKE ALL ON FUNCTION scrub_audit_ip_addresses_count(interval) FROM PUBLIC, safry_app;
REVOKE ALL ON PROCEDURE anonymise_deleted_users(interval, integer, boolean) FROM PUBLIC, safry_app;
REVOKE ALL ON PROCEDURE scrub_audit_ip_addresses(interval, integer, boolean) FROM PUBLIC, safry_app;
REVOKE ALL ON FUNCTION erasure_overdue_counts(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erasure_overdue_counts(integer, integer) TO safry_app;
GRANT EXECUTE ON FUNCTION anonymise_deleted_users_batch(interval, integer) TO safry_maintenance_ops;
GRANT EXECUTE ON FUNCTION anonymise_deleted_users_count(interval) TO safry_maintenance_ops;
GRANT EXECUTE ON FUNCTION scrub_audit_ip_addresses_batch(interval, integer) TO safry_maintenance_ops;
GRANT EXECUTE ON FUNCTION scrub_audit_ip_addresses_count(interval) TO safry_maintenance_ops;
