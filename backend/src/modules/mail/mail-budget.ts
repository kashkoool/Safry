import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ThrottlerStorage } from "@nestjs/throttler";
import { MetricsService } from "../../common/http/metrics.js";
import type { MailTemplate } from "./templates.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export type MailPool = "general" | "security";

/** Notices an account owner needs to see even while the budget is spent. Links that can be requested in bulk are never in this set. */
const SECURITY_KINDS: ReadonlySet<MailTemplate["kind"]> = new Set(["password-changed"]);
export function isSecurityMail(kind: MailTemplate["kind"]): boolean {
  return SECURITY_KINDS.has(kind);
}

export interface MailBudgetLimits {
  enabled: boolean;
  hour: number;
  day: number;
  /** Part of each window kept for security notices; general mail can use only the rest. */
  reserveHour: number;
  reserveDay: number;
}

/**
 * Defaults fit the Resend free tier (100 mails a day). Switched off under NODE_ENV=test (like the HTTP limiter) unless a limit
 * is set explicitly, so the suites that send many mails are unaffected.
 */
export function mailBudgetLimits(config: { get<T = unknown>(key: string, fallback?: T): T | undefined }): MailBudgetLimits {
  const explicit = config.get<number>("MAIL_BUDGET_PER_HOUR") !== undefined || config.get<number>("MAIL_BUDGET_PER_DAY") !== undefined;
  const hour = config.get<number>("MAIL_BUDGET_PER_HOUR", 30)!;
  const day = config.get<number>("MAIL_BUDGET_PER_DAY", 100)!;
  const percent = config.get<number>("MAIL_BUDGET_RESERVE_PERCENT", 10)!;
  const reserve = (limit: number): number => Math.min(limit, Math.max(1, Math.round((limit * percent) / 100)));
  return { enabled: config.get<string>("NODE_ENV") !== "test" || explicit, hour, day, reserveHour: reserve(hour), reserveDay: reserve(day) };
}

/**
 * Process-wide and shared hourly/daily ceiling on ALL outbound mail, so register/forgot/resend can not drain the provider quota
 * (and the sender reputation) by rotating addresses. Counters live in the rate-limit store: Redis when RATE_LIMIT_REDIS_URL is set
 * (shared by every replica, degrading to in-process counters like the HTTP limiter), in-process otherwise. Two pools per window:
 * general mail may use all but a small reserve; security notices have their own reserve and so still go out when general is spent.
 * A refusal is silent for the caller (the API answer is the same neutral one) and is logged once per window, without a recipient.
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
  async allow(kind: MailTemplate["kind"]): Promise<boolean> {
    if (!this.limits.enabled) return true;
    const pool: MailPool = isSecurityMail(kind) ? "security" : "general";
    const { hour, day, reserveHour, reserveDay } = this.limits;
    try {
      const hourLimit = pool === "security" ? reserveHour : hour - reserveHour;
      const dayLimit = pool === "security" ? reserveDay : day - reserveDay;
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
}
