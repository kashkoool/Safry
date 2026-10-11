import { ConflictException, Injectable } from "@nestjs/common";
import { hashPassword } from "../../../common/security/password.js";
import { PrismaService } from "../../../database/prisma.service.js";
import type { Prisma, User } from "../../../generated/prisma/client.js";

/** Unanswered invitations one identity may hold at the same time (GET /users/me/invitations lists at most 50). */
export const MAX_PENDING_INVITATIONS = 20;

export interface NewAccount {
  email: string;
  displayName: string;
  phone?: string | undefined;
  password: string;
}

export interface ResolvedAccount {
  user: User;
  /** True when the e-mail already belonged to an identity that is now linked to one more tenant. */
  linked: boolean;
}

export interface InvitedAccount {
  userId: string;
  /** True when the e-mail belongs to an existing identity whose owner must accept the membership. */
  awaitingOwnerConsent: boolean;
}

/**
 * Linked Account Management / Tenant User Association.
 *
 * One e-mail address is one identity (`users.emailNormalized` stays globally unique) that can hold
 * one membership per tenant. An existing identity is linked to a second tenant only with its
 * owner's proof or consent; the existing password and profile are never replaced.
 */
@Injectable()
export class AccountLinkingService {
  constructor(private readonly prisma: PrismaService) {}


  /**
   * Unanswered invitations of one identity across ALL tenants. The caller's transaction is tenant-scoped (RLS), so the count is
   * made on that same client with the bypass flag raised for this single read-only statement and restored right after.
   * It must not use another client: a nested connection has no role context, and as the restricted runtime login the policy
   * then hides every row, which turned the cap into a no-op.
   */
  private async pendingInvitations(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    const [previous] = await tx.$queryRaw<Array<{ value: string }>>`SELECT coalesce(current_setting('app.bypass_rls', true), 'off') AS value`;
    await tx.$queryRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const [row] = await tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM tenant_memberships WHERE "userId" = ${userId}::uuid AND status = 'INVITED' AND "awaitingOwnerConsent" = true`;
    await tx.$queryRaw`SELECT set_config('app.bypass_rls', ${previous?.value === "on" ? "on" : "off"}, true)`;
    return row?.n ?? 0;
  }

  /** Accounts that must never be linked implicitly by a tenant. */
  private linkable(user: User): boolean {
    return user.status === "ACTIVE" && user.deletedAt === null && !user.isPlatformAdmin;
  }

  private async create(tx: Prisma.TransactionClient, email: string, input: NewAccount): Promise<User> {
    return tx.user.create({
      data: {
        email,
        emailNormalized: email,
        displayName: input.displayName.trim(),
        phone: input.phone,
        passwordHash: await hashPassword(input.password)
      }
    });
  }

  private async existing(tx: Prisma.TransactionClient, tenantId: string, email: string): Promise<User | null> {
    const existing = await tx.user.findUnique({ where: { emailNormalized: email } });
    if (!existing) return null;
    if (!this.linkable(existing)) throw new ConflictException("البريد الإلكتروني مستخدم بالفعل");
    const membership = await tx.tenantMembership.findFirst({ where: { tenantId, userId: existing.id } });
    if (membership) throw new ConflictException("البريد الإلكتروني مستخدم بالفعل في هذه الجهة");
    return existing;
  }

  /**
   * Self-registration only: the caller must already have proven ownership of an existing identity
   * (RegistrationService.proveOwnership) before it is linked to one more tenant.
   */
  async resolve(tx: Prisma.TransactionClient, tenantId: string, input: NewAccount): Promise<ResolvedAccount> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.existing(tx, tenantId, email);
    if (!existing) return { user: await this.create(tx, email, input), linked: false };
    return { user: existing, linked: true };
  }

  /**
   * Accounts created by a tenant-side actor (organization staff, provider owner). An identity that
   * already exists is never linked implicitly: the caller gets only its id and must
   * create the membership as an invitation that the identity's owner accepts. The password typed by
   * the actor is ignored for an existing identity, and none of its profile is returned.
   */
  async createOrInvite(tx: Prisma.TransactionClient, tenantId: string, input: NewAccount): Promise<InvitedAccount> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.existing(tx, tenantId, email);
    if (!existing) return { userId: (await this.create(tx, email, input)).id, awaitingOwnerConsent: false };
    // Invitation spam guard: an identity holds a bounded number of unanswered invitations,
    // counted across tenants. Same message as the other "already used" refusals.
    const pending = await this.pendingInvitations(tx, existing.id);
    if (pending >= MAX_PENDING_INVITATIONS) throw new ConflictException("البريد الإلكتروني مستخدم بالفعل");
    return { userId: existing.id, awaitingOwnerConsent: true };
  }
}
