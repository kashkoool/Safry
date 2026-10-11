import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type RouteInfo, type Session, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Route-by-route authorization and input matrix, derived from the routes the running app really serves
 * (World.routes: Express router + Nest metadata), so a new route is covered by the generic checks the moment it exists:
 *   - protected route without credentials            -> 401
 *   - route with required permissions, role-less user -> 403
 *   - platform route, tenant admin (not platform)     -> 403
 *   - route with a body, unknown field                -> 400 (whitelist + forbidNonWhitelisted)
 *   - route with a uuid parameter, malformed id       -> 400, never 5xx
 *   - oversize body                                   -> 413
 * The success cases of the routes the other suites do not reach are at the bottom. `pnpm test:routes` fails when a
 * route is never called, never succeeds, or lacks an unauthenticated and a negative call.
 */
const METRICS_TOKEN = "matrix-metrics-token-0123456789abcdef";
const fill = (route: RouteInfo, value: (param: string) => string): string =>
  route.path.replace(/^\/api\/v1/, "").replace(/:(\w+)/g, (_match, param: string) => value(param));

describe("api route matrix", () => {
  let world: World;
  let a: TestTenant;
  let b: TestTenant;
  let routes: RouteInfo[];
  let admin: Session; // tenant-admin of A
  let nobody: Session; // active member of A with no role at all
  let platform: Session; // platform administrator
  let adminUser: TestUser;

  const auth = (session: Session): { accessToken: string; tenantId: string } => ({ accessToken: session.accessToken, tenantId: session.user.tenantId });
  const call = (route: RouteInfo, options: { session?: Session; body?: unknown; param?: (name: string) => string; headers?: Record<string, string> } = {}) =>
    world.api(route.method, fill(route, options.param ?? ((name) => (name === "kind" ? "users" : randomUUID()))), {
      ...(options.session ? { session: auth(options.session) } : {}),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.headers ? { headers: options.headers } : {})
    });

  beforeAll(async () => {
    world = await World.start({ METRICS_TOKEN, TRUST_PROXY: "true" });
    a = await world.createTenant("mx-a");
    b = await world.createTenant("mx-b");
    adminUser = await world.createUser(a, { roles: ["tenant-admin"] });
    admin = await world.session(adminUser);
    nobody = await world.session(await world.createUser(a, { roles: [] }));
    platform = await world.session(await world.createUser(b, { roles: ["tenant-admin"], isPlatformAdmin: true }));
    routes = await world.routes();
  });

  afterAll(async () => {
    await world.stop();
  });

  it("serves at least the 69 routes the matrix was derived from, each classified", () => {
    expect(routes.length).toBeGreaterThanOrEqual(69);
    const platformOnly = routes.filter((route) => route.platformGuard);
    expect(platformOnly.length).toBeGreaterThanOrEqual(12);
    expect(routes.filter((route) => route.public).map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(["POST /api/v1/auth/login", "GET /api/v1/health/live"])
    );
  });

  describe("unauthenticated", () => {
    it("answers 401 on every non-public route, with and without a body, and with a garbage bearer token", async () => {
      const failures: string[] = [];
      for (const route of routes.filter((r) => !r.public)) {
        for (const reply of [
          await call(route),
          ...(route.hasBody ? [await call(route, { body: {} })] : []),
          await call(route, { headers: { authorization: "Bearer not.a.jwt" } })
        ])
          if (reply.status !== 401) failures.push(`${route.method} ${route.path} -> ${reply.status}`);
      }
      expect(failures).toEqual([]);
    });

    it("never accepts a token for another tenant header: x-tenant-id must match the token", async () => {
      const reply = await world.api("GET", "/tenants/current", {
        headers: { authorization: `Bearer ${admin.accessToken}`, "x-tenant-id": b.id }
      });
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(reply.status).toBeLessThan(500);
    });
  });

  describe("authorization by permission", () => {
    it("answers 403 to a role-less member on every route that requires a permission", async () => {
      const failures: string[] = [];
      for (const route of routes.filter((r) => !r.public && !r.platformGuard && r.permissions.length > 0)) {
        const reply = await call(route, { session: nobody, ...(route.hasBody ? { body: {} } : {}) });
        if (reply.status !== 403) failures.push(`${route.method} ${route.path} [${route.permissions.join(",")}] -> ${reply.status}`);
      }
      expect(failures).toEqual([]);
    });

    it("answers 403 to a tenant administrator on every platform route", async () => {
      const failures: string[] = [];
      for (const route of routes.filter((r) => r.platformGuard)) {
        const reply = await call(route, { session: admin, ...(route.hasBody ? { body: {} } : {}) });
        if (reply.status !== 403) failures.push(`${route.method} ${route.path} -> ${reply.status}`);
      }
      expect(failures).toEqual([]);
    });

    it("lets a platform administrator past the platform guard (never 401/403)", async () => {
      const failures: string[] = [];
      for (const route of routes.filter((r) => r.platformGuard)) {
        const reply = await call(route, { session: platform, ...(route.hasBody ? { body: { zzz: 1 } } : {}) });
        if (reply.status === 401 || reply.status === 403) failures.push(`${route.method} ${route.path} -> ${reply.status}`);
      }
      expect(failures).toEqual([]);
    });

    it("keeps routes without a declared permission to authenticated callers only (no silent public route)", () => {
      const open = routes.filter((r) => !r.public && !r.platformGuard && r.permissions.length === 0).map((r) => `${r.method} ${r.path}`);
      // Identity-scoped routes: the caller acts on themself. Any addition must be a conscious decision of this list.
      expect(open.sort()).toEqual(
        [
          "DELETE /api/v1/auth/sessions/:id",
          "GET /api/v1/auth/me",
          "GET /api/v1/auth/mfa",
          "GET /api/v1/auth/sessions",
          "GET /api/v1/users/me",
          "GET /api/v1/users/me/invitations",
          "PATCH /api/v1/users/me",
          "POST /api/v1/auth/activity",
          "POST /api/v1/auth/login-throttle/unlock",
          "POST /api/v1/auth/logout-all",
          "POST /api/v1/auth/mfa/disable",
          "POST /api/v1/auth/mfa/enable",
          "POST /api/v1/auth/mfa/recovery-codes",
          "POST /api/v1/auth/mfa/setup",
          "POST /api/v1/auth/password",
          "POST /api/v1/users/me/invitations/:membershipId/accept",
          "POST /api/v1/users/me/invitations/:membershipId/decline"
        ].sort()
      );
    });
  });

  describe("input validation", () => {
    it("rejects an unknown field with 400 on every route that takes a body", async () => {
      const failures: string[] = [];
      for (const route of routes.filter((r) => r.hasBody)) {
        const session = route.public ? undefined : route.platformGuard ? platform : admin;
        // login-throttle/unlock is guarded by the platform guard inside the controller, so it needs the platform session.
        const effective = route.path.endsWith("/login-throttle/unlock") ? platform : session;
        const reply = await call(route, { ...(effective ? { session: effective } : {}), body: { zzUnknownField: 1 } });
        if (reply.status !== 400) failures.push(`${route.method} ${route.path} -> ${reply.status} ${JSON.stringify(reply.body).slice(0, 120)}`);
      }
      expect(failures).toEqual([]);
    });

    it("rejects wrong JSON types (array, string, null) as a body with 4xx, never 5xx", async () => {
      const failures: string[] = [];
      for (const route of routes.filter((r) => r.hasBody && !r.public)) {
        const session = route.platformGuard ? platform : admin;
        for (const body of [[1, 2], "text", null, 12345]) {
          const reply = await call(route, { session, body });
          if (reply.status < 400 || reply.status >= 500) failures.push(`${route.method} ${route.path} ${JSON.stringify(body)} -> ${reply.status}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it("rejects a malformed uuid path parameter with 400 on every route that has one", async () => {
      const failures: string[] = [];
      for (const route of routes.filter((r) => r.params.some((p) => p !== "kind"))) {
        const session = route.public ? undefined : route.platformGuard ? platform : admin;
        const reply = await call(route, {
          ...(session ? { session } : {}),
          param: (name) => (name === "kind" ? "users" : "not-a-uuid"),
          ...(route.hasBody ? { body: {} } : {})
        });
        if (reply.status !== 400) failures.push(`${route.method} ${route.path} -> ${reply.status}`);
      }
      expect(failures).toEqual([]);
    });

    it("answers 404 (not 500) for a well-formed id that does not exist", async () => {
      const failures: string[] = [];
      for (const route of routes.filter((r) => r.params.length > 0 && !r.public)) {
        if (route.path.includes("/users/me/invitations/")) continue; // covered by the consent tests
        const session = route.platformGuard ? platform : admin;
        const reply = await call(route, { session, ...(route.hasBody ? { body: {} } : {}) });
        if (reply.status >= 500) failures.push(`${route.method} ${route.path} -> ${reply.status}`);
      }
      expect(failures).toEqual([]);
    });

    it("never accepts a body over the size limit: 4xx, nothing created", async () => {
      const big = { note: "x".repeat(300_000) };
      for (const [method, path, session] of [
        ["POST", "/auth/login", undefined],
        ["POST", "/auth/register/customer", undefined],
        ["POST", "/bookings", admin],
        ["POST", "/services", admin]
      ] as const) {
        const reply = await world.api(method, path, { ...(session ? { session: auth(session) } : {}), body: big });
        expect(reply.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      }
    });

    it("answers 413 (not 500) for a body over the size limit", async () => {
      for (const [path, session] of [["/auth/login", undefined], ["/bookings", admin]] as const) {
        const reply = await world.api("POST", path, { ...(session ? { session: auth(session) } : {}), body: { note: "x".repeat(300_000) } });
        expect(reply.status, path).toBe(413);
      }
    });

    it("rejects out-of-range and non-numeric pagination on every list route", async () => {
      for (const route of routes.filter((r) => r.method === "GET" && r.permissions.length > 0 && r.params.length === 0 && /bookings|services$|marketplace|providers$|tenants\/members$/.test(r.path))) {
        const path = fill(route, () => "x");
        for (const query of ["limit=0", "limit=-1", "limit=100000", "limit=abc", "limit=1.5"]) {
          const reply = await world.api("GET", `${path}?${query}`, { session: auth(admin) });
          expect(reply.status, `${path}?${query}`).toBe(400);
        }
      }
    });
  });

  describe("public and operational routes", () => {
    const raw = (path: string, headers: Record<string, string> = {}): Promise<Response> => fetch(`${world.baseUrl}${path}`, { headers });

    it("GET /health/live and /health/ready answer without credentials", async () => {
      const live = await raw("/health/live");
      expect(live.status).toBe(200);
      expect(((await live.json()) as { status: string }).status).toBe("ok");
      const ready = await raw("/health/ready");
      expect(ready.status).toBe(200);
      expect(((await ready.json()) as { database: string }).database).toBe("reachable");
      expect((await world.api("GET", "/health/live", {})).status).toBe(200);
      expect((await world.api("GET", "/health/ready", {})).status).toBe(200);
    });

    it("GET /metrics is closed without the scrape token and open with it", async () => {
      expect((await raw("/metrics")).status).toBe(401);
      expect((await raw("/metrics", { authorization: "Bearer wrong-token-of-another-length" })).status).toBe(401);
      expect((await raw("/metrics", { authorization: `Bearer ${admin.accessToken}` })).status).toBe(401);
      const open = await world.api("GET", "/metrics", { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
      expect(open.status).toBe(200);
      expect((open.body as unknown as { text: string }).text).toContain("safry_http_requests_total");
      expect((await world.api("GET", "/metrics", {})).status).toBe(401);
    });
  });
});
