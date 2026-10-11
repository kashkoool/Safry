-- tighten what the restricted application role (safry_app) may do.

-- The audit trail is append-only for the application.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_events" FROM safry_app;

-- Platform-level (NULL-tenant) audit events can only be written from the explicit system scope.
DROP POLICY IF EXISTS tenant_isolation ON "audit_events";
CREATE POLICY tenant_isolation ON "audit_events"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- The permission catalogue is maintained by migrations and the seed (table owner), never at run time.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "permissions" FROM safry_app;

-- role_permissions has no tenant column: a tenant session may only see or change rows of its own roles.
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "role_permissions";
CREATE POLICY tenant_isolation ON "role_permissions"
  USING (app_rls_bypass() OR EXISTS (
    SELECT 1 FROM "roles" r WHERE r."id" = "role_permissions"."roleId" AND r."tenantId" = app_current_tenant()))
  WITH CHECK (app_rls_bypass() OR EXISTS (
    SELECT 1 FROM "roles" r WHERE r."id" = "role_permissions"."roleId" AND r."tenantId" = app_current_tenant()));

-- users is global (no tenant column, read during login): a tenant session may never grant or remove
-- platform-administrator status; only the explicit system scope (platform administration) can.
CREATE OR REPLACE FUNCTION app_guard_platform_admin_flag() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_user = 'safry_app' AND NOT app_rls_bypass()
     AND (TG_OP = 'INSERT' AND NEW."isPlatformAdmin"
          OR TG_OP = 'UPDATE' AND NEW."isPlatformAdmin" IS DISTINCT FROM OLD."isPlatformAdmin") THEN
    RAISE EXCEPTION 'isPlatformAdmin can only be changed by the platform' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS users_platform_admin_guard ON "users";
CREATE TRIGGER users_platform_admin_guard BEFORE INSERT OR UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION app_guard_platform_admin_flag();
