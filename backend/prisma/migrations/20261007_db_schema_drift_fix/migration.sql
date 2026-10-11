-- Make the migration history reproduce schema.prisma exactly (`prisma migrate diff` is empty).
-- Prisma sets "updatedAt" itself (@updatedAt); migration 0003 had left a database default behind.
ALTER TABLE "provider_organizations" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- Prisma truncates generated constraint names to 63 characters.
ALTER TABLE "tenant_memberships"
  RENAME CONSTRAINT "tenant_memberships_departmentId_providerOrganizationId_tenantId"
  TO "tenant_memberships_departmentId_providerOrganizationId_ten_fkey";
