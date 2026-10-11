-- The audit trail is append-only for the application role.
-- The application never updates or deletes audit rows (grep: only scripts that connect as owner).
-- Foreign-key actions (ON DELETE SET NULL) run with the table owner's rights, so they are unaffected.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_events" FROM safry_app;

-- / refresh_sessions growth: retention as batched, resumable procedures.
-- Run by the owner role (cron / scheduler), never by the app role. Usage:
--   CALL purge_refresh_sessions(interval '30 days');            -- expired or revoked more than 30 days ago
--   CALL purge_audit_events(interval '24 months');              -- audit rows older than 24 months
-- Each batch commits on its own, so no long lock or WAL burst. The retention period is a
-- business/legal decision: there is deliberately no default (set it per deployment).
CREATE OR REPLACE PROCEDURE purge_refresh_sessions(retention interval, batch_size integer DEFAULT 5000)
LANGUAGE plpgsql
AS $$
DECLARE
  removed bigint;
BEGIN
  IF retention < interval '1 day' THEN
    RAISE EXCEPTION 'refresh session retention must be at least 1 day';
  END IF;
  PERFORM set_config('app.bypass_rls', 'on', false);
  LOOP
    DELETE FROM "refresh_sessions"
    WHERE "id" IN (
      SELECT "id" FROM "refresh_sessions"
      WHERE "expiresAt" < now() - retention
         OR ("revokedAt" IS NOT NULL AND "revokedAt" < now() - retention)
      LIMIT batch_size
    );
    GET DIAGNOSTICS removed = ROW_COUNT;
    COMMIT;
    EXIT WHEN removed = 0;
  END LOOP;
  PERFORM set_config('app.bypass_rls', 'off', false);
END
$$;

CREATE OR REPLACE PROCEDURE purge_audit_events(retention interval, batch_size integer DEFAULT 5000)
LANGUAGE plpgsql
AS $$
DECLARE
  removed bigint;
BEGIN
  IF retention < interval '30 days' THEN
    RAISE EXCEPTION 'audit retention must be at least 30 days';
  END IF;
  PERFORM set_config('app.bypass_rls', 'on', false);
  LOOP
    DELETE FROM "audit_events"
    WHERE "id" IN (SELECT "id" FROM "audit_events" WHERE "occurredAt" < now() - retention LIMIT batch_size);
    GET DIAGNOSTICS removed = ROW_COUNT;
    COMMIT;
    EXIT WHEN removed = 0;
  END LOOP;
  PERFORM set_config('app.bypass_rls', 'off', false);
END
$$;

REVOKE ALL ON PROCEDURE purge_refresh_sessions(interval, integer) FROM PUBLIC, safry_app;
REVOKE ALL ON PROCEDURE purge_audit_events(interval, integer) FROM PUBLIC, safry_app;
