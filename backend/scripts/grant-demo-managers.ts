import "dotenv/config";
import { assertDevDatabase } from "../src/config/script-guard.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

assertDevDatabase("grant-demo-managers");
const connectionString = process.env["DATABASE_URL"];
if (!connectionString) throw new Error("DATABASE_URL is required");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const emails = ["provider", "umrah", "hotel", "airline", "transport", "restaurant", "visa", "visit"]
  .map((alias) => `${alias}@safry.local`);

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { code: "safry" } });
  if (!tenant) throw new Error("The local demo tenant does not exist");
  const managerRole = await prisma.role.findUniqueOrThrow({
    where: { tenantId_code: { tenantId: tenant.id, code: "organization-manager" } }
  });
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { emailNormalized: email },
      include: { memberships: { where: { tenantId: tenant.id }, include: { roles: { include: { role: true } } } } } });
    const membership = user?.memberships[0];
    if (!user || !membership?.providerOrganizationId ||
      !membership.roles.some(({ role }) => ["service-provider", "travel-company"].includes(role.code)))
      continue;
    if (membership.roles.some(({ roleId }) => roleId === managerRole.id)) continue;
    if (!process.argv.includes("--apply")) {
      process.stdout.write(`Would grant demo manager: ${email}\n`);
      continue;
    }
    await prisma.$transaction(async (tx) => {
      await tx.membershipRole.create({ data: {
        tenantId: tenant.id, membershipId: membership.id, roleId: managerRole.id
      } });
      await tx.user.update({ where: { id: user.id }, data: { authVersion: { increment: 1 } } });
      await tx.refreshSession.updateMany({ where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() } });
      await tx.auditEvent.create({ data: {
        tenantId: tenant.id, action: "demo.organization.manager.grant", entityType: "membership",
        entityId: membership.id, metadata: { organizationId: membership.providerOrganizationId }
      } });
    });
    process.stdout.write(`Granted demo manager: ${email}\n`);
  }
}

await main().finally(async () => prisma.$disconnect());
