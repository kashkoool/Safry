-- Indexes for foreign-key columns and tenant-first access paths.
-- PostgreSQL does not index referencing columns automatically; every missing index below made the
-- listed lookup (and the RESTRICT / CASCADE check on the parent row) a sequential scan.
-- Tenant-first column order also serves the row-level-security predicate ("tenantId" = app_current_tenant()).
-- Large tables: `prisma migrate deploy` runs a multi-statement file in one transaction, where
-- CREATE INDEX CONCURRENTLY is not allowed. Once a table is big, pre-create the index with the same
-- name and CONCURRENTLY (see backend/docs/database-operations.md); IF NOT EXISTS then makes this a no-op.

CREATE INDEX IF NOT EXISTS "tenant_memberships_tenantId_providerOrganizationId_idx" ON "tenant_memberships"("tenantId", "providerOrganizationId");
CREATE INDEX IF NOT EXISTS "tenant_memberships_tenantId_departmentId_idx" ON "tenant_memberships"("tenantId", "departmentId");
CREATE INDEX IF NOT EXISTS "travel_services_tenantId_providerOrganizationId_idx" ON "travel_services"("tenantId", "providerOrganizationId");
CREATE INDEX IF NOT EXISTS "service_components_tenantId_serviceId_idx" ON "service_components"("tenantId", "serviceId");
CREATE INDEX IF NOT EXISTS "membership_roles_tenantId_roleId_idx" ON "membership_roles"("tenantId", "roleId");
CREATE INDEX IF NOT EXISTS "refresh_sessions_membershipId_idx" ON "refresh_sessions"("membershipId");
CREATE INDEX IF NOT EXISTS "refresh_sessions_expiresAt_idx" ON "refresh_sessions"("expiresAt");
CREATE INDEX IF NOT EXISTS "audit_events_tenantId_action_occurredAt_idx" ON "audit_events"("tenantId", "action", "occurredAt");
CREATE INDEX IF NOT EXISTS "audit_events_tenantId_entityType_entityId_occurredAt_idx" ON "audit_events"("tenantId", "entityType", "entityId", "occurredAt");
CREATE INDEX IF NOT EXISTS "audit_events_occurredAt_idx" ON "audit_events"("occurredAt");

-- Superseded by the wider indexes above (left-prefix equivalents).
DROP INDEX IF EXISTS "membership_roles_tenantId_idx";
DROP INDEX IF EXISTS "audit_events_entityType_entityId_idx";
