import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, type SystemRoleCode } from "../dist/modules/identity/access/system-roles.js";
import { World, type RouteInfo, type Session, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Authorization matrix over EVERY route the running app serves.
 *
 * Part A  every route x 8 principals (anonymous, traveler A, provider A, org-manager A, provider of ANOTHER org in A,
 *         tenant-admin A, tenant-admin B, platform admin). The expectation is derived from the route metadata
 *         (public / platform guard / required permissions). "Passed authorization" means the status is neither 401 nor 403.
 *         Any 5xx is a mismatch. Platform routes are also checked for an administrator without MFA (403 mfa_enrollment_required).
 * Part C  guard behaviours that a refactor could silently drop (token revocation, permission combination, status checks).
 * Part B  service-level authorization (the checks that live in services, not guards) with VALID bodies against tenant A
 *         resources, called by principals that must be refused; the database is re-read to prove nothing changed.
 */
type Who = "anon" | "travelerA" | "providerA" | "orgManagerA" | "providerA2" | "adminA" | "adminB" | "platform";
const WHO: Who[] = ["anon", "travelerA", "providerA", "orgManagerA", "providerA2", "adminA", "adminB", "platform"];

describe("authorization matrix", () => {
  let world: World;
  let a: TestTenant;
  let b: TestTenant;
  let routes: RouteInfo[];
  const sessions = {} as Record<Exclude<Who, "anon">, Session>;
  const users = {} as Record<Exclude<Who, "anon">, TestUser>;
  const perms = {} as Record<Who, Set<string>>;
  const roleOf: Record<Exclude<Who, "anon">, SystemRoleCode[]> = {
    travelerA: ["traveler"],
    providerA: ["travel-company"],
    orgManagerA: ["service-provider", "organization-manager"],
    providerA2: ["travel-company"],
    adminA: ["tenant-admin"],
    adminB: ["tenant-admin"],
    platform: ["tenant-admin"]
  };
  let orgA1: string;
  let orgA2: string;
  let orgB1: string;
  let serviceA: string;
  let victim: TestUser;

  const tok = (who: Who): { accessToken: string; tenantId: string } | undefined =>
    who === "anon" ? undefined : { accessToken: sessions[who].accessToken, tenantId: sessions[who].user.tenantId };
  const call = (who: Who, method: string, path: string, body?: unknown) => {
    const session = tok(who);
    return world.api(method, path, { ...(session ? { session } : {}), ...(body === undefined ? {} : { body }) });
  };

  beforeAll(async () => {
    world = await World.start({ METRICS_TOKEN: "matrix-metrics-token-0123456789abcdef", TRUST_PROXY: "true" });
    a = await world.createTenant("az-a");
    b = await world.createTenant("az-b");
    orgA1 = await world.createOrganization(a);
    orgA2 = await world.createOrganization(a);
    orgB1 = await world.createOrganization(b);
    users.travelerA = await world.createUser(a, { roles: roleOf.travelerA });
    users.providerA = await world.createUser(a, { roles: roleOf.providerA, organizationId: orgA1 });
    users.orgManagerA = await world.createUser(a, { roles: roleOf.orgManagerA, organizationId: orgA1 });
    users.providerA2 = await world.createUser(a, { roles: roleOf.providerA2, organizationId: orgA2 });
    users.adminA = await world.createUser(a, { roles: roleOf.adminA });
    users.adminB = await world.createUser(b, { roles: roleOf.adminB });
    users.platform = await world.createUser(b, { roles: roleOf.platform, isPlatformAdmin: true });
    victim = await world.createUser(a, { roles: ["traveler"] });
    for (const who of Object.keys(users) as Exclude<Who, "anon">[]) {
      sessions[who] = await world.session(users[who]);
      perms[who] = new Set(roleOf[who].flatMap((role) => ROLE_PERMISSIONS[role]));
    }
    perms.anon = new Set();
    serviceA = await world.createService(a, users.providerA);
    routes = await world.routes();
    void orgB1;
  });

  afterAll(async () => {
    await world.stop();
  });

  // -------------------------------------------------------------------------------------------------- Part A
  it("A: every route x every principal behaves as the route metadata says, and nothing answers 5xx", async () => {
    const special: Record<string, { platformOnly?: boolean; body?: unknown }> = {
      "POST /api/v1/auth/login-throttle/unlock": { platformOnly: true, body: { email: "nobody@example.test" } }
    };
    const fill = (route: RouteInfo): string =>
      route.path.replace(/^\/api\/v1/, "").replace(/:(\w+)/g, (_m, param: string) => (param === "kind" ? "users" : randomUUID()));
    const ordered = [...routes].sort((x, y) => Number(x.path.endsWith("/logout-all")) - Number(y.path.endsWith("/logout-all")));
    const rows: Array<Record<string, unknown>> = [];
    const mismatches: string[] = [];
    for (const route of ordered) {
      const key = `${route.method} ${route.path}`;
      const sp = special[key];
      const observed: Record<string, number> = {};
      const expected: Record<string, boolean | "public"> = {};
      for (const who of WHO) {
        const body = sp?.body ?? (route.hasBody ? {} : undefined);
        const reply = await call(who, route.method, fill(route), body);
        observed[who] = reply.status;
        const exp: boolean | "public" = route.public
          ? "public"
          : who === "anon"
            ? false
            : sp?.platformOnly || route.platformGuard
              ? who === "platform"
              : [...route.permissions].every((code) => perms[who].has(code));
        expected[who] = exp;
        const passed = reply.status !== 401 && reply.status !== 403;
        if (reply.status >= 500) mismatches.push(`${key} as ${who}: ${reply.status} (5xx)`);
        else if (exp === "public") {
          if (reply.status === 403) mismatches.push(`${key} as ${who}: public route answered 403`);
        } else if (exp !== passed) mismatches.push(`${key} as ${who}: expected ${exp ? "pass" : "deny"}, observed ${reply.status}`);
      }
      rows.push({ route: key, public: route.public, platformGuard: route.platformGuard, permissions: route.permissions, expected, observed });
    }
    expect(rows.length).toBe(routes.length);
    expect(mismatches).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------------- Part C
  describe("C: guard behaviours", () => {
    beforeAll(async () => {
      for (const who of Object.keys(users) as Exclude<Who, "anon">[]) sessions[who] = await world.session(users[who]);
    });
    const bearer = (session: Session): { accessToken: string; tenantId: string } => ({ accessToken: session.accessToken, tenantId: session.user.tenantId });

    it("platform routes: an administrator without MFA gets 403 mfa_enrollment_required, an enrolled one is allowed", async () => {
      const bare = await world.createUser(b, { roles: ["tenant-admin"], isPlatformAdmin: true, mfa: false });
      const bareSession = bearer(await world.session(bare));
      const platformRoutes = routes.filter((route) => route.platformGuard && route.method === "GET" && !route.path.includes(":"));
      expect(platformRoutes.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const route of platformRoutes) {
        const path = route.path.replace(/^\/api\/v1/, "");
        const denied = await world.api("GET", path, { session: bareSession });
        if (denied.status !== 403 || denied.body?.code !== "mfa_enrollment_required") failures.push(`no-MFA ${path} -> ${denied.status} ${String(denied.body?.code)}`);
        const allowed = await world.api("GET", path, { session: bearer(sessions.platform) });
        if (allowed.status === 401 || allowed.status === 403 || allowed.status >= 500) failures.push(`enrolled ${path} -> ${allowed.status}`);
      }
      expect(failures).toEqual([]);
    });

    it("no GET response (admin of A, platform admin, traveler, org manager) contains credential material", async () => {
      const forbidden = /passwordHash|mfaSecretEnc|mfaRecoveryHashes|tokenHash|"password"|mfaChallengeHash|secretEnc/;
      const found: string[] = [];
      const paths = ["/auth/me", "/auth/mfa", "/auth/sessions", "/users/me", "/tenants/current", "/tenants/members", "/providers", "/providers/workspace", "/roles", "/permissions", "/services", "/services/marketplace", "/bookings", "/access/audit", "/platform/overview", "/platform/references", "/platform/tenants",
        ...["users", "services", "bookings", "providers", "tenants", "audit", "sessions"].map((k) => `/platform/records/${k}`), `/tenants/members/${users.travelerA.membershipId}/history`, `/organizations/${orgA1}/management`];
      for (const who of ["adminA", "platform", "travelerA", "orgManagerA"] as Who[])
        for (const path of paths) {
          const reply = await call(who, "GET", path);
          if (reply.status >= 500) found.push(`${who} GET ${path} -> ${reply.status}`);
          if (forbidden.test(JSON.stringify(reply.body ?? ""))) found.push(`${who} GET ${path} exposes credential field`);
        }
      expect(found).toEqual([]);
    });

    it("a suspended organization's manager cannot edit the provider record (the tenant admin still can)", async () => {
      const org = await world.createOrganization(a);
      const manager = await world.createUser(a, { roles: ["service-provider", "organization-manager"], organizationId: org });
      const m = bearer(await world.session(manager));
      expect((await call("adminA", "PATCH", `/providers/${org}/status`, { status: "SUSPENDED" })).status).toBe(200);
      const refused = await world.api("PATCH", `/providers/${org}`, { session: m, body: { licenseNumber: "CHANGED-WHILE-SUSPENDED" } });
      expect(refused.status).toBe(403);
      expect((await world.prisma.providerOrganization.findUniqueOrThrow({ where: { id: org } })).licenseNumber).not.toBe("CHANGED-WHILE-SUSPENDED");
      const byAdmin = await call("adminA", "PATCH", `/providers/${org}`, { licenseNumber: "ADMIN-EDIT-1" });
      expect(byAdmin.status).toBe(200);
      expect((await call("adminA", "PATCH", `/providers/${org}/status`, { status: "ACTIVE" })).status).toBe(200);
      const after = await world.api("PATCH", `/providers/${org}`, { session: m, body: { licenseNumber: "MANAGER-EDIT-2" } });
      expect(after.status).toBe(200);
    });

    it("an access token stops working when the membership is suspended, the user disabled, the tenant suspended or the platform flag removed", async () => {
      const m1 = await world.createUser(a, { roles: ["traveler"] });
      const own = bearer(await world.session(m1));
      expect((await world.api("GET", "/bookings", { session: own })).status).toBe(200);
      expect((await call("adminA", "PATCH", `/tenants/members/${m1.membershipId}/status`, { status: "SUSPENDED", reason: "matrix test" })).status).toBe(200);
      expect((await world.api("GET", "/bookings", { session: own })).status).toBe(401);

      const m2 = await world.createUser(a, { roles: ["traveler"] });
      const own2 = bearer(await world.session(m2));
      await world.prisma.user.update({ where: { id: m2.userId }, data: { status: "DISABLED" } });
      expect((await world.api("GET", "/bookings", { session: own2 })).status).toBe(401);

      const c = await world.createTenant("az-c");
      const m3 = await world.createUser(c, { roles: ["traveler"] });
      const own3 = bearer(await world.session(m3));
      expect((await call("platform", "POST", `/platform/tenants/${c.id}/status`, { status: "SUSPENDED", reason: "matrix test" })).status).toBeLessThan(300);
      expect((await world.api("GET", "/bookings", { session: own3 })).status).toBe(401);

      const m4 = await world.createUser(a, { roles: ["tenant-admin"], isPlatformAdmin: true });
      const own4 = bearer(await world.session(m4));
      expect((await world.api("GET", "/platform/overview", { session: own4 })).status).toBe(200);
      await world.prisma.user.update({ where: { id: m4.userId }, data: { isPlatformAdmin: false } });
      expect((await world.api("GET", "/platform/overview", { session: own4 })).status).toBe(403);
    });

    it("a token is rejected once its tenant is suspended even when its sessions were NOT revoked (tenant status is checked on every request)", async () => {
      const t = await world.createTenant("az-d");
      const user = await world.createUser(t, { roles: ["traveler"] });
      const own = bearer(await world.session(user));
      // Suspend at the database level: nothing revokes the refresh session or bumps the token version.
      await world.prisma.tenant.update({ where: { id: t.id }, data: { status: "SUSPENDED" } });
      const revoked = await world.prisma.refreshSession.count({ where: { userId: user.userId, tenantId: t.id, revokedAt: { not: null } } });
      expect(revoked).toBe(0);
      expect((await world.api("GET", "/bookings", { session: own })).status).toBe(401);
      await world.prisma.tenant.update({ where: { id: t.id }, data: { status: "ACTIVE" } });
      expect((await world.api("GET", "/bookings", { session: bearer(await world.session(user)) })).status).toBe(200);
    });

    it("a custom role holding only ONE of two required permissions is refused (identity.user.read + audit.read on member history)", async () => {
      const role = await world.prisma.role.create({ data: { tenantId: a.id, code: "half-access", name: "Half", isSystem: false } });
      const perm = await world.prisma.permission.findUniqueOrThrow({ where: { code: "identity.user.read" } });
      await world.prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      const half = await world.createUser(a, { roles: [] });
      await world.prisma.membershipRole.create({ data: { tenantId: a.id, membershipId: half.membershipId, roleId: role.id } });
      const own = bearer(await world.session(half));
      const members = await world.api("GET", "/tenants/members", { session: own });
      const history = await world.api("GET", `/tenants/members/${users.travelerA.membershipId}/history`, { session: own });
      expect(members.status).toBe(200);
      expect(history.status).toBe(403);
    });

    it("an access token dies when the password is reset (auth version) and when logout-all runs", async () => {
      const u = await world.createUser(a, { roles: ["traveler"] });
      const own = bearer(await world.session(u));
      expect((await world.api("GET", "/auth/me", { session: own })).status).toBe(200);
      await world.prisma.user.update({ where: { id: u.userId }, data: { authVersion: { increment: 1 } } });
      expect((await world.api("GET", "/auth/me", { session: own })).status).toBe(401);
      const u2 = await world.createUser(a, { roles: ["traveler"] });
      const own2 = bearer(await world.session(u2));
      expect((await world.api("POST", "/auth/logout-all", { session: own2 })).status).toBeLessThan(300);
      expect((await world.api("GET", "/auth/me", { session: own2 })).status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------------------------------- Part B
  describe("B: service-level authorization with valid bodies against tenant A resources", () => {
    beforeAll(async () => {
      // Part A ends with POST /auth/logout-all for every principal, which revokes their sessions: sign in again.
      for (const who of Object.keys(users) as Exclude<Who, "anon">[]) sessions[who] = await world.session(users[who]);
    });
    const refused = (status: number): boolean => status === 403 || status === 404 || status === 401;
    const outsiders = (...allowed: Who[]): Who[] => WHO.filter((who) => !allowed.includes(who));

    it("bookings: only the owner, the owning provider/org and the tenant admin can read/cancel/confirm/edit; others get 403/404 and the row is unchanged", async () => {
      const created = await call("travelerA", "POST", "/bookings", { serviceId: serviceA, travelersCount: 1, serviceDate: world.futureDate() });
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      const failures: string[] = [];
      for (const who of outsiders("travelerA", "providerA", "orgManagerA", "adminA")) {
        for (const [method, path, body] of [
          ["PATCH", `/bookings/${id}/status`, { status: "CANCELLED" }],
          ["PATCH", `/bookings/${id}/status`, { status: "CONFIRMED" }],
          ["PATCH", `/bookings/${id}`, { travelersCount: 3 }]
        ] as const) {
          const reply = await call(who, method, path, body);
          if (!refused(reply.status)) failures.push(`${who} ${method} ${path} ${JSON.stringify(body)} -> ${reply.status}`);
        }
      }
      // a second traveler in the same tenant (victim) must not see or touch it either
      const other = await world.session(victim);
      const o = { accessToken: other.accessToken, tenantId: other.user.tenantId };
      for (const [method, path, body] of [
        ["PATCH", `/bookings/${id}/status`, { status: "CANCELLED" }],
        ["PATCH", `/bookings/${id}`, { travelersCount: 3 }]
      ] as const) {
        const reply = await world.api(method, path, { session: o, body });
        if (!refused(reply.status)) failures.push(`travelerA2 ${method} ${path} -> ${reply.status}`);
      }
      const list = await world.api("GET", "/bookings", { session: o });
      if (JSON.stringify(list.body).includes(id)) failures.push("travelerA2 can list traveler A's booking");
      const row = await world.prisma.booking.findUniqueOrThrow({ where: { id } });
      if (row.status !== "PENDING" || row.travelersCount !== 1) failures.push(`booking changed: ${row.status}/${row.travelersCount}`);
      // the traveler may not confirm their own booking
      const self = await call("travelerA", "PATCH", `/bookings/${id}/status`, { status: "CONFIRMED" });
      if (self.status !== 403 && self.status !== 404) failures.push(`traveler confirmed own booking -> ${self.status}`);
      const ok = await call("providerA", "PATCH", `/bookings/${id}/status`, { status: "CONFIRMED" });
      if (ok.status !== 200) failures.push(`owning provider could not confirm: ${ok.status}`);
      expect(failures).toEqual([]);
    });

    it("services: provider of another org, traveler, tenant admin of another tenant cannot edit tenant A's service; and cannot create into org A1", async () => {
      const failures: string[] = [];
      for (const who of outsiders("providerA", "orgManagerA", "adminA")) {
        const reply = await call(who, "PATCH", `/services/${serviceA}`, { title: "hijacked title" });
        if (!refused(reply.status)) failures.push(`${who} PATCH service -> ${reply.status}`);
      }
      for (const who of ["providerA2", "adminB", "travelerA"] as Who[]) {
        const reply = await call(who, "POST", "/services", {
          title: "cross-org service", description: "cross-org service description", category: "PACKAGE", city: "Makkah",
          priceCents: 100000, capacity: 5, details: { durationDays: "3", departureCity: "Riyadh", itinerary: "x" }, providerOrganizationId: orgA1
        });
        if (reply.status === 201 && reply.body.providerOrganizationId === orgA1) failures.push(`${who} created a service in org A1`);
      }
      const row = await world.prisma.travelService.findUniqueOrThrow({ where: { id: serviceA } });
      if (row.title === "hijacked title") failures.push("service title changed");
      const made = await world.prisma.travelService.findMany({ where: { title: "cross-org service", providerOrganizationId: orgA1 }, select: { id: true } });
      if (made.length) failures.push(`rows created in org A1: ${made.length}`);
      expect(failures).toEqual([]);
    });

    it("providers: other tenants/orgs cannot edit or suspend org A1", async () => {
      const failures: string[] = [];
      for (const who of outsiders("adminA", "orgManagerA")) {
        const reply = await call(who, "PATCH", `/providers/${orgA1}`, { nameAr: "اسم مخترق", nameEn: "Hacked" });
        if (!refused(reply.status)) failures.push(`${who} PATCH provider -> ${reply.status}`);
      }
      for (const who of outsiders("adminA")) {
        const reply = await call(who, "PATCH", `/providers/${orgA1}/status`, { status: "SUSPENDED" });
        if (!refused(reply.status)) failures.push(`${who} PATCH provider status -> ${reply.status}`);
      }
      const row = await world.prisma.providerOrganization.findUniqueOrThrow({ where: { id: orgA1 } });
      if (row.status !== "ACTIVE" || row.nameEn === "Hacked") failures.push(`org changed: ${row.status}/${row.nameEn}`);
      expect(failures).toEqual([]);
    });

    it("roles: only tenant admin A can edit/delete A's custom roles or assign roles to A's members; B's admin cannot, even with A's ids", async () => {
      const role = await world.prisma.role.create({ data: { tenantId: a.id, code: "custom-role", name: "Custom role", isSystem: false } });
      const failures: string[] = [];
      for (const who of outsiders("adminA")) {
        for (const [method, path, body] of [
          ["PATCH", `/roles/${role.id}`, { name: "renamed" }],
          ["DELETE", `/roles/${role.id}`, undefined],
          ["PUT", `/memberships/${users.travelerA.membershipId}/roles`, { roleIds: [a.roleIds["tenant-admin"]] }]
        ] as const) {
          const reply = await call(who, method, path, body);
          if (!refused(reply.status)) failures.push(`${who} ${method} ${path} -> ${reply.status}`);
        }
      }
      // B's tenant admin assigning A's role id to B's own member (cross-tenant role reference)
      const bm = users.adminB.membershipId;
      const cross = await call("adminB", "PUT", `/memberships/${bm}/roles`, { roleIds: [a.roleIds["tenant-admin"]] });
      if (cross.status === 200) failures.push("adminB assigned a tenant A role to a tenant B member");
      const stillThere = await world.prisma.role.findUnique({ where: { id: role.id } });
      if (!stillThere || stillThere.name !== "Custom role") failures.push("custom role changed or deleted");
      const bRoles = await world.prisma.membershipRole.count({ where: { membershipId: bm, roleId: a.roleIds["tenant-admin"] } });
      if (bRoles !== 0) failures.push("cross-tenant role row exists");
      expect(failures).toEqual([]);
    });

    it("members and tenant settings: non-admins and other tenants cannot suspend A's members or edit A's tenant", async () => {
      const failures: string[] = [];
      for (const who of outsiders("adminA")) {
        for (const [method, path, body] of [
          ["PATCH", `/tenants/members/${victim.membershipId}/status`, { status: "SUSPENDED", reason: "matrix test" }],
          ["GET", `/tenants/members/${victim.membershipId}/history`, undefined]
        ] as const) {
          const reply = await call(who, method, path, body);
          if (!refused(reply.status)) failures.push(`${who} ${method} ${path} -> ${reply.status}`);
        }
      }
      for (const who of ["travelerA", "providerA", "orgManagerA", "providerA2"] as Who[]) {
        const reply = await call(who, "PATCH", "/tenants/current", { name: "Hijacked tenant name" });
        if (!refused(reply.status)) failures.push(`${who} PATCH tenants/current -> ${reply.status}`);
      }
      const tenant = await world.prisma.tenant.findUniqueOrThrow({ where: { id: a.id } });
      if (tenant.name === "Hijacked tenant name") failures.push("tenant A renamed");
      const member = await world.prisma.tenantMembership.findUniqueOrThrow({ where: { id: victim.membershipId } });
      if (member.status !== "ACTIVE") failures.push(`victim membership status ${member.status}`);
      // adminB's PATCH /tenants/current must change B only
      await call("adminB", "PATCH", "/tenants/current", { name: "B renamed by B" });
      const tenantA = await world.prisma.tenant.findUniqueOrThrow({ where: { id: a.id } });
      if (tenantA.name === "B renamed by B") failures.push("adminB changed tenant A");
      expect(failures).toEqual([]);
    });

    it("organizations: a manager/provider of org A2 and tenant B's admin cannot read or change org A1 (departments, roles, employees, specialties)", async () => {
      const mgrA2 = await world.createUser(a, { roles: ["service-provider", "organization-manager"], organizationId: orgA2 });
      const mgrA2Session = await world.session(mgrA2);
      const m = { accessToken: mgrA2Session.accessToken, tenantId: mgrA2Session.user.tenantId };
      const dep = await call("orgManagerA", "POST", `/organizations/${orgA1}/departments`, { code: "ops", name: "Operations" });
      expect(dep.status).toBe(201);
      const failures: string[] = [];
      const attempts: Array<[string, string, unknown]> = [
        ["GET", `/organizations/${orgA1}/management`, undefined],
        ["PATCH", `/organizations/${orgA1}/specialties`, { specialties: ["x"] }],
        ["POST", `/organizations/${orgA1}/departments`, { code: "intruder", name: "Intruder" }],
        ["PATCH", `/organizations/${orgA1}/departments/${dep.body.id}`, { name: "Renamed" }],
        ["POST", `/organizations/${orgA1}/roles`, { code: "intruder", name: "Intruder", permissions: ["booking.read"] }],
        ["POST", `/organizations/${orgA1}/employees`, { email: `${randomUUID()}@example.test`, displayName: "Intruder", password: "Correct-Horse-Battery-9", jobTitle: "Intruder", departmentId: dep.body.id, roleIds: [] }],
        ["PATCH", `/organizations/${orgA1}/employees/${users.providerA.membershipId}`, { jobTitle: "Intruder" }]
      ];
      for (const [method, path, body] of attempts) {
        const replies = [
          ["orgManagerA2", await world.api(method, path, { session: m, ...(body === undefined ? {} : { body }) })] as const,
          ...(await Promise.all(
            (["providerA2", "travelerA", "adminB"] as Who[]).map(async (who) => [who, await call(who, method, path, body)] as const)
          ))
        ];
        for (const [who, reply] of replies) if (!refused(reply.status)) failures.push(`${who} ${method} ${path} -> ${reply.status}`);
      }
      const depRow = await world.prisma.organizationDepartment.findUniqueOrThrow({ where: { id: dep.body.id } });
      if (depRow.name !== "Operations") failures.push("department renamed");
      expect(await world.prisma.organizationDepartment.count({ where: { code: "intruder" } })).toBe(0);
      expect(await world.prisma.tenantMembership.count({ where: { jobTitle: "Intruder" } })).toBe(0);
      expect(failures).toEqual([]);
    });

    it("sessions: nobody can list or revoke another user's refresh session", async () => {
      const second = await world.login(users.travelerA);
      expect(second.status).toBe(200);
      const own = await call("travelerA", "GET", "/auth/sessions");
      const target = (own.body as Array<{ id: string }>)[0]!.id;
      const failures: string[] = [];
      for (const who of outsiders("travelerA")) {
        const reply = await call(who, "DELETE", `/auth/sessions/${target}`);
        if (!refused(reply.status) && reply.status !== 204) failures.push(`${who} DELETE session -> ${reply.status}`);
        if (reply.status === 204) failures.push(`${who} revoked another user's session (204)`);
      }
      const rows = await world.prisma.refreshSession.findMany({ where: { familyId: target } });
      if (rows.length === 0 || rows.some((row) => row.revokedAt)) failures.push("session family got revoked");
      expect(failures).toEqual([]);
    });

    it("invitations: another identity cannot accept or decline an invitation addressed to someone else", async () => {
      const email = `${world.unique("invitee")}@example.test`;
      const invitee = await world.createUser(b, { roles: ["traveler"], email });
      const invited = await world.link(a, invitee.userId, email, invitee.password, { roles: ["traveler"] });
      await world.prisma.tenantMembership.update({ where: { id: invited.membershipId }, data: { status: "INVITED", awaitingOwnerConsent: true } });
      const failures: string[] = [];
      for (const who of ["travelerA", "adminA", "adminB", "providerA"] as Who[])
        for (const verb of ["accept", "decline"]) {
          const reply = await call(who, "POST", `/users/me/invitations/${invited.membershipId}/${verb}`);
          if (!refused(reply.status) && reply.status !== 400) failures.push(`${who} ${verb} -> ${reply.status}`);
          if (reply.status === 200 || reply.status === 201 || reply.status === 204) failures.push(`${who} ${verb} succeeded -> ${reply.status}`);
        }
      const row = await world.prisma.tenantMembership.findUniqueOrThrow({ where: { id: invited.membershipId } });
      if (row.status !== "INVITED") failures.push(`invitation status ${row.status}`);
      expect(failures).toEqual([]);
    });

    it("platform operations: tenant admins (A and B), providers and travelers get 403 on every mutating platform route with a valid body; nothing changes", async () => {
      const failures: string[] = [];
      const targets: Array<[string, string, unknown]> = [
        ["POST", "/platform/users", { displayName: "Intruder", email: `${randomUUID()}@example.test`, phone: "", password: "Correct-Horse-Battery-9", tenantId: a.id, roleId: a.roleIds["tenant-admin"] }],
        ["PATCH", `/platform/users/${victim.userId}`, { isPlatformAdmin: true, currentPassword: "x" }],
        ["POST", `/platform/users/${victim.userId}/state`, { action: "SUSPENDED", reason: "matrix test" }],
        ["POST", `/platform/users/${victim.userId}/revoke-sessions`, undefined],
        ["PATCH", `/platform/memberships/${victim.membershipId}/access`, { roleIds: [a.roleIds["tenant-admin"]], permissionOverrides: {}, status: "ACTIVE" }],
        ["POST", "/platform/tenants", { code: `intruder-${world.stamp}`, name: "Intruder tenant" }],
        ["POST", `/platform/tenants/${a.id}/status`, { status: "SUSPENDED", reason: "matrix test" }],
        ["POST", "/auth/login-throttle/unlock", { email: victim.email }],
        ["GET", "/platform/records/users", undefined],
        ["GET", `/platform/tenants/${a.id}/activity`, undefined]
      ];
      for (const who of ["travelerA", "providerA", "orgManagerA", "providerA2", "adminA", "adminB"] as Who[])
        for (const [method, path, body] of targets) {
          const reply = await call(who, method, path, body);
          if (reply.status !== 403) failures.push(`${who} ${method} ${path} -> ${reply.status}`);
        }
      const user = await world.prisma.user.findUniqueOrThrow({ where: { id: victim.userId } });
      if (user.isPlatformAdmin || user.status !== "ACTIVE") failures.push("victim user changed");
      const tenant = await world.prisma.tenant.findUniqueOrThrow({ where: { id: a.id } });
      if (tenant.status !== "ACTIVE") failures.push(`tenant status ${tenant.status}`);
      expect(await world.prisma.tenant.count({ where: { code: `intruder-${world.stamp}` } })).toBe(0);
      expect(failures).toEqual([]);
    });

    it("cross-tenant references in request bodies are refused: booking another tenant's service, listing it, reading it", async () => {
      const failures: string[] = [];
      const book = await call("adminB", "POST", "/bookings", { serviceId: serviceA, travelersCount: 1, serviceDate: world.futureDate() });
      if (book.status === 201) failures.push("adminB booked tenant A's service");
      const travelerB = await world.createUser(b, { roles: ["traveler"] });
      const sb = await world.session(travelerB);
      const booked = await world.api("POST", "/bookings", { session: { accessToken: sb.accessToken, tenantId: sb.user.tenantId }, body: { serviceId: serviceA, travelersCount: 1, serviceDate: world.futureDate() } });
      if (booked.status === 201) failures.push("traveler B booked tenant A's service");
      for (const path of ["/services", "/services/marketplace", "/providers", "/bookings"]) {
        const reply = await world.api("GET", path, { session: { accessToken: sb.accessToken, tenantId: sb.user.tenantId } });
        if (JSON.stringify(reply.body).includes(serviceA) || JSON.stringify(reply.body).includes(orgA1)) failures.push(`traveler B sees tenant A data at GET ${path}`);
      }
      // x-tenant-id forgery with a valid B token
      const forged = await world.api("GET", "/services", { session: { accessToken: sb.accessToken, tenantId: a.id } });
      if (forged.status === 200 && JSON.stringify(forged.body).includes(serviceA)) failures.push("x-tenant-id forgery exposed tenant A");
      expect(failures).toEqual([]);
    });
  });
});
