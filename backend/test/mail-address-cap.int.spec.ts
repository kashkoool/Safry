import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Reply, type TestTenant } from "./support/world.js";

/** One client address has a daily cap on the mail it can cause; the answer to the caller stays the same. */
const password = `Np-${randomBytes(9).toString("hex")}-Zz`;
interface Sent { to: string; text: string }
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400)); // detached sends finish after the answer

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

describe("per-address daily cap", () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    ctx = await start({ MAIL_ADDRESS_RESET_PER_DAY: "3", MAIL_ADDRESS_REGISTRATION_PER_DAY: "2", MAIL_RECIPIENT_RESET_PER_DAY: "2" });
  });
  afterAll(async () => {
    await ctx.world.stop();
  });

  it("stops forgot-password mail after 3 requests from one address, with the same answer, and not for another address", async () => {
    const { world, tenant, outbox, api } = ctx;
    const emails = await Promise.all(Array.from({ length: 5 }, async () => (await world.createUser(tenant, { roles: ["traveler"] })).email));
    const replies: Reply[] = [];
    for (const email of emails) replies.push(await api("/auth/password/forgot", { email }, "198.51.100.50"));
    await settle();
    expect(replies.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    expect(new Set(replies.map((r) => JSON.stringify(r.body))).size, "capped and uncapped answers are identical").toBe(1);
    expect(emails.map((e) => outbox().some((m) => m.to === e))).toEqual([true, true, true, false, false]);

    // Another client address is unaffected.
    expect((await api("/auth/password/forgot", { email: emails[4]! }, "198.51.100.51")).status).toBe(202);
    await settle();
    expect(outbox().some((m) => m.to === emails[4])).toBe(true);
  }, 120_000);

  it("stops reset mail to ONE recipient after the per-recipient cap, whoever asks, with the same answer as for an unknown address", async () => {
    const { world, tenant, outbox, api } = ctx;
    const email = (await world.createUser(tenant, { roles: ["traveler"] })).email;
    const replies: Reply[] = [];
    const clearTokens = (): Promise<unknown> => world.sql.query(`DELETE FROM credential_tokens WHERE "userId" = (SELECT id FROM users WHERE "emailNormalized" = $1)`, [email]);
    for (let i = 0; i < 4; i++) {
      replies.push(await api("/auth/password/forgot", { email })); // a fresh client address each time
      await settle();
      if (i === 0) replies.push(await api("/auth/password/forgot", { email })); // too soon after the first: refused by the per-account limit, must not use the recipient's day
      await clearTokens(); // forget the previous link, so the one-minute resend interval does not decide and only the recipient cap does
    }
    const unknown = await api("/auth/password/forgot", { email: `${world.unique("nobody")}@example.test` });
    await settle();
    expect(replies.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    expect(new Set([...replies, unknown].map((r) => JSON.stringify(r.body))).size, "capped, uncapped and unknown answers are identical").toBe(1);
    expect(outbox().filter((m) => m.to === email).length).toBe(2); // MAIL_RECIPIENT_RESET_PER_DAY=2
  }, 120_000);

  it("counts an IPv6 /64 as one address", async () => {
    const { world, tenant, outbox, api } = ctx;
    const emails = await Promise.all(Array.from({ length: 4 }, async () => (await world.createUser(tenant, { roles: ["traveler"] })).email));
    for (const [i, email] of emails.entries()) expect((await api("/auth/password/forgot", { email }, `2001:db8:77:88:${i + 1}::${i + 1}`)).status).toBe(202);
    await settle();
    expect(emails.map((e) => outbox().some((m) => m.to === e))).toEqual([true, true, true, false]);
  }, 120_000);

  it("stops sign-up verification mail after 2 sign-ups from one address; the account is still created and the answer is the same", async () => {
    const { world, tenant, outbox, api } = ctx;
    const emails = Array.from({ length: 4 }, () => `${world.unique("signup")}@example.test`);
    const replies: Reply[] = [];
    for (const email of emails) replies.push(await api("/auth/register/customer", { displayName: "Signup Person", email, password, tenantCode: tenant.code }, "198.51.100.60"));
    await settle();
    expect(replies.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(replies.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(emails.map((e) => outbox().some((m) => m.to === e))).toEqual([true, true, false, false]);
  }, 120_000);
});
