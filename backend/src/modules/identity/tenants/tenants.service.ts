import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { requestContext } from "../../../common/context/request-context.js";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { PrismaService } from "../../../database/prisma.service.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from "../access/system-roles.js";
import type { CreateTenantDto, TenantSettingsDto, TenantStatusDto, UpdateTenantDto } from "./dto/tenants.dto.js";
import { isUniqueViolation } from "../../../common/filters/database-errors.js";
import { revokeActiveSessions } from "../../../common/security/revoke-sessions.js";

const tenantSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  settings: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true
} as const;

/** Keys a tenant may store in `settings`. */
const SETTINGS_KEYS = new Set(["locale", "timezone", "currency", "branding", "features"]);
const MAX_SETTINGS_BYTES = 8 * 1024;
/** Server-side ceiling of the platform tenant list. */
const LIST_LIMIT = 500;

/**
 * Tenant Management.
 * Tenant level: profile and configuration of the caller's own tenant.
 * Platform level: creation, status and lifecycle (the caller runs in explicit system scope).
 */
@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async current(user: AuthUser): Promise<object> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: user.tenantId }, select: tenantSelect });
    if (!tenant) throw new NotFoundException("Tenant not found");
    return tenant;
  }

  private settings(input: TenantSettingsDto): Prisma.InputJsonObject {
    // The validated DTO may carry absent fields as undefined; a JSON round trip keeps only real values
    // so a partial update never erases a stored key.
    const json = JSON.stringify(input);
    const value = JSON.parse(json) as Record<string, unknown>;
    const unknown = Object.keys(value).filter((key) => !SETTINGS_KEYS.has(key));
    if (unknown.length) throw new BadRequestException(`إعدادات غير مدعومة: ${unknown.join(", ")}`);
    if (Buffer.byteLength(json) > MAX_SETTINGS_BYTES) throw new BadRequestException("الإعدادات كبيرة جداً");
    return value as Prisma.InputJsonObject;
  }

  /** Tenant profile and configuration (own tenant only). */
  async updateCurrent(user: AuthUser, input: UpdateTenantDto): Promise<object> {
    const before = await this.current(user);
    const incoming = input.settings === undefined ? undefined : this.settings(input.settings);
    const current = (before as { settings: unknown }).settings;
    const merged =
      incoming === undefined
        ? undefined
        : { ...(typeof current === "object" && current !== null ? current : {}), ...incoming };
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenant.update({
        where: { id: user.tenantId },
        data: { name: input.name, settings: merged },
        select: tenantSelect
      });
      await tx.auditEvent.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          requestId: requestContext.getStore()?.requestId,
          action: "identity.tenant.update",
          entityType: "tenant",
          entityId: user.tenantId,
          metadata: { name: input.name ?? null, settingsKeys: Object.keys(incoming ?? {}) }
        }
      });
      return updated;
    });
  }

  list(): Promise<object[]> {
    return this.prisma.tenant.findMany({ select: tenantSelect, orderBy: { name: "asc" }, take: LIST_LIMIT });
  }

  /** Tenant Creation: a new tenant starts with the standard system roles and permissions. */
  async create(actor: AuthUser, input: CreateTenantDto): Promise<object> {
    const code = input.code.trim().toLowerCase();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: { code, name: input.name.trim(), settings: input.settings ? this.settings(input.settings) : {} },
          select: tenantSelect
        });
        const permissions = await tx.permission.findMany({
          where: { code: { in: PERMISSIONS.map(([permissionCode]) => permissionCode) } },
          select: { id: true, code: true }
        });
        for (const [roleCode, name] of SYSTEM_ROLES) {
          const role = await tx.role.create({ data: { tenantId: tenant.id, code: roleCode, name, isSystem: true } });
          const allowed = new Set<string>(ROLE_PERMISSIONS[roleCode]);
          await tx.rolePermission.createMany({
            data: permissions.filter(({ code: permission }) => allowed.has(permission)).map(({ id }) => ({ roleId: role.id, permissionId: id }))
          });
        }
        await tx.auditEvent.create({
          data: {
            tenantId: tenant.id,
            actorUserId: actor.userId,
            requestId: requestContext.getStore()?.requestId,
            action: "platform.tenant.create",
            entityType: "tenant",
            entityId: tenant.id,
            metadata: { code }
          }
        });
        return tenant;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("رمز الجهة مستخدم");
      throw error;
    }
  }

  /** Status, suspension/reactivation and closure. */
  async setStatus(actor: AuthUser, id: string, input: TenantStatusDto): Promise<object> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id"=${id}::uuid FOR UPDATE`;
      const tenant = await tx.tenant.findUnique({ where: { id }, select: tenantSelect });
      if (!tenant) throw new NotFoundException("الجهة غير موجودة");
      if (tenant.status === "ARCHIVED") throw new ConflictException("الجهة مؤرشفة ولا يمكن تغيير حالتها");
      if (tenant.status === input.status) return tenant;
      if (actor.tenantId === id && input.status !== "ACTIVE")
        throw new ConflictException("لا يمكنك تعليق أو إغلاق الجهة التي تعمل منها");
      const updated = await tx.tenant.update({
        where: { id },
        data: { status: input.status, archivedAt: input.status === "ARCHIVED" ? new Date() : null },
        select: tenantSelect
      });
      if (input.status !== "ACTIVE")
        await revokeActiveSessions(tx, { tenantId: id });
      await tx.auditEvent.create({
        data: {
          tenantId: id,
          actorUserId: actor.userId,
          requestId: requestContext.getStore()?.requestId,
          action: `platform.tenant.${input.status.toLowerCase()}`,
          entityType: "tenant",
          entityId: id,
          metadata: { before: tenant.status, after: input.status, reason: input.reason }
        }
      });
      return updated;
    });
  }

  /** Tenant Activity History. */
  activity(id: string): Promise<object[]> {
    return this.prisma.auditEvent.findMany({
      where: { tenantId: id },
      select: { id: true, action: true, entityType: true, entityId: true, actorUserId: true, metadata: true, occurredAt: true },
      orderBy: { occurredAt: "desc" },
      take: 200
    });
  }
}
