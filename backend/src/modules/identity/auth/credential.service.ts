import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { runAsSystem, requestContext } from "../../../common/context/request-context.js";
import { hashPassword } from "../../../common/security/password.js";
import { revokeActiveSessions } from "../../../common/security/revoke-sessions.js";
import { PrismaService } from "../../../database/prisma.service.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { CredentialTokenPurpose } from "../../../generated/prisma/enums.js";
import { appBaseUrl } from "../../mail/mail.config.js";
import { MailService } from "../../mail/mail.service.js";
import { AccountSecurityService } from "./account-security.service.js";
import {
  MAX_LINKS_PER_HOUR, MIN_RESEND_INTERVAL_MS, RESET_TTL_MINUTES, TOKEN_PATTERN, VERIFY_TTL_HOURS,
  hashToken, newToken, sameDigest
} from "./credential-token.js";

const INVALID_RESET = "Reset link is invalid or expired";
const INVALID_VERIFY = "Verification link is invalid or expired";

/** Identity fields the mail flows need. */
export type MailAccount = { id: string; email: string; emailNormalized: string; locale: string; status: string; deletedAt: Date | null; emailVerifiedAt: Date | null };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Password reset and e-mail verification links.
 *
 * - The token is 32 random bytes; only its SHA-256 is stored, compared in constant time, single use (claimed with a conditional
 *   update inside the user-row lock), and a newer link of the same purpose voids older unused ones.
 * - The link carries the token in the URL fragment (`#token=...`), which browsers never send to a server, so it stays out of
 *   access logs and Referer headers. The page reads it and POSTs it in a JSON body.
 * - "Request a link" endpoints answer identically and take at least AUTH_MAIL_MIN_RESPONSE_MS whether or not the address belongs
 *   to an account; mail goes out after the answer is decided, so provider latency is not a signal either.
 * Every method runs in the explicit system scope (identity-level data, no tenant yet).
 */
@Injectable()
export class CredentialService {
  private readonly logger = new Logger(CredentialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly security: AccountSecurityService
  ) {}

  private get minResponseMs(): number {
    return this.config.get<number>("AUTH_MAIL_MIN_RESPONSE_MS", 300);
  }

  private link(path: string, token: string): string {
    return `${appBaseUrl(this.config)}${path}#token=${token}`;
  }

  /** Runs `work`, then waits so the whole call takes at least the configured floor (constant response time). */
  private async paced<T>(work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      const wait = this.minResponseMs - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  }

  private eligible(user: MailAccount | null): user is MailAccount {
    return user !== null && user.status === "ACTIVE" && user.deletedAt === null;
  }

  private audit(tx: Prisma.TransactionClient, action: string, userId: string | null, ipAddress: string | undefined, metadata: Prisma.InputJsonObject = {}): Promise<unknown> {
    return tx.auditEvent.create({
      data: { tenantId: null, actorUserId: userId, requestId: requestContext.getStore()?.requestId, action, entityType: "user", entityId: userId, ipAddress, metadata }
    });
  }

  /**
   * Creates the token inside the user-row lock after applying the per-account send limits. Returns undefined when the limit
   * says "do not send" (the caller still answers as usual).
   */
  private issue(user: MailAccount, purpose: CredentialTokenPurpose, ttlMs: number, ipAddress: string | undefined, action: string): Promise<string | undefined> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id"=${user.id}::uuid FOR UPDATE`;
      const now = new Date();
      const recent = await tx.credentialToken.findMany({
        where: { userId: user.id, purpose, createdAt: { gt: new Date(now.getTime() - 3_600_000) } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true }
      });
      const last = recent[0]?.createdAt;
      if (recent.length >= MAX_LINKS_PER_HOUR || (last && now.getTime() - last.getTime() < MIN_RESEND_INTERVAL_MS)) {
        await this.audit(tx, `${action}.suppressed`, user.id, ipAddress, { reason: "rate_limited" });
        return undefined;
      }
      await tx.credentialToken.updateMany({ where: { userId: user.id, purpose, usedAt: null }, data: { usedAt: now } });
      const token = newToken();
      await tx.credentialToken.create({
        data: { userId: user.id, purpose, tokenHash: hashToken(token), email: user.emailNormalized, expiresAt: new Date(now.getTime() + ttlMs) }
      });
      await this.audit(tx, action, user.id, ipAddress);
      return token;
    });
  }

  /** POST /auth/password/forgot */
  forgotPassword(email: string, ipAddress: string | undefined): Promise<void> {
    return this.paced(() => runAsSystem(async () => {
      const user = await this.prisma.user.findUnique({ where: { emailNormalized: email.trim().toLowerCase() } });
      if (!this.eligible(user)) {
        await this.prisma.$transaction(async (tx) => {
          await this.audit(tx, "identity.password.reset_requested", null, ipAddress, { matched: false });
        });
        return;
      }
      const token = await this.issue(user, "PASSWORD_RESET", RESET_TTL_MINUTES * 60_000, ipAddress, "identity.password.reset_requested");
      if (token) this.mail.sendDetached(user.email, user.locale, { kind: "password-reset", link: this.link("/reset-password", token), validForMinutes: RESET_TTL_MINUTES });
    }));
  }

  /** POST /auth/email/resend: only an unverified, active account gets a link; everyone else gets the same answer. */
  resendVerification(email: string, ipAddress: string | undefined): Promise<void> {
    return this.paced(() => runAsSystem(async () => {
      const user = await this.prisma.user.findUnique({ where: { emailNormalized: email.trim().toLowerCase() } });
      if (!this.eligible(user) || user.emailVerifiedAt !== null) {
        await this.prisma.$transaction(async (tx) => {
          await this.audit(tx, "identity.email.verification_requested", null, ipAddress, { matched: false });
        });
        return;
      }
      await this.sendVerification(user, ipAddress);
    }));
  }

  /**
   * Issues and mails a verification link (registration, address change, resend). Runs after the change that needs the link has
   * committed, so it never throws: a failure to issue or to hand the mail over is logged (error class only, no address or token)
   * and the user can ask for a new link through /auth/email/resend.
   */
  async sendVerification(user: MailAccount, ipAddress?: string): Promise<void> {
    try {
      const token = await runAsSystem(() => this.issue(user, "EMAIL_VERIFICATION", VERIFY_TTL_HOURS * 3_600_000, ipAddress, "identity.email.verification_requested"));
      if (token) this.mail.sendDetached(user.email, user.locale, { kind: "email-verification", link: this.link("/verify-email", token), validForHours: VERIFY_TTL_HOURS });
    } catch (error) {
      this.logger.error(`verification link not sent: ${error instanceof Error ? error.name : "unknown error"}`);
    }
  }

  /** For callers that only hold a user id (platform address change). Never throws, like `sendVerification`. */
  async sendVerificationTo(userId: string, ipAddress?: string): Promise<void> {
    try {
      const user = await runAsSystem(() => this.prisma.user.findUnique({ where: { id: userId } }));
      if (this.eligible(user) && user.emailVerifiedAt === null) await this.sendVerification(user, ipAddress);
    } catch (error) {
      this.logger.error(`verification link not sent: ${error instanceof Error ? error.name : "unknown error"}`);
    }
  }

  /** Token row for a presented token, or undefined. Shape and digest checks come before and after the lookup. */
  private async find(token: string, purpose: CredentialTokenPurpose): Promise<{ id: string; userId: string; email: string } | undefined> {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const tokenHash = hashToken(token);
    const row = await this.prisma.credentialToken.findUnique({ where: { tokenHash } });
    if (!row || row.purpose !== purpose || row.usedAt !== null || row.expiresAt <= new Date() || !sameDigest(row.tokenHash, tokenHash)) return undefined;
    return { id: row.id, userId: row.userId, email: row.email };
  }

  /**
   * Claims the token (single use) under the user-row lock and re-checks the account. Throws `invalid` when another request
   * claimed it first, the account is no longer active, or its address changed after the link was issued.
   */
  private async claim(tx: Prisma.TransactionClient, row: { id: string; userId: string; email: string }, invalid: string): Promise<MailAccount> {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id"=${row.userId}::uuid FOR UPDATE`;
    const claimed = await tx.credentialToken.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    const user = await tx.user.findUnique({ where: { id: row.userId } });
    if (claimed.count !== 1 || !this.eligible(user) || user.emailNormalized !== row.email) throw new BadRequestException(invalid);
    return user;
  }

  /** POST /auth/password/reset */
  resetPassword(token: string, newPassword: string, ipAddress: string | undefined): Promise<void> {
    return runAsSystem(async () => {
      const row = await this.find(token, "PASSWORD_RESET");
      if (!row) throw new BadRequestException(INVALID_RESET);
      const passwordHash = await hashPassword(newPassword);
      const account = await this.prisma.$transaction(async (tx) => {
        const user = await this.claim(tx, row, INVALID_RESET);
        const now = new Date();
        await tx.user.update({
          where: { id: user.id },
          data: {
            passwordHash,
            authVersion: { increment: 1 },
            mfaChallengeHash: null,
            // Receiving the link proves control of the mailbox.
            ...(user.emailVerifiedAt === null ? { emailVerifiedAt: now } : {})
          }
        });
        await tx.credentialToken.updateMany({ where: { userId: user.id, purpose: "PASSWORD_RESET", usedAt: null }, data: { usedAt: now } });
        const ended = await revokeActiveSessions(tx, { userId: user.id });
        await this.audit(tx, "identity.password.reset", user.id, ipAddress, { sessionsEnded: ended });
        return user;
      });
      await this.security.clearLockout(account.emailNormalized, ipAddress);
      this.mail.sendDetached(account.email, account.locale, { kind: "password-changed" });
    });
  }

  /** POST /auth/email/verify */
  verifyEmail(token: string, ipAddress: string | undefined): Promise<void> {
    return runAsSystem(async () => {
      const row = await this.find(token, "EMAIL_VERIFICATION");
      if (!row) throw new BadRequestException(INVALID_VERIFY);
      await this.prisma.$transaction(async (tx) => {
        const user = await this.claim(tx, row, INVALID_VERIFY);
        if (user.emailVerifiedAt === null) await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
        await this.audit(tx, "identity.email.verified", user.id, ipAddress);
      });
    });
  }
}
