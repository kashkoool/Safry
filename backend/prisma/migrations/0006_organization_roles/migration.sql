ALTER TABLE "roles" ADD COLUMN "organizationId" UUID;
CREATE INDEX "roles_organizationId_idx" ON "roles"("organizationId");
ALTER TABLE "roles" ADD CONSTRAINT "roles_organizationId_tenantId_fkey"
  FOREIGN KEY ("organizationId", "tenantId") REFERENCES "provider_organizations"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
