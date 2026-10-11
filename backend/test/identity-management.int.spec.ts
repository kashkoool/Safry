import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Session, type TestTenant, type TestUser } from "./support/world.js";

/** users, roles & permissions, tenant management. */
describe("identity management", () => {
  let world: World;
  let tenant: TestTenant;
  let admin: TestUser;
  let adminSession: Session;

  const auth = (session: Pick<Session, "accessToken" | "user">): { accessToken: string; tenantId: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user.tenantId
  });
  const actions = async (where: object): Promise<string[]> =>
    (await world.prisma.auditEvent.findMany({ where, orderBy: { occurredAt: "asc" }, select: { action: true } })).map((event) => event.action);
  const activeSessions = (membershipId: string): Promise<number> =>
    world.prisma.refreshSession.count({ where: { membershipId, revokedAt: null } });

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("idm");
    admin = await world.createUser(tenant, { roles: ["tenant-admin"] });
    adminSession = await world.session(admin);
  });

  afterAll(async () => {
    await world.stop();
  });

  describe("roles and permissions", () => {
    let customRoleId: string;

    it("lists system roles and tenant-grantable permissions only to role managers", async () => {
      const roles = await world.api("GET", "/roles", { session: auth(adminSession) });
      expect(roles.status).toBe(200);
      const codes = (roles.body as Array<{ code: string; isSystem: boolean }>).map((role) => role.code);
      expect(codes).toEqual(expect.arrayContaining(["tenant-admin", "traveler", "service-provider"]));
      const permissions = await world.api("GET", "/permissions", { session: auth(adminSession) });
      const permissionCodes = (permissions.body as Array<{ code: string }>).map((permission) => permission.code);
      expect(permissionCodes).toContain("booking.read");
      expect(permissionCodes.some((code) => code.startsWith("platform."))).toBe(false);

      const traveler = await world.createUser(tenant, { roles: ["traveler"] });
      const travelerSession = await world.session(traveler);
      expect((await world.api("GET", "/roles", { session: auth(travelerSession) })).status).toBe(403);
      expect((await world.api("POST", "/roles", { session: auth(travelerSession), body: {} })).status).toBe(403);
    });

    it("creates a custom role and audits it", async () => {
      const created = await world.api("POST", "/roles", {
        session: auth(adminSession),
        body: { code: "support-agent", name: "Support agent", permissions: ["catalog.service.read", "booking.read"] }
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ code: "support-agent", isSystem: false, members: 0, permissions: ["booking.read", "catalog.service.read"] });
      customRoleId = created.body.id as string;
      expect(await actions({ tenantId: tenant.id, entityId: customRoleId })).toContain("identity.role.create");
    });

    it("rejects invalid role definitions", async () => {
      const post = (body: object): Promise<{ status: number }> => world.api("POST", "/roles", { session: auth(adminSession), body });
      expect((await post({ code: "support-agent", name: "Again", permissions: [] })).status).toBe(409);
      expect((await post({ code: "traveler", name: "Reserved", permissions: [] })).status).toBe(409);
      expect((await post({ code: "org-anything", name: "Reserved", permissions: [] })).status).toBe(409);
      expect((await post({ code: "bad-perm", name: "Bad", permissions: ["does.not.exist"] })).status).toBe(400);
      expect((await post({ code: "Bad Code", name: "Bad", permissions: [] })).status).toBe(400);
      expect((await post({ code: "platform-role", name: "Platform", permissions: ["platform.tenant.create"] })).status).toBe(403);
    });

    it("stops a role manager from granting permissions they do not hold", async () => {
      const limited = await world.api("POST", "/roles", {
        session: auth(adminSession),
        body: { code: "role-keeper", name: "Role keeper", permissions: ["identity.role.manage", "audit.read"] }
      });
      const keeper = await world.createUser(tenant, { roles: ["traveler"] });
      const assigned = await world.api("PUT", `/memberships/${keeper.membershipId}/roles`, {
        session: auth(adminSession),
        body: { roleIds: [limited.body.id] }
      });
      expect(assigned.status).toBe(200);
      const keeperSession = await world.session(keeper);
      const escalate = await world.api("POST", "/roles", {
        session: auth(keeperSession),
        body: { code: "sneaky", name: "Sneaky", permissions: ["booking.manage"] }
      });
      expect(escalate.status).toBe(403);
      const allowed = await world.api("POST", "/roles", {
        session: auth(keeperSession),
        body: { code: "auditor", name: "Auditor", permissions: ["audit.read"] }
      });
      expect(allowed.status).toBe(201);
      const adminRole = tenant.roleIds["tenant-admin"]!;
      const grantAdmin = await world.api("PUT", `/memberships/${admin.membershipId}/roles`, {
        session: auth(keeperSession),
        body: { roleIds: [adminRole] }
      });
      expect(grantAdmin.status).toBe(403);
      const other = await world.createUser(tenant, { roles: ["traveler"] });
      const grantOver = await world.api("PUT", `/memberships/${other.membershipId}/roles`, {
        session: auth(keeperSession),
        body: { roleIds: [adminRole] }
      });
      expect(grantOver.status).toBe(403);
    });

    it("assigns roles, ends the member's sessions and records before/after", async () => {
      const member = await world.createUser(tenant, { roles: ["traveler"] });
      await world.session(member);
      expect(await activeSessions(member.membershipId)).toBeGreaterThan(0);
      const assigned = await world.api("PUT", `/memberships/${member.membershipId}/roles`, {
        session: auth(adminSession),
        body: { roleIds: [customRoleId] }
      });
      expect(assigned.status).toBe(200);
      expect(assigned.body.roles).toHaveLength(1);
      expect(await activeSessions(member.membershipId)).toBe(0);
      const event = await world.prisma.auditEvent.findFirstOrThrow({
        where: { entityId: member.membershipId, action: "identity.membership.roles.update" }
      });
      expect(event.metadata).toMatchObject({ before: ["traveler"], after: ["support-agent"] });
      const relogin = await world.session(member);
      expect(relogin.user.roles).toEqual(["support-agent"]);
      expect(relogin.user.permissions).toEqual(["booking.read", "catalog.service.read"]);
    });

    it("rejects invalid assignments", async () => {
      const member = await world.createUser(tenant, { roles: ["traveler"] });
      const put = (id: string, body: object): Promise<{ status: number }> =>
        world.api("PUT", `/memberships/${id}/roles`, { session: auth(adminSession), body });
      expect((await put(member.membershipId, { roleIds: [] })).status).toBe(400);
      expect((await put(member.membershipId, { roleIds: ["not-a-uuid"] })).status).toBe(400);
      expect((await put(admin.membershipId, { roleIds: [customRoleId] })).status).toBe(409);
      expect((await put("00000000-0000-4000-8000-000000000000", { roleIds: [customRoleId] })).status).toBe(404);
      const platform = await world.createUser(tenant, { roles: ["traveler"], isPlatformAdmin: true });
      expect((await put(platform.membershipId, { roleIds: [customRoleId] })).status).toBe(403);
      // A company role needs a matching organization.
      expect((await put(member.membershipId, { roleIds: [tenant.roleIds["travel-company"]] })).status).toBe(400);
      const foreign = await world.createTenant("idm-foreign");
      expect((await put(member.membershipId, { roleIds: [foreign.roleIds["traveler"]] })).status).toBe(400);
    });

    it("updates a role's permissions, ends holders' sessions and audits the change", async () => {
      const holder = await world.createUser(tenant, { roles: ["traveler"] });
      await world.api("PUT", `/memberships/${holder.membershipId}/roles`, { session: auth(adminSession), body: { roleIds: [customRoleId] } });
      await world.session(holder);
      const updated = await world.api("PATCH", `/roles/${customRoleId}`, {
        session: auth(adminSession),
        body: { name: "Senior support", permissions: ["booking.read"] }
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: "Senior support", permissions: ["booking.read"] });
      expect(await activeSessions(holder.membershipId)).toBe(0);
      const event = await world.prisma.auditEvent.findFirstOrThrow({ where: { entityId: customRoleId, action: "identity.role.update" } });
      expect(event.metadata).toMatchObject({
        before: { name: "Support agent", permissions: ["booking.read", "catalog.service.read"] },
        after: { name: "Senior support", permissions: ["booking.read"] }
      });
    });

    it("protects system roles and roles that are still assigned", async () => {
      const system = await world.api("PATCH", `/roles/${tenant.roleIds["traveler"]}`, { session: auth(adminSession), body: { name: "Hacked" } });
      expect(system.status).toBe(403);
      expect((await world.api("DELETE", `/roles/${tenant.roleIds["traveler"]}`, { session: auth(adminSession) })).status).toBe(403);
      expect((await world.api("DELETE", `/roles/${customRoleId}`, { session: auth(adminSession) })).status).toBe(409);
      const spare = await world.api("POST", "/roles", { session: auth(adminSession), body: { code: "spare", name: "Spare", permissions: [] } });
      expect((await world.api("DELETE", `/roles/${spare.body.id}`, { session: auth(adminSession) })).status).toBe(204);
      expect(await actions({ entityId: spare.body.id })).toEqual(["identity.role.create", "identity.role.delete"]);
    });

    it("exposes the permission-change audit trail to audit readers", async () => {
      const trail = await world.api("GET", "/access/audit", { session: auth(adminSession) });
      expect(trail.status).toBe(200);
      const names = (trail.body as Array<{ action: string }>).map((event) => event.action);
      expect(names).toEqual(expect.arrayContaining(["identity.role.create", "identity.role.update", "identity.membership.roles.update"]));
      const traveler = await world.session(await world.createUser(tenant, { roles: ["traveler"] }));
      expect((await world.api("GET", "/access/audit", { session: auth(traveler) })).status).toBe(403);
    });
  });

  describe("users and accounts", () => {
    it("reads and updates the caller's own profile with an audit entry", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const session = await world.session(user);
      const me = await world.api("GET", "/users/me", { session: auth(session) });
      expect(me.body).toMatchObject({ id: user.userId, email: user.email, mfaEnabled: false, tenantId: tenant.id });
      expect(me.body.passwordHash).toBeUndefined();
      const patch = await world.api("PATCH", "/users/me", {
        session: auth(session),
        body: { displayName: "  New Name  ", phone: "+966 50 123 4567", locale: "en-US" }
      });
      expect(patch.status).toBe(200);
      expect(patch.body).toMatchObject({ displayName: "New Name", phone: "+966 50 123 4567", locale: "en-US" });
      const event = await world.prisma.auditEvent.findFirstOrThrow({ where: { actorUserId: user.userId, action: "identity.user.profile.update" } });
      expect(event.metadata).toMatchObject({ changed: ["displayName", "phone", "locale"] });
      expect((await world.api("PATCH", "/users/me", { session: auth(session), body: { locale: "xx" } })).status).toBe(400);
      expect((await world.api("PATCH", "/users/me", { session: auth(session), body: { isPlatformAdmin: true } })).status).toBe(400);
      expect((await world.api("PATCH", "/users/me", { session: auth(session), body: { email: "x@y.test" } })).status).toBe(400);
    });

    it("searches the member directory of the tenant", async () => {
      const needle = world.unique("needle");
      await world.createUser(tenant, { roles: ["traveler"], email: `${needle}@example.test` });
      const found = await world.api("GET", `/tenants/members?q=${needle}`, { session: auth(adminSession) });
      expect(found.status).toBe(200);
      expect(found.body).toHaveLength(1);
      expect(found.body[0].user.email).toBe(`${needle}@example.test`);
    });

    it("suspends and reactivates a member, ending only this tenant's sessions", async () => {
      const other = await world.createTenant("idm-other");
      const person = await world.createUser(tenant, { roles: ["traveler"] });
      const otherMembership = await world.link(other, person.userId, person.email, person.password, { roles: ["traveler"] });
      const session = await world.session(person);
      const otherSession = await world.session(otherMembership);

      const suspend = await world.api("PATCH", `/tenants/members/${person.membershipId}/status`, {
        session: auth(adminSession),
        body: { status: "SUSPENDED", reason: "Policy violation" }
      });
      expect(suspend.status).toBe(200);
      expect(suspend.body.status).toBe("SUSPENDED");
      expect((await world.api("GET", "/auth/me", { session: auth(session) })).status).toBe(401);
      expect((await world.login(person)).status).toBe(401);
      // The same person keeps working in the other tenant.
      expect((await world.api("GET", "/auth/me", { session: auth(otherSession) })).status).toBe(200);
      expect((await world.login(otherMembership)).status).toBe(200);

      const reactivate = await world.api("PATCH", `/tenants/members/${person.membershipId}/status`, {
        session: auth(adminSession),
        body: { status: "ACTIVE" }
      });
      expect(reactivate.status).toBe(200);
      expect((await world.login(person)).status).toBe(200);
      const history = await world.api("GET", `/tenants/members/${person.membershipId}/history`, { session: auth(adminSession) });
      const names = (history.body as Array<{ action: string }>).map((event) => event.action);
      expect(names).toContain("identity.membership.status");
      expect(history.body.find((event: Json) => event.action === "identity.membership.status" && event.metadata.after === "SUSPENDED").metadata.reason).toBe(
        "Policy violation"
      );
    });

    it("protects against self-service status changes and unauthorized managers", async () => {
      expect(
        (await world.api("PATCH", `/tenants/members/${admin.membershipId}/status`, { session: auth(adminSession), body: { status: "SUSPENDED" } })).status
      ).toBe(409);
      const traveler = await world.createUser(tenant, { roles: ["traveler"] });
      const travelerSession = await world.session(traveler);
      const target = await world.createUser(tenant, { roles: ["traveler"] });
      expect(
        (await world.api("PATCH", `/tenants/members/${target.membershipId}/status`, { session: auth(travelerSession), body: { status: "REVOKED" } })).status
      ).toBe(403);
      expect(
        (await world.api("PATCH", `/tenants/members/${target.membershipId}/status`, { session: auth(adminSession), body: { status: "BROKEN" } })).status
      ).toBe(400);
      const platform = await world.createUser(tenant, { roles: ["traveler"], isPlatformAdmin: true });
      expect(
        (await world.api("PATCH", `/tenants/members/${platform.membershipId}/status`, { session: auth(adminSession), body: { status: "SUSPENDED" } })).status
      ).toBe(403);
    });
  });

  describe("tenant management", () => {
    it("lets a tenant manager update the profile and configuration of their own tenant", async () => {
      const updated = await world.api("PATCH", "/tenants/current", {
        session: auth(adminSession),
        body: { name: "Renamed Tenant", settings: { locale: "ar-SA", branding: { primaryColor: "#0a7" } } }
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: "Renamed Tenant", settings: { locale: "ar-SA", branding: { primaryColor: "#0a7" } } });
      const merged = await world.api("PATCH", "/tenants/current", { session: auth(adminSession), body: { settings: { timezone: "Asia/Riyadh" } } });
      expect(merged.body.settings).toMatchObject({ locale: "ar-SA", timezone: "Asia/Riyadh" });
      expect(await actions({ tenantId: tenant.id, entityType: "tenant" })).toContain("identity.tenant.update");
    });

    it("rejects unsupported or oversized settings and unauthorized callers", async () => {
      const patch = (body: object): Promise<{ status: number }> => world.api("PATCH", "/tenants/current", { session: auth(adminSession), body });
      expect((await patch({ settings: { secretKey: "x" } })).status).toBe(400);
      expect((await patch({ settings: { branding: { blob: "x".repeat(9000) } } })).status).toBe(400);
      expect((await patch({ code: "takeover" })).status).toBe(400);
      expect((await patch({ status: "ARCHIVED" })).status).toBe(400);
      const traveler = await world.session(await world.createUser(tenant, { roles: ["traveler"] }));
      expect((await world.api("PATCH", "/tenants/current", { session: auth(traveler), body: { name: "Nope" } })).status).toBe(403);
    });

    describe("platform lifecycle", () => {
      let platformSession: Session;
      let created: Json;
      let target: TestTenant;
      let targetAdmin: TestUser;

      beforeAll(async () => {
        const platform = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
        platformSession = await world.session(platform);
      });

      it("creates a tenant that starts with the standard system roles and permissions", async () => {
        const code = world.unique("new").toLowerCase();
        const reply = await world.api("POST", "/platform/tenants", { session: auth(platformSession), body: { code, name: "Brand New" } });
        expect(reply.status).toBe(201);
        created = reply.body;
        expect(created).toMatchObject({ code, name: "Brand New", status: "ACTIVE" });
        const roles = await world.prisma.role.findMany({ where: { tenantId: created.id }, include: { permissions: { include: { permission: true } } } });
        expect(roles.map((role) => role.code).sort()).toEqual(["organization-manager", "service-provider", "tenant-admin", "travel-company", "traveler"]);
        expect(roles.every((role) => role.isSystem)).toBe(true);
        const adminRole = roles.find((role) => role.code === "tenant-admin")!;
        expect(adminRole.permissions.map(({ permission }) => permission.code)).toContain("identity.role.manage");
        expect(roles.find((role) => role.code === "traveler")!.permissions.map(({ permission }) => permission.code).sort()).toEqual([
          "booking.create", "booking.read", "catalog.service.read", "tenant.read"
        ]);
        expect(await actions({ tenantId: created.id })).toContain("platform.tenant.create");
        target = { id: created.id, code, roleIds: Object.fromEntries(roles.map((role) => [role.code, role.id])) };
        targetAdmin = await world.createUser(target, { roles: ["tenant-admin"] });
      });

      it("rejects duplicate codes and non-platform callers", async () => {
        expect((await world.api("POST", "/platform/tenants", { session: auth(platformSession), body: { code: created.code, name: "Dup" } })).status).toBe(409);
        expect((await world.api("POST", "/platform/tenants", { session: auth(platformSession), body: { code: "Bad Code", name: "Bad" } })).status).toBe(400);
        expect((await world.api("POST", "/platform/tenants", { session: auth(adminSession), body: { code: "mine", name: "Mine" } })).status).toBe(403);
      });

      it("suspends a tenant: sessions end, nobody can sign in, then reactivates", async () => {
        const session = await world.session(targetAdmin);
        const suspend = await world.api("POST", `/platform/tenants/${target.id}/status`, {
          session: auth(platformSession),
          body: { status: "SUSPENDED", reason: "Unpaid invoice" }
        });
        expect(suspend.status).toBe(201);
        expect(suspend.body.status).toBe("SUSPENDED");
        expect((await world.api("GET", "/tenants/current", { session: auth(session) })).status).toBe(401);
        expect((await world.login(targetAdmin)).status).toBe(401);
        expect(await world.prisma.refreshSession.count({ where: { tenantId: target.id, revokedAt: null } })).toBe(0);
        const reactivate = await world.api("POST", `/platform/tenants/${target.id}/status`, {
          session: auth(platformSession),
          body: { status: "ACTIVE", reason: "Paid" }
        });
        expect(reactivate.body.status).toBe("ACTIVE");
        expect((await world.login(targetAdmin)).status).toBe(200);
      });

      it("protects the platform's own tenant and archives irreversibly", async () => {
        const own = await world.api("POST", `/platform/tenants/${tenant.id}/status`, {
          session: auth(platformSession),
          body: { status: "SUSPENDED", reason: "Oops" }
        });
        expect(own.status).toBe(409);
        const archive = await world.api("POST", `/platform/tenants/${target.id}/status`, {
          session: auth(platformSession),
          body: { status: "ARCHIVED", reason: "Customer left" }
        });
        expect(archive.body).toMatchObject({ status: "ARCHIVED" });
        expect(archive.body.archivedAt).toEqual(expect.any(String));
        const revive = await world.api("POST", `/platform/tenants/${target.id}/status`, {
          session: auth(platformSession),
          body: { status: "ACTIVE", reason: "Changed mind" }
        });
        expect(revive.status).toBe(409);
        expect((await world.api("POST", `/platform/tenants/${target.id}/status`, { session: auth(platformSession), body: { status: "ACTIVE" } })).status).toBe(400);
        expect((await world.api("POST", `/platform/tenants/${crypto.randomUUID()}/status`, { session: auth(platformSession), body: { status: "SUSPENDED", reason: "none" } })).status).toBe(404);
      });

      it("records the lifecycle in the tenant's activity history", async () => {
        const history = await world.api("GET", `/platform/tenants/${target.id}/activity`, { session: auth(platformSession) });
        const names = (history.body as Array<{ action: string }>).map((event) => event.action);
        expect(names).toEqual(expect.arrayContaining(["platform.tenant.create", "platform.tenant.suspended", "platform.tenant.active", "platform.tenant.archived"]));
        expect((await world.api("GET", `/platform/tenants/${target.id}/activity`, { session: auth(adminSession) })).status).toBe(403);
      });
    });
  });
});
