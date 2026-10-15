import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Response } from "express";
import { DEFAULT_PAGE_SIZE, type PageQueryDto } from "../../../common/pagination.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { AccountLinkingService } from "../../identity/users/account-linking.service.js";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { providerDefinitions, serviceDefinitions } from "../../travel-services/catalog.js";
import type { CreateProviderDto, UpdateProviderDto } from "./dto/provider.dto.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly linking: AccountLinkingService
  ) {}
  async workspace(user: AuthUser): Promise<unknown> {
    const membership = await this.prisma.tenantMembership.findFirst({
      where: { id: user.membershipId, tenantId: user.tenantId },
      include: { organization: true }
    });
    return { organization: membership?.organization ?? null, providerDefinitions, serviceDefinitions };
  }
  /** Alphabetical, keyset-paged on (name, id): `?limit=` and `?cursor=`, next cursor in `X-Next-Cursor`. */
  async list(user: AuthUser, page: PageQueryDto, response: Response): Promise<unknown> {
    const limit = page.limit ?? DEFAULT_PAGE_SIZE;
    let after: { name: string; id: string } | undefined;
    if (page.cursor) {
      try {
        after = JSON.parse(Buffer.from(page.cursor, "base64url").toString("utf8")) as { name: string; id: string };
        // name: bounded, and no NUL byte (PostgreSQL rejects it in text and the request would answer 500) - GAP-AUTHZ-033.
        if (typeof after.name !== "string" || after.name.length > 200 || after.name.includes("\u0000") || typeof after.id !== "string" || !UUID_PATTERN.test(after.id)) throw new Error();
      } catch {
        throw new BadRequestException("cursor is invalid");
      }
    }
    const rows = await this.prisma.providerOrganization.findMany({
      where: {
        tenantId: user.tenantId,
        ...(user.roles.includes("tenant-admin") ? {} : { status: "ACTIVE" }),
        ...(after ? { OR: [{ name: { gt: after.name } }, { name: after.name, id: { gt: after.id } }] } : {})
      },
      take: limit + 1,
      select: {
        id: true,
        name: true,
        nameAr: true,
        nameEn: true,
        type: true,
        city: true,
        status: true,
        contactEmail: true,
        phone: true,
        ...(user.roles.includes("tenant-admin") ? { licenseNumber: true } : {}),
        _count: { select: { services: true, members: true } }
      },
      orderBy: [{ name: "asc" }, { id: "asc" }]
    });
    response.setHeader("Access-Control-Expose-Headers", "X-Next-Cursor");
    if (rows.length <= limit) return rows;
    const items = rows.slice(0, limit);
    const last = items[limit - 1]!;
    response.setHeader("X-Next-Cursor", Buffer.from(JSON.stringify({ name: last.name, id: last.id })).toString("base64url"));
    return items;
  }
  async create(user: AuthUser, input: CreateProviderDto): Promise<unknown> {
    if (!user.roles.includes("tenant-admin")) throw new ForbiddenException();
    const email = input.contactEmail.trim().toLowerCase();
    return this.prisma.$transaction(async (tx) => {
      const definition = providerDefinitions[input.type];
      const role = await tx.role.findUnique({
        where: { tenantId_code: { tenantId: user.tenantId, code: definition.role } }
      });
      const ownerRole = await tx.role.findUnique({
        where: { tenantId_code: { tenantId: user.tenantId, code: "organization-manager" } }
      });
      if (!role || !ownerRole) throw new ConflictException("أدوار الجهة لم تهيأ بعد");
      const organization = await tx.providerOrganization.create({
        data: {
          tenantId: user.tenantId,
          name: input.nameAr.trim(),
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          type: input.type,
          city: input.city.trim(),
          contactEmail: email,
          phone: input.phone.trim(),
          licenseNumber: input.licenseNumber.trim()
        }
      });
      // An existing identity becomes an invitation its owner must accept (GAP-AUTHZ-001).
      const { userId, awaitingOwnerConsent } = await this.linking.createOrInvite(tx, user.tenantId, {
        email, displayName: input.name, password: input.password
      });
      const member = await tx.tenantMembership.create({
        data: {
          tenantId: user.tenantId,
          userId,
          status: awaitingOwnerConsent ? "INVITED" : "ACTIVE",
          awaitingOwnerConsent,
          providerOrganizationId: organization.id,
          jobTitle: definition.label
        }
      });
      await tx.membershipRole.createMany({
        data: [role.id, ownerRole.id].map((roleId) => ({
          tenantId: user.tenantId, membershipId: member.id, roleId
        }))
      });
      await tx.auditEvent.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          action: "provider.create",
          entityId: organization.id,
          entityType: "provider_organization",
          metadata: { ownerAwaitingConsent: awaitingOwnerConsent }
        }
      });
      return { ...organization, ownerAwaitingConsent: awaitingOwnerConsent };
    });
  }
  async update(user: AuthUser, id: string, input: UpdateProviderDto): Promise<unknown> {
    const owned = await this.prisma.providerOrganization.findFirst({
      where: {
        id,
        tenantId: user.tenantId,
        ...(user.roles.includes("tenant-admin") ? {} : { members: { some: { id: user.membershipId } } })
      }
    });
    if (!owned) throw new NotFoundException("المنشأة غير متاحة لهذا الحساب");
    // Same rule as service creation and the organization workspace: a suspended organization is edited by the tenant, not by its own staff.
    if (!user.roles.includes("tenant-admin") && owned.status !== "ACTIVE")
      throw new ForbiddenException("المنشأة غير مفعلة؛ لا يمكن تعديل بياناتها قبل تفعيلها من إدارة الجهة");
    // The organization's legal identity is edited by its manager or the tenant, not by every staff member (GAP-AUTHZ-014).
    if (!user.roles.includes("tenant-admin") && !user.permissions.includes("organization.staff.manage"))
      throw new ForbiddenException("تعديل بيانات المنشأة متاح لمسؤولها فقط");
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.providerOrganization.update({
        where: { id },
        data: {
          name: input.nameAr?.trim() ?? input.name?.trim(),
          nameAr: input.nameAr?.trim() ?? input.name?.trim(),
          nameEn: input.nameEn?.trim(),
          city: input.city?.trim(),
          phone: input.phone?.trim(),
          licenseNumber: input.licenseNumber?.trim()
        }
      });
      await tx.auditEvent.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          action: "provider.update",
          entityId: id,
          entityType: "provider_organization",
          metadata: {
            before: { name: owned.name, nameEn: owned.nameEn, city: owned.city, licenseNumber: owned.licenseNumber },
            after: { name: changed.name, nameEn: changed.nameEn, city: changed.city, licenseNumber: changed.licenseNumber }
          }
        }
      });
      return changed;
    });
  }
  async status(user: AuthUser, id: string, status: "ACTIVE" | "SUSPENDED"): Promise<unknown> {
    if (!user.roles.includes("tenant-admin")) throw new ForbiddenException();
    const exists = await this.prisma.providerOrganization.findFirst({
      where: { id, tenantId: user.tenantId }
    });
    if (!exists) throw new NotFoundException();
    return this.prisma.$transaction(async (tx) => {
      // The same organization lock is taken by service/booking writes.
      await tx.$queryRaw`SELECT "id" FROM "provider_organizations" WHERE "id"=${id}::uuid FOR UPDATE`;
      const updated = await tx.providerOrganization.update({ where: { id }, data: { status } });
      await tx.auditEvent.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          action: `provider.${status.toLowerCase()}`,
          entityType: "provider_organization",
          entityId: id
        }
      });
      return updated;
    });
  }
}
