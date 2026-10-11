ALTER TYPE "ServiceCategory" ADD VALUE 'UMRAH';
ALTER TYPE "ServiceCategory" ADD VALUE 'PACKAGE';
ALTER TYPE "ServiceCategory" ADD VALUE 'RESTAURANT';
ALTER TYPE "ServiceCategory" ADD VALUE 'VISA';
ALTER TYPE "ServiceCategory" ADD VALUE 'VISIT';
CREATE TYPE "ProviderType" AS ENUM ('UMRAH_COMPANY','TRAVEL_COMPANY','HOTEL','AIRLINE','TRANSPORT','RESTAURANT','VISA','VISIT','OTHER');
CREATE TABLE "provider_organizations" (
  "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "name" VARCHAR(200) NOT NULL,
  "type" "ProviderType" NOT NULL, "city" VARCHAR(120) NOT NULL,
  "contactEmail" VARCHAR(320) NOT NULL, "phone" VARCHAR(32) NOT NULL DEFAULT '',
  "licenseNumber" VARCHAR(120) NOT NULL DEFAULT '', "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_organizations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "provider_organizations_id_tenantId_key" ON "provider_organizations"("id","tenantId");
CREATE INDEX "provider_organizations_tenantId_type_status_idx" ON "provider_organizations"("tenantId","type","status");
ALTER TABLE "tenant_memberships" ADD COLUMN "providerOrganizationId" UUID;
-- Preserve existing owners, services and bookings; establish a separate company identity.
INSERT INTO "provider_organizations" ("id","tenantId","name","type","city","contactEmail")
SELECT m."id",m."tenantId",u."displayName",'TRAVEL_COMPANY','غير محددة',u."email"
FROM "tenant_memberships" m JOIN "users" u ON u."id"=m."userId"
WHERE EXISTS (SELECT 1 FROM "travel_services" s WHERE s."providerMembershipId"=m."id")
OR EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r."id"=mr."roleId" WHERE mr."membershipId"=m."id" AND r."code"='service-provider');
UPDATE "tenant_memberships" m SET "providerOrganizationId"=p."id" FROM "provider_organizations" p WHERE p."id"=m."id";
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_providerOrganizationId_tenantId_fkey" FOREIGN KEY ("providerOrganizationId","tenantId") REFERENCES "provider_organizations"("id","tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "travel_services" ADD COLUMN "providerOrganizationId" UUID;
UPDATE "travel_services" SET "providerOrganizationId"="providerMembershipId";
ALTER TABLE "travel_services" ALTER COLUMN "providerOrganizationId" SET NOT NULL;
ALTER TABLE "travel_services" ADD COLUMN "details" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "travel_services" ADD COLUMN "capacity" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "travel_services" ADD CONSTRAINT "travel_services_providerOrganizationId_tenantId_fkey" FOREIGN KEY ("providerOrganizationId","tenantId") REFERENCES "provider_organizations"("id","tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "service_components" (
  "packageId" UUID NOT NULL, "serviceId" UUID NOT NULL, "tenantId" UUID NOT NULL,
  PRIMARY KEY ("packageId","serviceId"),
  CONSTRAINT "service_components_packageId_tenantId_fkey" FOREIGN KEY ("packageId","tenantId") REFERENCES "travel_services"("id","tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "service_components_serviceId_tenantId_fkey" FOREIGN KEY ("serviceId","tenantId") REFERENCES "travel_services"("id","tenantId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "service_components_not_self" CHECK ("packageId" <> "serviceId")
);
ALTER TABLE "bookings" ADD COLUMN "unitPriceCents" INTEGER;
UPDATE "bookings" SET "unitPriceCents"="totalCents"/"travelersCount";
ALTER TABLE "bookings" ALTER COLUMN "unitPriceCents" SET NOT NULL;
ALTER TABLE "bookings" ADD COLUMN "units" INTEGER NOT NULL DEFAULT 1;
UPDATE "bookings" SET "units"="travelersCount";
ALTER TABLE "bookings" ADD COLUMN "serviceDate" DATE;
ALTER TABLE "bookings" ADD COLUMN "endDate" DATE;
ALTER TABLE "travel_services" ADD CONSTRAINT "service_positive_capacity_price" CHECK ("capacity">0 AND "priceCents">0);
ALTER TABLE "bookings" ADD CONSTRAINT "booking_positive_values" CHECK ("units">0 AND "travelersCount">0 AND "unitPriceCents">0 AND "totalCents">0);
