import { createHash } from "node:crypto";
import { Injectable, Optional } from "@nestjs/common";
import { MetricsService } from "../../../common/http/metrics.js";
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

const FAILED = "identity.login.failed";
const CAPPED = "identity.login.failed_capped";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** Thrown inside the transaction to roll back the insert made for an unknown account (see recordFailure). */
class DiscardAudit extends Error {}

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
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService
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
      await tx.loginThrottle.createMany({ data: [{ key: keys.account }, { key: keys.pair, accountKey: keys.account }], skipDuplicates: true });
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
        data: { failures: pairAttempts, blockedUntil: pairBlocks ? new Date(now.getTime() + delay) : null, accountKey: keys.account, updatedAt: now }
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

  /** Active account-wide sign-in blocks for the given e-mails (platform admin view). Returns e-mail -> block end; unblocked e-mails are absent. */
  async blockedUntilByEmail(emails: string[]): Promise<Map<string, Date>> {
    const byKey = new Map(emails.map((email) => [this.keys("login", email, undefined).account, email]));
    if (!byKey.size) return new Map();
    const rows = await this.prisma.loginThrottle.findMany({
      where: { key: { in: [...byKey.keys()] }, blockedUntil: { gt: new Date() } },
      select: { key: true, blockedUntil: true }
    });
    return new Map(rows.map((row) => [byKey.get(row.key)!, row.blockedUntil!]));
  }

  /**
   * Platform-admin unlock: lifts the account-wide block of the e-mail and the blocks of every (e-mail, address) pair of it,
   * and audits who did it. Address trust is kept. Pair rows written before the account key existed expire on their own.
   */
  async unlock(email: string, actor?: { userId: string; tenantId: string }): Promise<number> {
    const account = this.keys("login", email, undefined).account;
    const { count } = await this.prisma.loginThrottle.updateMany({
      where: { OR: [{ key: account }, { accountKey: account }] },
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

  /** Rows an unauthenticated caller may add to ONE account's audit trail per rolling hour (AUDIT_UNAUTH_ROWS_PER_ACCOUNT_HOUR). */
  get auditRowsPerAccountHour(): number {
    return this.config.get<number>("AUDIT_UNAUTH_ROWS_PER_ACCOUNT_HOUR", 20);
  }

  /**
   * True while `userId` has fewer than the per-hour budget of audit rows with these actions. Unauthenticated callers (failed
   * logins, reset or verification requests for a known account) can repeat a request up to the per-IP rate limit, so each such row
   * is gated here. Check-then-insert is not locked: concurrent requests can overshoot by at most the number of requests in flight,
   * which the sign-in capacity limit and the per-IP limits already bound.
   */
  async hasAuditRoom(db: Pick<Prisma.TransactionClient, "auditEvent">, userId: string, actions: string[]): Promise<boolean> {
    const used = await db.auditEvent.count({ where: { actorUserId: userId, action: { in: actions }, occurredAt: { gte: new Date(Date.now() - 3_600_000) } } });
    return used < this.auditRowsPerAccountHour;
  }

  /** An audit row that was not written because nobody can act on it (unknown account) or the account's hourly budget was spent. */
  skippedAudit(kind: "unknown_login" | "unknown_address" | "account_budget"): void {
    this.metrics?.auditSkipped(kind);
  }

  /**
   * Audits a failed or refused attempt.
   * - Known account: one row per failure, but at most AUDIT_UNAUTH_ROWS_PER_ACCOUNT_HOUR per account per hour; the first failure past
   *   the budget writes a single "capped" row and the rest are only counted (metric), so a flood against one account adds a bounded
   *   number of rows. Lock-out rows are written as before (an account-wide block limits how many can start).
   * - Unknown account: nothing is stored (there is no account to attach it to; the address is in the request log and the failure
   *   metric). The same queries and an insert that is rolled back still run, so the work done, the reply and the timing do not
   *   reveal whether the account exists.
   */
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
    this.metrics?.loginFailure(context.reason.startsWith("throttled") ? "locked" : context.reason === "bad_mfa_code" ? "mfa_failed" : "bad_credentials");
    if (context.blocked && context.userId) this.metrics?.accountLockout();
    const known = Boolean(context.userId);
    await this.prisma
      .$transaction(async (tx) => {
        const rows = await tx.auditEvent.groupBy({
          by: ["action"],
          where: { actorUserId: context.userId ?? NIL_UUID, action: { in: [FAILED, CAPPED] }, occurredAt: { gte: new Date(Date.now() - 3_600_000) } },
          _count: { _all: true }
        });
        const count = (action: string): number => rows.find((row) => row.action === action)?._count._all ?? 0;
        const room = count(FAILED) < this.auditRowsPerAccountHour;
        const data = [
          ...(room ? [{ ...base, action: FAILED }] : []),
          ...(!room && known && count(CAPPED) === 0
            ? [{ ...base, action: CAPPED, metadata: { reason: "account_budget", perHour: this.auditRowsPerAccountHour } }]
            : []),
          ...(context.blocked && known ? [{ ...base, action: "identity.account.locked" }] : [])
        ];
        if (!room && known) this.skippedAudit("account_budget");
        if (!known) this.skippedAudit("unknown_login");
        if (data.length > 0) await tx.auditEvent.createMany({ data });
        if (!known) throw new DiscardAudit();
      })
      .catch((error: unknown) => {
        if (!(error instanceof DiscardAudit)) throw error;
      });
  }

  /** Ends every session of the user except `keepSessionId` (after a credential or MFA change). */
  async endOtherSessions(userId: string, keepSessionId: string | undefined, db: Parameters<typeof revokeActiveSessions>[0] = this.prisma): Promise<void> {
    await revokeActiveSessions(db, { userId, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) });
  }

  /** Drops counters nobody touched for a day (at most every ten minutes per process); trusted addresses are kept. */
  private async prune(now: Date): Promise<void> {
    if (now.getTime() - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now.getTime();
    const cutoff = new Date(now.getTime() - this.config.get<number>("LOGIN_THROTTLE_RETENTION_HOURS", PRUNE_AFTER_MS / 3_600_000) * 3_600_000);
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
