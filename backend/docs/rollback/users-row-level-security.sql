-- Rollback of migration 20261018_authz_users_row_level_security.
-- Run as the table owner (DATABASE_MIGRATE_URL login), then mark the migration as rolled back:
--   pnpm exec prisma migrate resolve --rolled-back 20261018_authz_users_row_level_security
-- This restores the state after 20261008_authz_platform_admin_guard_any_role: no row-level security on "users", and the
-- trigger that guards only "isPlatformAdmin". It loses no data. Note that isolation of "users" is gone until it is re-applied.

DROP POLICY IF EXISTS users_select ON "users";
DROP POLICY IF EXISTS users_insert ON "users";
DROP POLICY IF EXISTS users_update ON "users";
DROP POLICY IF EXISTS users_delete ON "users";
ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_guard_platform_admin_flag() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER')
     AND NOT app_rls_bypass()
     AND (TG_OP = 'INSERT' AND NEW."isPlatformAdmin"
          OR TG_OP = 'UPDATE' AND NEW."isPlatformAdmin" IS DISTINCT FROM OLD."isPlatformAdmin") THEN
    RAISE EXCEPTION 'isPlatformAdmin can only be changed by the platform' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS app_identity_system();
