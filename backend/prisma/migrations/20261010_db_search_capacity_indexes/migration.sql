-- trigram indexes for the case-insensitive substring search used by the platform
-- admin lists (Prisma `contains` + `mode: insensitive` becomes ILIKE '%term%', which a btree cannot serve),
-- and a date-range index for the capacity check.
-- pg_trgm is a trusted extension (PostgreSQL 13+): the database owner may create it without SUPERUSER.
-- Large tables: plain CREATE INDEX blocks writes while it builds; once a table is big, pre-create the same
-- index name with CONCURRENTLY (backend/docs/database-operations.md); IF NOT EXISTS then makes this a no-op.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "users_email_trgm_idx" ON "users" USING GIN ("email" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_displayName_trgm_idx" ON "users" USING GIN ("displayName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "travel_services_title_trgm_idx" ON "travel_services" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "provider_organizations_name_trgm_idx" ON "provider_organizations" USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "bookings_serviceId_serviceDate_endDate_idx" ON "bookings"("serviceId", "serviceDate", "endDate");
