import { Logger } from "@nestjs/common";
import { ThrottlerStorageService } from "@nestjs/throttler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsService } from "../../common/http/metrics.js";
import { MailBudget, isSecurityMail, mailBudgetLimits } from "./mail-budget.js";

const config = (values: Record<string, unknown>): never => ({ get: (key: string, fallback?: unknown) => values[key] ?? fallback }) as never;

describe("mailBudgetLimits", () => {
  it("defaults to 30/hour and 100/day, which fits the Resend free tier, with a 10 percent security reserve", () => {
    expect(mailBudgetLimits(config({ NODE_ENV: "production" }))).toEqual({ enabled: true, hour: 30, day: 100, reserveHour: 3, reserveDay: 10 });
  });
  it("is off under NODE_ENV=test unless a limit is set explicitly", () => {
    expect(mailBudgetLimits(config({ NODE_ENV: "test" })).enabled).toBe(false);
    expect(mailBudgetLimits(config({ NODE_ENV: "test", MAIL_BUDGET_PER_HOUR: 4 })).enabled).toBe(true);
  });
});

describe("isSecurityMail", () => {
  it("covers notices the account owner needs, not links that can be requested in bulk", () => {
    expect(isSecurityMail("password-changed")).toBe(true);
    expect(isSecurityMail("password-reset")).toBe(false);
    expect(isSecurityMail("email-verification")).toBe(false);
  });
});

describe("MailBudget", () => {
  afterEach(() => vi.restoreAllMocks());
  const make = (values: Record<string, unknown>, metrics = new MetricsService()): { metrics: MetricsService; budget: MailBudget } =>
    ({ metrics, budget: new MailBudget(new ThrottlerStorageService(), config({ NODE_ENV: "production", ...values }), metrics) });

  it("allows the general share of the hourly budget, then refuses; the reserve is kept for security mail", async () => {
    const { budget } = make({ MAIL_BUDGET_PER_HOUR: 10, MAIL_BUDGET_PER_DAY: 100 }); // reserve 1 -> 9 general
    const general: boolean[] = [];
    for (let i = 0; i < 12; i++) general.push(await budget.allow("password-reset"));
    expect(general.filter(Boolean)).toHaveLength(9);
    expect(await budget.allow("password-changed")).toBe(true);
    expect(await budget.allow("password-changed")).toBe(false); // reserve of 1 used
  });

  it("applies the daily budget too", async () => {
    const { budget } = make({ MAIL_BUDGET_PER_HOUR: 1000, MAIL_BUDGET_PER_DAY: 20 }); // reserve 2 -> 18 general
    let sent = 0;
    for (let i = 0; i < 40; i++) if (await budget.allow("email-verification")) sent++;
    expect(sent).toBe(18);
  });

  it("starts a new window after the period (rollover)", async () => {
    vi.useFakeTimers();
    try {
      const { budget } = make({ MAIL_BUDGET_PER_HOUR: 10, MAIL_BUDGET_PER_DAY: 1000 });
      for (let i = 0; i < 9; i++) expect(await budget.allow("password-reset")).toBe(true);
      expect(await budget.allow("password-reset")).toBe(false);
      vi.advanceTimersByTime(3_600_000 + 1000);
      expect(await budget.allow("password-reset")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs ONE warning per window without a recipient, and counts every dropped mail", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { budget, metrics } = make({ MAIL_BUDGET_PER_HOUR: 10, MAIL_BUDGET_PER_DAY: 1000 });
    for (let i = 0; i < 30; i++) await budget.allow("password-reset");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/@/);
    const text = metrics.render({});
    expect(text).toContain('safry_mail_budget_exhausted_total{pool="general"} 21');
    expect(text).toContain('safry_mail_budget_exhausted_total{pool="security"} 0');
  });

  it("counts security refusals separately", async () => {
    const { budget, metrics } = make({ MAIL_BUDGET_PER_HOUR: 10, MAIL_BUDGET_PER_DAY: 1000 });
    await budget.allow("password-changed");
    await budget.allow("password-changed");
    expect(metrics.render({})).toContain('safry_mail_budget_exhausted_total{pool="security"} 1');
  });

  it("does nothing when disabled and fails open if the store throws", async () => {
    const off = new MailBudget(new ThrottlerStorageService(), config({ NODE_ENV: "test" }), new MetricsService());
    for (let i = 0; i < 200; i++) expect(await off.allow("password-reset")).toBe(true);
    const broken = new MailBudget({ increment: (): Promise<never> => Promise.reject(new Error("boom")) }, config({ NODE_ENV: "production" }), new MetricsService());
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    expect(await broken.allow("password-reset")).toBe(true);
  });
});
