-- CreateEnum
CREATE TYPE "ServiceCategory" AS ENUM ('FLIGHT', 'HOTEL', 'TRANSPORT', 'TOUR', 'OTHER');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "travel_services" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerMembershipId" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "category" "ServiceCategory" NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "status" "ServiceStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "travel_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "travelerMembershipId" UUID NOT NULL,
    "travelersCount" INTEGER NOT NULL DEFAULT 1,
    "totalCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "notes" VARCHAR(1000),
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "travel_services_id_tenantId_key" ON "travel_services"("id", "tenantId");
CREATE INDEX "travel_services_tenantId_status_category_idx" ON "travel_services"("tenantId", "status", "category");
CREATE INDEX "travel_services_providerMembershipId_status_idx" ON "travel_services"("providerMembershipId", "status");
CREATE INDEX "bookings_tenantId_status_createdAt_idx" ON "bookings"("tenantId", "status", "createdAt");
CREATE INDEX "bookings_travelerMembershipId_createdAt_idx" ON "bookings"("travelerMembershipId", "createdAt");
CREATE INDEX "bookings_serviceId_status_idx" ON "bookings"("serviceId", "status");

ALTER TABLE "travel_services" ADD CONSTRAINT "travel_services_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "travel_services" ADD CONSTRAINT "travel_services_providerMembershipId_tenantId_fkey" FOREIGN KEY ("providerMembershipId", "tenantId") REFERENCES "tenant_memberships"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_serviceId_tenantId_fkey" FOREIGN KEY ("serviceId", "tenantId") REFERENCES "travel_services"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_travelerMembershipId_tenantId_fkey" FOREIGN KEY ("travelerMembershipId", "tenantId") REFERENCES "tenant_memberships"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
