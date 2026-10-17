import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Reply, type TestTenant } from "./support/world.js";

/**
 * With the HTTP limiter on, many addresses (rotating X-Forwarded-For, every per-minute limit left high) must not be able to send
 * more mail than a pool allows, the API answers must stay the same neutral ones, a sign-up flood must not stop the reset mail of
 * an existing account, and one client address has a daily cap on the mail it can cause.
 */
const password = `Np-${randomBytes(9).toString("hex")}-Zz`;
interface Sent { to: string; text: string }
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400)); // detached sends finish after the answer
const tokenOf = (text: string): string | undefined => /#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1];

async function start(env: Record<string, string>): Promise<{ world: World; tenant: TestTenant; outbox: () => Sent[]; api: (path: string, body: Json, ip?: string) => Promise<Reply> }> {
  const world = await World.start({
    NODE_ENV: "development", TRUST_PROXY: "true", AUTH_MAIL_MIN_RESPONSE_MS: "0", RATE_LIMIT_IP_PER_MINUTE: "100000", RATE_LIMIT_ACCOUNT_PER_MINUTE: "100000", ...env
  });
  const { MAIL_TRANSPORT } = await import("../dist/modules/mail/mail.types.js");
  const transport = world.app.get(MAIL_TRANSPORT) as { outbox: Sent[] };
  let counter = 0;
  const api = (path: string, body: Json, ip?: string): Promise<Reply> =>
    world.api("POST", path, { headers: { "x-forwarded-for": ip ?? `203.0.113.${(++counter % 250) + 1}` }, body });
  return { world, tenant: await world.createTenant("budget"), outbox: () => [...transport.outbox], api };
}

describe("mail pools under a flood", () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    // Registration pool 6 an hour, reset pool 8, security 2. Daily limits and address caps far away: this suite is about the pools.
    ctx = await start({
      MAIL_BUDGET_REGISTRATION_PER_HOUR: "6", MAIL_BUDGET_REGISTRATION_PER_DAY: "1000", MAIL_BUDGET_RESET_PER_HOUR: "8", MAIL_BUDGET_RESET_PER_DAY: "1000",
      MAIL_BUDGET_SECURITY_PER_HOUR: "2", MAIL_BUDGET_SECURITY_PER_DAY: "1000", MAIL_ADDRESS_REGISTRATION_PER_DAY: "1000", MAIL_ADDRESS_RESET_PER_DAY: "1000"
    });
  });
  afterAll(async () => {
    await ctx.world.stop();
  });

  it("a sign-up flood is bounded by the registration pool and leaves reset and security mail available", async () => {
    const { world, tenant, outbox, api } = ctx;
    const victim = await world.createUser(tenant, { roles: ["traveler"] });
    const replies: Reply[] = [];
    for (let i = 0; i < 30; i += 5)
      replies.push(...(await Promise.all(Array.from({ length: 5 }, () => api("/auth/register/customer", { displayName: "Flood Person", email: `${world.unique("flood")}@example.test`, password, tenantCode: tenant.code })))));
    await settle();

    expect(replies.every((r) => r.status === 201), JSON.stringify(replies.map((r) => r.status))).toBe(true);
    expect(new Set(replies.map((r) => JSON.stringify(Object.keys(r.body as object)))).size, "same answer shape however many mails were dropped").toBe(1);
    expect(outbox().length, "the registration pool let exactly its hourly limit through").toBe(6);

    // The flood spent the registration pool. A real user's reset must still be mailed (reset pool) and the notice (security pool) too.
    expect((await api("/auth/password/forgot", { email: victim.email })).status).toBe(202);
    await settle();
    const reset = outbox().find((m) => m.to === victim.email);
    expect(reset, "the reset mail of an existing account was sent although the registration pool is spent").toBeDefined();
    const token = tokenOf(reset!.text);
    expect(token).toBeDefined();
    const done = await api("/auth/password/reset", { token: token!, newPassword: `Fresh-${randomBytes(6).toString("hex")}-Pw1` });
    expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);
    await settle();
    expect(outbox().filter((m) => m.to === victim.email), "reset link and password-changed notice").toHaveLength(2);
  }, 120_000);

  it("a reset flood is bounded by the reset pool", async () => {
    const { world, tenant, outbox, api } = ctx;
    const known = await Promise.all(Array.from({ length: 20 }, async () => (await world.createUser(tenant, { roles: ["traveler"] })).email));
    const unknown = Array.from({ length: 10 }, () => `${world.unique("nobody")}@example.test`);
    const before = outbox().length;
    const replies = await Promise.all([...known, ...unknown].map((email) => api("/auth/password/forgot", { email })));
    await settle();
    expect(replies.every((r) => r.status === 202)).toBe(true);
    expect(new Set(replies.map((r) => JSON.stringify(r.body))).size, "identical body for known and unknown addresses").toBe(1);
    // The reset pool is 8 an hour; the previous test already used 1 (the victim's reset link), so 7 are left. The flood spent them.
    expect(outbox().length - before).toBe(7);
  }, 120_000);
});
