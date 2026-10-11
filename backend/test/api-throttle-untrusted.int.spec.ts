import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type TestUser } from "./support/world.js";

/**
 * TRUST_PROXY: without a trusted proxy the X-Forwarded-For header is ignored, so rotating it cannot
 * be used to dodge the per-(account, address) limit. Own file: the proxy setting is read once per process.
 */
describe("api throttling without a trusted proxy", () => {
  let world: World;
  let user: TestUser;

  beforeAll(async () => {
    world = await World.start({ NODE_ENV: "development", TRUST_PROXY: "false", RATE_LIMIT_ACCOUNT_PER_MINUTE: "3", RATE_LIMIT_IP_PER_MINUTE: "1000", LOGIN_MAX_ATTEMPTS: "20" });
    user = await world.createUser(await world.createTenant("untrusted"), { roles: ["traveler"] });
  });

  afterAll(async () => {
    await world.stop();
  });

  it("spoofed X-Forwarded-For values all count against the socket address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1)
      statuses.push(
        (
          await world.api("POST", "/auth/login", {
            headers: { "x-forwarded-for": `203.0.113.${10 + i}` },
            body: { email: user.email, password: "Wrong-Password-1", tenantCode: user.tenant.code }
          })
        ).status
      );
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
  });
});
