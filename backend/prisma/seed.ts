import "dotenv/config";
import { hash } from "argon2";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { bootstrapCore } from "./bootstrap-core.js";
import { withRlsBypass } from "./rls-bypass.js";
import { seedBusinessProviders } from "./seed-providers.js";
import { adminPassword, assertSeedAllowed, demoPassword } from "./seed-guard.js";

assertSeedAllowed();
// Fail fast, before any database write, if the passwords are missing or weak.
adminPassword();
demoPassword();

// Seeding is an owner task: use the owner connection when the runtime one is a restricted role.
const databaseUrl = process.env["DATABASE_MIGRATE_URL"] ?? process.env["DATABASE_URL"];

if (!databaseUrl) {
  throw new Error("DATABASE_MIGRATE_URL or DATABASE_URL is required");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl })
});

async function main(): Promise<void> {
  const tenantCode = (process.env["BOOTSTRAP_TENANT_CODE"] ?? "safry").toLowerCase();
  const tenantName = process.env["BOOTSTRAP_TENANT_NAME"] ?? "Safry Platform";
  const adminEmail = (process.env["BOOTSTRAP_ADMIN_EMAIL"] ?? "admin@safry.local").toLowerCase();

  const { tenant, roles } = await bootstrapCore(prisma, { tenantCode, tenantName, adminEmail, adminPasswordHash: await hash(adminPassword()) });

  await withRlsBypass(prisma, async (tx) => {
    async function createDemoMember(input: {
      email: string;
      displayName: string;
      jobTitle: string;
      roleCode: "service-provider" | "traveler";
    }): Promise<{ id: string }> {
      const email = input.email.toLowerCase();
      const user = await tx.user.upsert({
        where: { emailNormalized: email },
        update: { displayName: input.displayName },
        create: {
          email,
          emailNormalized: email,
          displayName: input.displayName,
          passwordHash: await hash(demoPassword()),
          emailVerifiedAt: new Date()
        }
      });
      const member = await tx.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
        update: { jobTitle: input.jobTitle },
        create: { tenantId: tenant.id, userId: user.id, status: "ACTIVE", jobTitle: input.jobTitle }
      });
      const role = roles.get(input.roleCode)!;
      await tx.membershipRole.upsert({
        where: { membershipId_roleId: { membershipId: member.id, roleId: role.id } },
        update: {},
        create: { membershipId: member.id, roleId: role.id, tenantId: tenant.id }
      });
      return member;
    }

    const provider = await createDemoMember({
      email: "provider@safry.local",
      displayName: "روائع السفر للسياحة",
      jobTitle: "مقدم خدمات سياحية",
      roleCode: "service-provider"
    });
    await createDemoMember({
      email: "traveler@safry.local",
      displayName: "مسافر سفري",
      jobTitle: "مسافر",
      roleCode: "traveler"
    });

    const legacyOrganization = await tx.providerOrganization.upsert({
      where: { id: provider.id },
      update: {},
      create: {
        id: provider.id,
        tenantId: tenant.id,
        name: "روائع السفر للسياحة",
        nameAr: "روائع السفر للسياحة",
        nameEn: "Travel Wonders",
        type: "TRAVEL_COMPANY",
        city: "الرياض",
        contactEmail: "provider@safry.local"
      }
    });
    await tx.tenantMembership.updateMany({
      where: { id: provider.id, providerOrganizationId: null },
      data: { providerOrganizationId: legacyOrganization.id }
    });
    await tx.membershipRole.upsert({
      where: { membershipId_roleId: { membershipId: provider.id, roleId: roles.get("organization-manager")!.id } },
      update: {},
      create: { tenantId: tenant.id, membershipId: provider.id, roleId: roles.get("organization-manager")!.id }
    });

    await seedBusinessProviders(tx, tenant.id);
  });
}

await main().finally(async () => prisma.$disconnect());
