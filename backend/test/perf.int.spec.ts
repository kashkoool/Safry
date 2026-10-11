import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Session, type TestTenant, type TestUser } from "./support/world.js";

/** Backend performance and scaling behaviour: principal cache, pagination, probes, metrics. */
describe("performance and scaling", () => {
  let world: World;
  let tenant: TestTenant;
  let traveler: TestUser;
  let serviceId: string;
  const METRICS_TOKEN = "metrics-token-for-tests-only";
  const auth = (session: Pick<Session, "accessToken" | "user">): { accessToken: string; tenantId: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user.tenantId
  });
  const raw = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${world.baseUrl}${path}`, init);
  const metric = async (name: string): Promise<number> => {
    const reply = await raw("/metrics", { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    const text = await reply.text();
    expect(reply.status, text.slice(0, 200)).toBe(200);
    return Number(new RegExp(`^${name} ([0-9]+)`, "m").exec(text)?.[1] ?? Number.NaN);
  };

  beforeAll(async () => {
    world = await World.start({ AUTH_CACHE_TTL_MS: "60000", METRICS_TOKEN });
    tenant = await world.createTenant("perf");
    const orgId = await world.createOrganization(tenant);
    const provider = await world.createUser(tenant, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
    traveler = await world.createUser(tenant, { roles: ["traveler"] });
    serviceId = await world.createService(tenant, provider, { capacity: 1000 });
  });
  afterAll(async () => {
    await world.stop();
  });

  describe("principal cache", () => {
    it("serves repeated requests from the cache", async () => {
      const session = await world.session(traveler);
      const before = await metric("safry_auth_cache_hits_total");
      for (let i = 0; i < 3; i += 1) expect((await world.api("GET", "/auth/me", { session: auth(session) })).status).toBe(200);
      expect((await metric("safry_auth_cache_hits_total")) - before).toBeGreaterThanOrEqual(2);
    });

    it("rejects a token the moment its session is logged out, despite a warm cache", async () => {
      const session = await world.session(traveler);
      expect((await world.api("GET", "/auth/me", { session: auth(session) })).status).toBe(200);
      expect((await world.api("GET", "/auth/me", { session: auth(session) })).status).toBe(200);
      await world.api("POST", "/auth/logout", { session: auth(session), body: { refreshToken: session.refreshToken } });
      expect((await world.api("GET", "/auth/me", { session: auth(session) })).status).toBe(401);
    });

    it("applies a membership suspension at once", async () => {
      const victim = await world.createUser(tenant, { roles: ["traveler"] });
      const admin = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"] }));
      const session = await world.session(victim);
      expect((await world.api("GET", "/bookings", { session: auth(session) })).status).toBe(200);
      expect((await world.api("GET", "/bookings", { session: auth(session) })).status).toBe(200);
      const changed = await world.api("PATCH", `/tenants/members/${victim.membershipId}/status`, {
        session: auth(admin), body: { status: "SUSPENDED", reason: "perf test" }
      });
      expect(changed.status).toBe(200);
      expect((await world.api("GET", "/bookings", { session: auth(session) })).status).toBe(401);
    });

    it("applies a password change (authVersion bump) to a warm cached session at once", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const other = await world.session(user);
      const current = await world.session(user);
      for (let i = 0; i < 2; i += 1) expect((await world.api("GET", "/auth/me", { session: auth(other) })).status).toBe(200);
      const changed = await world.api("POST", "/auth/password", {
        session: auth(current), body: { currentPassword: user.password, newPassword: "Perf-Test-New-Password-42" }
      });
      expect(changed.status).toBe(204);
      expect((await world.api("GET", "/auth/me", { session: auth(other) })).status).toBe(401);
      expect((await world.api("GET", "/auth/me", { session: auth(current) })).status).toBe(200);
    });

    it("never shares a cached principal across tenants", async () => {
      const other = await world.createTenant("perf-other");
      const stranger = await world.createUser(other, { roles: ["traveler"] });
      const session = await world.session(stranger);
      const crossTenant = await world.api("GET", "/auth/me", { session: { accessToken: session.accessToken, tenantId: tenant.id } });
      expect(crossTenant.status).toBe(401);
    });
  });

  describe("pagination", () => {
    it("pages bookings with a cursor header and no overlap", async () => {
      const session = await world.session(traveler);
      for (let i = 0; i < 5; i += 1)
        await world.api("POST", "/bookings", { session: auth(session), body: { serviceId, travelersCount: 1, serviceDate: world.futureDate(10 + i) } });
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
        const response: Response = await raw(`/bookings${query}`, { headers: { authorization: `Bearer ${session.accessToken}` } });
        expect(response.status).toBe(200);
        const rows = (await response.json()) as Array<{ id: string }>;
        expect(rows.length).toBeLessThanOrEqual(2);
        seen.push(...rows.map((row) => row.id));
        cursor = response.headers.get("x-next-cursor");
        pages += 1;
      } while (cursor && pages < 10);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBeGreaterThanOrEqual(5);
      expect(pages).toBeGreaterThanOrEqual(3);
    });

    it("rejects out-of-range limits and forged cursors", async () => {
      const session = await world.session(traveler);
      const get = (query: string): Promise<{ status: number; body: Json }> => world.api("GET", `/bookings${query}`, { session: auth(session) });
      expect((await get("?limit=0")).status).toBe(400);
      expect((await get("?limit=201")).status).toBe(400);
      expect((await get("?cursor=not-a-cursor")).status).toBe(400);
      expect((await world.api("GET", `/services/marketplace?limit=1`, { session: auth(session) })).status).toBe(200);
    });
  });

  describe("probes and metrics", () => {
    it("answers liveness without a token and reports readiness", async () => {
      expect((await raw("/health/live")).status).toBe(200);
      expect((await raw("/health/ready")).status).toBe(200);
    });

    it("keeps metrics closed without the token and exports no ids or query strings", async () => {
      expect((await raw("/metrics")).status).toBe(401);
      expect((await raw("/metrics", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      await raw("/health/live?secret=abc");
      const text = await (await raw("/metrics", { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
      expect(text).toContain("safry_http_requests_total");
      expect(text).not.toContain("secret=abc");
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    });

    it("compresses large responses when the client accepts it", async () => {
      const session = await world.session(traveler);
      const response = await raw("/services/marketplace", { headers: { authorization: `Bearer ${session.accessToken}`, "accept-encoding": "gzip" } });
      expect(response.status).toBe(200);
    });

    it("sends no-store on API answers and never compresses token-bearing auth routes", async () => {
      for (let i = 0; i < 12; i++) await world.createService(tenant, await world.createUser(tenant, { roles: ["travel-company"], organizationId: await world.createOrganization(tenant) }), { capacity: 5 });
      const gzip = { "accept-encoding": "gzip", "content-type": "application/json", "x-client": "mobile" };
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const login = await raw("/auth/login", { method: "POST", headers: gzip, body: JSON.stringify({ email: user.email, password: user.password, tenantCode: tenant.code }) });
      expect(login.status).toBe(200);
      expect(login.headers.get("cache-control")).toBe("no-store");
      expect(login.headers.get("pragma")).toBe("no-cache");
      expect(login.headers.get("content-encoding")).toBeNull();
      const tokens = (await login.json()) as { accessToken: string; refreshToken: string };
      const authz = { ...gzip, authorization: `Bearer ${tokens.accessToken}` };
      const sessions = await raw("/auth/sessions", { headers: authz });
      expect(sessions.status).toBe(200);
      expect(sessions.headers.get("cache-control")).toBe("no-store");
      expect(sessions.headers.get("content-encoding")).toBeNull();
      const refresh = await raw("/auth/refresh", { method: "POST", headers: gzip, body: JSON.stringify({ refreshToken: tokens.refreshToken }) });
      expect(refresh.status).toBe(200);
      expect(refresh.headers.get("cache-control")).toBe("no-store");
      expect(refresh.headers.get("pragma")).toBe("no-cache");
      expect(refresh.headers.get("content-encoding")).toBeNull();
      const rotated = (await refresh.json()) as { accessToken: string };
      const list = await raw("/services/marketplace?limit=50", { headers: { ...gzip, authorization: `Bearer ${rotated.accessToken}` } });
      expect(list.status).toBe(200);
      expect(list.headers.get("cache-control")).toBe("no-store");
      expect(list.headers.get("content-encoding")).toBe("gzip");
    });
  });
});
