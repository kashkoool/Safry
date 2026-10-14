import "dotenv/config";
import { assertDevDatabase } from "../src/config/script-guard.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { demoCatalog } from "../prisma/demo-catalog.js";

assertDevDatabase("refresh-demo-data");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }) });
const oldIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", ...Array.from({ length: 7 }, (_, i) => `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`)];
const newIds = demoCatalog.map((_, i) => `44444444-4444-4444-8444-${String(i + 1).padStart(12, "0")}`);
// Explicitly approved by the project owner: "رحلة 2 اوكتوبر" and its demo links.
oldIds.push("abfed65b-6600-47bf-a713-644a2dedcba8");
async function main() {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { code: "safry" } });
  const traveler = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: tenant.id, user: { emailNormalized: "traveler@safry.local" } } });
  const providers = [];
  for (const item of demoCatalog) {
    const member = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: tenant.id, user: { emailNormalized: `${item.alias}@safry.local` } }, include: { organization: true } });
    if (!member.organization || member.organization.contactEmail !== `${item.alias}@safry.local`) throw new Error(`Unexpected company mapping: ${item.alias}`);
    providers.push({ item, member, organization: member.organization });
  }
  const services = await prisma.travelService.findMany({ where: { id: { in: oldIds }, tenantId: tenant.id } });
  const ids = services.map(s => s.id);
  const bookings = await prisma.booking.findMany({ where: { serviceId: { in: ids } } });
  const components = await prisma.serviceComponent.findMany({ where: { OR: [{ packageId: { in: ids } }, { serviceId: { in: ids } }] } });
  if (bookings.some(b => b.travelerMembershipId !== traveler.id) || components.some(c => !ids.includes(c.packageId))) throw new Error("Non-demo records reference old demo services; review required before replacement.");
  if (await prisma.travelService.count({ where: { id: { in: newIds } } })) throw new Error("New demo catalog already exists; refusing to duplicate or overwrite it.");
  console.log(JSON.stringify({ removeServices: ids, removeBookingIds: bookings.map(b => b.id), newServices: newIds.length, preservedOtherServices: await prisma.travelService.count({ where: { tenantId: tenant.id, id: { notIn: ids } } }), preservedAccounts: true }, null, 2));
  if (!process.argv.includes("--apply")) return;
  const backupDir = resolve("backups");
  await mkdir(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, `demo-before-refresh-${Date.now()}.json`);
  await writeFile(backupPath, JSON.stringify({ tenantId: tenant.id, services, bookings, components, organizations: providers.map(p => p.organization) }, null, 2), { flag: "wx" });
  await prisma.$transaction(async tx => {
    await tx.booking.deleteMany({ where: { id: { in: bookings.map(b => b.id) }, tenantId: tenant.id } });
    await tx.serviceComponent.deleteMany({ where: { packageId: { in: ids } } });
    await tx.travelService.deleteMany({ where: { id: { in: ids }, tenantId: tenant.id } });
    const date = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    for (const [index, { item, member, organization }] of providers.entries()) {
      // Preserve personalized companies and all existing members/roles and user-created services.
      const customized = item.alias === "umrah" || item.alias === "provider";
      const nameAr = customized ? organization.name : item.companyAr;
      await tx.providerOrganization.update({ where: { id: organization.id }, data: { name: nameAr, nameAr, nameEn: item.companyEn } });
      const { alias, companyAr, companyEn, ...service } = item;
      void alias; void companyAr; void companyEn;
      await tx.travelService.create({ data: { ...service, id: newIds[index], tenantId: tenant.id, providerMembershipId: member.id, providerOrganizationId: organization.id, status: "ACTIVE", details: { ...item.details, ...(item.category === "FLIGHT" ? { departureDate: date } : {}) } } });
    }
    await tx.serviceComponent.createMany({ data: [1, 3].map(index => ({ tenantId: tenant.id, packageId: newIds[0]!, serviceId: newIds[index]! })) });
    for (const [index, status] of ["PENDING", "CONFIRMED", "CANCELLED"].entries()) {
      const serviceIndex = [0, 1, 7][index]!;
      const service = demoCatalog[serviceIndex]!;
      const hotel = service.category === "HOTEL";
      const endDate = hotel ? new Date(new Date(date).getTime() + 2 * 86400000) : null;
      await tx.booking.create({ data: { tenantId: tenant.id, serviceId: newIds[serviceIndex]!, travelerMembershipId: traveler.id, travelersCount: 2, units: hotel ? 1 : 2, serviceDate: new Date(date), endDate, currency: service.currency, unitPriceCents: service.priceCents, totalCents: service.priceCents * 2n, status: status as "PENDING" | "CONFIRMED" | "CANCELLED", notes: "Demo booking" } });
    }
    await tx.auditEvent.create({ data: { tenantId: tenant.id, action: "demo.catalog.replace", entityType: "demo_catalog", metadata: { removedServiceIds: ids, removedBookingIds: bookings.map(b => b.id), createdServiceIds: newIds, backupPath } } });
  }, { timeout: 30000 });
  console.log(`Replaced ${ids.length} demo services and ${bookings.length} demo bookings. Created 8 bilingual services and 3 bookings. Backup: ${backupPath}`);
}
await main().finally(() => prisma.$disconnect());
