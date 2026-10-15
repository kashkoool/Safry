import { WriteThrottle } from "../../../common/cache/write-throttle.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { hashPassword, verifyPassword } from "../../../common/security/password.js";
import { requestContext, runAsSystem } from "../../../common/context/request-context.js";
import type { AuthUser } from "../../../common/security/auth-user.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { PrismaService } from "../../../database/prisma.service.js";
import type { LoginDto } from "./dto/login.dto.js";
import {
  ACCESS_TOKEN,
  MFA_TOKEN,
  type JwtPayload,
  type LoginResult,
  type MfaChallenge,
  type MfaTokenPayload,
  type IssuedTokenPair
} from "./auth.types.js";
import { effectivePermissions } from "../../../common/security/effective-permissions.js";
import { AccountSecurityService } from "./account-security.service.js";
import { MfaService } from "./mfa.service.js";
import { revokeActiveSessions } from "../../../common/security/revoke-sessions.js";

interface ClientMetadata {
  userAgent?: string;
  ipAddress?: string;
}

type Portal = NonNullable<LoginDto["portal"]>;

/** Session family carried over on refresh: the login time caps the absolute lifetime. */
interface SessionFamily {
  familyId: string;
  authenticatedAt: Date;
}

type IssuableMembership = {
  id: string;
  tenantId: string;
  providerOrganizationId: string | null;
  permissionOverrides?: unknown;
  roles: Array<{
    role: { code: string; permissions: Array<{ permission: { code: string } }> };
  }>;
};

const MFA_CHALLENGE_SECONDS = 300;
/** A rotated refresh token presented again within this window is a benign race, not theft. */
const ROTATION_GRACE_MS = 10_000;
const INVALID_CREDENTIALS = "Invalid credentials or tenant";
const INVALID_REFRESH = "Refresh token is invalid or expired";
const MFA_EXPIRED = "انتهت صلاحية التحقق؛ سجل الدخول مجدداً";
const INVALID_MFA_CODE = "رمز التحقق غير صحيح";

const membershipInclude = {
  tenant: true,
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } }
} as const;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly security: AccountSecurityService,
    private readonly mfa: MfaService
  ) {}

  private get idleMs(): number {
    return this.config.get<number>("SESSION_IDLE_TIMEOUT_MINUTES", 15) * 60_000;
  }

  private get absoluteMs(): number {
    return this.config.get<number>("SESSION_ABSOLUTE_TIMEOUT_HOURS", 24) * 3_600_000;
  }

  /** User Login (with throttling and an optional MFA challenge). */
  login(input: LoginDto, metadata: ClientMetadata): Promise<LoginResult> {
    return runAsSystem(() => this.authenticate(input, metadata));
  }

  /**
   * Unknown, blocked and existing accounts take the same path: one throttle transaction, one
   * argon2 verification and one audit row, and the same 401 answer on every failure.
   */
  private async authenticate(input: LoginDto, metadata: ClientMetadata): Promise<LoginResult> {
    const emailNormalized = input.email.trim().toLowerCase();
    const tenantCode = input.tenantCode.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized },
      include: {
        memberships: {
          where: { tenant: { code: tenantCode, status: "ACTIVE" }, status: "ACTIVE" },
          include: membershipInclude
        }
      }
    });
    const attempt = await this.security.begin(emailNormalized, metadata.ipAddress);
    this.dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
    const checked = await verifyPassword(user && attempt.allowed ? user.passwordHash : await this.dummyHash, input.password);
    const passwordValid = Boolean(user) && attempt.allowed && checked;
    const membership = user?.memberships[0];
    // With MFA the address's streak ends only after the second factor; the password step is refunded.
    if (passwordValid)
      await (user!.mfaEnabledAt ? this.security.refund(emailNormalized, metadata.ipAddress) : this.security.succeed(emailNormalized, metadata.ipAddress));
    // A self-registered account must confirm its address first. The refusal is the same 401 as any other failure; the audit reason tells support.
    if (!user || !passwordValid || user.status !== "ACTIVE" || user.deletedAt !== null || user.emailVerifiedAt === null || !membership) {
      await this.security.recordFailure({
        userId: user?.id,
        tenantId: membership?.tenantId,
        ipAddress: metadata.ipAddress,
        reason: !attempt.allowed ? "throttled" : !user ? "unknown_account" : !passwordValid ? "bad_password" : user.emailVerifiedAt === null ? "email_unverified" : "inactive_account_or_tenant",
        blocked: attempt.blocks && !passwordValid
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    this.assertPortal(input.portal, user, membership);
    if (user.mfaEnabledAt) return this.challenge(user.id, membership, input.portal);
    return this.issueTokenPair(user.id, user.email, membership, metadata, "identity.login", user.authVersion);
  }

  /** second step of login when the account has MFA enabled. */
  verifyMfa(mfaToken: string, code: string, metadata: ClientMetadata): Promise<IssuedTokenPair> {
    return runAsSystem(() => this.completeMfa(mfaToken, code, metadata));
  }

  private async completeMfa(mfaToken: string, code: string, metadata: ClientMetadata): Promise<IssuedTokenPair> {
    const claims = await this.jwt
      .verifyAsync<MfaTokenPayload>(mfaToken, {
        secret: this.mfaSecret(),
        algorithms: [MFA_TOKEN.algorithm],
        issuer: MFA_TOKEN.issuer,
        audience: MFA_TOKEN.audience
      })
      .catch(() => {
        throw new UnauthorizedException(MFA_EXPIRED);
      });
    if (claims.purpose !== "mfa" || !claims.jti) throw new UnauthorizedException(MFA_EXPIRED);
    const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    const membership = await this.prisma.tenantMembership.findFirst({
      where: {
        id: claims.mid,
        tenantId: claims.tid,
        userId: claims.sub,
        status: "ACTIVE",
        tenant: { status: "ACTIVE" }
      },
      include: membershipInclude
    });
    if (!user || !membership || user.status !== "ACTIVE" || user.deletedAt !== null || !user.mfaEnabledAt)
      throw new UnauthorizedException(MFA_EXPIRED);
    const attempt = await this.security.begin(user.emailNormalized, metadata.ipAddress);
    if (!attempt.allowed || !(await this.mfa.verifyCode(user.id, code, claims.jti))) {
      await this.security.recordFailure({
        userId: user.id,
        tenantId: membership.tenantId,
        ipAddress: metadata.ipAddress,
        reason: attempt.allowed ? "bad_mfa_code" : "throttled",
        blocked: attempt.blocks
      });
      throw new UnauthorizedException(INVALID_MFA_CODE);
    }
    await this.security.succeed(user.emailNormalized, metadata.ipAddress);
    this.assertPortal(claims.portal, user, membership);
    return this.issueTokenPair(user.id, user.email, membership, metadata, "identity.login.mfa", user.authVersion);
  }

  private mfaSecret(): string {
    return `${this.config.getOrThrow<string>("JWT_ACCESS_SECRET")}:mfa-challenge`;
  }

  /** Issues a single-use challenge: only the latest one per account is valid and answering consumes it. */
  private async challenge(
    userId: string,
    membership: { id: string; tenantId: string },
    portal: Portal | undefined
  ): Promise<MfaChallenge> {
    const challengeId = randomUUID();
    await this.prisma.user.update({ where: { id: userId }, data: { mfaChallengeHash: sha256(challengeId) } });
    const payload: MfaTokenPayload = { purpose: "mfa", sub: userId, tid: membership.tenantId, mid: membership.id, portal };
    const mfaToken = await this.jwt.signAsync(payload, {
      secret: this.mfaSecret(),
      expiresIn: MFA_CHALLENGE_SECONDS,
      algorithm: MFA_TOKEN.algorithm,
      issuer: MFA_TOKEN.issuer,
      audience: MFA_TOKEN.audience,
      jwtid: challengeId
    });
    return { mfaRequired: true, mfaToken, expiresIn: MFA_CHALLENGE_SECONDS };
  }

  private assertPortal(
    portal: Portal | undefined,
    user: { isPlatformAdmin: boolean },
    membership: { providerOrganizationId: string | null; roles: Array<{ role: { code: string; isSystem: boolean } }> }
  ): void {
    if (!portal) {
      // Opt-in server-side enforcement: deployments that serve one portal can refuse portal-less logins.
      if (this.config.get<string>("LOGIN_PORTAL_REQUIRED") === "true")
        throw new UnauthorizedException("هذا الحساب غير مخوّل لبوابة الدخول المحددة");
      return;
    }
    const roleCodes = membership.roles.map(({ role }) => role.code);
    const allowed =
      portal === "admin"
        ? user.isPlatformAdmin
        : portal === "provider"
          ? !user.isPlatformAdmin &&
            (Boolean(membership.providerOrganizationId) || roleCodes.includes("tenant-admin"))
          : !user.isPlatformAdmin &&
            !membership.providerOrganizationId &&
            !roleCodes.includes("tenant-admin") &&
            // Travelers, and members whose roles are all tenant-defined (their pages are filtered by permission).
            (roleCodes.includes("traveler") || (membership.roles.length > 0 && membership.roles.every(({ role }) => !role.isSystem)));
    if (!allowed) throw new UnauthorizedException("هذا الحساب غير مخوّل لبوابة الدخول المحددة");
  }

  refresh(refreshToken: string, metadata: ClientMetadata): Promise<IssuedTokenPair> {
    return runAsSystem(() => this.rotate(refreshToken, metadata));
  }

  /**
   * Single-use rotation inside one transaction. Presenting a token that was already rotated means
   * it was copied: the whole session family is revoked (OWASP refresh-token reuse detection).
   */
  private async rotate(refreshToken: string, metadata: ClientMetadata): Promise<IssuedTokenPair> {
    const tokenHash = sha256(refreshToken);
    const existing = await this.prisma.refreshSession.findUnique({
      where: { tokenHash },
      select: { userId: true }
    });
    if (!existing) throw new UnauthorizedException(INVALID_REFRESH);
    const outcome = await this.prisma.$transaction(async (tx) => {
      // Keep the same user -> session lock order as administrative revocation.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id"=${existing.userId}::uuid FOR UPDATE`;
      const current = await tx.refreshSession.findUnique({
        where: { tokenHash },
        include: { user: true, membership: { include: membershipInclude } }
      });
      if (!current) throw new UnauthorizedException(INVALID_REFRESH);
      const now = new Date();
      if (current.revokedAt) {
        // Two tabs or a retry after a timeout present the same token within moments of each other: refuse
        // the loser but keep the family alive. Reuse after the grace window is theft.
        if (now.getTime() - current.revokedAt.getTime() <= ROTATION_GRACE_MS) throw new UnauthorizedException(INVALID_REFRESH);
        const revoked = await tx.refreshSession.updateMany({
          where: { familyId: current.familyId, revokedAt: null },
          data: { revokedAt: now }
        });
        if (revoked.count > 0)
          await tx.auditEvent.create({
            data: {
              tenantId: current.tenantId,
              actorUserId: current.userId,
              requestId: requestContext.getStore()?.requestId,
              action: "identity.session.reuse_detected",
              entityType: "refresh_session",
              entityId: current.id,
              ipAddress: metadata.ipAddress,
              metadata: { familyId: current.familyId, revokedSessions: revoked.count }
            }
          });
        return null;
      }
      if (
        current.expiresAt <= now ||
        current.authenticatedAt.getTime() + this.absoluteMs <= now.getTime() ||
        (current.lastUsedAt ?? current.createdAt).getTime() <= now.getTime() - this.idleMs ||
        current.user.status !== "ACTIVE" ||
        current.user.deletedAt !== null ||
        current.membership.status !== "ACTIVE" ||
        current.membership.tenant.status !== "ACTIVE"
      ) {
        throw new UnauthorizedException(INVALID_REFRESH);
      }
      const rotation = await tx.refreshSession.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: now }
      });
      if (rotation.count !== 1) throw new UnauthorizedException("Refresh token has already been used");
      return this.issueIn(
        tx,
        current.user.id,
        current.user.email,
        current.membership,
        metadata,
        "identity.session.refresh",
        current.user.authVersion,
        { familyId: current.familyId, authenticatedAt: current.authenticatedAt },
        current.lastUsedAt ?? current.createdAt
      );
    });
    // Thrown after the commit so the family revocation is kept.
    if (!outcome) throw new UnauthorizedException(INVALID_REFRESH);
    return outcome;
  }

  /** The access token was just verified against the session (JwtStrategy), so a skipped write loses at most one interval of precision. */
  private readonly activityWrites = new WriteThrottle();

  async activity(user: AuthUser): Promise<void> {
    if (!user.sessionId) throw new UnauthorizedException();
    const now = new Date();
    const idleMs = this.idleMs;
    // One DB write per session per interval (at most a quarter of the idle timeout, 60 s by default).
    const interval = Math.min(this.config.get<number>("ACTIVITY_WRITE_INTERVAL_MS", 60_000), Math.floor(idleMs / 4));
    if (!this.activityWrites.shouldWrite(user.sessionId, interval)) return;
    const cutoff = new Date(now.getTime() - idleMs);
    const sessionId = user.sessionId;
    const changed = await this.prisma.refreshSession.updateMany({
      where: { id: user.sessionId, userId: user.userId, revokedAt: null, expiresAt: { gt: now },
        OR: [{ lastUsedAt: { gt: cutoff } }, { lastUsedAt: null, createdAt: { gt: cutoff } }] },
      data: { lastUsedAt: now }
    }).catch((error: unknown) => {
      this.activityWrites.forget(sessionId);
      throw error;
    });
    if (changed.count !== 1) {
      this.activityWrites.forget(user.sessionId);
      throw new UnauthorizedException("انتهت الجلسة بسبب عدم النشاط");
    }
  }

  /**
   * Ends the session family the refresh token belongs to. Needs no access token, so a client whose
   * access token already expired can still end the server session. Unknown tokens are ignored.
   */
  logout(refreshToken: string, metadata: ClientMetadata): Promise<void> {
    return runAsSystem(async () => {
      const session = await this.prisma.refreshSession.findUnique({
        where: { tokenHash: sha256(refreshToken) },
        select: { id: true, userId: true, tenantId: true, familyId: true }
      });
      if (!session) return;
      const result = await this.prisma.refreshSession.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      if (result.count > 0)
        await this.prisma.auditEvent.create({
          data: {
            tenantId: session.tenantId,
            actorUserId: session.userId,
            requestId: requestContext.getStore()?.requestId,
            action: "identity.logout",
            entityType: "refresh_session",
            entityId: session.id,
            ipAddress: metadata.ipAddress
          }
        });
    });
  }

  /** Ends every session of the identity, in every tenant. */
  /** The signed-in identity's own logins (one entry per login, however often its token rotated), in every tenant. */
  listSessions(user: AuthUser): Promise<Array<{ id: string; userAgent: string | null; ipAddress: string | null; signedInAt: Date; lastUsedAt: Date | null; tenantId: string }>> {
    const now = new Date();
    return runAsSystem(async () => {
      const rows = await this.prisma.refreshSession.findMany({
        where: { userId: user.userId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { familyId: true, userAgent: true, ipAddress: true, authenticatedAt: true, lastUsedAt: true, createdAt: true, tenantId: true }
      });
      return rows.map((row) => ({
        id: row.familyId, userAgent: row.userAgent, ipAddress: row.ipAddress,
        signedInAt: row.authenticatedAt, lastUsedAt: row.lastUsedAt ?? row.createdAt, tenantId: row.tenantId
      }));
    });
  }

  /** Ends one of the caller's own logins. Another user's id answers 404, exactly like an unknown one. */
  async endSession(user: AuthUser, familyId: string): Promise<void> {
    const ended = await runAsSystem(() => this.prisma.refreshSession.updateMany({
      where: { userId: user.userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() }
    }));
    if (ended.count === 0) throw new NotFoundException();
    await this.prisma.auditEvent.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        requestId: requestContext.getStore()?.requestId,
        action: "identity.session.end",
        entityType: "session",
        entityId: familyId
      }
    });
  }

  async logoutAll(user: AuthUser): Promise<void> {
    await runAsSystem(() => this.security.endOtherSessions(user.userId, undefined));
    await this.prisma.auditEvent.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        requestId: requestContext.getStore()?.requestId,
        action: "identity.logout.all",
        entityType: "user",
        entityId: user.userId
      }
    });
  }

  /**
   * change password: requires the current password (counted by the login throttle),
   * then ends every other session of the identity. The calling session stays signed in.
   */
  async changePassword(user: AuthUser, currentPassword: string, newPassword: string, ipAddress: string | undefined): Promise<void> {
    await runAsSystem(async () => {
      const account = await this.prisma.user.findUnique({ where: { id: user.userId } });
      if (!account || account.status !== "ACTIVE" || account.deletedAt) throw new UnauthorizedException();
      const attempt = await this.security.begin(account.emailNormalized, ipAddress);
      if (!attempt.allowed || !(await verifyPassword(account.passwordHash, currentPassword))) {
        await this.security.recordFailure({
          userId: account.id,
          tenantId: user.tenantId,
          ipAddress,
          reason: attempt.allowed ? "bad_password_on_password_change" : "throttled",
          blocked: attempt.blocks
        });
        throw new UnauthorizedException("كلمة المرور الحالية غير صحيحة");
      }
      await this.security.succeed(account.emailNormalized, ipAddress);
      if (newPassword === currentPassword) throw new BadRequestException("يجب أن تختلف كلمة المرور الجديدة عن الحالية");
      const passwordHash = await hashPassword(newPassword);
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id"=${account.id}::uuid FOR UPDATE`;
        await tx.user.update({ where: { id: account.id }, data: { passwordHash, mfaChallengeHash: null } });
        await revokeActiveSessions(tx, { userId: account.id, ...(user.sessionId ? { id: { not: user.sessionId } } : {}) });
        await tx.auditEvent.create({
          data: {
            tenantId: user.tenantId,
            actorUserId: account.id,
            requestId: requestContext.getStore()?.requestId,
            action: "identity.password.change",
            entityType: "user",
            entityId: account.id,
            ipAddress
          }
        });
      });
    });
  }

  private issueTokenPair(
    userId: string,
    email: string,
    membership: IssuableMembership,
    metadata: ClientMetadata,
    auditAction: string,
    expectedAuthVersion: number
  ): Promise<IssuedTokenPair> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize token issuance with account revocation so an in-flight login
      // cannot mint a usable session after the administrator ends all sessions.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id"=${userId}::uuid FOR UPDATE`;
      return this.issueIn(tx, userId, email, membership, metadata, auditAction, expectedAuthVersion);
    });
  }

  /** Creates the session row and tokens. The caller holds the user row lock in `tx`. */
  private async issueIn(
    tx: Prisma.TransactionClient,
    userId: string,
    email: string,
    membership: IssuableMembership,
    metadata: ClientMetadata,
    auditAction: string,
    expectedAuthVersion: number,
    family?: SessionFamily,
    lastActivityAt?: Date
  ): Promise<IssuedTokenPair> {
    const roles = membership.roles.map(({ role }) => role.code);
    const permissions = effectivePermissions(
      membership.roles.flatMap(({ role }) => role.permissions.map(({ permission }) => permission.code)),
      membership.permissionOverrides
    );
    const account = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (account.status !== "ACTIVE" || account.deletedAt || account.authVersion !== expectedAuthVersion)
      throw new UnauthorizedException();
    const user: AuthUser = {
      isPlatformAdmin: account.isPlatformAdmin,
      userId,
      tenantId: membership.tenantId,
      membershipId: membership.id,
      providerOrganizationId: membership.providerOrganizationId,
      email,
      roles,
      permissions
    };
    const now = new Date();
    const authenticatedAt = family?.authenticatedAt ?? now;
    const expiresIn = this.config.get<number>("JWT_ACCESS_TTL_SECONDS", 900);
    const refreshToken = randomBytes(48).toString("base64url");
    const refreshMs = this.config.get<number>("REFRESH_TOKEN_TTL_DAYS", 30) * 86_400_000;
    // Never past the absolute lifetime of the login, whatever the refresh TTL says.
    const expiresAt = new Date(Math.min(now.getTime() + refreshMs, authenticatedAt.getTime() + this.absoluteMs));
    const session = await tx.refreshSession.create({
      data: {
        tokenHash: sha256(refreshToken),
        userId,
        tenantId: membership.tenantId,
        membershipId: membership.id,
        familyId: family?.familyId ?? randomUUID(),
        authenticatedAt,
        userAgent: metadata.userAgent,
        ipAddress: metadata.ipAddress,
        lastUsedAt: lastActivityAt ?? now,
        expiresAt
      }
    });
    const payload: JwtPayload = {
      av: account.authVersion,
      sid: session.id,
      sub: userId,
      tid: membership.tenantId,
      mid: membership.id,
      email,
      roles,
      permissions
    };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"),
      expiresIn,
      algorithm: ACCESS_TOKEN.algorithm,
      issuer: ACCESS_TOKEN.issuer,
      audience: ACCESS_TOKEN.audience
    });
    await tx.auditEvent.create({
      data: {
        tenantId: membership.tenantId,
        actorUserId: userId,
        requestId: requestContext.getStore()?.requestId,
        action: auditAction,
        entityType: "refresh_session",
        entityId: session.id,
        ipAddress: metadata.ipAddress
      }
    });
    return { accessToken, refreshToken, refreshExpiresAt: expiresAt, expiresIn,
      idleTimeoutSeconds: this.idleMs / 1000, user };
  }
}
