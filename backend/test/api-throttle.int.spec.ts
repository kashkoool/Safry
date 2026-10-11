import { afterEach, describe, expect, it } from "vitest";
import { World, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Rate limiting is switched off when NODE_ENV=test, so these suites boot the app as "development" with tiny limits.
 *  (b) the "account" throttler is keyed e-mail|client address, over real HTTP with X-Forwarded-For
 *  (c) the shared (Redis) store is unreachable -> limits degrade to per-instance, no route returns 500
 */
const ipOf = (n: number): string => `203.0.113.${n}`;

describe("api throttling over HTTP", () => {
  let world: World | undefined;
  afterEach(async () => {
    await world?.stop();
    world = undefined;
  });

  async function start(overrides: Record<string, string>): Promise<{ world: World; tenant: TestTenant; user: TestUser }> {
    world = await World.start({
      NODE_ENV: "development",
      RATE_LIMIT_ACCOUNT_PER_MINUTE: "3",
      RATE_LIMIT_IP_PER_MINUTE: "1000",
      RATE_LIMIT_USER_PER_MINUTE: "1000",
      LOGIN_MAX_ATTEMPTS: "20",
      ...overrides
    });
    const tenant = await world.createTenant("thr");
    return { world, tenant, user: await world.createUser(tenant, { roles: ["traveler"] }) };
  }

  const login = (w: World, user: TestUser, ip: string, password = user.password, email = user.email) =>
    w.api("POST", "/auth/login", { headers: { "x-forwarded-for": ip }, body: { email, password, tenantCode: user.tenant.code } });

  describe("(b) account throttle is keyed email|ip", () => {
    it("one address exhausting an account's bucket gets 429, while the owner from another address is unaffected", async () => {
      const { world: w, user } = await start({ TRUST_PROXY: "true" });
      const attacker = ipOf(1);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await login(w, user, attacker, "Wrong-Password-1")).status);
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
      // Even the right password is throttled for that (account, address) pair ...
      expect((await login(w, user, attacker)).status).toBe(429);
      // ... but a stranger cannot spend the owner's bucket: another address signs in normally.
      expect((await login(w, user, ipOf(2))).status).toBe(200);
    });

    it("the same address attacking two different accounts has a separate bucket per account", async () => {
      const { world: w, user, tenant } = await start({ TRUST_PROXY: "true" });
      const second = await w.createUser(tenant, { roles: ["traveler"] });
      for (let i = 0; i < 4; i += 1) await login(w, user, ipOf(3), "Wrong-Password-1");
      expect((await login(w, user, ipOf(3), "Wrong-Password-1")).status).toBe(429);
      expect((await login(w, second, ipOf(3))).status).toBe(200);
    });

    it("the key is the normalised e-mail: case and spacing variants share one bucket", async () => {
      const { world: w, user } = await start({ TRUST_PROXY: "true" });
      for (const variant of [user.email.toUpperCase(), ` ${user.email} `, user.email, user.email.toUpperCase()])
        await login(w, user, ipOf(4), "Wrong-Password-1", variant);
      expect((await login(w, user, ipOf(4), "Wrong-Password-1", ` ${user.email.toUpperCase()}`)).status).toBe(429);
    });

    it("trusted proxy: a different X-Forwarded-For is a different client (the untrusted case is in api-throttle-untrusted.int.spec.ts)", async () => {
      const { world: w, user } = await start({ TRUST_PROXY: "true" });
      for (let i = 0; i < 4; i += 1) await login(w, user, ipOf(5), "Wrong-Password-1");
      expect((await login(w, user, ipOf(5), "Wrong-Password-1")).status).toBe(429);
      expect((await login(w, user, ipOf(6), "Wrong-Password-1")).status).toBe(401);
    });

    it("requests without an e-mail in the body are not counted in any account bucket", async () => {
      const { world: w, user } = await start({ TRUST_PROXY: "true" });
      for (let i = 0; i < 6; i += 1) expect((await w.api("POST", "/auth/login", { headers: { "x-forwarded-for": ipOf(20) }, body: {} })).status).toBe(400);
      expect((await login(w, user, ipOf(20))).status).toBe(200);
    });

    it("the 429 carries no account information and the throttle does not reveal whether the e-mail exists", async () => {
      const { world: w, user } = await start({ TRUST_PROXY: "true" });
      const known: number[] = [];
      const unknown: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        known.push((await login(w, user, ipOf(30), "Wrong-Password-1")).status);
        unknown.push((await login(w, user, ipOf(31), "Wrong-Password-1", `nobody-${i}@example.test`)).status);
      }
      expect(known.length).toBe(unknown.length);
      const tripped = await login(w, user, ipOf(30), "Wrong-Password-1");
      expect(tripped.status).toBe(429);
      expect(JSON.stringify(tripped.body)).not.toContain(user.email);
    });
  });

  describe("(c) rate-limit store down degrades, it does not fail", () => {
    it("with an unreachable Redis the API keeps serving (never 500), still limits per instance, and readiness reports degraded", async () => {
      // 127.0.0.1:1 refuses connections: every Redis command errors, which is the outage being simulated.
      const { world: w, user } = await start({ TRUST_PROXY: "true", RATE_LIMIT_REDIS_URL: "redis://127.0.0.1:1" });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await login(w, user, ipOf(40), "Wrong-Password-1")).status);
      expect(statuses).not.toContain(500);
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3).every((status) => status === 429)).toBe(true);
      expect((await login(w, user, ipOf(41))).status).toBe(200);
      const ready = await fetch(`${w.baseUrl}/health/ready`);
      expect(ready.status).toBe(200);
      expect(((await ready.json()) as { rateLimit: string }).rateLimit).toBe("degraded-in-process");
      expect((await fetch(`${w.baseUrl}/health/live`)).status).toBe(200);
    });
  });
  // Needs a live Redis: set TEST_REDIS_URL (e.g. redis://127.0.0.1:55524). Skipped otherwise.
  describe.runIf(Boolean(process.env.TEST_REDIS_URL))("(d) two replicas share one Redis counter", () => {
    it("failures spread across two API instances add up to one bucket", async () => {
      const redis = { TRUST_PROXY: "true", RATE_LIMIT_REDIS_URL: process.env.TEST_REDIS_URL ?? "" };
      const { world: a, user } = await start(redis);
      const second = await World.start({
        NODE_ENV: "development",
        RATE_LIMIT_ACCOUNT_PER_MINUTE: "3",
        RATE_LIMIT_IP_PER_MINUTE: "1000",
        RATE_LIMIT_USER_PER_MINUTE: "1000",
        LOGIN_MAX_ATTEMPTS: "20",
        ...redis
      });
      try {
        const ip = ipOf(60);
        const statuses = [
          (await login(a, user, ip, "Wrong-Password-1")).status,
          (await login(a, user, ip, "Wrong-Password-1")).status,
          (await login(second, user, ip, "Wrong-Password-1")).status,
          (await login(second, user, ip, "Wrong-Password-1")).status,
          (await login(a, user, ip, "Wrong-Password-1")).status
        ];
        // Per-instance counting would allow 3 per instance (all five answered 401); the shared store trips on the 4th.
        expect(statuses).toEqual([401, 401, 401, 429, 429]);
      } finally {
        await second.stop();
      }
    });
  });
});
