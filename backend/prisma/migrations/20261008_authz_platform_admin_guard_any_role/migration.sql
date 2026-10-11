-- The platform-admin guard protected only the role named safry_app.
-- Protect against every session that is not the table owner (or a member of it), whatever the login is called.
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
