import { Controller, Get, Header, Headers, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SkipThrottle } from "@nestjs/throttler";
import { timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../database/prisma.service.js";
import { runAsSystem } from "../context/request-context.js";
import { AuthPrincipalCache } from "../cache/auth-principal-cache.js";
import { rateLimitState } from "./rate-limit.js";
import { Public } from "../security/public.decorator.js";

export type LoginFailureReason = "bad_credentials" | "locked" | "mfa_failed" | "portal_denied";
export type MailOutcome = "sent" | "failed";
export type ReadinessFailureReason = "database" | "draining";

/**
 * Event counters. The label values are fixed enums, so the series set is closed: never an e-mail, address, user id or
 * tenant. Every series is rendered from the start (at 0) so rate() and increase() see the first event.
 */
const EVENT_SERIES: Record<string, { help: string; label?: string; values?: readonly string[] }> = {
  safry_login_failures_total: { help: "Failed sign-ins by coarse reason", label: "reason", values: ["bad_credentials", "locked", "mfa_failed", "portal_denied"] },
  safry_account_lockouts_total: { help: "Sign-in blocks started on an account" },
  safry_refresh_reuse_detected_total: { help: "Refresh tokens presented again after rotation (session family revoked)" },
  safry_platform_admin_signins_total: { help: "Completed sign-ins of platform administrators" },
  safry_mail_delivery_total: { help: "Detached mail deliveries by final outcome", label: "outcome", values: ["sent", "failed"] },
  safry_mail_budget_exhausted_total: { help: "Mails dropped because the hourly or daily mail budget was spent, by pool", label: "pool", values: ["general", "security"] },
  safry_readiness_failures_total: { help: "Readiness probes answered 503", label: "reason", values: ["database", "draining"] },
  safry_rate_limited_total: { help: "HTTP 429 answers by route group", label: "group", values: ["auth", "api"] }
};

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

/** Minimal Prometheus-text metrics (no dependency): request counts and latency histogram per route template. */
@Injectable()
export class MetricsService {
  private readonly counts = new Map<string, number>();
  private readonly buckets = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly events = new Map<string, number>();

  private bump(name: string, value?: string): void {
    const key = value === undefined ? name : `${name}|${value}`;
    this.events.set(key, (this.events.get(key) ?? 0) + 1);
  }

  loginFailure(reason: LoginFailureReason): void { this.bump("safry_login_failures_total", reason); }
  accountLockout(): void { this.bump("safry_account_lockouts_total"); }
  refreshReuse(): void { this.bump("safry_refresh_reuse_detected_total"); }
  platformAdminSignIn(): void { this.bump("safry_platform_admin_signins_total"); }
  mailOutcome(outcome: MailOutcome): void { this.bump("safry_mail_delivery_total", outcome); }
  mailBudgetExhausted(pool: "general" | "security"): void { this.bump("safry_mail_budget_exhausted_total", pool); }
  readinessFailure(reason: ReadinessFailureReason): void { this.bump("safry_readiness_failures_total", reason); }

  /** Route templates only (never raw URLs): the label set stays bounded and carries no ids or query strings. */
  observe(method: string, route: string, status: number, durationMs: number): void {
    if (status === 429) this.bump("safry_rate_limited_total", route.includes("/auth/") ? "auth" : "api");
    const statusClass = `${Math.floor(status / 100)}xx`;
    const key = `${method}|${route}|${statusClass}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.sums.set(key, (this.sums.get(key) ?? 0) + durationMs);
    const hist = this.buckets.get(key) ?? new Array<number>(BUCKETS_MS.length + 1).fill(0);
    const found = BUCKETS_MS.findIndex((bound) => durationMs <= bound);
    hist[found === -1 ? BUCKETS_MS.length : found]! += 1;
    this.buckets.set(key, hist);
  }

  render(extra: Record<string, number>): string {
    const lines = ["# TYPE safry_http_requests_total counter", "# TYPE safry_http_request_duration_ms histogram"];
    for (const [key, count] of this.counts) {
      const [method, route, status] = key.split("|");
      const labels = `method="${method}",route="${route}",status="${status}"`;
      lines.push(`safry_http_requests_total{${labels}} ${count}`);
      let cumulative = 0;
      const hist = this.buckets.get(key)!;
      BUCKETS_MS.forEach((bound, index) => {
        cumulative += hist[index]!;
        lines.push(`safry_http_request_duration_ms_bucket{${labels},le="${bound}"} ${cumulative}`);
      });
      lines.push(`safry_http_request_duration_ms_bucket{${labels},le="+Inf"} ${count}`);
      lines.push(`safry_http_request_duration_ms_sum{${labels}} ${this.sums.get(key)!.toFixed(1)}`);
      lines.push(`safry_http_request_duration_ms_count{${labels}} ${count}`);
    }
    for (const [name, spec] of Object.entries(EVENT_SERIES)) {
      lines.push(`# HELP ${name} ${spec.help}`, `# TYPE ${name} counter`);
      if (!spec.label) lines.push(`${name} ${this.events.get(name) ?? 0}`);
      else for (const value of spec.values!) lines.push(`${name}{${spec.label}="${value}"} ${this.events.get(`${name}|${value}`) ?? 0}`);
    }
    for (const [name, value] of Object.entries(extra)) lines.push(`${name} ${value}`);
    const memory = process.memoryUsage();
    lines.push(`safry_process_resident_memory_bytes ${memory.rss}`, `safry_process_heap_used_bytes ${memory.heapUsed}`);
    return `${lines.join("\n")}\n`;
  }
}

/**
 * Not part of the public API: disabled (404) unless METRICS_TOKEN is configured, and then only
 * served to a caller presenting it as a bearer token (the scraper), compared in constant time.
 */
@Public()
@SkipThrottle({ default: true, account: true })
@Controller("metrics")
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
    private readonly principals: AuthPrincipalCache,
    private readonly prisma: PrismaService
  ) {}

  private mfaResets = { at: 0, value: 0 };

  /**
   * Break-glass MFA resets run in a separate operator process (backend/scripts/reset-platform-admin-mfa.ts), so no in-process
   * counter can see them. They are read from the audit trail instead (last 24 h, cached 60 s). On a database error the series is
   * omitted: the readiness alerts cover that outage and the reset alert must not fire on a guess.
   */
  private async recentMfaResets(): Promise<Record<string, number>> {
    const now = Date.now();
    if (now - this.mfaResets.at > 60_000) {
      try {
        const since = new Date(now - 24 * 3_600_000);
        const value = await runAsSystem(() => this.prisma.auditEvent.count({ where: { action: "platform.admin.mfa_reset", occurredAt: { gte: since } } }));
        this.mfaResets = { at: now, value };
      } catch {
        return {};
      }
    }
    return { safry_platform_admin_mfa_resets_24h: this.mfaResets.value };
  }

  /** Prometheus 3 refuses a scrape whose Content-Type is not the text exposition format (a bare string would be sent as text/html). */
  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async scrape(@Headers("authorization") authorization?: string): Promise<string> {
    const token = this.config.get<string>("METRICS_TOKEN");
    if (!token) throw new NotFoundException();
    const given = Buffer.from(authorization?.replace(/^Bearer /i, "") ?? "");
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedException();
    const cache = this.principals.stats();
    return this.metrics.render({
      safry_auth_cache_hits_total: cache.hits,
      safry_auth_cache_misses_total: cache.misses,
      safry_auth_cache_entries: cache.size,
      safry_auth_cache_invalidations_total: cache.invalidations,
      safry_rate_limit_degraded: rateLimitState.degraded ? 1 : 0,
      safry_rate_limit_fallback_total: rateLimitState.fallbackTotal,
      ...(await this.recentMfaResets())
    });
  }
}
