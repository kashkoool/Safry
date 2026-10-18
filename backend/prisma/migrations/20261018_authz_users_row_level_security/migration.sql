-- Row-level security for the global "users" table.
--
-- users has no tenant column; an identity belongs to a tenant through tenant_memberships. A tenant session may therefore
--   * read and update only identities that hold a membership in app_current_tenant(),
--   * never delete an identity,
--   * insert an identity, or look one up that has no membership here yet (staff creation, invitations), only while the
--     narrow flag app.identity_system is raised for that single statement group (src/database/identity-access.ts).
-- The explicit system scope (app.bypass_rls = on: login, registration, platform administration, operator scripts) sees all.
-- The platform-admin flag trigger from 20261007/20261008 stays; it is extended below with a column allow-list.
-- Needs no data change. A running image from before this release cannot create staff or invite from a tenant session
-- until it is replaced (see backend/docs/database-operations.md): roll the migration and the new image out together.

CREATE OR REPLACE FUNCTION app_identity_system() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.identity_system', true), '') = 'on' $$;

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "users";
DROP POLICY IF EXISTS users_select ON "users";
DROP POLICY IF EXISTS users_insert ON "users";
DROP POLICY IF EXISTS users_update ON "users";
DROP POLICY IF EXISTS users_delete ON "users";

CREATE POLICY users_select ON "users" FOR SELECT
  USING (app_rls_bypass() OR app_identity_system() OR EXISTS (
    SELECT 1 FROM "tenant_memberships" m WHERE m."userId" = "users"."id" AND m."tenantId" = app_current_tenant()));

CREATE POLICY users_insert ON "users" FOR INSERT
  WITH CHECK (app_rls_bypass() OR app_identity_system());

CREATE POLICY users_update ON "users" FOR UPDATE
  USING (app_rls_bypass() OR EXISTS (
    SELECT 1 FROM "tenant_memberships" m WHERE m."userId" = "users"."id" AND m."tenantId" = app_current_tenant()))
  WITH CHECK (app_rls_bypass() OR EXISTS (
    SELECT 1 FROM "tenant_memberships" m WHERE m."userId" = "users"."id" AND m."tenantId" = app_current_tenant()));

CREATE POLICY users_delete ON "users" FOR DELETE
  USING (app_rls_bypass());

-- A tenant session may edit only the profile columns of a member; email, password hash, MFA state, status and the
-- like belong to the identity's own flows, which run in the system scope. An allow-list, so a column added later
-- is protected by default.
CREATE OR REPLACE FUNCTION app_guard_platform_admin_flag() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER')
     AND NOT app_rls_bypass() THEN
    IF TG_OP = 'INSERT' AND NEW."isPlatformAdmin"
       OR TG_OP = 'UPDATE' AND NEW."isPlatformAdmin" IS DISTINCT FROM OLD."isPlatformAdmin" THEN
      RAISE EXCEPTION 'isPlatformAdmin can only be changed by the platform' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - ARRAY['displayName', 'phone', 'locale', 'updatedAt'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['displayName', 'phone', 'locale', 'updatedAt']) THEN
      RAISE EXCEPTION 'identity columns can only be changed by the platform' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
