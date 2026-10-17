import { describe, expect, it } from "vitest";
import { World } from "./support/world.js";

describe("alert signal metrics: rate limiting", () => {
  it("counts 429 answers under the auth route group (rate limiting is off when NODE_ENV=test, so boot as development)", async () => {
    const token = "alert-signals-metrics-token-0123456789abcdef";
    const world = await World.start({ NODE_ENV: "development", METRICS_TOKEN: token, TRUST_PROXY: "true", RATE_LIMIT_ACCOUNT_PER_MINUTE: "2", RATE_LIMIT_IP_PER_MINUTE: "1000", LOGIN_MAX_ATTEMPTS: "20" });
    try {
      const tenant = await world.createTenant("alerts429");
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++)
        statuses.push((await world.api("POST", "/auth/login", { headers: { "x-forwarded-for": "203.0.113.50" }, body: { email: user.email, password: "Wrong-Password-1", tenantCode: tenant.code } })).status);
      expect(statuses).toContain(429);
      const text = String(((await world.api("GET", "/metrics", { headers: { authorization: `Bearer ${token}` } })).body as { text?: string }).text);
      const limited = statuses.filter((status) => status === 429).length;
      expect(text).toContain(`safry_rate_limited_total{group="auth"} ${limited}`);
    } finally {
      await world.stop();
    }
  }, 180_000);
});
