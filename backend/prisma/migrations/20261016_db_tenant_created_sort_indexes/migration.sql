-- The paginated lists (bookings, services) filter by tenant and sort newest first (createdAt DESC, id DESC). Without a matching
-- index the unfiltered admin list sorts the whole tenant's rows for every first page. Additive only: no existing index, column
-- or constraint changes, so the previous release keeps working against this schema.
-- Large tables: `prisma migrate deploy` runs this file in one transaction, where CREATE INDEX CONCURRENTLY is not allowed. On a table
-- that is already big, pre-create the same index by name with CONCURRENTLY (backend/docs/database-operations.md); IF NOT EXISTS then
-- makes this statement a no-op.

CREATE INDEX IF NOT EXISTS "bookings_tenantId_createdAt_id_idx" ON "bookings"("tenantId", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "travel_services_tenantId_createdAt_id_idx" ON "travel_services"("tenantId", "createdAt" DESC, "id" DESC);
