import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
