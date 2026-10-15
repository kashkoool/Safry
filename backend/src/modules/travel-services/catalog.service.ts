import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { Response } from "express";
import { toMinorUnits } from "../../common/money/money.js";
import { finishPage, keysetPage, type PageQueryDto } from "../../common/pagination.js";
import type { AuthUser } from "../../common/security/auth-user.js";
import { isOperator, isTenantAdmin } from "../../common/security/principal.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { CreateServiceDto } from "./dto/create-service.dto.js";
import type { UpdateServiceDto } from "./dto/update-service.dto.js";
import { assertCategory, validateDetails } from "./catalog.js";
import { serviceInclude } from "./service-select.js";
import { ConfigService } from "@nestjs/config";
import { bookingLimits, pendingCutoff, type BookingLimits } from "../operations/bookings/booking-limits.js";

const operator = isOperator;
const admin = isTenantAdmin;

@Injectable()
export class CatalogService {
  private readonly bookingLimits: BookingLimits;
  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.bookingLimits = bookingLimits(config);
  }

  /** Newest first, keyset-paged (see common/pagination.ts): `?limit=` and `?cursor=`, next cursor in `X-Next-Cursor`. */
  async listServices(user: AuthUser, page: PageQueryDto, response: Response, marketplace = false): Promise<unknown> {
    const where: Prisma.TravelServiceWhereInput = {
        tenantId: user.tenantId,
        ...(!admin(user) && !marketplace && operator(user)
          ? { organization: { members: { some: { id: user.membershipId } } } }
          : admin(user) && !marketplace
            ? {}
            : { status: "ACTIVE", organization: { status: "ACTIVE" } })
      };
    const rows = await this.prisma.travelService.findMany({ ...keysetPage(page, where), include: serviceInclude });
    return finishPage(rows, page, response);
  }

  private async organization(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    id?: string
  ): Promise<{ id: string; type: Parameters<typeof assertCategory>[0] }> {
    const organization = await tx.providerOrganization.findFirst({
      where: {
        tenantId: user.tenantId,
        ...(admin(user)
          ? { id: id ?? "00000000-0000-0000-0000-000000000000" }
          : { members: { some: { id: user.membershipId } } })
      }
    });
    if (!organization) throw new ForbiddenException("الحساب غير مرتبط بمنشأة مخولة");
    await tx.$queryRaw`SELECT "id" FROM "provider_organizations" WHERE "id"=${organization.id}::uuid FOR UPDATE`;
    const current = await tx.providerOrganization.findUniqueOrThrow({
      where: { id: organization.id, tenantId: user.tenantId }
    });
    if (current.status !== "ACTIVE") throw new ForbiddenException("المنشأة موقوفة حالياً");
    return current;
  }
  private async audit(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    action: string,
    entityId: string
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        action,
        entityType: "travel_service",
        entityId
      }
    });
  }
  private async components(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    category: string,
    ids: string[],
    packageId?: string
  ): Promise<void> {
    if (!ids.length) return;
    if (!["UMRAH", "PACKAGE"].includes(category))
      throw new BadRequestException("ربط المكونات متاح للبرامج فقط");
    if (ids.includes(packageId ?? "")) throw new BadRequestException("لا يمكن ربط البرنامج بنفسه");
    const count = await tx.travelService.count({
      where: {
        id: { in: ids },
        tenantId: user.tenantId,
        status: "ACTIVE",
        organization: { status: "ACTIVE" },
        category: { notIn: ["UMRAH", "PACKAGE"] }
      }
    });
    if (count !== ids.length) throw new BadRequestException("أحد مكونات البرنامج غير متاح أو خارج الجهة");
  }

  async createService(user: AuthUser, input: CreateServiceDto): Promise<unknown> {
    if (!admin(user) && !operator(user)) throw new ForbiddenException();
    const details = validateDetails(input.category, input.details);
    return this.prisma.$transaction(async (tx) => {
      const org = await this.organization(tx, user, input.providerOrganizationId);
      assertCategory(org.type, input.category);
      await this.components(tx, user, input.category, input.componentIds ?? []);
      const service = await tx.travelService.create({
        data: {
          tenantId: user.tenantId,
          providerMembershipId: user.membershipId,
          providerOrganizationId: org.id,
          title: input.title.trim(),
          titleEn: input.titleEn?.trim(),
          descriptionEn: input.descriptionEn?.trim(),
          cityEn: input.cityEn?.trim(),
          detailsEn: validateDetails(input.category, input.detailsEn ?? {}, true),
          description: input.description.trim(),
          category: input.category,
          city: input.city.trim(),
          priceCents: toMinorUnits(input.priceCents),
          currency: input.currency ?? "SAR",
          capacity: input.capacity,
          details,
          status: "ACTIVE",
          components: {
            create: (input.componentIds ?? []).map((serviceId) => ({ serviceId }))
          }
        },
        include: serviceInclude
      });
      await this.audit(tx, user, "catalog.service.create", service.id);
      return service;
    });
  }

  async updateService(user: AuthUser, id: string, input: UpdateServiceDto): Promise<unknown> {
    return this.prisma.$transaction(async (tx) => {
      const old = await tx.travelService.findFirst({
        where: {
          id,
          tenantId: user.tenantId,
          ...(admin(user) ? {} : { organization: { members: { some: { id: user.membershipId } } } })
        }
      });
      if (!old) throw new NotFoundException("الخدمة غير متاحة لهذا الحساب");
      await this.organization(tx, user, old.providerOrganizationId);
      await tx.$queryRaw`SELECT "id" FROM "travel_services" WHERE "id"=${id}::uuid FOR UPDATE`;
      const service = await tx.travelService.findUniqueOrThrow({ where: { id, tenantId: user.tenantId } });
      if (input.category && input.category !== service.category)
        throw new BadRequestException("نوع الخدمة ثابت؛ أنشئ خدمة جديدة لتغيير النوع");
      // Keep pre-migration mixed offerings editable without allowing category changes.
      const details =
        input.details === undefined ? service.details : validateDetails(service.category, input.details);
      if (input.capacity !== undefined) {
        // One aggregate in SQL: the highest number of units booked on any upcoming day (peaks start on a booking's first day or today).
        const cutoff = pendingCutoff(this.bookingLimits);
        const [peak] = await tx.$queryRaw<Array<{ peak: number }>>`
          WITH act AS (
            SELECT "units", "serviceDate" AS s, COALESCE("endDate", "serviceDate" + 1) AS e FROM "bookings"
            WHERE "serviceId" = ${id}::uuid AND "status" <> 'CANCELLED'
              AND NOT ("status" = 'PENDING' AND "createdAt" < ${cutoff}::timestamptz)
              AND COALESCE("endDate", "serviceDate" + 1) > CURRENT_DATE
          ), pts AS (SELECT GREATEST(s, CURRENT_DATE) AS d FROM act UNION SELECT CURRENT_DATE)
          SELECT COALESCE(MAX(t), 0)::int AS peak FROM (
            SELECT SUM(act.units) AS t FROM pts JOIN act ON act.s <= pts.d AND pts.d < act.e GROUP BY pts.d
          ) x`;
        if ((peak?.peak ?? 0) > input.capacity) throw new ConflictException("السعة المتاحة لا تكفي في الموعد المحدد");
      }
      if (input.componentIds !== undefined)
        await this.components(tx, user, service.category, input.componentIds, id);
      const updated = await tx.travelService.update({
        where: { id, tenantId: user.tenantId },
        data: {
          title: input.title?.trim(),
          titleEn: input.titleEn?.trim(),
          descriptionEn: input.descriptionEn?.trim(),
          cityEn: input.cityEn?.trim(),
          detailsEn: input.detailsEn === undefined ? undefined : validateDetails(service.category, input.detailsEn, true),
          description: input.description?.trim(),
          city: input.city?.trim(),
          priceCents: input.priceCents === undefined ? undefined : toMinorUnits(input.priceCents),
          currency: input.currency,
          capacity: input.capacity,
          status: input.status,
          details: details as Prisma.InputJsonObject,
          ...(input.componentIds !== undefined
            ? {
                components: {
                  deleteMany: {},
                  create: input.componentIds.map((serviceId) => ({ serviceId }))
                }
              }
            : {})
        },
        include: serviceInclude
      });
      await this.audit(tx, user, "catalog.service.update", id);
      return updated;
    });
  }
}
