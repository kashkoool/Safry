import { hash } from "argon2";
import type { Prisma } from "../src/generated/prisma/client.js";
import { providerDefinitions } from "../src/modules/travel-services/catalog.js";
import { demoCatalog } from "./demo-catalog.js";
import { demoPassword } from "./seed-guard.js";
import type { ProviderType } from "../src/generated/prisma/enums.js";

export async function seedBusinessProviders(prisma: Prisma.TransactionClient, tenantId: string): Promise<void> {
  const departureDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const serviceIds: Record<string, string> = {};
  for (const [index, fixture] of demoCatalog.entries()) {
    const type = ({ umrah: "UMRAH_COMPANY", provider: "TRAVEL_COMPANY", hotel: "HOTEL", airline: "AIRLINE", transport: "TRANSPORT", restaurant: "RESTAURANT", visa: "VISA", visit: "VISIT" } as Record<string, ProviderType>)[fixture.alias]!;
    const email = `${fixture.alias}@safry.local`;
    const existing = await prisma.user.findUnique({ where: { emailNormalized: email } });
    if (existing && !(await prisma.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId, userId: existing.id } } })))
      throw new Error(`Demo email belongs to another workspace: ${email}`);
    const user = existing ?? await prisma.user.create({ data: {
      email, emailNormalized: email, displayName: fixture.companyAr,
      passwordHash: await hash(demoPassword()), emailVerifiedAt: new Date()
    } });
    const membership = await prisma.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId, userId: user.id } }, update: {},
      create: { tenantId, userId: user.id, status: "ACTIVE", jobTitle: providerDefinitions[type].label }
    });
    const organization = await prisma.providerOrganization.upsert({
      where: { id: membership.providerOrganizationId ?? membership.id }, update: {},
      create: { id: membership.id, tenantId, name: fixture.companyAr, nameAr: fixture.companyAr, nameEn: fixture.companyEn,
        type, city: fixture.city, contactEmail: email }
    });
    await prisma.tenantMembership.updateMany({ where: { id: membership.id, providerOrganizationId: null }, data: { providerOrganizationId: organization.id } });
    for (const code of [providerDefinitions[type].role, "organization-manager"]) {
      const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId, code } } });
      await prisma.membershipRole.upsert({
        where: { membershipId_roleId: { membershipId: membership.id, roleId: role.id } }, update: {},
        create: { tenantId, membershipId: membership.id, roleId: role.id }
      });
    }
    const id = `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`;
    const { alias, companyAr, companyEn, ...service } = fixture;
    void companyAr; void companyEn;
    await prisma.travelService.upsert({
      where: { id }, update: {},
      create: { ...service, id, tenantId, providerMembershipId: membership.id, providerOrganizationId: organization.id, status: "ACTIVE",
        details: { ...service.details, ...(service.category === "FLIGHT" ? { departureDate } : {}) } }
    });
    serviceIds[alias] = id;
  }
  for (const alias of ["hotel", "transport"]) {
    await prisma.serviceComponent.upsert({
      where: { packageId_serviceId: { packageId: serviceIds.umrah!, serviceId: serviceIds[alias]! } }, update: {},
      create: { tenantId, packageId: serviceIds.umrah!, serviceId: serviceIds[alias]! }
    });
  }
}
