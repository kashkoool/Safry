import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import type { Request } from "express";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { ACCESS_TOKEN, type JwtPayload } from "./auth.types.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { runAsSystem } from "../../../common/context/request-context.js";
import { AuthPrincipalCache, principalKey } from "../../../common/cache/auth-principal-cache.js";
import { effectivePermissions } from "../../../common/security/effective-permissions.js";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly idleTimeoutMinutes: number;
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly principals: AuthPrincipalCache
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("JWT_ACCESS_SECRET"),
      // Pinned: only HS256, and only access tokens of this API (not MFA challenges).
      algorithms: [ACCESS_TOKEN.algorithm],
      issuer: ACCESS_TOKEN.issuer,
      audience: ACCESS_TOKEN.audience,
      passReqToCallback: true
    });
    this.idleTimeoutMinutes = config.get<number>("SESSION_IDLE_TIMEOUT_MINUTES", 15);
  }

  // Token verification happens before a tenant scope exists, so its lookups run as system.
  validate(request: Request, payload: JwtPayload): Promise<AuthUser> {
    return runAsSystem(() => this.verifyPrincipal(request, payload));
  }

  private async verifyPrincipal(request: Request, payload: JwtPayload): Promise<AuthUser> {
    const requestedTenant = request.header("x-tenant-id");
    if (requestedTenant && requestedTenant !== payload.tid) {
      throw new UnauthorizedException("Token does not belong to the requested tenant");
    }
    if (!payload.sid) throw new UnauthorizedException("انتهت الجلسة؛ سجل الدخول مجدداً");
    const meta = { sessionId: payload.sid, userId: payload.sub, membershipId: payload.mid, tenantId: payload.tid };
    // Only successful verifications are cached (a throw is never stored); see AuthPrincipalCache for staleness.
    return this.principals.getOrLoad(principalKey(meta, payload.av ?? 0), meta, () => this.loadPrincipal(payload));
  }

  private async loadPrincipal(payload: JwtPayload): Promise<AuthUser> {
    const now = new Date();
    const session = await this.prisma.refreshSession.findFirst({
      where: { id: payload.sid, userId: payload.sub, tenantId: payload.tid,
        membershipId: payload.mid, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true, lastUsedAt: true, createdAt: true }
    });
    if (!session) throw new UnauthorizedException("الجلسة غير صالحة أو منتهية");
    if ((session.lastUsedAt ?? session.createdAt).getTime() <= now.getTime() - this.idleTimeoutMinutes * 60_000) {
      await this.prisma.refreshSession.updateMany({ where: { id: session.id, revokedAt: null },
        data: { revokedAt: now } });
      throw new UnauthorizedException("انتهت الجلسة بسبب عدم النشاط");
    }
    const member = await this.prisma.tenantMembership.findFirst({
      where: {
        id: payload.mid,
        tenantId: payload.tid,
        userId: payload.sub,
        status: "ACTIVE",
        user: { status: "ACTIVE", deletedAt: null },
        tenant: { status: "ACTIVE" }
      },
      include: {
        // Only what the principal needs: never load passwordHash or MFA secrets on the per-request path.
        user: { select: { email: true, isPlatformAdmin: true, authVersion: true } },
        roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } }
      }
    });
    if (!member) throw new UnauthorizedException("الحساب أو الجهة غير نشطين");
    if ((payload.av ?? 0) !== member.user.authVersion)
      throw new UnauthorizedException("انتهت صلاحية الجلسة؛ سجل الدخول مجدداً");
    return {
      isPlatformAdmin: member.user.isPlatformAdmin,
      userId: payload.sub,
      tenantId: payload.tid,
      membershipId: payload.mid,
      providerOrganizationId: member.providerOrganizationId,
      sessionId: payload.sid,
      email: member.user.email,
      roles: member.roles.map(({ role }) => role.code),
      permissions: effectivePermissions(
        member.roles.flatMap(({ role }) => role.permissions.map(({ permission }) => permission.code)),
        member.permissionOverrides
      )
    };
  }
}
