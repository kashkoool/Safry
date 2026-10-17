import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Reply, type TestTenant } from "./support/world.js";

/**
 * Many addresses (rotating X-Forwarded-For, every per-address limit left high) must not be able to send more mail than the budget
 * allows, the API answers must stay the same neutral ones, and security notices must still go out afterwards.
 * Budget here: 12 an hour (1 kept for security notices), so 11 general mails; the daily budget is far away.
 */
const password = `Np-${randomBytes(9).toString("hex")}-Zz`;
interface Sent { to: string; text: string }

describe("global mail budget under a flood", () => {
  let world: World;
  let tenant: TestTenant;
  let outbox: () => Sent[];
  let ipCounter = 0;
  const api = (path: string, body: Json): Promise<Reply> => world.api("POST", path, { headers: { "x-forwarded-for": `203.0.113.${(++ipCounter % 250) + 1}` }, body });

  beforeAll(async () => {
    world = await World.start({
      NODE_ENV: "development", TRUST_PROXY: "true", AUTH_MAIL_MIN_RESPONSE_MS: "0", RATE_LIMIT_IP_PER_MINUTE: "100000", RATE_LIMIT_ACCOUNT_PER_MINUTE: "100000",
      MAIL_BUDGET_PER_HOUR: "12", MAIL_BUDGET_PER_DAY: "1000"
    });
    const { MAIL_TRANSPORT } = await import("../dist/modules/mail/mail.types.js");
    const transport = world.app.get(MAIL_TRANSPORT) as { outbox: Sent[] };
    outbox = () => [...transport.outbox];
    tenant = await world.createTenant("budget");
  });
  afterAll(async () => {
    await world.stop();
  });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400)); // detached sends finish after the answer

  it("sends at most the budget however many addresses ask, keeps the answers neutral, and still sends the security notice", async () => {
    // A victim asks for a reset first: its token is needed later, and that mail is one of the 11 general ones.
    const victim = await world.createUser(tenant, { roles: ["traveler"] });
    expect((await api("/auth/password/forgot", { email: victim.email })).status).toBe(202);
    await settle();
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(outbox().find((m) => m.to === victim.email)?.text ?? "")?.[1];
    expect(token).toBeDefined();

    const known = await Promise.all(Array.from({ length: 20 }, async () => (await world.createUser(tenant, { roles: ["traveler"] })).email));
    const unknown = Array.from({ length: 20 }, () => `${world.unique("nobody")}@example.test`);
    const replies: Reply[] = [];
    for (let i = 0; i < 20; i += 5) {
      replies.push(
        ...(await Promise.all([
          ...known.slice(i, i + 5).map((email) => api("/auth/password/forgot", { email })),
          ...unknown.slice(i, i + 5).map((email) => api("/auth/password/forgot", { email })),
          ...Array.from({ length: 5 }, () => api("/auth/register/customer", { displayName: "Flood Person", email: `${world.unique("flood")}@example.test`, password, tenantCode: tenant.code })),
          ...known.slice(i, i + 5).map((email) => api("/auth/email/resend", { email }))
        ]))
      );
    }
    await settle();

    for (const reply of replies.filter((r) => r.status === 202)) expect(reply.body).toEqual(replies.find((r) => r.status === 202)!.body);
    expect(replies.every((r) => r.status === 202 || r.status === 201), JSON.stringify(replies.filter((r) => r.status !== 202 && r.status !== 201).map((r) => r.status))).toBe(true);
    expect(outbox().length, "all kinds together stay within the general budget").toBeLessThanOrEqual(11);
    expect(outbox().length).toBeGreaterThanOrEqual(11); // the flood really exhausted it, so the test proves something

    const before = outbox().length;
    const reset = await api("/auth/password/reset", { token: token!, newPassword: `Fresh-${randomBytes(6).toString("hex")}-Pw1` });
    expect(reset.status, JSON.stringify(reset.body)).toBeLessThan(300);
    await settle();
    expect(outbox().length, "the password-changed notice uses the security reserve").toBe(before + 1);
    expect(outbox().at(-1)!.to).toBe(victim.email);
  }, 120_000);
});
