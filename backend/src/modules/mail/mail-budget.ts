import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ThrottlerStorage } from "@nestjs/throttler";
import { clientKey } from "../../common/http/rate-limit.js";
import { MetricsService } from "../../common/http/metrics.js";
import { ADDRESS_SCOPES, MAIL_ADDRESS_DEFAULTS, MAIL_POOLS, MAIL_POOL_DEFAULTS, addressEnvKey, poolEnvKeys, type AddressScope, type MailPool, type PoolLimit } from "./mail-limits.js";
import type { MailTemplate } from "./templates.js";

export type { AddressScope, MailPool } from "./mail-limits.js";

/** Where a verification mail comes from: a new sign-up, or a request about an account that already exists. */
export type MailSource = "registration" | "existing";
export interface MailBudgetLimits {
  enabled: boolean;
  pools: Record<MailPool, PoolLimit>;
  addressPerDay: Record<AddressScope, number>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Notices an account owner needs to see even while the other pools are spent. Links that can be requested in bulk are never in this set. */
const SECURITY_KINDS: ReadonlySet<MailTemplate["kind"]> = new Set(["password-changed"]);
export function isSecurityMail(kind: MailTemplate["kind"]): boolean {
  return SECURITY_KINDS.has(kind);
}

/** Pool a mail is counted in: security notices always use the security pool; otherwise the caller says whether it is a sign-up mail. */
export function poolOf(kind: MailTemplate["kind"], source: MailSource = "existing"): MailPool {
  return isSecurityMail(kind) ? "security" : source === "registration" ? "registration" : "reset";
}

/** Switched off under NODE_ENV=test (like the HTTP limiter) unless a limit is set explicitly, so the suites that send many mails are unaffected. */
export function mailBudgetLimits(config: { get<T = unknown>(key: string, fallback?: T): T | undefined }): MailBudgetLimits {
  const keys = [...MAIL_POOLS.flatMap((pool) => Object.values(poolEnvKeys(pool))), ...ADDRESS_SCOPES.map(addressEnvKey)];
  const explicit = keys.some((key) => config.get<number>(key) !== undefined);
  const pools = Object.fromEntries(MAIL_POOLS.map((pool) => {
    const k = poolEnvKeys(pool);
    return [pool, { hour: config.get<number>(k.hour, MAIL_POOL_DEFAULTS[pool].hour)!, day: config.get<number>(k.day, MAIL_POOL_DEFAULTS[pool].day)! }];
  })) as Record<MailPool, PoolLimit>;
  const addressPerDay = Object.fromEntries(ADDRESS_SCOPES.map((scope) => [scope, config.get<number>(addressEnvKey(scope), MAIL_ADDRESS_DEFAULTS[scope])!])) as Record<AddressScope, number>;
  return { enabled: config.get<string>("NODE_ENV") !== "test" || explicit, pools, addressPerDay };
}

/**
 * Process-wide and shared hourly/daily ceilings on outbound mail, so register/forgot/resend can not drain the provider quota
 * (and the sender reputation) by rotating addresses. Counters live in the rate-limit store: Redis when RATE_LIMIT_REDIS_URL is set
 * (shared by every replica, degrading to in-process counters like the HTTP limiter), in-process otherwise. Three independent pools
 * (registration, reset, security) each have their own hourly and daily limit, so spending one never blocks another. On top of the
 * pools a per-client-address DAILY cap (IPv6 by /64) limits how much of a pool one source can use.
 * A refusal is silent for the caller (the API answer is the same neutral one) and is logged once per window, without a recipient.
 *
 * Retries: `MailService.deliverWithRetry` asks `allow` ONCE per logical mail, not once per attempt. All attempts reuse the same
 * idempotency key, so the provider sends at most one mail; counting each attempt would charge the pool several times for one mail.
 */
@Injectable()
export class MailBudget {
  private readonly logger = new Logger(MailBudget.name);
  private readonly limits: MailBudgetLimits;
  private readonly warnedUntil = new Map<string, number>();

  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService
  ) {
    this.limits = mailBudgetLimits(config);
  }

  /** True when this mail may be sent. Counts the attempt; a store failure never blocks mail (fail open, logged). */
  async allow(kind: MailTemplate["kind"], source: MailSource = "existing"): Promise<boolean> {
    if (!this.limits.enabled) return true;
    const pool = poolOf(kind, source);
    const { hour: hourLimit, day: dayLimit } = this.limits.pools[pool];
    try {
      const h = await this.storage.increment(`${pool}:hour`, HOUR_MS, hourLimit, 0, "mailbudget");
      const d = await this.storage.increment(`${pool}:day`, DAY_MS, dayLimit, 0, "mailbudget");
      const exhausted = h.totalHits > hourLimit ? { window: "hourly", record: h } : d.totalHits > dayLimit ? { window: "daily", record: d } : undefined;
      if (!exhausted) return true;
      this.metrics?.mailBudgetExhausted(pool);
      const now = Date.now();
      const key = `${pool}:${exhausted.window}`;
      if ((this.warnedUntil.get(key) ?? 0) <= now) {
        this.warnedUntil.set(key, now + Math.max(1, exhausted.record.timeToExpire) * 1000);
        this.logger.warn(`${exhausted.window} mail budget for ${pool} mail is spent; further ${pool} mail is dropped until the window resets (about ${exhausted.record.timeToExpire} s)`);
      }
      return false;
    } catch (error) {
      this.logger.error(`mail budget check failed (${error instanceof Error ? error.name : "unknown error"}); sending without it`);
      return true;
    }
  }

  /**
   * Counts one request from this client address against its daily cap and says whether it may cause mail. The caller keeps its answer
   * and timing unchanged either way. The address is the request IP (IPv6 grouped by /64). Fails open like `allow`.
   */
  async allowAddress(scope: AddressScope, ip: string | undefined): Promise<boolean> {
    if (!this.limits.enabled || ip === undefined) return true;
    const limit = this.limits.addressPerDay[scope];
    try {
      const record = await this.storage.increment(`${scope}:${clientKey(ip)}`, DAY_MS, limit, 0, "mailaddress");
      if (record.totalHits <= limit) return true;
      this.metrics?.mailAddressCapped(scope);
      const now = Date.now();
      const key = `address:${scope}`;
      if ((this.warnedUntil.get(key) ?? 0) <= now) {
        this.warnedUntil.set(key, now + 60_000);
        this.logger.warn(`a client address reached its daily cap of ${limit} ${scope} mail requests; further ones from it send no mail until the window resets`);
      }
      return false;
    } catch (error) {
      this.logger.error(`mail address cap check failed (${error instanceof Error ? error.name : "unknown error"}); sending without it`);
      return true;
    }
  }
}
