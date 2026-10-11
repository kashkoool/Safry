import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { requestContext, runAsSystem } from "../../../common/context/request-context.js";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { effectivePermissions } from "../../../common/security/effective-permissions.js";
import { heldPermissionCodes, isTenantAdmin, withinCeiling } from "../../../common/security/principal.js";
import { PrismaService } from "../../../database/prisma.service.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { MemberStatusDto, UpdateProfileDto } from "./dto/users.dto.js";
import { revokeActiveSessions } from "../../../common/security/revoke-sessions.js";

const profileSelect = {
  id: true,
  email: true,
  displayName: true,
  phone: true,
  locale: true,
  status: true,
  emailVerifiedAt: true,
  mfaEnabledAt: true,
  createdAt: true
} as const;

const memberSelect = {
  id: true,
  status: true,
  awaitingOwnerConsent: true,
  jobTitle: true,
  createdAt: true,
  user: { select: { id: true, email: true, displayName: true, phone: true, status: true } },
  roles: { select: { role: { select: { code: true, name: true } } } }
} as const;

type Member = Prisma.TenantMembershipGetPayload<{ select: typeof memberSelect }>;

/** Until its owner accepts, an invited identity's profile is not shown to the tenant. */
function present(member: Member): Member {
  if (!member.awaitingOwnerConsent) return member;
  return { ...member, user: { id: member.user.id, email: member.user.email, displayName: member.user.email, phone: null, status: "INVITED" } };
}

/**
 * User & Account Management (tenant view):
 * profile and contact management, membership status management,
 * search, change and lifecycle history.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async profile(user: AuthUser): Promise<object> {
    const account = await this.prisma.user.findUnique({ where: { id: user.userId }, select: profileSelect });
    if (!account) throw new UnauthorizedException();
    const { mfaEnabledAt, ...rest } = account;
    return { ...rest, mfaEnabled: mfaEnabledAt !== null, tenantId: user.tenantId, membershipId: user.membershipId };
  }

  async updateProfile(user: AuthUser, input: UpdateProfileDto): Promise<object> {
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: user.userId }, select: profileSelect });
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.userId },
        data: { displayName: input.displayName, phone: input.phone, locale: input.locale }
      });
      await tx.auditEvent.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          requestId: requestContext.getStore()?.requestId,
          action: "identity.user.profile.update",
          entityType: "user",
          entityId: user.userId,
          metadata: {
            changed: Object.keys(input).filter((key) => input[key as keyof UpdateProfileDto] !== undefined),
            before: { displayName: before.displayName, phone: before.phone, locale: before.locale }
          }
        }
      });
    });
    return this.profile(user);
  }

  async members(user: AuthUser, search?: string): Promise<object[]> {
    const term = search?.trim();
    const rows = await this.prisma.tenantMembership.findMany({
      where: {
        tenantId: user.tenantId,
        // A search must not reveal the profile of an identity that has not accepted its invitation.
        ...(term
          ? {
              awaitingOwnerConsent: false,
              user: {
                OR: [
                  { email: { contains: term, mode: "insensitive" } },
                  { displayName: { contains: term, mode: "insensitive" } }
                ]
              }
            }
          : {})
      },
      select: memberSelect,
      orderBy: { createdAt: "asc" },
      take: 500
    });
    return rows.map(present);
  }

  /** Account Status Management: suspend, revoke or re-activate a member of this tenant. */
  async setMemberStatus(user: AuthUser, membershipId: string, input: MemberStatusDto): Promise<object> {
    const member = await this.prisma.tenantMembership.findFirst({
      where: { id: membershipId, tenantId: user.tenantId },
      include: { user: true, roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } }
    });
    if (!member) throw new NotFoundException("العضوية غير موجودة ضمن الجهة الحالية");
    if (member.userId === user.userId) throw new ConflictException("لا يمكنك تغيير حالة حسابك الحالي");
    if (member.user.isPlatformAdmin) throw new ForbiddenException("حساب مدير النظام يُدار من المنصة");
    if (!isTenantAdmin(user) && member.roles.some(({ role }) => role.code === "tenant-admin"))
      throw new ForbiddenException("لا يمكنك تغيير حالة مدير الجهة");
    if (!withinCeiling(user, effectivePermissions(heldPermissionCodes(member), member.permissionOverrides)))
      throw new ForbiddenException("لا يمكنك تغيير حالة عضو يملك صلاحيات تتجاوز صلاحياتك");
    if (member.status === input.status) return this.memberSummary(user, membershipId);
    if (input.status === "ACTIVE" && member.awaitingOwnerConsent)
      throw new ConflictException("الدعوة بانتظار موافقة صاحب الحساب");
    // A suspended invitation could be neither accepted nor activated: withdraw it instead.
    if (input.status === "SUSPENDED" && member.awaitingOwnerConsent && member.status === "INVITED")
      throw new ConflictException("الدعوة بانتظار موافقة صاحب الحساب؛ ألغِها (REVOKED) بدل تعليقها");
    return this.prisma.$transaction(async (tx) => {
      await tx.tenantMembership.update({
        where: { id: membershipId, tenantId: user.tenantId },
        data: {
          status: input.status,
          revokedAt: input.status === "REVOKED" ? new Date() : null,
          // A tenant-level suspension or revocation can not be lifted by an organization manager.
          statusLockedByTenant: input.status !== "ACTIVE"
        }
      });
      // Only this tenant's sessions end; the person's access to other tenants is unaffected.
      if (input.status !== "ACTIVE")
        await revokeActiveSessions(tx, { membershipId });
      await tx.auditEvent.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          requestId: requestContext.getStore()?.requestId,
          action: "identity.membership.status",
          entityType: "membership",
          entityId: membershipId,
          metadata: { before: member.status, after: input.status, reason: input.reason ?? null }
        }
      });
      return present(await tx.tenantMembership.findUniqueOrThrow({
        where: { id: membershipId, tenantId: user.tenantId },
        select: memberSelect
      }));
    });
  }

  private async memberSummary(user: AuthUser, membershipId: string): Promise<object> {
    return present(await this.prisma.tenantMembership.findFirstOrThrow({
      where: { id: membershipId, tenantId: user.tenantId },
      select: memberSelect
    }));
  }

  /**
   * Invitations addressed to the signed-in identity in any tenant. They are looked up
   * by the verified user id only, so this is the one place an identity sees memberships outside the
   * tenant of its token.
   */
  invitations(user: AuthUser): Promise<object[]> {
    return runAsSystem(() => this.prisma.tenantMembership.findMany({
      where: { userId: user.userId, status: "INVITED", awaitingOwnerConsent: true },
      select: {
        id: true, jobTitle: true, createdAt: true,
        tenant: { select: { code: true, name: true } },
        organization: { select: { name: true, nameAr: true, nameEn: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 50
    }));
  }

  /** The identity's owner accepts or declines an invitation addressed to them. */
  respondToInvitation(user: AuthUser, membershipId: string, accept: boolean): Promise<object> {
    return runAsSystem(() => this.prisma.$transaction(async (tx) => {
      const invitation = await tx.tenantMembership.findFirst({
        where: { id: membershipId, userId: user.userId, status: "INVITED", awaitingOwnerConsent: true }
      });
      if (!invitation) throw new NotFoundException("الدعوة غير موجودة");
      // Re-check the state inside the write: a concurrent accept/decline must not both succeed.
      const answered = await tx.tenantMembership.updateMany({
        where: { id: membershipId, userId: user.userId, status: "INVITED", awaitingOwnerConsent: true },
        data: accept
          ? { status: "ACTIVE", awaitingOwnerConsent: false }
          : { status: "REVOKED", revokedAt: new Date() }
      });
      if (answered.count !== 1) throw new NotFoundException("الدعوة غير موجودة");
      await tx.auditEvent.create({
        data: {
          tenantId: invitation.tenantId,
          actorUserId: user.userId,
          requestId: requestContext.getStore()?.requestId,
          action: accept ? "identity.membership.invitation.accept" : "identity.membership.invitation.decline",
          entityType: "membership",
          entityId: membershipId
        }
      });
      return { membershipId, status: accept ? "ACTIVE" : "REVOKED" };
    }));
  }

  /** Data Change and Lifecycle History of one member. */
  async history(user: AuthUser, membershipId: string): Promise<object[]> {
    const member = await this.prisma.tenantMembership.findFirst({
      where: { id: membershipId, tenantId: user.tenantId },
      select: { id: true, userId: true }
    });
    if (!member) throw new NotFoundException("العضوية غير موجودة ضمن الجهة الحالية");
    const where: Prisma.AuditEventWhereInput = {
      tenantId: user.tenantId,
      OR: [
        { entityType: "membership", entityId: membershipId },
        { entityType: "user", entityId: member.userId },
        { actorUserId: member.userId, action: { startsWith: "identity." } }
      ]
    };
    return this.prisma.auditEvent.findMany({
      where,
      select: { id: true, action: true, entityType: true, entityId: true, actorUserId: true, metadata: true, occurredAt: true },
      orderBy: { occurredAt: "desc" },
      take: 200
    });
  }
}
