import { describe, expect, it } from "vitest";
import { MetricsService } from "./metrics.js";

const line = (text: string, series: string): number | undefined => {
  const hit = text.split("\n").find((l) => l.startsWith(`${series} `));
  return hit ? Number(hit.slice(series.length + 1)) : undefined;
};

describe("MetricsService event counters", () => {
  it("renders every counter at 0 before anything happens, so rate() has a baseline", () => {
    const text = new MetricsService().render({});
    for (const reason of ["bad_credentials", "locked", "mfa_failed", "portal_denied"])
      expect(line(text, `safry_login_failures_total{reason="${reason}"}`)).toBe(0);
    expect(line(text, "safry_account_lockouts_total")).toBe(0);
    expect(line(text, "safry_refresh_reuse_detected_total")).toBe(0);
    expect(line(text, "safry_platform_admin_signins_total")).toBe(0);
    expect(line(text, 'safry_mail_delivery_total{outcome="failed"}')).toBe(0);
    expect(line(text, 'safry_mail_delivery_total{outcome="sent"}')).toBe(0);
    expect(line(text, 'safry_readiness_failures_total{reason="database"}')).toBe(0);
    expect(line(text, 'safry_rate_limited_total{group="auth"}')).toBe(0);
    expect(line(text, 'safry_rate_limited_total{group="api"}')).toBe(0);
  });

  it("moves each counter by one per event", () => {
    const m = new MetricsService();
    m.loginFailure("bad_credentials");
    m.loginFailure("bad_credentials");
    m.loginFailure("locked");
    m.loginFailure("mfa_failed");
    m.loginFailure("portal_denied");
    m.accountLockout();
    m.refreshReuse();
    m.platformAdminSignIn();
    m.mailOutcome("failed");
    m.mailOutcome("sent");
    m.readinessFailure("database");
    m.readinessFailure("draining");
    const text = m.render({});
    expect(line(text, 'safry_login_failures_total{reason="bad_credentials"}')).toBe(2);
    expect(line(text, 'safry_login_failures_total{reason="locked"}')).toBe(1);
    expect(line(text, 'safry_login_failures_total{reason="mfa_failed"}')).toBe(1);
    expect(line(text, 'safry_login_failures_total{reason="portal_denied"}')).toBe(1);
    expect(line(text, "safry_account_lockouts_total")).toBe(1);
    expect(line(text, "safry_refresh_reuse_detected_total")).toBe(1);
    expect(line(text, "safry_platform_admin_signins_total")).toBe(1);
    expect(line(text, 'safry_mail_delivery_total{outcome="failed"}')).toBe(1);
    expect(line(text, 'safry_mail_delivery_total{outcome="sent"}')).toBe(1);
    expect(line(text, 'safry_readiness_failures_total{reason="database"}')).toBe(1);
    expect(line(text, 'safry_readiness_failures_total{reason="draining"}')).toBe(1);
  });

  it("counts HTTP 429 by route group, auth routes apart from the rest, without ids in labels", () => {
    const m = new MetricsService();
    m.observe("POST", "/api/v1/auth/login", 429, 3);
    m.observe("POST", "/api/v1/auth/login", 429, 3);
    m.observe("GET", "/api/v1/bookings/:id", 429, 3);
    m.observe("GET", "/api/v1/bookings/:id", 200, 3);
    const text = m.render({});
    expect(line(text, 'safry_rate_limited_total{group="auth"}')).toBe(2);
    expect(line(text, 'safry_rate_limited_total{group="api"}')).toBe(1);
  });

  it("emits only the fixed label values (no e-mail, address, user or tenant can become a label)", () => {
    const m = new MetricsService();
    m.loginFailure("bad_credentials");
    const text = m.render({});
    const labelled = text.split("\n").filter((l) => /^safry_(login|mail|readiness|rate_limited)/.test(l));
    for (const l of labelled) expect(l).toMatch(/\{(reason|outcome|group|pool|scope)="[a-z_]+"\} \d+$/);
  });
});

describe("mail pool metrics and process start time", () => {
  it("renders every pool and address scope at 0, then counts each under its own label", () => {
    const m = new MetricsService();
    const zero = m.render({});
    for (const pool of ["registration", "reset", "security"]) expect(line(zero, `safry_mail_budget_exhausted_total{pool="${pool}"}`)).toBe(0);
    for (const scope of ["registration", "reset", "recipient"]) expect(line(zero, `safry_mail_address_capped_total{scope="${scope}"}`)).toBe(0);
    m.mailBudgetExhausted("registration");
    m.mailBudgetExhausted("reset");
    m.mailBudgetExhausted("reset");
    m.mailAddressCapped("reset");
    const text = m.render({});
    expect(line(text, 'safry_mail_budget_exhausted_total{pool="registration"}')).toBe(1);
    expect(line(text, 'safry_mail_budget_exhausted_total{pool="reset"}')).toBe(2);
    expect(line(text, 'safry_mail_budget_exhausted_total{pool="security"}')).toBe(0);
    expect(line(text, 'safry_mail_address_capped_total{scope="reset"}')).toBe(1);
  });
  it("exports a constant process start time in the past", () => {
    const first = line(new MetricsService().render({}), "safry_process_start_time_seconds");
    expect(first).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
    expect(first).toBeGreaterThan(1_700_000_000);
    expect(line(new MetricsService().render({}), "safry_process_start_time_seconds")).toBe(first);
  });
});
