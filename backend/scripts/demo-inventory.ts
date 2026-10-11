import "dotenv/config";
import { assertDevDatabase } from "../src/config/script-guard.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
assertDevDatabase("demo-inventory");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }) });
try {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { code: "safry" } });
  const users = await prisma.user.findMany({ where: { memberships: { some: { tenantId: tenant.id } } },
    select: { id: true, email: true, displayName: true, memberships: { select: { id: true, providerOrganizationId: true } } } });
  const providers = await prisma.providerOrganization.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true, contactEmail: true } });
  const services = await prisma.travelService.findMany({ where: { tenantId: tenant.id }, select: { id: true, title: true, providerOrganizationId: true } });
  const bookings = await prisma.booking.findMany({ where: { tenantId: tenant.id }, select: { id: true, serviceId: true, travelerMembershipId: true } });
  const components = await prisma.serviceComponent.findMany({ where: { tenantId: tenant.id } });
  console.log(JSON.stringify({ users, providers, services, bookings, components }, null, 2));
} finally { await prisma.$disconnect(); }
