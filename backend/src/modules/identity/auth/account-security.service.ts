import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { requestContext } from "../../../common/context/request-context.js";
import { PrismaService } from "../../../database/prisma.service.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { revokeActiveSessions } from "../../../common/security/revoke-sessions.js";

export interface FailureContext {
  userId?: string | null;
  tenantId?: string | null;
  ipAddress?: string | undefined;
  reason: string;
  /** True when counting this attempt started a block. */
  blocked?: boolean;
}

export interface Attempt {
  /** False while the e-mail (or e-mail + address) is blocked: the caller must not verify anything. */
  allowed: boolean;
  /** True when counting this attempt started a block (audited as identity.account.locked on failure). */
  blocks: boolean;
}

/**
 * Separate counters per purpose: password guesses through registration are throttled too, but they
 * can never block the owner's sign-in.
 */
export type ThrottleScope = "login" | "register";

const PRUNE_EVERY_MS = 10 * 60_000;
const PRUNE_AFTER_MS = 24 * 3_600_000;
const TRUST_MS = 30 * 86_400_000;
/** Account-wide budget, as a multiple of LOGIN_MAX_ATTEMPTS, for guesses from untrusted addresses. */
const ACCOUNT_FACTOR = 4;

/**
 * Login Attempt Management / Account Lockout Management.
 *
 * Every password or second-factor check reserves an attempt in two buckets before it runs:
 *  - e-mail + client address: from LOGIN_MAX_ATTEMPTS consecutive attempts without a success, the
 *    pair is blocked for 1, 2, 4 ... minutes (doubling, capped at LOGIN_LOCKOUT_MINUTES);
 *  - e-mail alone: more than 4 x LOGIN_MAX_ATTEMPTS attempts inside LOGIN_LOCKOUT_MINUTES block the
 *    e-mail for LOGIN_LOCKOUT_MINUTES, which bounds distributed guessing. An address that signed in
 *    successfully within 30 days is exempt from this block, so an attacker cannot lock the owner out
 *    of a device they already use.
 * Blocks always expire. A success clears the pair and refunds the reserved account attempts.
 * Check and count run under row locks in one transaction, so parallel guesses can not pass the limit.
 * Unknown e-mails are counted the same way, so the throttle reveals nothing about account existence.
 * Callers must run in system scope (login happens before a tenant is bound).
 */
@Injectable()
export class AccountSecurityService {
  private lastPrune = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService
  ) {}

  private get maxAttempts(): number {
    return this.config.get<number>("LOGIN_MAX_ATTEMPTS", 5);
  }

  private get lockoutMs(): number {
    return this.config.get<number>("LOGIN_LOCKOUT_MINUTES", 15) * 60_000;
  }

  private keys(scope: ThrottleScope, email: string, ipAddress: string | undefined): { account: string; pair: string } {
    const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
    const normalized = email.trim().toLowerCase();
    return {
      account: digest(`${scope}:account:${normalized}`),
      pair: digest(`${scope}:pair:${normalized}:${ipAddress ?? "unknown"}`)
    };
  }

  /** Reserves one verification attempt atomically; the caller verifies only when `allowed`. */
  async begin(email: string, ipAddress: string | undefined, scope: ThrottleScope = "login"): Promise<Attempt> {
    const keys = this.keys(scope, email, ipAddress);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.loginThrottle.createMany({ data: [{ key: keys.account }, { key: keys.pair }], skipDuplicates: true });
      await tx.$queryRaw`SELECT "key" FROM "login_throttles" WHERE "key" IN (${keys.account}, ${keys.pair}) ORDER BY "key" FOR UPDATE`;
      const rows = await tx.loginThrottle.findMany({ where: { key: { in: [keys.account, keys.pair] } } });
      const account = rows.find((row) => row.key === keys.account)!;
      const pair = rows.find((row) => row.key === keys.pair)!;
      const trusted = pair.trustedUntil !== null && pair.trustedUntil > now;
      const blockedBy = (until: Date | null): boolean => until !== null && until > now;
      if (blockedBy(pair.blockedUntil) || (!trusted && blockedBy(account.blockedUntil))) return { allowed: false, blocks: false };

      const accountFresh = now.getTime() - account.windowStartedAt.getTime() >= this.lockoutMs;
      const accountAttempts = (accountFresh ? 0 : account.failures) + 1;
      const accountBlocks = !trusted && accountAttempts > this.maxAttempts * ACCOUNT_FACTOR;
      await tx.loginThrottle.update({
        where: { key: keys.account },
        data: {
          failures: accountBlocks ? 0 : accountAttempts,
          windowStartedAt: accountFresh || accountBlocks ? now : account.windowStartedAt,
          ...(accountBlocks ? { blockedUntil: new Date(now.getTime() + this.lockoutMs) } : {}),
          updatedAt: now
        }
      });

      const pairAttempts = pair.failures + 1;
      const pairBlocks = pairAttempts >= this.maxAttempts;
      const delay = Math.min(60_000 * 2 ** (pairAttempts - this.maxAttempts), this.lockoutMs);
      await tx.loginThrottle.update({
        where: { key: keys.pair },
        data: { failures: pairAttempts, blockedUntil: pairBlocks ? new Date(now.getTime() + delay) : null, updatedAt: now }
      });
      return { allowed: true, blocks: accountBlocks || pairBlocks };
    });
    void this.prune(now);
    return result;
  }

  /** The sign-in succeeded: clear the address's streak, trust the address for this e-mail and refund the attempt. */
  async succeed(email: string, ipAddress: string | undefined, scope: ThrottleScope = "login"): Promise<void> {
    const keys = this.keys(scope, email, ipAddress);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.loginThrottle.updateMany({
        where: { key: keys.pair },
        data: { failures: 0, blockedUntil: null, trustedUntil: new Date(now.getTime() + TRUST_MS), updatedAt: now }
      });
      await this.refundAccount(tx, keys.account);
    });
  }

  /**
   * A correct password that still needs a second factor: give back this one attempt, but keep the
   * second-factor streak, so knowing the password does not reset the limit on code guesses.
   */
  async refund(email: string, ipAddress: string | undefined): Promise<void> {
    const keys = this.keys("login", email, ipAddress);
    await this.prisma.$transaction(async (tx) => {
      await this.refundOne(tx, keys.pair);
      await this.refundAccount(tx, keys.account);
    });
  }

  /** One atomic `failures = failures - 1 WHERE failures > 0`: concurrent refunds and begins can not overwrite each other. */
  private async refundOne(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.loginThrottle.updateMany({ where: { key, failures: { gt: 0 } }, data: { failures: { decrement: 1 } } });
  }

  private refundAccount(tx: Prisma.TransactionClient, key: string): Promise<void> {
    return this.refundOne(tx, key);
  }

  /**
   * Platform-admin unlock: lifts the account-wide block of the e-mail and audits who did it. Pair
   * blocks are keyed by address as well; they are short and expire on their own.
   */
  async unlock(email: string, actor?: { userId: string; tenantId: string }): Promise<number> {
    const account = this.keys("login", email, undefined).account;
    const { count } = await this.prisma.loginThrottle.updateMany({
      where: { key: account },
      data: { failures: 0, blockedUntil: null, windowStartedAt: new Date() }
    });
    if (actor)
      await this.prisma.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          requestId: requestContext.getStore()?.requestId,
          action: "identity.login_throttle.unlock",
          entityType: "login_throttle",
          entityId: null,
          metadata: { cleared: count }
        }
      });
    return count;
  }

  /**
   * After a password reset: lifts the account-wide counter and the block of the address that completed the reset. Pair rows of
   * other addresses are keyed by address too (not enumerable); they are short and expire on their own.
   */
  async clearLockout(email: string, ipAddress: string | undefined): Promise<void> {
    const keys = this.keys("login", email, ipAddress);
    const now = new Date();
    await this.prisma.loginThrottle.updateMany({
      where: { key: { in: [keys.account, keys.pair] } },
      data: { failures: 0, blockedUntil: null, windowStartedAt: now, updatedAt: now }
    });
  }

  /** Audits a failed or refused attempt. Unknown e-mails are audited too (without the e-mail), so both paths do the same work. */
  async recordFailure(context: FailureContext): Promise<void> {
    const base = {
      tenantId: context.tenantId ?? null,
      actorUserId: context.userId ?? null,
      requestId: requestContext.getStore()?.requestId,
      entityType: "user",
      entityId: context.userId ?? null,
      ipAddress: context.ipAddress,
      metadata: { reason: context.reason }
    };
    await this.prisma.auditEvent.createMany({
      data: [
        { ...base, action: "identity.login.failed" },
        ...(context.blocked && context.userId ? [{ ...base, action: "identity.account.locked" }] : [])
      ]
    });
  }

  /** Ends every session of the user except `keepSessionId` (after a credential or MFA change). */
  async endOtherSessions(userId: string, keepSessionId: string | undefined): Promise<void> {
    await revokeActiveSessions(this.prisma, { userId, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) });
  }

  /** Drops counters nobody touched for a day (at most every ten minutes per process); trusted addresses are kept. */
  private async prune(now: Date): Promise<void> {
    if (now.getTime() - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now.getTime();
    const cutoff = new Date(now.getTime() - PRUNE_AFTER_MS);
    await this.prisma.loginThrottle
      .deleteMany({
        where: {
          updatedAt: { lt: cutoff },
          AND: [
            { OR: [{ blockedUntil: null }, { blockedUntil: { lt: now } }] },
            { OR: [{ trustedUntil: null }, { trustedUntil: { lt: now } }] }
          ]
        }
      })
      .catch(() => undefined);
  }
}
