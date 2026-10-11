-- a membership created by a tenant-side actor for an identity that already exists
-- stays INVITED until the identity's owner accepts it; managers can not activate it for them.
ALTER TABLE "tenant_memberships" ADD COLUMN "awaitingOwnerConsent" BOOLEAN NOT NULL DEFAULT false;

-- a suspension or revocation decided at tenant level can only be lifted at tenant level.
ALTER TABLE "tenant_memberships" ADD COLUMN "statusLockedByTenant" BOOLEAN NOT NULL DEFAULT false;
