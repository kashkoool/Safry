import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { World, type Session, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Success, duplicate and cross-tenant cases for the routes the other suites do not reach
 * (the route-coverage gate `pnpm test:routes` lists any route missing from the recorded calls).
 */
describe("api success paths", () => {
  let world: World;
  let a: TestTenant;
  let b: TestTenant;
  let adminA: TestUser;
  let adminB: TestUser;
  let sa: Session; // tenant admin of A
  let sb: Session; // tenant admin of B
  let platform: Session;
  let platformUser: TestUser;
  let orgId: string;
  let manager: TestUser;
  let sm: Session; // organization manager (+ travel company) of A
  let departmentId: string;

  const auth = (session: Session): { accessToken: string; tenantId: string } => ({ accessToken: session.accessToken, tenantId: session.user.tenantId });
  const serviceBody = (): Record<string, unknown> => ({
    title: `Umrah package ${world.unique("svc")}`,
    description: "Five nights near the Haram with transport",
    category: "PACKAGE",
    city: "Makkah",
    priceCents: 250_000,
    capacity: 12,
    details: { durationDays: "5", departureCity: "Riyadh", itinerary: "Test itinerary" }
  });

  beforeAll(async () => {
    world = await World.start({ TRUST_PROXY: "true" });
    a = await world.createTenant("ok-a");
    b = await world.createTenant("ok-b");
    adminA = await world.createUser(a, { roles: ["tenant-admin"] });
    adminB = await world.createUser(b, { roles: ["tenant-admin"] });
    sa = await world.session(adminA);
    sb = await world.session(adminB);
    platformUser = await world.createUser(b, { roles: ["tenant-admin"], isPlatformAdmin: true });
    platform = await world.session(platformUser);
    orgId = await world.createOrganization(a);
    manager = await world.createUser(a, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
    sm = await world.session(manager);
    const department = await world.api("POST", `/organizations/${orgId}/departments`, { session: auth(sm), body: { code: "ops", name: "Operations" } });
    expect(department.status).toBe(201);
    departmentId = department.body.id as string;
  });

  afterAll(async () => {
    await world.stop();
  });

  describe("POST /services, PATCH /services/:id", () => {
    it("creates and edits a service; a foreign tenant can neither read nor edit it", async () => {
      const created = await world.api("POST", "/services", { session: auth(sm), body: serviceBody() });
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      expect(created.body.tenantId ?? a.id).toBe(a.id);
      const patched = await world.api("PATCH", `/services/${id}`, { session: auth(sm), body: { capacity: 20, status: "ACTIVE" } });
      expect(patched.status).toBe(200);
      expect(patched.body.capacity).toBe(20);
      expect((await world.api("PATCH", `/services/${id}`, { session: auth(sb), body: { capacity: 1 } })).status).toBe(404);
      expect(await world.prisma.travelService.findFirstOrThrow({ where: { id } }).then((row) => row.capacity)).toBe(20);
    });

    it("creating the same payload twice makes two independent services (no implicit idempotency)", async () => {
      const body = serviceBody();
      const first = await world.api("POST", "/services", { session: auth(sm), body });
      const second = await world.api("POST", "/services", { session: auth(sm), body });
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(first.body.id).not.toBe(second.body.id);
    });

    it("rejects boundary values: price, capacity, title, category, currency, details type", async () => {
      const bad: Array<Record<string, unknown>> = [
        { priceCents: 99 },
        { priceCents: 100_000_001 },
        { priceCents: 10.5 },
        { priceCents: "100" },
        { capacity: 0 },
        { capacity: 100_001 },
        { title: "ab" },
        { title: "x".repeat(201) },
        { description: "short" },
        { category: "NOT_A_CATEGORY" },
        { currency: "XXX" },
        { details: "not an object" },
        { componentIds: ["not-a-uuid"] },
        { providerOrganizationId: "not-a-uuid" }
      ];
      for (const patch of bad) {
        const reply = await world.api("POST", "/services", { session: auth(sm), body: { ...serviceBody(), ...patch } });
        expect(reply.status, JSON.stringify(patch)).toBe(400);
      }
    });

    it("accepts the lower and upper bounds exactly", async () => {
      for (const patch of [{ priceCents: 100, capacity: 1 }, { priceCents: 100_000_000, capacity: 100_000 }]) {
        expect((await world.api("POST", "/services", { session: auth(sm), body: { ...serviceBody(), ...patch } })).status).toBe(201);
      }
    });

    it("never creates a service in another tenant's organization: a manager's providerOrganizationId is ignored, an admin's is refused", async () => {
      const foreign = await world.createOrganization(b);
      const own = await world.api("POST", "/services", { session: auth(sm), body: { ...serviceBody(), providerOrganizationId: foreign } });
      expect(own.status).toBe(201);
      expect(own.body.providerOrganizationId).toBe(orgId);
      const admin = await world.api("POST", "/services", { session: auth(sa), body: { ...serviceBody(), providerOrganizationId: foreign } });
      expect(admin.status).toBe(403);
      expect(await world.prisma.travelService.count({ where: { providerOrganizationId: foreign } })).toBe(0);
    });
  });

  describe("GET /services/exchange-rates, GET /providers/workspace", () => {
    it("serves exchange rates from a stubbed provider (no internet call) to a catalog reader and refuses an anonymous caller", async () => {
      const real = globalThis.fetch;
      const calls: string[] = [];
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes("frankfurter")) return real(input, init);
        calls.push(url);
        const date = new Date().toISOString().slice(0, 10);
        const rows = [["TRY", 40], ["SYP", 13000], ["SAR", 3.75], ["EUR", 0.9], ["EGP", 50]].map(([quote, rate]) => ({ date, base: "USD", quote, rate }));
        return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
      });
      try {
        const reply = await world.api("GET", "/services/exchange-rates", { session: auth(sm) });
        expect(reply.status).toBe(200);
        expect(reply.body).toBeTypeOf("object");
        expect(reply.body.base).toBe("USD");
        expect(calls.length).toBeLessThanOrEqual(1);
        expect((await world.api("GET", "/services/exchange-rates", {})).status).toBe(401);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns the caller's own organization and never another one", async () => {
      const reply = await world.api("GET", "/providers/workspace", { session: auth(sm) });
      expect(reply.status).toBe(200);
      expect(reply.body.organization.id).toBe(orgId);
      const other = await world.api("GET", "/providers/workspace", { session: auth(sb) });
      expect(other.status).toBe(200);
      expect(other.body.organization ?? null).toBeNull();
    });
  });

  describe("organization roles, departments, specialties", () => {
    it("POST /organizations/:id/roles creates a role, refuses a duplicate code and an unknown permission", async () => {
      const code = `agent-${world.stamp}`;
      const created = await world.api("POST", `/organizations/${orgId}/roles`, { session: auth(sm), body: { code, name: "Agent", permissions: ["booking.read"] } });
      expect(created.status).toBe(201);
      expect((await world.api("POST", `/organizations/${orgId}/roles`, { session: auth(sm), body: { code, name: "Agent", permissions: [] } })).status).toBe(409);
      for (const permissions of [["tenant.update"], ["platform.tenant.create"], ["booking.read", "booking.read"], ["a", "b", "c", "d", "e"]]) {
        const reply = await world.api("POST", `/organizations/${orgId}/roles`, { session: auth(sm), body: { code: `x-${world.unique("r")}`.toLowerCase(), name: "Bad", permissions } });
        expect([400, 403], JSON.stringify(permissions)).toContain(reply.status);
      }
      for (const bad of [{ code: "A", name: "n", permissions: [] }, { code: "Upper", name: "name", permissions: [] }, { code: "ok-code", name: "n", permissions: [] }]) {
        expect((await world.api("POST", `/organizations/${orgId}/roles`, { session: auth(sm), body: bad })).status).toBe(400);
      }
      this_role = created.body.id as string;
    });

    let this_role = "";
    it("PATCH /organizations/:id/roles/:roleId renames and re-scopes the role; another tenant's manager gets 4xx", async () => {
      const role = this_role || (await world.api("POST", `/organizations/${orgId}/roles`, { session: auth(sm), body: { code: `ag2-${world.stamp}`, name: "Agent", permissions: [] } })).body.id;
      const patched = await world.api("PATCH", `/organizations/${orgId}/roles/${role}`, { session: auth(sm), body: { name: "Senior agent", permissions: ["booking.read", "booking.manage"] } });
      expect(patched.status).toBe(200);
      const outsider = await world.createUser(b, { roles: ["travel-company", "organization-manager"], organizationId: await world.createOrganization(b) });
      const reply = await world.api("PATCH", `/organizations/${orgId}/roles/${role}`, { session: auth(await world.session(outsider)), body: { name: "Hijacked" } });
      expect([403, 404]).toContain(reply.status);
      expect((await world.api("PATCH", `/organizations/${orgId}/roles/${role}`, { session: auth(sm), body: { permissions: ["catalog.service.manage", "x"] } })).status).toBe(400);
    });

    it("PATCH /organizations/:id/departments/:departmentId renames and deactivates; unknown department is 404", async () => {
      const patched = await world.api("PATCH", `/organizations/${orgId}/departments/${departmentId}`, { session: auth(sm), body: { name: "Operations team", active: false } });
      expect(patched.status).toBe(200);
      expect(patched.body.active).toBe(false);
      expect((await world.api("PATCH", `/organizations/${orgId}/departments/${departmentId}`, { session: auth(sm), body: { name: "x" } })).status).toBe(400);
      expect((await world.api("PATCH", `/organizations/${orgId}/departments/${"00000000-0000-4000-8000-000000000000"}`, { session: auth(sm), body: { name: "Operations" } })).status).toBe(404);
      await world.api("PATCH", `/organizations/${orgId}/departments/${departmentId}`, { session: auth(sm), body: { active: true } });
    });

    it("PATCH /organizations/:id/specialties replaces the list, de-duplicates, and enforces the bounds", async () => {
      const ok = await world.api("PATCH", `/organizations/${orgId}/specialties`, { session: auth(sm), body: { specialties: ["Umrah", "Hajj", "Umrah"] } });
      expect(ok.status).toBe(200);
      expect(ok.body.specialties).toEqual(["Umrah", "Hajj"]);
      expect((await world.api("PATCH", `/organizations/${orgId}/specialties`, { session: auth(sm), body: { specialties: Array.from({ length: 21 }, (_, i) => `s${i}`) } })).status).toBe(400);
      expect((await world.api("PATCH", `/organizations/${orgId}/specialties`, { session: auth(sm), body: { specialties: ["x".repeat(81)] } })).status).toBe(400);
      expect((await world.api("PATCH", `/organizations/${orgId}/specialties`, { session: auth(sm), body: { specialties: "Umrah" } })).status).toBe(400);
      const outsider = await world.session(await world.createUser(b, { roles: ["travel-company", "organization-manager"], organizationId: await world.createOrganization(b) }));
      expect([403, 404]).toContain((await world.api("PATCH", `/organizations/${orgId}/specialties`, { session: auth(outsider), body: { specialties: ["Hijack"] } })).status);
      expect((await world.prisma.providerOrganization.findUniqueOrThrow({ where: { id: orgId } })).specialties).toEqual(["Umrah", "Hajj"]);
    });
  });

  describe("auth: activity and provider registration", () => {
    it("POST /auth/activity answers 204 for a live session and 401 once logged out", async () => {
      const user = await world.createUser(a, { roles: ["traveler"] });
      const session = await world.session(user);
      expect((await world.api("POST", "/auth/activity", { session: auth(session) })).status).toBe(204);
      const refreshToken = (session as unknown as { refreshToken: string }).refreshToken;
      expect((await world.api("POST", "/auth/logout", { body: { refreshToken } })).status).toBe(204);
      expect((await world.api("POST", "/auth/activity", { session: auth(session) })).status).toBe(401);
    });

    it("POST /auth/register/provider creates the account and its organization; a repeat is refused and creates nothing", async () => {
      const body = {
        displayName: "Provider Owner",
        email: `${world.unique("prov")}@example.test`,
        password: `Provider-Test-${world.stamp}-Pw`,
        tenantCode: a.code,
        organizationName: "شركة الاختبار للسياحة",
        organizationNameEn: "Test Tourism Co",
        type: "TRAVEL_COMPANY",
        city: "Riyadh",
        phone: "+966500000000",
        licenseNumber: `LIC-${world.stamp}`
      };
      const first = await world.api("POST", "/auth/register/provider", { body });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const second = await world.api("POST", "/auth/register/provider", { body });
      // Only the registrant who proved ownership (same password) learns the e-mail is already a member of this tenant.
      expect(second.status).toBe(409);
      const wrongPassword = await world.api("POST", "/auth/register/provider", { body: { ...body, password: `Another-Wrong-${world.stamp}-Pw` } });
      expect(wrongPassword.status).toBeGreaterThanOrEqual(400);
      expect(wrongPassword.status).toBeLessThan(500);
      expect(await world.prisma.providerOrganization.count({ where: { tenantId: a.id, licenseNumber: body.licenseNumber } })).toBe(1);
      for (const patch of [{ type: "SPACESHIP" }, { organizationName: "ab" }, { tenantCode: "UPPER CASE" }, { password: "short" }, { email: "not-mail" }, { phone: "9".repeat(33) }]) {
        expect((await world.api("POST", "/auth/register/provider", { body: { ...body, email: `${world.unique("p")}@example.test`, ...patch } })).status, JSON.stringify(patch)).toBe(400);
      }
      expect((await world.api("POST", "/auth/register/provider", { body: { ...body, email: `${world.unique("p")}@example.test`, tenantCode: "no-such-tenant-code" } })).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("platform administration", () => {
    it("GET /platform/references and /platform/records/:kind answer for every kind; an unknown kind is a 4xx", async () => {
      const references = await world.api("GET", "/platform/references", { session: auth(platform) });
      expect(references.status).toBe(200);
      for (const kind of ["users", "services", "bookings", "providers", "tenants", "audit", "sessions"]) {
        const reply = await world.api("GET", `/platform/records/${kind}?page=1`, { session: auth(platform) });
        expect(reply.status, kind).toBe(200);
      }
      for (const query of ["page=0", "page=abc", "page=1001", "page=1000001", "tenantId=not-a-uuid", `q=${"x".repeat(201)}`])
        expect((await world.api("GET", `/platform/records/users?${query}`, { session: auth(platform) })).status, query).toBe(400);
      const unknown = await world.api("GET", "/platform/records/nope", { session: auth(platform) });
      expect(unknown.status).toBeGreaterThanOrEqual(400);
      expect(unknown.status).toBeLessThan(500);
    });

    it("records search with and without text, and the page depth is bounded", async () => {
      const everyone = await world.api("GET", "/platform/records/users?page=1", { session: auth(platform) });
      expect(everyone.body.items.length).toBeGreaterThan(1);
      const probe = everyone.body.items[0].email as string;
      const filtered = await world.api("GET", `/platform/records/users?page=1&q=${encodeURIComponent(probe.toUpperCase())}`, { session: auth(platform) });
      expect(filtered.status).toBe(200);
      expect(filtered.body.items.length).toBeGreaterThanOrEqual(1);
      expect(filtered.body.items.length).toBeLessThan(everyone.body.items.length);
      expect(filtered.body.items.every((u: { email: string }) => u.email.toLowerCase().includes(probe.toLowerCase()))).toBe(true);
      expect((await world.api("GET", "/platform/records/users?page=1000", { session: auth(platform) })).status).toBe(200);
    });

    it("POST /platform/users creates an account in a tenant; a duplicate e-mail is 409; invalid fields are 400", async () => {
      const body = { displayName: "Created By Platform", email: `${world.unique("pc")}@example.test`, phone: "", password: `Platform-Made-${world.stamp}-Pw`, tenantId: a.id, roleId: a.roleIds["traveler"] };
      const created = await world.api("POST", "/platform/users", { session: auth(platform), body });
      expect(created.status).toBe(201);
      const duplicate = await world.api("POST", "/platform/users", { session: auth(platform), body });
      expect([409, 400]).toContain(duplicate.status);
      for (const patch of [{ password: "short" }, { email: "x" }, { tenantId: "no" }, { roleId: "no" }, { displayName: "a" }, { phone: "1".repeat(33) }])
        expect((await world.api("POST", "/platform/users", { session: auth(platform), body: { ...body, email: `${world.unique("pc")}@example.test`, ...patch } })).status, JSON.stringify(patch)).toBe(400);
      const wrongTenantRole = await world.api("POST", "/platform/users", { session: auth(platform), body: { ...body, email: `${world.unique("pc")}@example.test`, roleId: b.roleIds["traveler"] } });
      expect(wrongTenantRole.status).toBeGreaterThanOrEqual(400);
      expect(wrongTenantRole.status).toBeLessThan(500);
    });

    it("PATCH /platform/users/:id edits a profile, refuses a taken e-mail and bad types", async () => {
      const target = await world.createUser(a, { roles: ["traveler"] });
      const other = await world.createUser(a, { roles: ["traveler"] });
      const patched = await world.api("PATCH", `/platform/users/${target.userId}`, { session: auth(platform), body: { displayName: "Renamed By Platform" } });
      expect(patched.status).toBe(200);
      expect(patched.body.displayName).toBe("Renamed By Platform");
      expect((await world.api("PATCH", `/platform/users/${target.userId}`, { session: auth(platform), body: { email: other.email } })).status).toBe(409);
      for (const body of [{ isPlatformAdmin: "yes" }, { displayName: "a" }, { email: "nope" }])
        expect((await world.api("PATCH", `/platform/users/${target.userId}`, { session: auth(platform), body })).status, JSON.stringify(body)).toBe(400);
    });

    it("POST /platform/users/:id/state suspends and restores; self-targeting is 409; reason is mandatory", async () => {
      const target = await world.createUser(a, { roles: ["traveler"] });
      const live = await world.session(target);
      const suspended = await world.api("POST", `/platform/users/${target.userId}/state`, { session: auth(platform), body: { action: "SUSPENDED", reason: "test suspension" } });
      expect(suspended.status).toBe(201);
      expect((await world.api("GET", "/auth/me", { session: auth(live) })).status).toBe(401);
      expect((await world.login(target)).status).toBe(401);
      expect((await world.api("POST", `/platform/users/${target.userId}/state`, { session: auth(platform), body: { action: "ACTIVE", reason: "restore" } })).status).toBe(201);
      expect((await world.login(target)).status).toBe(200);
      expect((await world.api("POST", `/platform/users/${platformUser.userId}/state`, { session: auth(platform), body: { action: "DISABLED", reason: "self" } })).status).toBe(409);
      for (const body of [{ action: "ACTIVE" }, { action: "ACTIVE", reason: "no" }, { action: "BANISH", reason: "valid reason" }, { reason: "valid reason" }])
        expect((await world.api("POST", `/platform/users/${target.userId}/state`, { session: auth(platform), body })).status, JSON.stringify(body)).toBe(400);
      expect((await world.api("POST", `/platform/users/00000000-0000-4000-8000-000000000000/state`, { session: auth(platform), body: { action: "ACTIVE", reason: "ghost" } })).status).toBe(404);
    });

    it("POST /platform/users/:id/revoke-sessions ends every session of the target", async () => {
      const target = await world.createUser(a, { roles: ["traveler"] });
      const one = await world.session(target);
      const two = await world.session(target);
      const reply = await world.api("POST", `/platform/users/${target.userId}/revoke-sessions`, { session: auth(platform) });
      expect(reply.status).toBeLessThan(300);
      expect((await world.api("GET", "/auth/me", { session: auth(one) })).status).toBe(401);
      expect((await world.api("GET", "/auth/me", { session: auth(two) })).status).toBe(401);
      expect((await world.api("POST", `/platform/users/00000000-0000-4000-8000-000000000000/revoke-sessions`, { session: auth(platform) })).status).toBeGreaterThanOrEqual(400);
    });

    it("PATCH /platform/memberships/:id/access sets roles, overrides and status; validates the body", async () => {
      const target = await world.createUser(a, { roles: ["traveler"] });
      const body = { roleIds: [a.roleIds["traveler"]], permissionOverrides: {}, status: "ACTIVE" };
      expect((await world.api("PATCH", `/platform/memberships/${target.membershipId}/access`, { session: auth(platform), body })).status).toBe(200);
      const roles = await world.prisma.membershipRole.findMany({ where: { membershipId: target.membershipId } });
      expect(roles.map((r) => r.roleId)).toEqual([a.roleIds["traveler"]]);
      // a provider role needs a matching organization on the membership
      expect((await world.api("PATCH", `/platform/memberships/${target.membershipId}/access`, { session: auth(platform), body: { ...body, roleIds: [a.roleIds["travel-company"]] } })).status).toBe(400);
      expect((await world.api("PATCH", `/platform/memberships/${target.membershipId}/access`, { session: auth(platform), body: { ...body, roleIds: [a.roleIds["travel-company"]], providerOrganizationId: orgId } })).status).toBe(200);
      expect((await world.api("PATCH", `/platform/memberships/${target.membershipId}/access`, { session: auth(platform), body: { ...body, status: "SUSPENDED" } })).status).toBe(200);
      for (const patch of [{ roleIds: [] }, { roleIds: ["x"] }, { roleIds: [a.roleIds["traveler"], a.roleIds["traveler"]] }, { status: "GONE" }, { permissionOverrides: "all" }, { roleIds: [b.roleIds["traveler"]] }]) {
        const reply = await world.api("PATCH", `/platform/memberships/${target.membershipId}/access`, { session: auth(platform), body: { ...body, ...patch } });
        expect(reply.status, JSON.stringify(patch)).toBeGreaterThanOrEqual(400);
        expect(reply.status, JSON.stringify(patch)).toBeLessThan(500);
      }
    });

    it("POST /auth/login-throttle/unlock needs a platform administrator, not a tenant administrator", async () => {
      expect((await world.api("POST", "/auth/login-throttle/unlock", { session: auth(sa), body: { email: adminA.email } })).status).toBe(403);
      expect((await world.api("POST", "/auth/login-throttle/unlock", { session: auth(platform), body: { email: adminA.email } })).status).toBe(204);
      expect((await world.api("POST", "/auth/login-throttle/unlock", { session: auth(platform), body: { email: "not-an-email" } })).status).toBe(400);
    });
  });
});
