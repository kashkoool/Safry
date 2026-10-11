-- Business rules that lived only in application code, now enforced by the database.
-- Pattern: this migration only ADDs each constraint NOT VALID (enforced for new writes at once). The scan that
-- proves the EXISTING rows is the next migration (20261011_db_validate_constraints), because `prisma migrate deploy` runs a
-- file as one transaction and ACCESS EXCLUSIVE taken by ADD CONSTRAINT would otherwise be held through the whole scan.

-- Pre-flight: fail with a readable message listing the offending rows BEFORE any constraint or index is created, instead of a
-- bare constraint error that leaves a failed migration to `migrate resolve`. Fix the data (never skip a rule), then redeploy.
DO $preflight$
DECLARE
  rule record;
  bad bigint;
  sample text;
  problems text := '';
BEGIN
  -- FORCE ROW LEVEL SECURITY applies to a non-superuser owner: without the bypass flag this check would silently see no tenant
  -- rows at all (constraint validation itself is not subject to RLS), so it would pass and the later VALIDATE would fail.
  PERFORM set_config('app.bypass_rls', 'on', true);
  FOR rule IN SELECT * FROM (VALUES
    ('tenants', 'tenants_code_normalized', $p$"code" = lower(btrim("code"))$p$),
    ('users', 'users_email_normalized_matches', $p$"emailNormalized" = lower(btrim("email"))$p$),
    ('users', 'users_failed_login_count_nonneg', $p$"failedLoginCount" >= 0$p$),
    ('bookings', 'bookings_end_not_before_start', $p$"endDate" IS NULL OR "serviceDate" IS NULL OR "endDate" >= "serviceDate"$p$),
    ('bookings', 'bookings_travelers_range', $p$"travelersCount" BETWEEN 1 AND 20$p$),
    ('bookings', 'bookings_units_range', $p$"units" BETWEEN 1 AND 20$p$),
    ('bookings', 'bookings_currency_format', $p$"currency" ~ '^[A-Z]{3}$'$p$),
    ('travel_services', 'travel_services_currency_format', $p$"currency" ~ '^[A-Z]{3}$'$p$),
    ('refresh_sessions', 'refresh_sessions_token_hash_hex', $p$"tokenHash" ~ '^[0-9a-f]{64}$'$p$),
    ('refresh_sessions', 'refresh_sessions_expiry_after_creation', $p$"expiresAt" > "createdAt"$p$)
  ) AS r(tbl, name, predicate)
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE NOT (%s)', rule.tbl, rule.predicate) INTO bad;
    IF bad > 0 THEN
      EXECUTE format('SELECT string_agg(id::text, '', '') FROM (SELECT id FROM %I WHERE NOT (%s) LIMIT 5) s', rule.tbl, rule.predicate) INTO sample;
      problems := problems || format(E'
  %s.%s: %s row(s) violate (%s), e.g. ids %s', rule.tbl, rule.name, bad, rule.predicate, sample);
    END IF;
  END LOOP;
  SELECT count(*) INTO bad FROM (
    SELECT 1 FROM "provider_organizations" GROUP BY "tenantId", lower(btrim("name")) HAVING count(*) > 1
  ) d;
  IF bad > 0 THEN
    problems := problems || format(E'
  provider_organizations: %s group(s) of organizations share a name within one tenant (case/space-insensitive); query: SELECT "tenantId", lower(btrim("name")), count(*) FROM provider_organizations GROUP BY 1, 2 HAVING count(*) > 1', bad);
  END IF;
  PERFORM set_config('app.bypass_rls', 'off', true);
  IF problems <> '' THEN
    RAISE EXCEPTION 'db_constraints pre-flight: existing data breaks the new rules, fix it and redeploy:%', problems;
  END IF;
END
$preflight$;

ALTER TABLE "tenants" ADD CONSTRAINT "tenants_code_normalized" CHECK ("code" = lower(btrim("code"))) NOT VALID;
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized_matches" CHECK ("emailNormalized" = lower(btrim("email"))) NOT VALID;
ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_count_nonneg" CHECK ("failedLoginCount" >= 0) NOT VALID;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_end_not_before_start" CHECK ("endDate" IS NULL OR "serviceDate" IS NULL OR "endDate" >= "serviceDate") NOT VALID;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_travelers_range" CHECK ("travelersCount" BETWEEN 1 AND 20) NOT VALID;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_units_range" CHECK ("units" BETWEEN 1 AND 20) NOT VALID;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$') NOT VALID;
ALTER TABLE "travel_services" ADD CONSTRAINT "travel_services_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$') NOT VALID;
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_token_hash_hex" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_expiry_after_creation" CHECK ("expiresAt" > "createdAt") NOT VALID;

-- Tenant-scoped, case-insensitive organization names (duplicates by spelling are rejected; the
-- global P2002 filter turns the violation into a 409). Expression index: not representable in
-- schema.prisma, `prisma migrate diff` does not compare it.
CREATE UNIQUE INDEX IF NOT EXISTS "provider_organizations_tenantId_lower_name_key" ON "provider_organizations"("tenantId", lower(btrim("name")));
