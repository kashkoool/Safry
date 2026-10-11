-- Backfill first: an earlier version of the invitation flow could leave a membership ACTIVE while still awaiting owner consent, and the
-- constraint below would abort the deploy on such a row. Move them back to INVITED (the safe state) and audit each.
-- FORCE ROW LEVEL SECURITY applies to the migration role too, so enable the system scope for this session (a transaction-local setting does not survive
-- statement-by-statement execution under prisma migrate deploy) and clear it straight after.
SELECT set_config('app.bypass_rls', 'on', false);
WITH reverted AS (
  UPDATE "tenant_memberships" SET status = 'INVITED'
  WHERE status = 'ACTIVE' AND "awaitingOwnerConsent"
  RETURNING id, "tenantId", "userId"
)
INSERT INTO "audit_events" (id, "tenantId", "actorUserId", action, "entityType", "entityId", metadata)
SELECT gen_random_uuid(), "tenantId", NULL, 'membership.consent_backfill_reverted', 'TenantMembership', id::text,
       jsonb_build_object('userId', "userId", 'from', 'ACTIVE', 'to', 'INVITED', 'reason', 'activated without owner consent')
FROM reverted;
SELECT set_config('app.bypass_rls', '', false);

-- an invitation becomes active only through its owner accepting it.
-- awaitingOwnerConsent stays true after a revoke or a decline, so nobody can activate it later.
ALTER TABLE "tenant_memberships" DROP CONSTRAINT IF EXISTS tenant_memberships_active_requires_consent;
ALTER TABLE "tenant_memberships"
  ADD CONSTRAINT tenant_memberships_active_requires_consent
  CHECK (status <> 'ACTIVE' OR NOT "awaitingOwnerConsent");

-- Consent can be cleared only by the acceptance itself (to ACTIVE), never by a revoke or suspension.
CREATE OR REPLACE FUNCTION app_guard_membership_consent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD."awaitingOwnerConsent" AND NOT NEW."awaitingOwnerConsent" AND NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'an invitation is cleared only by its owner accepting it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS tenant_memberships_consent_guard ON "tenant_memberships";
CREATE TRIGGER tenant_memberships_consent_guard BEFORE UPDATE ON "tenant_memberships"
  FOR EACH ROW EXECUTE FUNCTION app_guard_membership_consent();
