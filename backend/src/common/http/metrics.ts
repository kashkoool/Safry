import { Controller, Get, Header, Headers, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
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
  safry_storage_signal_errors_total: { help: "Reads of the storage-health gauges (heartbeat, partitions, dead rows) that failed; their series are missing while this grows" },
  safry_audit_skipped_total: { help: "Audit rows not written: unknown account (login or reset request) or the account's hourly budget was spent", label: "kind", values: ["unknown_login", "unknown_address", "account_budget"] },
  safry_session_rotations_total: { help: "Refresh tokens exchanged for a new session (routine rotation, not audited row by row)" },
  safry_refresh_reuse_detected_total: { help: "Refresh tokens presented again after rotation (session family revoked)" },
  safry_platform_admin_signins_total: { help: "Completed sign-ins of platform administrators" },
  safry_mail_delivery_total: { help: "Detached mail deliveries by final outcome", label: "outcome", values: ["sent", "failed"] },
  safry_mail_budget_exhausted_total: { help: "Mails dropped because the hourly or daily mail budget was spent, by pool", label: "pool", values: ["registration", "reset", "security"] },
  safry_mail_address_capped_total: { help: "Requests from one client address that caused no mail because its daily cap was reached, by scope", label: "scope", values: ["registration", "reset", "recipient"] },
  safry_readiness_failures_total: { help: "Readiness probes answered 503", label: "reason", values: ["database", "draining"] },
  safry_rate_limited_total: { help: "HTTP 429 answers by route group", label: "group", values: ["auth", "api"] }
};

/** Fixed at load, so a restart (new process) shows as a new value and changes() counts restarts. */
const PROCESS_START_SECONDS = Math.floor(Date.now() / 1000 - process.uptime());

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
  storageSignalError(): void { this.bump("safry_storage_signal_errors_total"); }
  auditSkipped(kind: "unknown_login" | "unknown_address" | "account_budget"): void { this.bump("safry_audit_skipped_total", kind); }
  sessionRotated(): void { this.bump("safry_session_rotations_total"); }
  refreshReuse(): void { this.bump("safry_refresh_reuse_detected_total"); }
  platformAdminSignIn(): void { this.bump("safry_platform_admin_signins_total"); }
  mailOutcome(outcome: MailOutcome): void { this.bump("safry_mail_delivery_total", outcome); }
  mailBudgetExhausted(pool: "registration" | "reset" | "security"): void { this.bump("safry_mail_budget_exhausted_total", pool); }
  mailAddressCapped(scope: "registration" | "reset" | "recipient"): void { this.bump("safry_mail_address_capped_total", scope); }
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
    lines.push("# TYPE safry_process_start_time_seconds gauge", `safry_process_start_time_seconds ${PROCESS_START_SECONDS}`);
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

  private readonly logger = new Logger(MetricsController.name);
  private maintenance: { at: number; values: Record<string, number> } = { at: 0, values: {} };

  /**
   * Storage-health gauges read from the database (cached 2 minutes, one short read-only transaction, 3 s statement cap):
   *   safry_maintenance_last_success_timestamp_seconds  heartbeat of the retention job (maintenance_runs; a baseline row is written by the migration)
   *   safry_audit_default_partition_rows               rows in audit_events_default: > 0 means partitions were not created ahead
   *   safry_refresh_sessions_overdue                   1 when a refresh session is older than its retention plus 3 days (the job is not purging)
   *   safry_erasure_overdue                            1 when a deleted account is past ANONYMISE_DELETED_USERS_AFTER_DAYS + 3 days un-anonymised, or an audit row still holds an IP past AUDIT_IP_RETENTION_DAYS + 3 days
   *   safry_table_dead_tuples / safry_table_live_tuples{table}   from pg_stat_user_tables, for the tables that churn
   * On a database error the series are omitted (readiness alerts cover the outage; a stale-job alert must not fire on a guess).
   */
  private async storageSignals(): Promise<Record<string, number>> {
    const now = Date.now();
    if (now - this.maintenance.at < 120_000) return this.maintenance.values;
    try {
      const retentionMs = Number(this.config.get<number>("SESSION_RETENTION_DAYS", 30)) * 86_400_000;
      const overdueBefore = new Date(now - retentionMs - 3 * 86_400_000);
      const userDays = Number(this.config.get<number>("ANONYMISE_DELETED_USERS_AFTER_DAYS", 30));
      const ipDays = Number(this.config.get<number>("AUDIT_IP_RETENTION_DAYS", 90));
      const values = await runAsSystem(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = 3000`;
          const beat = await tx.maintenanceRun.findUnique({ where: { job: "purge" } });
          const defaultRows = (await tx.$queryRaw<{ rows: bigint }[]>`SELECT audit_default_partition_rows() AS rows`)[0]?.rows ?? 0n;
          const overdue = (await tx.$queryRaw<{ overdue: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM "refresh_sessions" WHERE "expiresAt" < ${overdueBefore} OR "revokedAt" < ${overdueBefore}) AS overdue`)[0]?.overdue ?? false;
          const erasure = (await tx.$queryRaw<{ users_pending: bigint; audit_ip_pending: bigint }[]>`
            SELECT users_pending, audit_ip_pending FROM erasure_overdue_counts(${userDays > 0 ? userDays + 3 : 0}::integer, ${ipDays > 0 ? ipDays + 3 : 0}::integer)`)[0];
          const stats = await tx.$queryRaw<{ relname: string; live: bigint; dead: bigint }[]>`
            SELECT relname, n_live_tup AS live, n_dead_tup AS dead FROM pg_stat_user_tables
            WHERE schemaname = 'public' AND relname IN ('refresh_sessions', 'credential_tokens', 'login_throttles', 'bookings')`;
          const out: Record<string, number> = {
            safry_maintenance_last_success_timestamp_seconds: beat ? Math.floor(beat.lastSuccessAt.getTime() / 1000) : 0,
            safry_audit_default_partition_rows: Number(defaultRows),
            safry_refresh_sessions_overdue: overdue ? 1 : 0,
            safry_erasure_overdue: erasure && (erasure.users_pending > 0n || erasure.audit_ip_pending > 0n) ? 1 : 0
          };
          for (const row of stats) {
            out[`safry_table_live_tuples{table="${row.relname}"}`] = Number(row.live);
            out[`safry_table_dead_tuples{table="${row.relname}"}`] = Number(row.dead);
          }
          return out;
        })
      );
      this.maintenance = { at: now, values };
      return values;
    } catch (error) {
      // Class name only (no message: it can carry connection details); the counter below feeds the StorageSignalsMissing alert.
      this.logger.warn(`storage signals unavailable: ${error instanceof Error ? error.name : "unknown error"}`);
      this.metrics.storageSignalError();
      this.maintenance = { at: now, values: {} };
      return {};
    }
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
      ...(await this.recentMfaResets()),
      ...(await this.storageSignals())
    });
  }
}
