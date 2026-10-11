ALTER TABLE "provider_organizations" ADD COLUMN "specialties" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "tenant_memberships" ADD COLUMN "departmentId" UUID;

CREATE TABLE "organization_departments" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "organization_departments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "organization_departments_organizationId_code_key" ON "organization_departments"("organizationId", "code");
CREATE UNIQUE INDEX "organization_departments_id_organizationId_tenantId_key" ON "organization_departments"("id", "organizationId", "tenantId");
CREATE INDEX "organization_departments_tenantId_organizationId_idx" ON "organization_departments"("tenantId", "organizationId");
ALTER TABLE "organization_departments" ADD CONSTRAINT "organization_departments_organizationId_tenantId_fkey"
  FOREIGN KEY ("organizationId", "tenantId") REFERENCES "provider_organizations"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_departmentId_providerOrganizationId_tenantId_fkey"
  FOREIGN KEY ("departmentId", "providerOrganizationId", "tenantId")
  REFERENCES "organization_departments"("id", "organizationId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "permissions" ("id", "code", "description", "createdAt")
VALUES (gen_random_uuid(), 'organization.staff.manage', 'Manage departments and staff of an assigned organization', CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "roles" ("id", "tenantId", "code", "name", "isSystem", "createdAt", "updatedAt")
SELECT gen_random_uuid(), t."id", 'organization-manager', 'مسؤول المنشأة', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "tenants" t ON CONFLICT ("tenantId", "code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p
WHERE r."code" = 'organization-manager' AND p."code" = 'organization.staff.manage'
ON CONFLICT DO NOTHING;
