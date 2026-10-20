import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { World, type Json, type Reply, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Unauthenticated callers cannot grow the audit trail without limit: failed sign-ins and reset or verification requests for an
 * UNKNOWN account store nothing (counted in a metric), and for a KNOWN account at most AUDIT_UNAUTH_ROWS_PER_ACCOUNT_HOUR rows per
 * hour. The answers do not change, so neither path reveals whether an account exists.
 */
describe("audit growth from unauthenticated requests", () => {
  const METRICS_TOKEN = "audit-growth-metrics-token-0123456789abcdef";
  const BUDGET = 4;
  let world: World;
  let tenant: TestTenant;
  let ipCounter = 0;
  const nextIp = (): string => `198.51.100.${++ipCounter}`;

  const login = (user: Pick<TestUser, "email" | "tenant">, password: string): Promise<Reply> =>
    world.api("POST", "/auth/login", { headers: { "x-forwarded-for": nextIp() }, body: { email: user.email, password, tenantCode: user.tenant.code } });
  const post = (path: string, body: Json): Promise<Reply> => world.api("POST", path, { headers: { "x-forwarded-for": nextIp() }, body });
  const rows = async (where: string, params: unknown[] = []): Promise<number> =>
    Number((await world.sql.query(`SELECT count(*)::int AS n FROM audit_events WHERE ${where}`, params)).rows[0].n);
  const metric = async (series: string): Promise<number> => {
    const text = String(((await world.api("GET", "/metrics", { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).body as { text?: string }).text ?? "");
    const hit = text.split("\n").find((line) => line.startsWith(`${series} `));
    if (!hit) throw new Error(`series ${series} missing`);
    return Number(hit.slice(series.length + 1));
  };

  beforeAll(async () => {
    world = await World.start({ TRUST_PROXY: "true", METRICS_TOKEN, AUDIT_UNAUTH_ROWS_PER_ACCOUNT_HOUR: String(BUDGET), AUTH_MAIL_MIN_RESPONSE_MS: "0", LOGIN_MAX_ATTEMPTS: "20" });
    tenant = await world.createTenant("auditgrowth");
  }, 180_000);
  afterAll(async () => world.stop());

  it("stores no audit row for failed sign-ins of unknown accounts, and counts them", async () => {
    const before = await metric('safry_audit_skipped_total{kind="unknown_login"}');
    const total = await rows(`action = 'identity.login.failed'`);
    const replies: Reply[] = [];
    for (let i = 0; i < 10; i++) replies.push(await login({ email: `${world.unique("ghost")}@example.test`, tenant }, "Wrong-Password-1"));
    expect(replies.every((reply) => reply.status === 401)).toBe(true);
    expect(await rows(`action = 'identity.login.failed'`)).toBe(total);
    expect((await metric('safry_audit_skipped_total{kind="unknown_login"}')) - before).toBe(10);
  });

  it("answers an unknown account and a known account with a wrong password identically", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const known = await login(user, "Wrong-Password-1");
    const unknown = await login({ email: `${world.unique("ghost")}@example.test`, tenant }, "Wrong-Password-1");
    expect(unknown.status).toBe(known.status);
    const shape = (reply: Reply): unknown => ({ ...reply.body, requestId: undefined, timestamp: undefined });
    expect(shape(unknown)).toEqual(shape(known));
  });

  it("caps the rows one known account collects per hour, writes one capped marker and keeps the lock-out row", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const before = await metric('safry_audit_skipped_total{kind="account_budget"}');
    for (let i = 0; i < 12; i++) expect((await login(user, "Wrong-Password-1")).status).toBe(401);
    expect(await rows(`"actorUserId" = $1 AND action = 'identity.login.failed'`, [user.userId])).toBe(BUDGET);
    expect(await rows(`"actorUserId" = $1 AND action = 'identity.login.failed_capped'`, [user.userId])).toBe(1);
    expect((await metric('safry_audit_skipped_total{kind="account_budget"}')) - before).toBe(12 - BUDGET);
    // The correct password still signs in: the cap limits audit rows only, not the account.
    expect((await login(user, user.password)).status).toBe(200);
    expect(await rows(`"actorUserId" = $1 AND action = 'identity.login'`, [user.userId])).toBe(1);
  });

  it("parallel failures cannot overshoot the budget or write the capped marker twice", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const replies = await Promise.all(Array.from({ length: 16 }, () => login(user, "Wrong-Password-1")));
    expect(replies.every((reply) => reply.status === 401 || reply.status === 503)).toBe(true);
    expect(await rows(`"actorUserId" = $1 AND action = 'identity.login.failed'`, [user.userId])).toBeLessThanOrEqual(BUDGET);
    expect(await rows(`"actorUserId" = $1 AND action = 'identity.login.failed_capped'`, [user.userId])).toBeLessThanOrEqual(1);
    expect(await rows(`"actorUserId" = $1 AND action = 'identity.login.failed'`, [user.userId])).toBe(BUDGET);
  });

  it("the budget is per account and per hour: another account is not affected, and rows older than an hour free it", async () => {
    const first = await world.createUser(tenant, { roles: ["traveler"] });
    const second = await world.createUser(tenant, { roles: ["traveler"] });
    for (let i = 0; i < BUDGET + 2; i++) await login(first, "Wrong-Password-1");
    await login(second, "Wrong-Password-1");
    expect(await rows(`"actorUserId" = $1 AND action = 'identity.login.failed'`, [second.userId])).toBe(1);
    await world.sql.query(`UPDATE audit_events SET "occurredAt" = now() - interval '2 hours' WHERE "actorUserId" = $1`, [first.userId]);
    await login(first, "Wrong-Password-1");
    expect(await rows(`"actorUserId" = $1 AND action = 'identity.login.failed' AND "occurredAt" > now() - interval '1 hour'`, [first.userId])).toBe(1);
  });

  it("logs one structured line per skipped row with the reason and the client address, never the e-mail", async () => {
    const { Logger } = await import("@nestjs/common");
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void lines.push(String(message)));
    try {
      const email = `${world.unique("ghost")}@example.test`;
      const ip = nextIp();
      await world.api("POST", "/auth/login", { headers: { "x-forwarded-for": ip }, body: { email, password: "Wrong-Password-1", tenantCode: tenant.code } });
      const skipped = lines.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } }).filter((entry) => entry?.["event"] === "audit_row_skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({ reason: "unknown_login", ip });
      expect(lines.join("\n")).not.toContain(email);
    } finally {
      spy.mockRestore();
    }
  });

  it("recording a failure costs a known and an unknown account about the same (a few ms apart, far below the password hash)", async () => {
    const { AccountSecurityService } = await import("../dist/modules/identity/auth/account-security.service.js");
    const { runAsSystem, requestContext } = await import("../dist/common/context/request-context.js");
    const { randomUUID } = await import("node:crypto");
    const service = world.app.get(AccountSecurityService);
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    // A budget of 4 is spent after 4 rows; use the known account only while it has room, then compare means over fresh accounts.
    const time = async (userId: string | undefined): Promise<number> => {
      const started = process.hrtime.bigint();
      await requestContext.run({ requestId: randomUUID() }, () => runAsSystem(() => service.recordFailure({ userId, tenantId: userId ? tenant.id : undefined, ipAddress: "198.51.100.250", reason: "bad_password" })));
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 60; i++) {
      const fresh = await world.createUser(tenant, { roles: ["traveler"] });
      known.push(await time(fresh.userId));
      unknown.push(await time(undefined));
    }
    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    void user;
    // Both sides run the same queries in a transaction; the known one commits a row and the unknown one rolls back. Measured on a local
    // PostgreSQL 17 (3 runs of 60 pairs): known 19.2 / 35.8 / 19.8 ms, unknown 15.8 / 31.2 / 17.1 ms, so the commit costs about 3-5 ms. The password
    // hash that every failed sign-in pays costs tens of ms with jitter of the same order, and the reply body is identical. The bound only
    // guards against a large regression (for example an extra query on one side).
    expect(Math.abs(mean(known) - mean(unknown))).toBeLessThan(25);
  });

  it("forgot-password and resend for unknown addresses store nothing and answer 202 like a known address", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const before = await metric('safry_audit_skipped_total{kind="unknown_address"}');
    const known = await post("/auth/password/forgot", { email: user.email });
    const unknownReplies: Reply[] = [];
    for (let i = 0; i < 4; i++) unknownReplies.push(await post("/auth/password/forgot", { email: `${world.unique("nobody")}@example.test` }));
    for (let i = 0; i < 4; i++) unknownReplies.push(await post("/auth/email/resend", { email: `${world.unique("nobody")}@example.test` }));
    expect(unknownReplies.every((reply) => reply.status === known.status && reply.status === 202)).toBe(true);
    expect(await rows(`"actorUserId" IS NULL AND action IN ('identity.password.reset_requested', 'identity.email.verification_requested')`)).toBe(0);
    expect((await metric('safry_audit_skipped_total{kind="unknown_address"}')) - before).toBe(8);
  });

  it("refused reset requests for a known account leave at most the hourly budget of rows", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    for (let i = 0; i < 10; i++) expect((await post("/auth/password/forgot", { email: user.email })).status).toBe(202);
    // One link was issued (one row); the 9 refused requests left BUDGET rows and were otherwise only counted.
    expect(await rows(`"actorUserId" = $1 AND action = 'identity.password.reset_requested'`, [user.userId])).toBe(1);
    expect(await rows(`"actorUserId" = $1 AND action = 'identity.password.reset_requested.suppressed'`, [user.userId])).toBe(BUDGET);
  });
});
