import { createHash, createHmac, randomBytes } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { requestContext, runAsSystem } from "../../../common/context/request-context.js";
import type { AuthUser } from "../../../common/security/auth-user.js";
import { MFA_ENROLLMENT_REQUIRED } from "../../../common/security/platform-admin.guard.js";
import { SecretBox } from "../../../common/security/secret-box.js";
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from "../../../common/security/totp.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { AccountSecurityService } from "./account-security.service.js";
import type { User } from "../../../generated/prisma/client.js";
import { verifyPassword } from "../../../common/security/password.js";

const RECOVERY_CODE_COUNT = 8;

export interface MfaStatus {
  enabled: boolean;
  pendingSetup: boolean;
  recoveryCodesRemaining: number;
  /** True after the legacy recovery codes were invalidated: the UI asks the user to generate a new set. */
  recoveryCodesRegenerationRequired: boolean;
}

/** 10 random bytes = 80 bits, written as 16 base32 characters in groups of four. */
const RECOVERY_CODE_BYTES = 10;
const RECOVERY_CODE_PATTERN = /^[A-Z2-7]{16}$/;
const normalizeRecovery = (code: string): string => code.replace(/[\s-]/g, "").toUpperCase();
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Multi-Factor Authentication (TOTP) and Authentication Method Management. */
@Injectable()
export class MfaService {
  private readonly box: SecretBox;
  private readonly recoveryKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly security: AccountSecurityService,
    config: ConfigService
  ) {
    // Production requires a dedicated MFA_ENCRYPTION_KEY (validateEnvironment); the fallback is for development only.
    const keyMaterial = config.get<string>("MFA_ENCRYPTION_KEY") ?? config.getOrThrow<string>("JWT_ACCESS_SECRET");
    this.box = new SecretBox(keyMaterial);
    this.recoveryKey = createHash("sha256").update(`safry:mfa-recovery:v1:${keyMaterial}`).digest();
  }

  /** Keyed (server secret) and salted (per user) hash, so a database dump alone does not reveal codes. */
  private recoveryHash(userId: string, code: string): string {
    return `h1:${createHmac("sha256", this.recoveryKey).update(`${userId}:${normalizeRecovery(code)}`).digest("hex")}`;
  }

  private async account(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== "ACTIVE" || user.deletedAt) throw new UnauthorizedException();
    return user;
  }

  /**
   * Password re-check for MFA changes, counted by the login throttle. With `needsSecondFactor` the
   * attempt is only refunded (the streak stays), because a code check follows and only a verified
   * code may clear the streak; otherwise a password holder could reset the limit on every guess.
   */
  private async reauthenticate(
    user: User,
    password: string,
    tenantId: string,
    ipAddress: string | undefined,
    needsSecondFactor = false
  ): Promise<void> {
    const attempt = await this.security.begin(user.emailNormalized, ipAddress);
    if (!attempt.allowed || !(await verifyPassword(user.passwordHash, password))) {
      await this.security.recordFailure({
        userId: user.id,
        tenantId,
        ipAddress,
        reason: attempt.allowed ? "bad_password_on_reauthentication" : "throttled",
        blocked: attempt.blocks
      });
      throw new UnauthorizedException("كلمة المرور غير صحيحة");
    }
    if (needsSecondFactor) await this.security.refund(user.emailNormalized, ipAddress);
    else await this.security.succeed(user.emailNormalized, ipAddress);
  }

  private recoveryHashes(user: { mfaRecoveryHashes: unknown }): string[] {
    return Array.isArray(user.mfaRecoveryHashes)
      ? user.mfaRecoveryHashes.filter((item): item is string => typeof item === "string")
      : [];
  }

  private async audit(user: AuthUser, action: string): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        requestId: requestContext.getStore()?.requestId,
        action,
        entityType: "user",
        entityId: user.userId
      }
    });
  }

  async status(user: AuthUser): Promise<MfaStatus> {
    const account = await this.account(user.userId);
    return {
      enabled: account.mfaEnabledAt !== null,
      pendingSetup: account.mfaEnabledAt === null && account.mfaSecretEnc !== null,
      recoveryCodesRemaining: this.recoveryHashes(account).length,
      recoveryCodesRegenerationRequired: account.mfaEnabledAt !== null && account.mfaRecoveryRegenerationRequired
    };
  }

  async beginSetup(user: AuthUser, password: string, ipAddress?: string): Promise<{ secret: string; otpauthUri: string }> {
    const account = await this.account(user.userId);
    await this.reauthenticate(account, password, user.tenantId, ipAddress);
    if (account.mfaEnabledAt) throw new ConflictException("المصادقة متعددة العوامل مفعّلة بالفعل");
    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: account.id },
      data: { mfaSecretEnc: this.box.seal(secret), mfaLastStep: null, mfaRecoveryHashes: [] }
    });
    await this.audit(user, "identity.mfa.setup");
    return { secret, otpauthUri: otpauthUri(secret, account.email) };
  }

  async enable(user: AuthUser, code: string): Promise<{ recoveryCodes: string[] }> {
    const account = await this.account(user.userId);
    if (account.mfaEnabledAt) throw new ConflictException("المصادقة متعددة العوامل مفعّلة بالفعل");
    if (!account.mfaSecretEnc) throw new BadRequestException("ابدأ إعداد المصادقة أولاً");
    const step = verifyTotp(this.box.open(account.mfaSecretEnc), code);
    if (step === null) throw new BadRequestException("رمز التحقق غير صحيح");
    const recoveryCodes = this.newRecoveryCodes();
    await this.prisma.user.update({
      where: { id: account.id },
      data: {
        mfaEnabledAt: new Date(),
        mfaLastStep: step,
        mfaRecoveryHashes: recoveryCodes.map((code) => this.recoveryHash(account.id, code)),
        mfaRecoveryRegenerationRequired: false
      }
    });
    // A session opened before the second factor existed must not outlive its enablement.
    // Sessions of the identity in every tenant, not only the current one (RLS).
    await runAsSystem(() => this.security.endOtherSessions(account.id, user.sessionId));
    await this.audit(user, "identity.mfa.enable");
    return { recoveryCodes };
  }

  private newRecoveryCodes(): string[] {
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => base32Encode(randomBytes(RECOVERY_CODE_BYTES)).match(/.{4}/g)!.join("-"));
  }

  /** Counted code check: only a verified code clears the streak (see reauthenticate). */
  private async requireSecondFactor(account: User, tenantId: string, code: string, ipAddress: string | undefined, reason: string, allowRecovery = true): Promise<void> {
    const attempt = await this.security.begin(account.emailNormalized, ipAddress);
    if (!attempt.allowed || !(await this.verifyCode(account.id, code, undefined, allowRecovery))) {
      await this.security.recordFailure({
        userId: account.id,
        tenantId,
        ipAddress,
        reason: attempt.allowed ? reason : "throttled",
        blocked: attempt.blocks
      });
      throw new UnauthorizedException("رمز التحقق غير صحيح");
    }
    await this.security.succeed(account.emailNormalized, ipAddress);
  }

  /**
   * Step-up for a privileged action: the current password, plus a fresh second-factor
   * code when the account has MFA. A platform administrator always needs the code: with no MFA enrolled the step-up is refused
   * (403 mfa_enrollment_required) instead of falling back to the password alone. Both are counted by the login throttle, so a stolen access token
   * alone can not perform the action and can not be used to guess the secrets.
   */
  async stepUp(user: AuthUser, password: string | undefined, code: string | undefined, ipAddress?: string): Promise<void> {
    if (!password) throw new UnauthorizedException("أكّد كلمة المرور لإتمام هذا الإجراء");
    const account = await this.account(user.userId);
    if (account.isPlatformAdmin && account.mfaEnabledAt === null)
      throw new ForbiddenException({ code: MFA_ENROLLMENT_REQUIRED, message: "فعّل المصادقة متعددة العوامل لحسابك لإتمام هذا الإجراء" });
    const needsSecondFactor = account.mfaEnabledAt !== null;
    await this.reauthenticate(account, password, user.tenantId, ipAddress, needsSecondFactor);
    if (needsSecondFactor) {
      if (!code) throw new UnauthorizedException("أدخل رمز التحقق لإتمام هذا الإجراء");
      await this.requireSecondFactor(account, user.tenantId, code, ipAddress, "bad_mfa_code_on_step_up");
    }
  }

  async disable(user: AuthUser, password: string, code: string, ipAddress?: string): Promise<void> {
    const account = await this.account(user.userId);
    await this.reauthenticate(account, password, user.tenantId, ipAddress, true);
    if (!account.mfaEnabledAt) throw new ConflictException("المصادقة متعددة العوامل غير مفعّلة");
    if (account.isPlatformAdmin) throw new ConflictException("لا يمكن إيقاف المصادقة متعددة العوامل لحساب مدير النظام");
    await this.requireSecondFactor(account, user.tenantId, code, ipAddress, "bad_mfa_code_on_disable");
    await this.prisma.$transaction(async (tx) => {
      // Same row lock as granting platform administration: re-check under the lock so an account granted that role
      // a moment ago can not lose its second factor.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${account.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: account.id }, select: { isPlatformAdmin: true, mfaEnabledAt: true } });
      if (current?.isPlatformAdmin) throw new ConflictException("لا يمكن إيقاف المصادقة متعددة العوامل لحساب مدير النظام");
      if (!current?.mfaEnabledAt) throw new ConflictException("المصادقة متعددة العوامل غير مفعّلة");
      await tx.user.update({
        where: { id: account.id },
        data: { mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, mfaRecoveryHashes: [], mfaChallengeHash: null, mfaRecoveryRegenerationRequired: false }
      });
    });
    // Sessions of the identity in every tenant, not only the current one (RLS).
    await runAsSystem(() => this.security.endOtherSessions(account.id, user.sessionId));
    await this.audit(user, "identity.mfa.disable");
  }

  /**
   * issues a fresh set of recovery codes, replacing every existing one (also the legacy ones removed by migration
   * 20261012_auth_invalidate_legacy_recovery_codes). Needs the password and a current authenticator code (a recovery code is not
   * accepted: it must prove possession of the authenticator), both counted by the login throttle.
   */
  async regenerateRecoveryCodes(user: AuthUser, password: string, code: string, ipAddress?: string): Promise<{ recoveryCodes: string[] }> {
    const account = await this.account(user.userId);
    await this.reauthenticate(account, password, user.tenantId, ipAddress, true);
    if (!account.mfaEnabledAt) throw new ConflictException("المصادقة متعددة العوامل غير مفعّلة");
    await this.requireSecondFactor(account, user.tenantId, code, ipAddress, "bad_mfa_code_on_recovery_regeneration", false);
    const recoveryCodes = this.newRecoveryCodes();
    await this.prisma.user.update({
      where: { id: account.id },
      data: {
        mfaRecoveryHashes: recoveryCodes.map((item) => this.recoveryHash(account.id, item)),
        mfaRecoveryRegenerationRequired: false
      }
    });
    await this.audit(user, "identity.mfa.recovery_codes_regenerated");
    return { recoveryCodes };
  }

  /**
   * Verifies a second-factor answer: an authenticator code (single use per time step, which blocks
   * replay) or a one-time recovery code. Serialized per account. With `challengeId` (login), the
   * challenge must be the pending one and is consumed by this attempt, right or wrong.
   */
  async verifyCode(userId: string, code: string, challengeId?: string, allowRecovery = true): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id"=${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (challengeId !== undefined) {
        if (user.mfaChallengeHash !== sha256(challengeId)) return false;
        await tx.user.update({ where: { id: userId }, data: { mfaChallengeHash: null } });
      }
      if (!user.mfaEnabledAt || !user.mfaSecretEnc) return false;
      const step = verifyTotp(this.box.open(user.mfaSecretEnc), code.trim());
      if (step !== null) {
        if (user.mfaLastStep !== null && step <= user.mfaLastStep) return false;
        await tx.user.update({ where: { id: userId }, data: { mfaLastStep: step } });
        return true;
      }
      if (!allowRecovery) return false;
      const hashes = this.recoveryHashes(user);
      const normalized = normalizeRecovery(code);
      // Only current-scheme codes ("h1:" keyed hash) are honoured. Codes issued before 2026-10-07 (8 characters, plain SHA-256)
      // were invalidated by migration 20261012_auth_invalidate_legacy_recovery_codes and never match any more.
      if (!RECOVERY_CODE_PATTERN.test(normalized)) return false;
      const hashed = this.recoveryHash(userId, normalized);
      if (!hashes.includes(hashed)) return false;
      await tx.user.update({
        where: { id: userId },
        data: { mfaRecoveryHashes: hashes.filter((item) => item !== hashed) }
      });
      return true;
    });
  }
}
