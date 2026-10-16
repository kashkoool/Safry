import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service.js";
import { AccountLinkingService } from "../identity/users/account-linking.service.js";
import { MfaService } from "../identity/auth/mfa.service.js";
import { AccountSecurityService } from "../identity/auth/account-security.service.js";
import { CredentialService } from "../identity/auth/credential.service.js";
import type { AuthUser } from "../../common/security/auth-user.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type {
  AccessDto,
  AccountStateDto,
  CreateAccountDto,
  PlatformQuery,
  UpdateAccountDto
} from "./platform.dto.js";
import { providerDefinitions } from "../travel-services/catalog.js";
import { isUniqueViolation } from "../../common/filters/database-errors.js";
import { revokeActiveSessions } from "../../common/security/revoke-sessions.js";

const identity = { id: true, displayName: true, email: true } as const;
const tenantSelect = { id: true, name: true, code: true } as const;
const roleSelect = {
  id: true,
  code: true,
  name: true,
  tenantId: true,
  permissions: { select: { permission: { select: { code: true } } } }
} as const;
const memberSelect = {
  id: true,
  tenantId: true,
  status: true,
  providerOrganizationId: true,
  permissionOverrides: true,
  tenant: { select: tenantSelect },
  organization: { select: { id: true, name: true, nameAr: true, nameEn: true, type: true } },
  roles: { select: { role: { select: roleSelect } } }
} as const;
const accountSelect = {
  ...identity,
  phone: true,
  status: true,
  emailVerifiedAt: true,
  isPlatformAdmin: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  memberships: { select: memberSelect }
} as const;

/** Rows per page of the platform record lists, and how long the overview counts are reused. */
const PAGE_SIZE = 30;
const OVERVIEW_TTL_MS = 30_000;

@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly linking: AccountLinkingService,
    private readonly mfa: MfaService,
    private readonly credentials: CredentialService,
    private readonly security: AccountSecurityService
  ) {}
  private overviewCache: { at: number; value: unknown } | undefined;

  /** Eight full-table counts: parallel and cached for 30 s, so repeated dashboard opens do not rescan the tables. */
  async overview(): Promise<unknown> {
    if (this.overviewCache && Date.now() - this.overviewCache.at < OVERVIEW_TTL_MS) return this.overviewCache.value;
    const [users, activeUsers, tenants, providers, services, bookings, pending, cancelled] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: "ACTIVE", deletedAt: null } }),
      this.prisma.tenant.count(),
      this.prisma.providerOrganization.count(),
      this.prisma.travelService.count(),
      this.prisma.booking.count(),
      this.prisma.booking.count({ where: { status: "PENDING" } }),
      this.prisma.booking.count({ where: { status: "CANCELLED" } })
    ]);
    const value = { users, activeUsers, tenants, providers, services, bookings, pending, cancelled, at: new Date() };
    this.overviewCache = { at: Date.now(), value };
    return value;
  }
  async references(): Promise<unknown> {
    const [tenants, roles, permissions, organizations] = await Promise.all([
      this.prisma.tenant.findMany({ select: tenantSelect, orderBy: { name: "asc" }, take: 1000 }),
      this.prisma.role.findMany({ select: roleSelect, orderBy: { name: "asc" }, take: 2000 }),
      this.prisma.permission.findMany({
        select: { code: true, description: true },
        orderBy: { code: "asc" }
      }),
      this.prisma.providerOrganization.findMany({
        select: { id: true, tenantId: true, name: true, nameAr: true, nameEn: true, type: true },
        orderBy: { name: "asc" },
        take: 2000
      })
    ]);
    return { tenants, roles, permissions, organizations };
  }
  async records(kind: string, input: PlatformQuery): Promise<unknown> {
    const { tenantId, page, q } = input;
    const scoped = tenantId ? { tenantId } : {};
    const paging = { skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE };
    const term = q?.trim() ?? "";
    const contains = { contains: term, mode: "insensitive" as const };
    // No search text: no ILIKE filter at all (an empty `contains` still scans every row).
    const search = (clauses: object[]): { OR?: object[] } => (term ? { OR: clauses } : {});
    let items: unknown[];
    let total: number;
    switch (kind) {
      case "users": {
        const where = {
          ...(tenantId ? { memberships: { some: { tenantId } } } : {}),
          ...search([{ email: contains }, { displayName: contains }])
        };
        [items, total] = await Promise.all([
          this.prisma.user.findMany({
            where,
            ...paging,
            select: accountSelect,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }]
          }),
          this.prisma.user.count({ where })
        ]);
        const blocked = await this.security.blockedUntilByEmail((items as Array<{ email: string }>).map((row) => row.email));
        items = (items as Array<{ email: string }>).map((row) => ({ ...row, lockedUntil: blocked.get(row.email) ?? null }));
        break;
      }
      case "services": {
        const where = { ...scoped, ...search([{ title: contains }, { titleEn: contains }, { organization: { name: contains } }, { organization: { nameEn: contains } }]) };
        [items, total] = await Promise.all([
          this.prisma.travelService.findMany({
            where,
            ...paging,
            include: {
              tenant: { select: tenantSelect },
              organization: { select: { id: true, name: true, nameAr: true, nameEn: true, type: true, status: true } },
              components: { include: { service: { select: { id: true, title: true, titleEn: true } } } }
            },
            orderBy: [{ createdAt: "desc" }, { id: "asc" }]
          }),
          this.prisma.travelService.count({ where })
        ]);
        break;
      }
      case "bookings": {
        const where = {
          ...scoped,
          ...search([{ service: { title: contains } }, { service: { titleEn: contains } }, { traveler: { user: { email: contains } } }])
        };
        [items, total] = await Promise.all([
          this.prisma.booking.findMany({
            where,
            ...paging,
            include: {
              tenant: { select: tenantSelect },
              service: {
                select: { id: true, title: true, titleEn: true, category: true, organization: { select: { name: true, nameAr: true, nameEn: true } } }
              },
              traveler: { select: { user: { select: identity } } }
            },
            orderBy: [{ createdAt: "desc" }, { id: "asc" }]
          }),
          this.prisma.booking.count({ where })
        ]);
        break;
      }
      case "providers": {
        const where = { ...scoped, ...search([{ name: contains }, { nameAr: contains }, { nameEn: contains }]) };
        [items, total] = await Promise.all([
          this.prisma.providerOrganization.findMany({
            where,
            ...paging,
            include: {
              tenant: { select: tenantSelect },
              _count: { select: { services: true, members: true } }
            },
            orderBy: [{ createdAt: "desc" }, { id: "asc" }]
          }),
          this.prisma.providerOrganization.count({ where })
        ]);
        break;
      }
      case "tenants": {
        const where = { ...(tenantId ? { id: tenantId } : {}), ...search([{ name: contains }, { code: contains }]) };
        [items, total] = await Promise.all([
          this.prisma.tenant.findMany({
            where,
            ...paging,
            select: {
              ...tenantSelect,
              status: true,
              createdAt: true,
              _count: { select: { memberships: true, providers: true, bookings: true } }
            },
            orderBy: [{ createdAt: "desc" }, { id: "asc" }]
          }),
          this.prisma.tenant.count({ where })
        ]);
        break;
      }
      case "audit": {
        const where = {
          ...scoped,
          ...search([{ action: contains }, { entityId: contains }, { actor: { email: contains } }])
        };
        [items, total] = await Promise.all([
          this.prisma.auditEvent.findMany({
            where,
            ...paging,
            select: {
              id: true,
              action: true,
              entityId: true,
              entityType: true,
              occurredAt: true,
              metadata: true,
              actor: { select: identity },
              tenant: { select: tenantSelect }
            },
            orderBy: [{ occurredAt: "desc" }, { id: "asc" }]
          }),
          this.prisma.auditEvent.count({ where })
        ]);
        break;
      }
      case "sessions": {
        const where = { ...scoped, ...(term ? { user: { email: contains } } : {}) };
        [items, total] = await Promise.all([
          this.prisma.refreshSession.findMany({
            where,
            ...paging,
            select: {
              id: true,
              createdAt: true,
              expiresAt: true,
              revokedAt: true,
              lastUsedAt: true,
              userAgent: true,
              user: { select: identity },
              tenant: { select: tenantSelect }
            },
            orderBy: [{ createdAt: "desc" }, { id: "asc" }]
          }),
          this.prisma.refreshSession.count({ where })
        ]);
        break;
      }
      default:
        throw new BadRequestException("قسم غير معروف");
    }
    return { items, total, page, pageSize: PAGE_SIZE };
  }
  private async lockAdmin(tx: Prisma.TransactionClient, actor: AuthUser): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "isPlatformAdmin" = true ORDER BY "id" FOR UPDATE`;
    const current = await tx.user.findUnique({ where: { id: actor.userId } });
    if (!current?.isPlatformAdmin || current.status !== "ACTIVE" || current.deletedAt)
      throw new ForbiddenException();
  }
  private async audit(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    action: string,
    entityId: string,
    metadata: Prisma.InputJsonObject = {},
    tenantId?: string
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        actorUserId: actor.userId,
        tenantId,
        action,
        entityType: action.includes("access") ? "membership" : "user",
        entityId,
        metadata
      }
    });
  }
  private async revoke(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.user.update({ where: { id }, data: { authVersion: { increment: 1 } } });
    await revokeActiveSessions(tx, { userId: id });
  }
  async updateAccount(actor: AuthUser, id: string, input: UpdateAccountDto, ipAddress?: string): Promise<unknown> {
    if (input.isPlatformAdmin === true) {
      // Granting platform administration needs a second step; re-saving an existing admin does not.
      const current = await this.prisma.user.findUnique({ where: { id }, select: { isPlatformAdmin: true } });
      if (current && !current.isPlatformAdmin) await this.mfa.stepUp(actor, input.currentPassword, input.mfaCode, ipAddress);
    }
    let addressChanged = false;
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await this.lockAdmin(tx, actor);
        // Lock the target before reading it, so the check below and the write cannot interleave with a concurrent
        // MFA disable (which takes the same row lock). Lock order: administrators first, then the target.
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const old = await tx.user.findUnique({ where: { id } });
        if (!old) throw new NotFoundException();
        if (old.deletedAt) throw new ConflictException("استعد الحساب المحذوف أولاً");
        // Platform administration is only ever held by an account with an enrolled second factor.
        if (input.isPlatformAdmin === true && !old.isPlatformAdmin && old.mfaEnabledAt === null)
          throw new ConflictException({ code: "target_mfa_required", message: "يجب على الحساب تفعيل المصادقة متعددة العوامل قبل منحه صلاحية مدير النظام" });
        if (id === actor.userId && input.isPlatformAdmin === false)
          throw new ConflictException("لا يمكنك إزالة صلاحية مدير النظام من حسابك الحالي");
        const email = input.email?.trim().toLowerCase();
        addressChanged = Boolean(email && email !== old.emailNormalized);
        const changed = await tx.user.update({
          where: { id },
          data: {
            displayName: input.displayName,
            phone: input.phone,
            email,
            emailNormalized: email,
            isPlatformAdmin: input.isPlatformAdmin,
            ...(email && email !== old.emailNormalized ? { emailVerifiedAt: null } : {})
          },
          select: accountSelect
        });
        if (input.isPlatformAdmin !== undefined && input.isPlatformAdmin !== old.isPlatformAdmin)
          await this.revoke(tx, id);
        await this.audit(tx, actor, "platform.account.update", id, {
          before: {
            displayName: old.displayName,
            email: old.email,
            phone: old.phone,
            isPlatformAdmin: old.isPlatformAdmin
          },
          after: {
            displayName: changed.displayName,
            email: changed.email,
            phone: changed.phone,
            isPlatformAdmin: changed.isPlatformAdmin
          }
        });
        return changed;
      });
      // The new address starts unverified (it blocks sign-in until confirmed): mail the link to it.
      if (addressChanged) await this.credentials.sendVerificationTo(id, ipAddress);
      return updated;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("البريد مستخدم بحساب آخر");
      throw error;
    }
  }
  async state(actor: AuthUser, id: string, input: AccountStateDto, ipAddress?: string): Promise<unknown> {
    if (id === actor.userId) throw new ConflictException("لا يمكنك تعطيل أو حذف حساب الإدارة الذي تستخدمه");
    // Suspending, disabling, deleting or restoring another PLATFORM ADMINISTRATOR changes who holds platform power.
    const target = await this.prisma.user.findUnique({ where: { id }, select: { isPlatformAdmin: true } });
    if (target?.isPlatformAdmin) await this.mfa.stepUp(actor, input.currentPassword, input.mfaCode, ipAddress);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAdmin(tx, actor);
      const old = await tx.user.findUnique({ where: { id } });
      if (!old) throw new NotFoundException();
      if (old.deletedAt && !["RESTORE", "DELETE"].includes(input.action))
        throw new ConflictException("استعد الحساب المحذوف أولاً");
      if (input.action === "RESTORE" && !old.deletedAt) throw new ConflictException("الحساب غير محذوف");
      const status =
        input.action === "DELETE" ? "DISABLED" : input.action === "RESTORE" ? "SUSPENDED" : input.action;
      const changed = await tx.user.update({
        where: { id },
        data: {
          status,
          deletedAt: input.action === "DELETE" ? new Date() : input.action === "RESTORE" ? null : undefined,
          disabledAt: status === "DISABLED" ? new Date() : null
        },
        select: accountSelect
      });
      await this.revoke(tx, id);
      await this.audit(tx, actor, `platform.account.${input.action.toLowerCase()}`, id, {
        reason: input.reason.trim(),
        before: old.status,
        after: status,
        retainedBusinessRecords: true
      });
      return changed;
    });
  }
  async revokeSessions(actor: AuthUser, id: string): Promise<unknown> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAdmin(tx, actor);
      if (!(await tx.user.findUnique({ where: { id } }))) throw new NotFoundException();
      await this.revoke(tx, id);
      await this.audit(tx, actor, "platform.sessions.revoke", id);
      return { revoked: true };
    });
  }
  async access(actor: AuthUser, id: string, input: AccessDto, ipAddress?: string): Promise<unknown> {
    // Granting tenant-admin to a membership that does not hold it is a privilege grant; demotion and re-saves are not.
    const adminRole = await this.prisma.role.findFirst({ where: { code: "tenant-admin", id: { in: input.roleIds } }, select: { id: true } });
    if (adminRole) {
      const alreadyHeld = await this.prisma.membershipRole.count({ where: { membershipId: id, roleId: adminRole.id } });
      if (alreadyHeld === 0) await this.mfa.stepUp(actor, input.currentPassword, input.mfaCode, ipAddress);
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockAdmin(tx, actor);
      const member = await tx.tenantMembership.findUnique({ where: { id }, include: { roles: true } });
      if (!member) throw new NotFoundException();
      if (member.userId === actor.userId)
        throw new ConflictException("لا تعدّل عضويات حساب الإدارة الحالي؛ استخدم مدير نظام آخر");
      if (input.status === "ACTIVE" && member.awaitingOwnerConsent)
        throw new ConflictException("الدعوة بانتظار موافقة صاحب الحساب");
      if (input.status === "SUSPENDED" && member.awaitingOwnerConsent && member.status === "INVITED")
        throw new ConflictException("الدعوة بانتظار موافقة صاحب الحساب؛ ألغِها (REVOKED) بدل تعليقها");
      const roles = await tx.role.findMany({
        where: { id: { in: input.roleIds }, tenantId: member.tenantId }
      });
      if (roles.length !== input.roleIds.length)
        throw new BadRequestException("الأدوار يجب أن تتبع جهة العضوية نفسها");
      const known = await tx.permission.findMany({ select: { code: true } });
      if (
        Object.entries(input.permissionOverrides).some(
          ([code, value]) => typeof value !== "boolean" || !known.some((p) => p.code === code)
        )
      )
        throw new BadRequestException("صلاحية غير معروفة أو قيمة غير صحيحة");
      const orgId =
        input.providerOrganizationId === undefined
          ? member.providerOrganizationId
          : input.providerOrganizationId;
      const org = orgId
        ? await tx.providerOrganization.findFirst({ where: { id: orgId, tenantId: member.tenantId } })
        : null;
      if (orgId && !org) throw new BadRequestException("المنشأة خارج نطاق الجهة");
      for (const role of roles)
        if (
          (role.organizationId !== null && role.organizationId !== orgId) ||
          ["service-provider", "travel-company"].includes(role.code) &&
          (!org || providerDefinitions[org.type].role !== role.code)
        )
          throw new BadRequestException("دور مقدم الخدمة أو الشركة يجب أن يطابق منشأة العضوية");
      await tx.membershipRole.deleteMany({ where: { membershipId: id } });
      await tx.membershipRole.createMany({
        data: roles.map((role) => ({ membershipId: id, roleId: role.id, tenantId: member.tenantId }))
      });
      const changed = await tx.tenantMembership.update({
        where: { id },
        data: {
          status: input.status,
          providerOrganizationId: orgId,
          permissionOverrides: input.permissionOverrides,
          revokedAt: input.status === "REVOKED" ? new Date() : null
        },
        select: memberSelect
      });
      await this.revoke(tx, member.userId);
      await this.audit(
        tx,
        actor,
        "platform.access.update",
        id,
        {
          before: {
            roleIds: member.roles.map((r) => r.roleId),
            permissionOverrides: member.permissionOverrides,
            status: member.status,
            providerOrganizationId: member.providerOrganizationId
          },
          after: {
            roleIds: input.roleIds,
            permissionOverrides: input.permissionOverrides,
            status: input.status,
            providerOrganizationId: orgId
          }
        },
        member.tenantId
      );
      return changed;
    });
  }
  async create(actor: AuthUser, input: CreateAccountDto, ipAddress?: string): Promise<unknown> {
    // Creating a tenant administrator hands out administrative power in a tenant.
    const requested = await this.prisma.role.findFirst({ where: { id: input.roleId, tenantId: input.tenantId }, select: { code: true } });
    if (requested?.code === "tenant-admin") await this.mfa.stepUp(actor, input.currentPassword, input.mfaCode, ipAddress);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockAdmin(tx, actor);
        const tenant = await tx.tenant.findFirst({ where: { id: input.tenantId, status: "ACTIVE" } });
        const role = await tx.role.findFirst({ where: { id: input.roleId, tenantId: input.tenantId } });
        if (!tenant || !role) throw new BadRequestException("اختر جهة نشطة ودوراً تابعاً لها");
        const org = input.providerOrganizationId
          ? await tx.providerOrganization.findFirst({
              where: { id: input.providerOrganizationId, tenantId: input.tenantId }
            })
          : null;
        if (input.providerOrganizationId && !org) throw new BadRequestException("المنشأة خارج نطاق الجهة");
        if (role.organizationId !== null && role.organizationId !== org?.id)
          throw new BadRequestException("دور الشركة لا يُسند إلا لموظف في الشركة نفسها");
        if (
          ["service-provider", "travel-company"].includes(role.code) &&
          (!org || providerDefinitions[org.type].role !== role.code)
        )
          throw new BadRequestException("اربط الدور بالمنشأة المناسبة");
        const email = input.email.trim().toLowerCase();
        const { user } = await this.linking.resolve(tx, tenant.id, {
          email,
          displayName: input.displayName,
          phone: input.phone,
          password: input.password,
          emailVerified: true
        });
        const member = await tx.tenantMembership.create({
          data: { tenantId: tenant.id, userId: user.id, status: "ACTIVE", providerOrganizationId: org?.id }
        });
        await tx.membershipRole.create({
          data: { tenantId: tenant.id, roleId: role.id, membershipId: member.id }
        });
        await this.audit(
          tx,
          actor,
          "platform.account.create",
          user.id,
          { email, role: role.code },
          tenant.id
        );
        return tx.user.findUniqueOrThrow({ where: { id: user.id }, select: accountSelect });
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("البريد مستخدم بحساب آخر");
      throw error;
    }
  }
}
