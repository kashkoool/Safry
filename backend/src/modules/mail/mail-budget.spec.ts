import { Logger } from "@nestjs/common";
import { ThrottlerStorageService } from "@nestjs/throttler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsService } from "../../common/http/metrics.js";
import { MailBudget, isSecurityMail, mailBudgetLimits, poolOf } from "./mail-budget.js";

const config = (values: Record<string, unknown>): never => ({ get: (key: string, fallback?: unknown) => values[key] ?? fallback }) as never;

describe("mailBudgetLimits", () => {
  it("defaults to three pools whose limits sum to 30/hour and 100/day (the Resend free tier)", () => {
    const limits = mailBudgetLimits(config({ NODE_ENV: "production" }));
    expect(limits).toEqual({
      enabled: true,
      pools: { registration: { hour: 10, day: 40 }, reset: { hour: 15, day: 45 }, security: { hour: 5, day: 15 } },
      addressPerDay: { registration: 10, reset: 10 },
      recipientResetPerDay: 5
    });
    expect(Object.values(limits.pools).reduce((sum, p) => sum + p.day, 0)).toBeLessThanOrEqual(100);
    expect(Object.values(limits.pools).reduce((sum, p) => sum + p.hour, 0)).toBe(30);
  });
  it("is off under NODE_ENV=test unless any limit is set explicitly", () => {
    expect(mailBudgetLimits(config({ NODE_ENV: "test" })).enabled).toBe(false);
    expect(mailBudgetLimits(config({ NODE_ENV: "test", MAIL_BUDGET_RESET_PER_HOUR: 4 })).enabled).toBe(true);
    expect(mailBudgetLimits(config({ NODE_ENV: "test", MAIL_ADDRESS_RESET_PER_DAY: 4 })).enabled).toBe(true);
  });
  it("reads each pool and address cap from its own setting", () => {
    const limits = mailBudgetLimits(config({ NODE_ENV: "production", MAIL_BUDGET_REGISTRATION_PER_HOUR: 2, MAIL_BUDGET_REGISTRATION_PER_DAY: 3, MAIL_ADDRESS_REGISTRATION_PER_DAY: 7 }));
    expect(limits.pools.registration).toEqual({ hour: 2, day: 3 });
    expect(limits.pools.reset).toEqual({ hour: 15, day: 45 });
    expect(limits.addressPerDay).toEqual({ registration: 7, reset: 10 });
  });
});

describe("pool choice", () => {
  it("puts owner notices in security, sign-up verification in registration, and everything else in reset", () => {
    expect(isSecurityMail("password-changed")).toBe(true);
    expect(isSecurityMail("password-reset")).toBe(false);
    expect(poolOf("password-changed", "registration")).toBe("security");
    expect(poolOf("email-verification", "registration")).toBe("registration");
    expect(poolOf("email-verification", "existing")).toBe("reset");
    expect(poolOf("email-verification")).toBe("reset");
    expect(poolOf("password-reset")).toBe("reset");
  });
});

describe("MailBudget pools", () => {
  afterEach(() => vi.restoreAllMocks());
  const make = (values: Record<string, unknown>, metrics = new MetricsService()): { metrics: MetricsService; budget: MailBudget } =>
    ({ metrics, budget: new MailBudget(new ThrottlerStorageService(), config({ NODE_ENV: "production", ...values }), metrics) });
  const small = { MAIL_BUDGET_REGISTRATION_PER_HOUR: 4, MAIL_BUDGET_REGISTRATION_PER_DAY: 100, MAIL_BUDGET_RESET_PER_HOUR: 3, MAIL_BUDGET_RESET_PER_DAY: 100, MAIL_BUDGET_SECURITY_PER_HOUR: 2, MAIL_BUDGET_SECURITY_PER_DAY: 100 };

  it("lets each pool use exactly its own hourly limit", async () => {
    const { budget } = make(small);
    const sent = { registration: 0, reset: 0, security: 0 };
    for (let i = 0; i < 10; i++) {
      if (await budget.allow("email-verification", "registration")) sent.registration++;
      if (await budget.allow("password-reset")) sent.reset++;
      if (await budget.allow("password-changed")) sent.security++;
    }
    expect(sent).toEqual({ registration: 4, reset: 3, security: 2 });
  });

  it("keeps the reset pool available after the registration pool is spent", async () => {
    const { budget } = make(small);
    for (let i = 0; i < 50; i++) await budget.allow("email-verification", "registration");
    expect(await budget.allow("email-verification", "registration")).toBe(false);
    expect(await budget.allow("password-reset")).toBe(true);
    expect(await budget.allow("email-verification", "existing")).toBe(true);
    expect(await budget.allow("password-changed")).toBe(true);
  });

  it("applies each pool daily limit", async () => {
    const { budget } = make({ ...small, MAIL_BUDGET_RESET_PER_HOUR: 1000, MAIL_BUDGET_RESET_PER_DAY: 20 });
    let sent = 0;
    for (let i = 0; i < 40; i++) if (await budget.allow("password-reset")) sent++;
    expect(sent).toBe(20);
  });

  it("starts a new window after the period (rollover)", async () => {
    vi.useFakeTimers();
    try {
      const { budget } = make({ MAIL_BUDGET_RESET_PER_HOUR: 10, MAIL_BUDGET_RESET_PER_DAY: 1000 });
      for (let i = 0; i < 10; i++) expect(await budget.allow("password-reset")).toBe(true);
      expect(await budget.allow("password-reset")).toBe(false);
      vi.advanceTimersByTime(3_600_000 + 1000);
      expect(await budget.allow("password-reset")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs ONE warning per pool window without a recipient, and counts every dropped mail per pool", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { budget, metrics } = make({ MAIL_BUDGET_RESET_PER_HOUR: 10, MAIL_BUDGET_RESET_PER_DAY: 1000 });
    for (let i = 0; i < 30; i++) await budget.allow("password-reset");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/@/);
    expect(String(warn.mock.calls[0]![0])).toContain("reset");
    const text = metrics.render({});
    expect(text).toContain('safry_mail_budget_exhausted_total{pool="reset"} 20');
    expect(text).toContain('safry_mail_budget_exhausted_total{pool="registration"} 0');
    expect(text).toContain('safry_mail_budget_exhausted_total{pool="security"} 0');
  });

  it("counts registration and security refusals under their own label", async () => {
    const { budget, metrics } = make(small);
    for (let i = 0; i < 6; i++) await budget.allow("email-verification", "registration");
    for (let i = 0; i < 3; i++) await budget.allow("password-changed");
    const text = metrics.render({});
    expect(text).toContain('safry_mail_budget_exhausted_total{pool="registration"} 2');
    expect(text).toContain('safry_mail_budget_exhausted_total{pool="security"} 1');
  });

  it("does nothing when disabled and fails open if the store throws", async () => {
    const off = new MailBudget(new ThrottlerStorageService(), config({ NODE_ENV: "test" }), new MetricsService());
    for (let i = 0; i < 200; i++) expect(await off.allow("password-reset")).toBe(true);
    const broken = new MailBudget({ increment: (): Promise<never> => Promise.reject(new Error("boom")) }, config({ NODE_ENV: "production" }), new MetricsService());
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    expect(await broken.allow("password-reset")).toBe(true);
    expect(await broken.allowAddress("reset", "198.51.100.1")).toBe(true);
  });
});

describe("MailBudget per-recipient daily cap", () => {
  const make = (values: Record<string, unknown> = {}): { metrics: MetricsService; budget: MailBudget } => {
    const metrics = new MetricsService();
    return { metrics, budget: new MailBudget(new ThrottlerStorageService(), config({ NODE_ENV: "production", MAIL_RECIPIENT_RESET_PER_DAY: 2, ...values }), metrics) };
  };

  it("allows the cap per recipient, refuses the rest, and counts another recipient separately", async () => {
    const { budget, metrics } = make();
    expect([await budget.allowRecipient("a@example.test"), await budget.allowRecipient("a@example.test"), await budget.allowRecipient("a@example.test")]).toEqual([true, true, false]);
    expect(await budget.allowRecipient("b@example.test")).toBe(true);
    expect(metrics.render({})).toContain('safry_mail_address_capped_total{scope="recipient"} 1');
  });

  it("defaults to 5 a day, is off when disabled, and the store key holds no address", async () => {
    const storage = new ThrottlerStorageService();
    const spy = vi.spyOn(storage, "increment");
    const budget = new MailBudget(storage, config({ NODE_ENV: "production" }), new MetricsService());
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push(await budget.allowRecipient("who@example.test"));
    expect(results).toEqual([true, true, true, true, true, false]);
    expect(spy.mock.calls.every(([key]) => !String(key).includes("who") && !String(key).includes("example"))).toBe(true);
    const off = new MailBudget(new ThrottlerStorageService(), config({ NODE_ENV: "test" }), new MetricsService());
    for (let i = 0; i < 20; i++) expect(await off.allowRecipient("who@example.test")).toBe(true);
  });

  it("fails open when the store fails", async () => {
    const storage = new ThrottlerStorageService();
    vi.spyOn(storage, "increment").mockRejectedValue(new Error("down"));
    const budget = new MailBudget(storage, config({ NODE_ENV: "production" }), new MetricsService());
    expect(await budget.allowRecipient("who@example.test")).toBe(true);
  });
});

describe("MailBudget per-address daily cap", () => {
  afterEach(() => vi.restoreAllMocks());
  const make = (values: Record<string, unknown> = {}): { metrics: MetricsService; budget: MailBudget } => {
    const metrics = new MetricsService();
    return { metrics, budget: new MailBudget(new ThrottlerStorageService(), config({ NODE_ENV: "production", MAIL_ADDRESS_RESET_PER_DAY: 3, MAIL_ADDRESS_REGISTRATION_PER_DAY: 2, ...values }), metrics) };
  };

  it("allows the cap per address and refuses the rest, per scope", async () => {
    const { budget, metrics } = make();
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await budget.allowAddress("reset", "198.51.100.7"));
    expect(results).toEqual([true, true, true, false, false]);
    expect(await budget.allowAddress("registration", "198.51.100.7")).toBe(true); // separate scope
    expect(await budget.allowAddress("reset", "198.51.100.8")).toBe(true); // other address
    expect(metrics.render({})).toContain('safry_mail_address_capped_total{scope="reset"} 2');
  });

  it("groups IPv6 by /64 and treats an IPv4-mapped address as the plain IPv4 address", async () => {
    const { budget } = make({ MAIL_ADDRESS_RESET_PER_DAY: 2 });
    expect(await budget.allowAddress("reset", "2001:db8:1:2:aaaa::1")).toBe(true);
    expect(await budget.allowAddress("reset", "2001:db8:1:2:bbbb::9")).toBe(true);
    expect(await budget.allowAddress("reset", "2001:db8:1:2:cccc::5")).toBe(false); // same /64
    expect(await budget.allowAddress("reset", "2001:db8:1:3::1")).toBe(true); // next /64
    expect(await budget.allowAddress("reset", "203.0.113.5")).toBe(true);
    expect(await budget.allowAddress("reset", "::ffff:203.0.113.5")).toBe(true);
    expect(await budget.allowAddress("reset", "203.0.113.5")).toBe(false);
  });

  it("starts a new day window, is off when disabled, and ignores a missing address", async () => {
    vi.useFakeTimers();
    try {
      const { budget } = make({ MAIL_ADDRESS_RESET_PER_DAY: 1 });
      expect(await budget.allowAddress("reset", "198.51.100.9")).toBe(true);
      expect(await budget.allowAddress("reset", "198.51.100.9")).toBe(false);
      vi.advanceTimersByTime(86_400_000 + 1000);
      expect(await budget.allowAddress("reset", "198.51.100.9")).toBe(true);
      expect(await budget.allowAddress("reset", undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    const off = new MailBudget(new ThrottlerStorageService(), config({ NODE_ENV: "test" }), new MetricsService());
    for (let i = 0; i < 50; i++) expect(await off.allowAddress("reset", "198.51.100.9")).toBe(true);
  });
});
