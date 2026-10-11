import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { requestContext } from "../../../common/context/request-context.js";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { effectivePermissions } from "../../../common/security/effective-permissions.js";
import { heldPermissionCodes, isTenantAdmin, withinCeiling } from "../../../common/security/principal.js";
import { PrismaService } from "../../../database/prisma.service.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { providerDefinitions } from "../../travel-services/catalog.js";
import type { AssignRolesDto, CreateRoleDto, UpdateRoleDto } from "./dto/access.dto.js";
import { PLATFORM_ONLY_PREFIX, SYSTEM_ROLE_CODES } from "./system-roles.js";
import { isUniqueViolation } from "../../../common/filters/database-errors.js";
import { revokeActiveSessions } from "../../../common/security/revoke-sessions.js";

const roleInclude = {
  permissions: { include: { permission: true } },
  _count: { select: { memberships: true } }
} as const;

type RoleWithPermissions = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

const AUDIT_PREFIXES = ["identity.role.", "identity.membership.", "organization.role.", "organization.employee.", "platform.access."];

/**
 * Roles & Permissions Management (tenant level):
 * role and permission definition, role-permission assignment,
 * user role assignment, custom roles, revocation and permission change audit.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  private summary(role: RoleWithPermissions): object {
    return {
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions: role.permissions.map(({ permission }) => permission.code).sort(),
      members: role._count.memberships
    };
  }

  private async audit(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Prisma.InputJsonObject
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        requestId: requestContext.getStore()?.requestId,
        action,
        entityType,
        entityId,
        metadata
      }
    });
  }

  /** Forces holders to sign in again so the next token reflects the new access. */
  private async endSessions(tx: Prisma.TransactionClient, membershipIds: string[]): Promise<void> {
    if (!membershipIds.length) return;
    await revokeActiveSessions(tx, { membershipId: { in: membershipIds } });
  }

  async listRoles(user: AuthUser): Promise<object[]> {
    const roles = await this.prisma.role.findMany({
      where: { tenantId: user.tenantId, organizationId: null },
      include: roleInclude,
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      take: 200 // server-side ceiling
    });
    return roles.map((role) => this.summary(role));
  }

  listPermissions(): Promise<Array<{ code: string; description: string | null }>> {
    return this.prisma.permission.findMany({
      where: { NOT: { code: { startsWith: PLATFORM_ONLY_PREFIX } } },
      select: { code: true, description: true },
      orderBy: { code: "asc" }
    });
  }

  /** A tenant can only grant permissions it may hold itself; platform permissions are never grantable. */
  private async grantable(user: AuthUser, codes: string[]): Promise<Array<{ id: string; code: string }>> {
    if (codes.some((code) => code.startsWith(PLATFORM_ONLY_PREFIX)))
      throw new ForbiddenException("صلاحيات المنصة لا تُمنح لأدوار الجهة");
    if (!isTenantAdmin(user) && codes.some((code) => !user.permissions.includes(code)))
      throw new ForbiddenException("لا يمكنك منح صلاحية لا تملكها");
    const permissions = await this.prisma.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true }
    });
    if (permissions.length !== codes.length) throw new BadRequestException("صلاحية غير معروفة");
    return permissions;
  }

  async createRole(user: AuthUser, input: CreateRoleDto): Promise<object> {
    if (SYSTEM_ROLE_CODES.has(input.code) || input.code.startsWith("org-"))
      throw new ConflictException("رمز الدور محجوز");
    const permissions = await this.grantable(user, input.permissions);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.create({
          data: {
            tenantId: user.tenantId,
            code: input.code,
            name: input.name,
            description: input.description,
            isSystem: false,
            permissions: { create: permissions.map(({ id }) => ({ permissionId: id })) }
          },
          include: roleInclude
        });
        await this.audit(tx, user, "identity.role.create", "role", role.id, {
          code: role.code,
          permissions: permissions.map(({ code }) => code).sort()
        });
        return this.summary(role);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("رمز الدور مستخدم في هذه الجهة");
      throw error;
    }
  }

  private async tenantRole(user: AuthUser, id: string): Promise<RoleWithPermissions> {
    const role = await this.prisma.role.findFirst({
      where: { id, tenantId: user.tenantId, organizationId: null },
      include: roleInclude
    });
    if (!role) throw new NotFoundException("الدور غير موجود");
    if (role.isSystem) throw new ForbiddenException("لا يمكن تعديل أدوار النظام");
    if (!withinCeiling(user, role.permissions.map(({ permission }) => permission.code)))
      throw new ForbiddenException("لا يمكنك تعديل دور يتجاوز صلاحياتك");
    return role;
  }

  async updateRole(user: AuthUser, id: string, input: UpdateRoleDto): Promise<object> {
    const before = await this.tenantRole(user, id);
    const permissions = input.permissions === undefined ? undefined : await this.grantable(user, input.permissions);
    return this.prisma.$transaction(async (tx) => {
      await tx.role.update({
        where: { id, tenantId: user.tenantId },
        data: {
          name: input.name,
          description: input.description,
          ...(permissions
            ? { permissions: { deleteMany: {}, create: permissions.map(({ id: permissionId }) => ({ permissionId })) } }
            : {})
        }
      });
      if (permissions) {
        const holders = await tx.membershipRole.findMany({ where: { roleId: id }, select: { membershipId: true } });
        await this.endSessions(tx, holders.map((holder) => holder.membershipId));
      }
      const role = await tx.role.findUniqueOrThrow({ where: { id, tenantId: user.tenantId }, include: roleInclude });
      await this.audit(tx, user, "identity.role.update", "role", id, {
        before: { name: before.name, permissions: before.permissions.map(({ permission }) => permission.code).sort() },
        after: { name: role.name, permissions: role.permissions.map(({ permission }) => permission.code).sort() }
      });
      return this.summary(role);
    });
  }

  async deleteRole(user: AuthUser, id: string): Promise<void> {
    const role = await this.tenantRole(user, id);
    if (role._count.memberships > 0) throw new ConflictException("الدور مسند لأعضاء؛ انقلهم إلى دور آخر أولاً");
    await this.prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id, tenantId: user.tenantId } });
      await this.audit(tx, user, "identity.role.delete", "role", id, { code: role.code });
    });
  }

  /** User Role Assignment: replaces the roles of one membership of the current tenant. */
  async assignRoles(user: AuthUser, membershipId: string, input: AssignRolesDto): Promise<object> {
    if (!input.roleIds.length) throw new BadRequestException("اختر دوراً واحداً على الأقل");
    const member = await this.prisma.tenantMembership.findFirst({
      where: { id: membershipId, tenantId: user.tenantId },
      include: {
        user: true,
        organization: true,
        roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } }
      }
    });
    if (!member) throw new NotFoundException("العضوية غير موجودة ضمن الجهة الحالية");
    if (member.userId === user.userId) throw new ConflictException("لا يمكنك تعديل أدوار حسابك الحالي");
    if (member.user.isPlatformAdmin) throw new ForbiddenException("حساب مدير النظام يُدار من المنصة");
    // Only a tenant administrator changes another administrator's roles; the caller (also an
    // administrator, and never the target) stays, so the tenant can not lose its last administrator here.
    if (!isTenantAdmin(user) && member.roles.some(({ role }) => role.code === "tenant-admin"))
      throw new ForbiddenException("لا يمكنك تعديل أدوار مدير الجهة");
    // The access being replaced must also be within the caller's own (no demoting stronger members).
    if (!withinCeiling(user, effectivePermissions(heldPermissionCodes(member), member.permissionOverrides)))
      throw new ForbiddenException("لا يمكنك تعديل أدوار عضو يملك صلاحيات تتجاوز صلاحياتك");
    const roles = await this.prisma.role.findMany({
      where: { id: { in: input.roleIds }, tenantId: user.tenantId },
      include: { permissions: { include: { permission: true } } }
    });
    if (roles.length !== input.roleIds.length) throw new BadRequestException("الأدوار يجب أن تتبع الجهة الحالية");
    for (const role of roles) {
      if (role.organizationId !== null && role.organizationId !== member.providerOrganizationId)
        throw new BadRequestException("دور الشركة لا يُسند إلا لموظف في الشركة نفسها");
      if (
        ["service-provider", "travel-company"].includes(role.code) &&
        (!member.organization || providerDefinitions[member.organization.type].role !== role.code)
      )
        throw new BadRequestException("دور مقدم الخدمة يجب أن يطابق منشأة العضوية");
      if (!isTenantAdmin(user) && role.code === "tenant-admin")
        throw new ForbiddenException("لا يمنح دور مدير الجهة إلا مدير الجهة");
      const codes = role.permissions.map(({ permission }) => permission.code);
      if (!isTenantAdmin(user) && codes.some((code) => !user.permissions.includes(code)))
        throw new ForbiddenException("لا يمكنك منح دور يتجاوز صلاحياتك");
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.membershipRole.deleteMany({ where: { membershipId } });
      await tx.membershipRole.createMany({
        data: roles.map((role) => ({ tenantId: user.tenantId, membershipId, roleId: role.id }))
      });
      await this.endSessions(tx, [membershipId]);
      await this.audit(tx, user, "identity.membership.roles.update", "membership", membershipId, {
        before: member.roles.map(({ role }) => role.code).sort(),
        after: roles.map((role) => role.code).sort()
      });
      return { membershipId, roles: roles.map((role) => ({ id: role.id, code: role.code, name: role.name })) };
    });
  }

  /** Permission Change Audit. */
  permissionAudit(user: AuthUser, limit = 100): Promise<object[]> {
    return this.prisma.auditEvent.findMany({
      where: {
        tenantId: user.tenantId,
        OR: AUDIT_PREFIXES.map((prefix) => ({ action: { startsWith: prefix } }))
      },
      select: { id: true, action: true, entityType: true, entityId: true, actorUserId: true, metadata: true, occurredAt: true },
      orderBy: { occurredAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200)
    });
  }
}
