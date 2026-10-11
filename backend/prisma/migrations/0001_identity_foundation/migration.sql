-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "emailNormalized" VARCHAR(320) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(32),
    "locale" VARCHAR(16) NOT NULL DEFAULT 'ar-SA',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "disabledAt" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_memberships" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'INVITED',
    "jobTitle" VARCHAR(160),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(500),
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(140) NOT NULL,
    "description" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "membership_roles" (
    "membershipId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,

    CONSTRAINT "membership_roles_pkey" PRIMARY KEY ("membershipId","roleId")
);

-- CreateTable
CREATE TABLE "refresh_sessions" (
    "id" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "userAgent" VARCHAR(500),
    "ipAddress" INET,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "actorUserId" UUID,
    "requestId" UUID,
    "action" VARCHAR(160) NOT NULL,
    "entityType" VARCHAR(120),
    "entityId" VARCHAR(120),
    "ipAddress" INET,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");

-- CreateIndex
CREATE UNIQUE INDEX "users_emailNormalized_key" ON "users"("emailNormalized");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "tenant_memberships_userId_status_idx" ON "tenant_memberships"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_tenantId_userId_key" ON "tenant_memberships"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_id_tenantId_key" ON "tenant_memberships"("id", "tenantId");

-- CreateIndex
CREATE INDEX "roles_tenantId_idx" ON "roles"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenantId_code_key" ON "roles"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "roles_id_tenantId_key" ON "roles"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "membership_roles_tenantId_idx" ON "membership_roles"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_sessions_tokenHash_key" ON "refresh_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_sessions_userId_expiresAt_idx" ON "refresh_sessions"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "refresh_sessions_tenantId_expiresAt_idx" ON "refresh_sessions"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "audit_events_tenantId_occurredAt_idx" ON "audit_events"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_events_actorUserId_occurredAt_idx" ON "audit_events"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_events_entityType_entityId_idx" ON "audit_events"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membershipId_tenantId_fkey" FOREIGN KEY ("membershipId", "tenantId") REFERENCES "tenant_memberships"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_roleId_tenantId_fkey" FOREIGN KEY ("roleId", "tenantId") REFERENCES "roles"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
