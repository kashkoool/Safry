-- Tenant Data Isolation: PostgreSQL Row-Level Security as a second
-- line of defence behind the application-level tenant scoping.
--
-- The application connects with a privileged role and, inside every transaction, runs
--   set_config('role', 'safry_app', true)          -- drop to the restricted role
--   set_config('app.tenant_id', '<uuid>', true)    -- tenant of the authenticated request
--   set_config('app.bypass_rls', 'on'|'off', true) -- explicit platform/system scope
-- A session that sets neither value sees no tenant rows (fail closed).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'safry_app') THEN
    CREATE ROLE safry_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT safry_app TO %I', current_user);
EXCEPTION WHEN OTHERS THEN
  NULL; -- superusers do not need an explicit membership to SET ROLE
END
$$;

GRANT USAGE ON SCHEMA public TO safry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO safry_app;
REVOKE ALL ON TABLE "_prisma_migrations" FROM safry_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO safry_app;

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on' $$;

-- Tables keyed by "tenantId".
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_memberships', 'provider_organizations', 'organization_departments',
    'travel_services', 'service_components', 'bookings', 'roles',
    'membership_roles', 'refresh_sessions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_rls_bypass() OR "tenantId" = app_current_tenant()) WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant())',
      t
    );
  END LOOP;
END
$$;

-- The tenant row itself is keyed by "id".
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenants";
CREATE POLICY tenant_isolation ON "tenants"
  USING (app_rls_bypass() OR "id" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "id" = app_current_tenant());

-- Audit events may be platform-level (NULL tenant): readable only with bypass,
-- writable by any tenant session as long as the tenant matches or is NULL.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "audit_events";
CREATE POLICY tenant_isolation ON "audit_events"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" IS NULL OR "tenantId" = app_current_tenant());
