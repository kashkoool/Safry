import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { AccountLinkingService } from "../../identity/users/account-linking.service.js";
import type { Prisma, ProviderOrganization } from "../../../generated/prisma/client.js";
import { providerDefinitions } from "../../travel-services/catalog.js";
import type { CreateDepartmentDto, CreateEmployeeDto, CreateOrganizationRoleDto, PermissionOverridesDto, SpecialtiesDto, UpdateDepartmentDto, UpdateEmployeeDto, UpdateOrganizationRoleDto } from "./dto/organization.dto.js";
import { isUniqueViolation } from "../../../common/filters/database-errors.js";
import { revokeActiveSessions } from "../../../common/security/revoke-sessions.js";

const staffPermissions = new Set(["tenant.read", "catalog.service.read", "catalog.service.manage", "booking.read", "booking.manage"]);
const editableOverrides = new Set(["catalog.service.read", "catalog.service.manage", "booking.read", "booking.manage"]);
const employeeSelect = {
  id: true,
  jobTitle: true,
  status: true,
  awaitingOwnerConsent: true,
  departmentId: true,
  permissionOverrides: true,
  user: { select: { id: true, displayName: true, email: true, status: true } },
  roles: { select: { role: { select: { id: true, code: true, name: true } } } }
} as const;

type Employee = Prisma.TenantMembershipGetPayload<{ select: typeof employeeSelect }>;

/**
 * A membership that waits for its owner's consent belongs to someone else's identity: the
 * organization sees only the e-mail it typed itself, never that person's profile.
 */
function present(employee: Employee): Employee {
  if (!employee.awaitingOwnerConsent) return employee;
  return { ...employee, user: { id: employee.user.id, email: employee.user.email, displayName: employee.user.email, status: "INVITED" } };
}

interface Authorized {
  organization: ProviderOrganization;
  /** Tenant administrator acting on the organization (a higher authority than its own managers). */
  tenantManager: boolean;
}

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly linking: AccountLinkingService
  ) {}

  /**
   * Organization managers act only on their own organization, and only while it is ACTIVE for
   * anything that changes it; the read-only overview stays available.
   */
  private async authorized(user: AuthUser, id: string, mutate = true): Promise<Authorized> {
    const organization = await this.prisma.providerOrganization.findFirst({
      where: { id, tenantId: user.tenantId }
    });
    if (!organization) throw new NotFoundException("المنشأة غير موجودة ضمن الجهة الحالية");
    const tenantManager = user.roles.includes("tenant-admin") && user.permissions.includes("identity.user.manage");
    if (!tenantManager) {
      const member = await this.prisma.tenantMembership.findFirst({
        where: { id: user.membershipId, tenantId: user.tenantId, providerOrganizationId: id, status: "ACTIVE" }
      });
      if (!member || !user.permissions.includes("organization.staff.manage")) throw new ForbiddenException();
      if (mutate && organization.status !== "ACTIVE")
        throw new ForbiddenException("المنشأة غير مفعلة؛ لا يمكن تعديل بياناتها قبل تفعيلها من إدارة الجهة");
    }
    return { organization, tenantManager };
  }

  private async roles(tenantId: string, organization: ProviderOrganization, roleIds: string[]): Promise<void> {
    if (!roleIds.length || new Set(roleIds).size !== roleIds.length) throw new BadRequestException("اختر دوراً واحداً على الأقل دون تكرار");
    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleIds }, tenantId },
      include: { permissions: { include: { permission: true } } }
    });
    if (roles.length !== roleIds.length || roles.some((role) =>
      (role.organizationId !== null && role.organizationId !== organization.id) ||
      (["service-provider", "travel-company"].includes(role.code) && providerDefinitions[organization.type].role !== role.code) ||
      ["tenant-admin", "organization-manager", "traveler"].includes(role.code) ||
      role.permissions.some((entry) => !staffPermissions.has(entry.permission.code))
    )) throw new ForbiddenException("يمكن إسناد أدوار تشغيلية خاصة بالمنشأة فقط");
  }

  private overrides(value: PermissionOverridesDto | undefined): Record<string, boolean> | undefined {
    if (value === undefined) return undefined;
    // The DTO instance may carry declared-but-absent fields as undefined: keep only real choices.
    const entries = Object.entries(value).filter(([, enabled]) => enabled !== undefined);
    if (entries.some(([code, enabled]) => !editableOverrides.has(code) || typeof enabled !== "boolean"))
      throw new BadRequestException("استثناء الصلاحية غير صالح");
    return Object.fromEntries(entries);
  }

  private async department(organizationId: string, tenantId: string, departmentId: string): Promise<void> {
    const department = await this.prisma.organizationDepartment.findFirst({
      where: { id: departmentId, organizationId, tenantId, active: true }
    });
    if (!department) throw new BadRequestException("القسم غير موجود أو غير نشط في هذه المنشأة");
  }

  async overview(user: AuthUser, id: string): Promise<unknown> {
    const { organization } = await this.authorized(user, id, false);
    const [departments, employees, roles] = await Promise.all([
      this.prisma.organizationDepartment.findMany({
        where: { organizationId: id, tenantId: user.tenantId },
        orderBy: { createdAt: "asc" },
        select: { id: true, code: true, name: true, active: true, createdAt: true, _count: { select: { members: true } } }
      }),
      this.prisma.tenantMembership.findMany({
        where: { providerOrganizationId: id, tenantId: user.tenantId },
        select: employeeSelect,
        orderBy: { createdAt: "asc" },
        take: 1000
      }),
      this.prisma.role.findMany({
        where: { tenantId: user.tenantId, OR: [{ organizationId: null }, { organizationId: id }] },
        include: { permissions: { include: { permission: true } } },
        orderBy: { name: "asc" },
        take: 500
      })
    ]);
    return {
      organization: { id: organization.id, name: organization.name, nameAr: organization.nameAr, nameEn: organization.nameEn, type: organization.type, specialties: organization.specialties },
      departments,
      employees: employees.map(present),
      assignableRoles: roles.filter((role) =>
        !["tenant-admin", "organization-manager", "traveler"].includes(role.code) &&
        (!["service-provider", "travel-company"].includes(role.code) || providerDefinitions[organization.type].role === role.code) &&
        role.permissions.every((entry) => staffPermissions.has(entry.permission.code))
      ).map((role) => ({ id: role.id, code: role.code, name: role.name })),
      organizationRoles: roles.filter((role) => role.organizationId === id).map((role) => ({
        id: role.id, code: role.code.split("-").slice(6).join("-"), name: role.name,
        permissions: role.permissions.map(({ permission }) => permission.code).filter((code) => editableOverrides.has(code))
      }))
    };
  }

  private rolePermissions(codes: string[]): string[] {
    if (codes.some((code) => !editableOverrides.has(code)))
      throw new BadRequestException("يمكن لدور الشركة استخدام صلاحيات الخدمات والحجوزات فقط");
    return ["tenant.read", ...codes];
  }

  async createRole(user: AuthUser, id: string, input: CreateOrganizationRoleDto): Promise<unknown> {
    await this.authorized(user, id);
    const codes = this.rolePermissions(input.permissions);
    const permissions = await this.prisma.permission.findMany({ where: { code: { in: codes } } });
    if (permissions.length !== codes.length) throw new BadRequestException("إعداد الصلاحيات غير مكتمل");
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.create({ data: {
          tenantId: user.tenantId, organizationId: id, code: `org-${id}-${input.code}`,
          name: input.name.trim(), permissions: { create: permissions.map((permission) => ({ permissionId: permission.id })) }
        } });
        await tx.auditEvent.create({ data: {
          tenantId: user.tenantId, actorUserId: user.userId, action: "organization.role.create",
          entityType: "role", entityId: role.id, metadata: { organizationId: id, permissions: codes }
        } });
        return role;
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("رمز الدور مستخدم في هذه الشركة");
      throw error;
    }
  }

  async updateRole(user: AuthUser, id: string, roleId: string, input: UpdateOrganizationRoleDto): Promise<unknown> {
    await this.authorized(user, id);
    const role = await this.prisma.role.findFirst({ where: {
      id: roleId, tenantId: user.tenantId, organizationId: id, isSystem: false
    } });
    if (!role) throw new NotFoundException("الدور غير موجود ضمن شركتك");
    const codes = input.permissions === undefined ? undefined : this.rolePermissions(input.permissions);
    const permissions = codes === undefined ? undefined : await this.prisma.permission.findMany({
      where: { code: { in: codes } }
    });
    if (codes && permissions?.length !== codes.length) throw new BadRequestException("إعداد الصلاحيات غير مكتمل");
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.role.update({ where: { id: roleId }, data: {
        name: input.name?.trim(),
        ...(permissions ? { permissions: { deleteMany: {}, create: permissions.map((permission) => ({ permissionId: permission.id })) } } : {})
      } });
      if (permissions) {
        // Only the holders' sessions in this tenant end; their identities and other tenants are untouched.
        const assignments = await tx.membershipRole.findMany({ where: { roleId }, select: { membershipId: true } });
        const membershipIds = assignments.map((assignment) => assignment.membershipId);
        if (membershipIds.length)
          await revokeActiveSessions(tx, { membershipId: { in: membershipIds } });
      }
      await tx.auditEvent.create({ data: {
        tenantId: user.tenantId, actorUserId: user.userId, action: "organization.role.update",
        entityType: "role", entityId: roleId, metadata: { organizationId: id, permissions: codes }
      } });
      return changed;
    });
  }

  async setSpecialties(user: AuthUser, id: string, input: SpecialtiesDto): Promise<unknown> {
    await this.authorized(user, id);
    const specialties = [...new Set(input.specialties.map((item) => item.trim()).filter(Boolean))];
    if (specialties.some((item) => item.length > 80)) throw new BadRequestException("الاختصاص طويل جداً");
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.providerOrganization.update({
        where: { id }, data: { specialties }, select: { id: true, specialties: true }
      });
      await tx.auditEvent.create({ data: {
        tenantId: user.tenantId, actorUserId: user.userId, action: "organization.specialties.update",
        entityType: "provider_organization", entityId: id, metadata: { specialties }
      } });
      return changed;
    });
  }

  async createDepartment(user: AuthUser, id: string, input: CreateDepartmentDto): Promise<unknown> {
    await this.authorized(user, id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const department = await tx.organizationDepartment.create({
          data: { tenantId: user.tenantId, organizationId: id, code: input.code, name: input.name.trim() }
        });
        await tx.auditEvent.create({ data: {
          tenantId: user.tenantId, actorUserId: user.userId, action: "organization.department.create",
          entityType: "organization_department", entityId: department.id
        } });
        return department;
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("رمز القسم مستخدم في هذه المنشأة");
      throw error;
    }
  }

  async updateDepartment(user: AuthUser, id: string, departmentId: string, input: UpdateDepartmentDto): Promise<unknown> {
    await this.authorized(user, id);
    const exists = await this.prisma.organizationDepartment.findFirst({
      where: { id: departmentId, organizationId: id, tenantId: user.tenantId }
    });
    if (!exists) throw new NotFoundException();
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.organizationDepartment.update({
        where: { id: departmentId }, data: { name: input.name?.trim(), active: input.active }
      });
      await tx.auditEvent.create({ data: {
        tenantId: user.tenantId, actorUserId: user.userId, action: "organization.department.update",
        entityType: "organization_department", entityId: departmentId,
        metadata: { name: changed.name, active: changed.active }
      } });
      return changed;
    });
  }

  async createEmployee(user: AuthUser, id: string, input: CreateEmployeeDto): Promise<unknown> {
    const { organization } = await this.authorized(user, id);
    await this.department(id, user.tenantId, input.departmentId);
    await this.roles(user.tenantId, organization, input.roleIds);
    const permissionOverrides = this.overrides(input.permissionOverrides) ?? {};
    const email = input.email.trim().toLowerCase();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // An e-mail that already belongs to an identity becomes an invitation its owner must accept.
        const { userId, awaitingOwnerConsent } = await this.linking.createOrInvite(tx, user.tenantId, {
          email, displayName: input.displayName, password: input.password
        });
        const member = await tx.tenantMembership.create({
          data: {
            userId, tenantId: user.tenantId, providerOrganizationId: id,
            departmentId: input.departmentId, jobTitle: input.jobTitle.trim(),
            status: awaitingOwnerConsent ? "INVITED" : "ACTIVE", awaitingOwnerConsent,
            permissionOverrides
          }
        });
        await tx.membershipRole.createMany({
          data: input.roleIds.map((roleId) => ({ tenantId: user.tenantId, membershipId: member.id, roleId }))
        });
        await tx.auditEvent.create({ data: {
          tenantId: user.tenantId, actorUserId: user.userId, action: "organization.employee.create",
          entityType: "membership", entityId: member.id,
          metadata: { organizationId: id, departmentId: input.departmentId, roleIds: input.roleIds, awaitingOwnerConsent }
        } });
        return present(await tx.tenantMembership.findUniqueOrThrow({ where: { id: member.id }, select: employeeSelect }));
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("البريد مستخدم");
      throw error;
    }
  }

  async updateEmployee(user: AuthUser, id: string, membershipId: string, input: UpdateEmployeeDto): Promise<unknown> {
    const { organization, tenantManager } = await this.authorized(user, id);
    const target =await this.prisma.tenantMembership.findFirst({
      where: { id: membershipId, tenantId: user.tenantId, providerOrganizationId: id },
      include: { roles: { include: { role: true } } }
    });
    if (!target) throw new NotFoundException();
    if (target.userId === user.userId || target.roles.some((entry) => ["tenant-admin", "organization-manager"].includes(entry.role.code)))
      throw new ForbiddenException("لا يمكن تعديل حساب المسؤول من هذه الصفحة");
    const statusChange = input.status !== undefined && input.status !== target.status ? input.status : undefined;
    if (statusChange === "ACTIVE" && target.awaitingOwnerConsent)
      throw new ConflictException("الدعوة بانتظار موافقة صاحب الحساب");
    if (statusChange === "SUSPENDED" && target.awaitingOwnerConsent && target.status === "INVITED")
      throw new ConflictException("الدعوة بانتظار موافقة صاحب الحساب؛ ألغِها (REVOKED) بدل تعليقها");
    // a tenant-level suspension or revocation, and any revocation, is final for organization managers.
    if (statusChange && !tenantManager && (target.statusLockedByTenant || target.status === "REVOKED"))
      throw new ForbiddenException("حالة هذه العضوية تحددها إدارة الجهة");
    if (input.departmentId) await this.department(id, user.tenantId, input.departmentId);
    if (input.roleIds) await this.roles(user.tenantId, organization, input.roleIds);
    if (target.status === "INVITED" && input.status === "ACTIVE" &&
      (!(input.departmentId ?? target.departmentId) || !(input.roleIds ?? target.roles.map((entry) => entry.roleId)).length))
      throw new BadRequestException("حدد قسماً ودوراً قبل قبول طلب الموظف");
    const permissionOverrides = this.overrides(input.permissionOverrides);
    return this.prisma.$transaction(async (tx) => {
      await tx.tenantMembership.update({ where: { id: membershipId }, data: {
        jobTitle: input.jobTitle?.trim(), departmentId: input.departmentId, permissionOverrides,
        ...(statusChange ? {
          status: statusChange,
          revokedAt: statusChange === "REVOKED" ? new Date() : null,
          ...(tenantManager ? { statusLockedByTenant: statusChange !== "ACTIVE" } : {})
        } : {})
      } });
      if (input.roleIds) {
        await tx.membershipRole.deleteMany({ where: { membershipId } });
        await tx.membershipRole.createMany({
          data: input.roleIds.map((roleId) => ({ tenantId: user.tenantId, membershipId, roleId }))
        });
      }
      // Only this membership's sessions end: a tenant-side action never touches the global identity.
      await revokeActiveSessions(tx, { membershipId });
      await tx.auditEvent.create({ data: {
        tenantId: user.tenantId, actorUserId: user.userId, action: "organization.employee.update",
        entityType: "membership", entityId: membershipId,
        metadata: { organizationId: id, departmentId: input.departmentId ?? target.departmentId,
          roleIds: input.roleIds ?? target.roles.map((entry) => entry.roleId),
          status: { before: target.status, after: statusChange ?? target.status } }
      } });
      return present(await tx.tenantMembership.findUniqueOrThrow({ where: { id: membershipId }, select: employeeSelect }));
    });
  }
}
