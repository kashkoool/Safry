import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Reply } from "./support/world.js";

/**
 * Rate limiting is off when NODE_ENV=test, so this suite boots the app as "development" (as the other throttle suites do).
 * Link-request endpoints are limited per client address and per (e-mail, client address); the token endpoints per address.
 */
/** A valid password generated per run: fixtures are never real credentials. */
const FRESH_PASSWORD = `Np-${randomBytes(9).toString("hex")}-Zz`;

describe("credential endpoints are rate limited", () => {
  let world: World;
  beforeAll(async () => {
    world = await World.start({ NODE_ENV: "development", TRUST_PROXY: "true", AUTH_MAIL_MIN_RESPONSE_MS: "0", RATE_LIMIT_IP_PER_MINUTE: "1000", RATE_LIMIT_ACCOUNT_PER_MINUTE: "1000" });
  });
  afterAll(async () => {
    await world.stop();
  });
  const post = (path: string, body: Json, ip: string): Promise<Reply> => world.api("POST", path, { headers: { "x-forwarded-for": ip }, body });
  const statuses = async (path: string, bodies: Json[], ip: string): Promise<number[]> => {
    const out: number[] = [];
    for (const body of bodies) out.push((await post(path, body, ip)).status);
    return out;
  };

  for (const path of ["/auth/password/forgot", "/auth/email/resend"]) {
    it(`${path}: one address is limited to 5 requests a minute whatever e-mails it asks about`, async () => {
      const bodies = Array.from({ length: 6 }, (_, i) => ({ email: `${world.unique("a")}-${i}@example.test` }));
      expect(await statuses(path, bodies, "198.51.100.10")).toEqual([202, 202, 202, 202, 202, 429]);
      expect((await post(path, { email: "other@example.test" }, "198.51.100.11")).status).toBe(202);
    });

    it(`${path}: one (e-mail, address) pair is limited to 3 requests a minute; another address is not affected`, async () => {
      const email = `${world.unique("pair")}@example.test`;
      expect(await statuses(path, [{ email }, { email }, { email }, { email }], "198.51.100.20")).toEqual([202, 202, 202, 429]);
      expect((await post(path, { email }, "198.51.100.21")).status).toBe(202);
    });
  }

  it("/auth/password/reset: 10 attempts a minute per address, then 429", async () => {
    const body = { token: "A".repeat(43), newPassword: FRESH_PASSWORD };
    const results = await statuses("/auth/password/reset", Array.from({ length: 11 }, () => body), "198.51.100.30");
    expect(results.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(results[10]).toBe(429);
  });

  it("/auth/email/verify: 20 attempts a minute per address, then 429", async () => {
    const results = await statuses("/auth/email/verify", Array.from({ length: 21 }, () => ({ token: "A".repeat(43) })), "198.51.100.40");
    expect(results.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(results[20]).toBe(429);
  });
});
