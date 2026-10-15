import { afterEach, describe, expect, it } from "vitest";
import { World, type Session, type TestUser } from "./support/world.js";

/**
 * POST /auth/refresh limits (rate limiting is off under NODE_ENV=test, so the app boots as "development"):
 * live sessions are counted per session, unknown credentials stay on a strict per-address limit.
 */
describe("refresh throttling", () => {
  let world: World | undefined;
  afterEach(async () => {
    await world?.stop();
    world = undefined;
  });

  async function start(overrides: Record<string, string> = {}): Promise<{ w: World; user: TestUser; other: TestUser }> {
    world = await World.start({
      NODE_ENV: "development",
      TRUST_PROXY: "true",
      RATE_LIMIT_IP_PER_MINUTE: "300",
      RATE_LIMIT_USER_PER_MINUTE: "1000",
      RATE_LIMIT_ACCOUNT_PER_MINUTE: "1000",
      ...overrides
    });
    const tenant = await world.createTenant("rft");
    return { w: world, user: await world.createUser(tenant, { roles: ["traveler"] }), other: await world.createUser(tenant, { roles: ["traveler"] }) };
  }
  const ip = "203.0.113.7";
  const signIn = (w: World, user: TestUser): Promise<Session> => w.session(user);
  const refresh = (w: World, token: string) =>
    w.api("POST", "/auth/refresh", { headers: { "x-forwarded-for": ip }, body: { refreshToken: token } });

  it("21 refreshes from one address across two live sessions are not limited", async () => {
    const { w, user, other } = await start();
    let a = (await signIn(w, user)).refreshToken;
    let b = (await signIn(w, other)).refreshToken;
    for (let i = 0; i < 21; i += 1) {
      const reply = await refresh(w, i % 2 === 0 ? a : b);
      expect(reply.status).toBe(200);
      const next = reply.body.refreshToken as string;
      if (i % 2 === 0) a = next;
      else b = next;
    }
  });

  it("one session refreshing without pause is limited, and the other session is not", async () => {
    const { w, user, other } = await start({ RATE_LIMIT_REFRESH_SESSION_PER_MINUTE: "5" });
    let a = (await signIn(w, user)).refreshToken;
    const b = (await signIn(w, other)).refreshToken;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const reply = await refresh(w, a);
      statuses.push(reply.status);
      if (reply.status === 200) a = reply.body.refreshToken as string;
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect((await refresh(w, b)).status).toBe(200);
  });

  it("unknown credentials and a missing credential stay on the strict per-address limit", async () => {
    const { w, user } = await start();
    const unknown: number[] = [];
    for (let i = 0; i < 22; i += 1) unknown.push((await refresh(w, `invalid-token-${i}-${"x".repeat(40)}`)).status);
    expect(unknown.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(unknown.slice(20)).toEqual([429, 429]);
    // The same address is then refused for a missing credential too, but a live session of another address still works.
    expect((await w.api("POST", "/auth/refresh", { headers: { "x-forwarded-for": ip }, body: {} })).status).toBe(429);
    const live = (await signIn(w, user)).refreshToken;
    expect((await w.api("POST", "/auth/refresh", { headers: { "x-forwarded-for": "203.0.113.99" }, body: { refreshToken: live } })).status).toBe(200);
  });

  it("a flood with no credential at all is limited per address", async () => {
    const { w } = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) statuses.push((await w.api("POST", "/auth/refresh", { headers: { "x-forwarded-for": "203.0.113.50" }, body: {} })).status);
    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it("replaying an already used credential counts against the address, not the session", async () => {
    const { w, user } = await start({ RATE_LIMIT_REFRESH_SESSION_PER_MINUTE: "100" });
    const first = (await signIn(w, user)).refreshToken;
    expect((await refresh(w, first)).status).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) statuses.push((await refresh(w, first)).status);
    expect(statuses[0]).toBe(401);
    expect(statuses.slice(-2)).toEqual([429, 429]);
  });
});
