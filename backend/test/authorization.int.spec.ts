import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Session, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Negative authorization cases: identity linking across tenants,
 * suspended organizations, the privilege ceiling of delegated managers and membership status authority.
 */
describe("authorization", () => {
  let world: World;
  let a: TestTenant;
  let b: TestTenant;
  let adminA: TestUser;
  let adminSessionA: Session;

  const auth = (session: Session): { accessToken: string; tenantId: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user.tenantId
  });

  /** An ACTIVE organization in tenant A with a manager, a department and a staff role. */
  async function organization(): Promise<{ id: string; manager: TestUser; session: Session; departmentId: string }> {
    const id = await world.createOrganization(a);
    const manager = await world.createUser(a, { roles: ["travel-company", "organization-manager"], organizationId: id });
    const session = await world.session(manager);
    const department = await world.api("POST", `/organizations/${id}/departments`, {
      session: auth(session),
      body: { code: "ops", name: "Operations" }
    });
    expect(department.status).toBe(201);
    return { id, manager, session, departmentId: department.body.id as string };
  }

  const staff = (departmentId: string, email: string): object => ({
    email,
    displayName: "Typed by manager",
    password: `Manager-Typed-${world.stamp}-Pw`,
    jobTitle: "Agent",
    departmentId,
    roleIds: [a.roleIds["travel-company"]]
  });

  beforeAll(async () => {
    world = await World.start();
    a = await world.createTenant("authz-a");
    b = await world.createTenant("authz-b");
    adminA = await world.createUser(a, { roles: ["tenant-admin"] });
    adminSessionA = await world.session(adminA);
  });

  afterAll(async () => {
    await world.stop();
  });

  describe("staff creation never links a foreign identity implicitly", () => {
    let victim: TestUser;
    let org: Awaited<ReturnType<typeof organization>>;
    let invitationId: string;
    const secretName = "Victim Private Display Name";

    beforeAll(async () => {
      victim = await world.createUser(b, { roles: ["traveler"] });
      await world.prisma.user.update({ where: { id: victim.userId }, data: { displayName: secretName, phone: "+966500000001" } });
      org = await organization();
    });

    it("creates an invitation, not an active membership, and echoes none of the identity's profile", async () => {
      const authVersion = (await world.prisma.user.findUniqueOrThrow({ where: { id: victim.userId } })).authVersion;
      const users = await world.prisma.user.count();
      const reply = await world.api("POST", `/organizations/${org.id}/employees`, {
        session: auth(org.session),
        body: staff(org.departmentId, victim.email)
      });
      expect(reply.status).toBe(201);
      expect(reply.body.status).toBe("INVITED");
      expect(reply.body.awaitingOwnerConsent).toBe(true);
      expect(JSON.stringify(reply.body)).not.toContain(secretName);
      invitationId = reply.body.id as string;
      expect(await world.prisma.user.count()).toBe(users);
      const membership = await world.prisma.tenantMembership.findUniqueOrThrow({ where: { id: invitationId } });
      expect(membership).toMatchObject({ status: "INVITED", awaitingOwnerConsent: true, tenantId: a.id });
      expect((await world.prisma.user.findUniqueOrThrow({ where: { id: victim.userId } })).authVersion).toBe(authVersion);
      // The identity can not be used in tenant A until its owner accepts.
      expect((await world.login({ ...victim, tenant: a })).status).toBe(401);
    });

    it("does not reveal the profile in the organization overview or the tenant member list", async () => {
      const overview = await world.api("GET", `/organizations/${org.id}/management`, { session: auth(org.session) });
      expect(overview.status).toBe(200);
      expect(JSON.stringify(overview.body)).not.toContain(secretName);
      const members = await world.api("GET", "/tenants/members", { session: auth(adminSessionA) });
      expect(members.status).toBe(200);
      expect(JSON.stringify(members.body)).not.toContain(secretName);
      expect(JSON.stringify(members.body)).not.toContain("+966500000001");
      const search = await world.api("GET", "/tenants/members?q=Victim", { session: auth(adminSessionA) });
      expect(search.body).toEqual([]);
    });

    it("lets neither the organization manager nor the tenant admin activate it for the owner", async () => {
      const manager = await world.api("PATCH", `/organizations/${org.id}/employees/${invitationId}`, {
        session: auth(org.session),
        body: { status: "ACTIVE" }
      });
      expect(manager.status).toBe(409);
      const admin = await world.api("PATCH", `/tenants/members/${invitationId}/status`, {
        session: auth(adminSessionA),
        body: { status: "ACTIVE" }
      });
      expect(admin.status).toBe(409);
      expect((await world.prisma.tenantMembership.findUniqueOrThrow({ where: { id: invitationId } })).status).toBe("INVITED");
    });

    it("editing the invited employee does not end the identity's sessions in other tenants", async () => {
      const victimSession = await world.session(victim);
      const edit = await world.api("PATCH", `/organizations/${org.id}/employees/${invitationId}`, {
        session: auth(org.session),
        body: { jobTitle: "Renamed" }
      });
      expect(edit.status).toBe(200);
      expect((await world.api("GET", "/users/me", { session: auth(victimSession) })).status).toBe(200);
    });

    it("only the identity's owner can accept, and then the membership becomes active", async () => {
      const stranger = await world.createUser(b, { roles: ["traveler"] });
      const strangerSession = await world.session(stranger);
      expect((await world.api("GET", "/users/me/invitations", { session: auth(strangerSession) })).body).toEqual([]);
      expect((await world.api("POST", `/users/me/invitations/${invitationId}/accept`, { session: auth(strangerSession) })).status).toBe(404);

      const victimSession = await world.session(victim);
      const list = await world.api("GET", "/users/me/invitations", { session: auth(victimSession) });
      expect(list.status).toBe(200);
      expect((list.body as Array<{ id: string }>).map((item) => item.id)).toEqual([invitationId]);
      const accepted = await world.api("POST", `/users/me/invitations/${invitationId}/accept`, { session: auth(victimSession) });
      expect(accepted.status).toBe(200);
      expect(await world.prisma.tenantMembership.findUniqueOrThrow({ where: { id: invitationId } }))
        .toMatchObject({ status: "ACTIVE", awaitingOwnerConsent: false });
      // The identity keeps its own password; the one typed by the manager was never applied.
      expect((await world.login({ ...victim, tenant: a })).status).toBe(200);
      expect((await world.login({ ...victim, tenant: a }, {}, `Manager-Typed-${world.stamp}-Pw`)).status).toBe(401);
      expect((await world.api("POST", `/users/me/invitations/${invitationId}/accept`, { session: auth(victimSession) })).status).toBe(404);
    });

    it("a provider created by the tenant admin for an existing identity waits for its owner too", async () => {
      const owner = await world.createUser(b, { roles: ["traveler"] });
      const reply = await world.api("POST", "/providers", {
        session: auth(adminSessionA),
        body: {
          name: "Provider owner", nameAr: "Provider AR", nameEn: "Provider EN", type: "HOTEL", city: "Riyadh",
          contactEmail: owner.email, phone: "", licenseNumber: "", password: `Admin-Typed-${world.stamp}-Pw`
        }
      });
      expect(reply.status).toBe(201);
      expect(reply.body.ownerAwaitingConsent).toBe(true);
      const membership = await world.prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: a.id, userId: owner.userId } });
      expect(membership).toMatchObject({ status: "INVITED", awaitingOwnerConsent: true });
      expect((await world.login({ ...owner, tenant: a })).status).toBe(401);
    });

    it("a new e-mail still creates an active staff account directly", async () => {
      const reply = await world.api("POST", `/organizations/${org.id}/employees`, {
        session: auth(org.session),
        body: staff(org.departmentId, `${world.unique("new-staff")}@example.test`)
      });
      expect(reply.status).toBe(201);
      expect(reply.body).toMatchObject({ status: "ACTIVE", awaitingOwnerConsent: false });
    });
  });

  describe("a suspended organization's managers can not administer it", () => {
    it("refuses every change while the organization is suspended, but keeps the read-only overview", async () => {
      const org = await organization();
      expect((await world.api("PATCH", `/providers/${org.id}/status`, { session: auth(adminSessionA), body: { status: "SUSPENDED" } })).status).toBe(200);
      const session = auth(org.session);
      expect((await world.api("GET", `/organizations/${org.id}/management`, { session })).status).toBe(200);
      expect((await world.api("POST", `/organizations/${org.id}/departments`, { session, body: { code: "sales", name: "Sales" } })).status).toBe(403);
      expect((await world.api("POST", `/organizations/${org.id}/employees`, {
        session, body: staff(org.departmentId, `${world.unique("blocked")}@example.test`)
      })).status).toBe(403);
      expect((await world.api("PATCH", `/organizations/${org.id}/specialties`, { session, body: { specialties: ["x"] } })).status).toBe(403);
      expect((await world.api("POST", `/organizations/${org.id}/roles`, { session, body: { code: "desk", name: "Desk", permissions: [] } })).status).toBe(403);
      // The tenant administrator (higher authority) can still act on it.
      expect((await world.api("POST", `/organizations/${org.id}/departments`, {
        session: auth(adminSessionA), body: { code: "audit", name: "Audit" }
      })).status).toBe(201);
    });
  });

  describe("privilege ceiling of a delegated role manager", () => {
    let keeperSession: Session;
    let strongRoleId: string;

    beforeAll(async () => {
      const keeperRole = await world.api("POST", "/roles", {
        session: auth(adminSessionA),
        body: { code: "keeper", name: "Keeper", permissions: ["identity.role.manage", "identity.user.manage", "identity.user.read", "audit.read"] }
      });
      expect(keeperRole.status).toBe(201);
      const strong = await world.api("POST", "/roles", {
        session: auth(adminSessionA),
        body: { code: "strong", name: "Strong", permissions: ["booking.manage", "audit.read"] }
      });
      strongRoleId = strong.body.id as string;
      const keeper = await world.createUser(a, { roles: ["traveler"] });
      expect((await world.api("PUT", `/memberships/${keeper.membershipId}/roles`, {
        session: auth(adminSessionA), body: { roleIds: [keeperRole.body.id] }
      })).status).toBe(200);
      keeperSession = await world.session(keeper);
    });

    it("can not demote a tenant administrator", async () => {
      const otherAdmin = await world.createUser(a, { roles: ["tenant-admin"] });
      const auditor = await world.api("POST", "/roles", {
        session: auth(keeperSession), body: { code: "auditor-x", name: "Auditor", permissions: ["audit.read"] }
      });
      expect(auditor.status).toBe(201);
      const demote = await world.api("PUT", `/memberships/${otherAdmin.membershipId}/roles`, {
        session: auth(keeperSession), body: { roleIds: [auditor.body.id] }
      });
      expect(demote.status).toBe(403);
      const roles = await world.prisma.membershipRole.findMany({ where: { membershipId: otherAdmin.membershipId }, include: { role: true } });
      expect(roles.map(({ role }) => role.code)).toEqual(["tenant-admin"]);
    });

    it("can not strip a member who holds more than the manager", async () => {
      const holder = await world.createUser(a, { roles: ["traveler"] });
      expect((await world.api("PUT", `/memberships/${holder.membershipId}/roles`, {
        session: auth(adminSessionA), body: { roleIds: [strongRoleId] }
      })).status).toBe(200);
      const auditorOnly = await world.prisma.role.findFirstOrThrow({ where: { tenantId: a.id, code: "auditor-x" } });
      expect((await world.api("PUT", `/memberships/${holder.membershipId}/roles`, {
        session: auth(keeperSession), body: { roleIds: [auditorOnly.id] }
      })).status).toBe(403);
      expect((await world.api("PATCH", `/tenants/members/${holder.membershipId}/status`, {
        session: auth(keeperSession), body: { status: "SUSPENDED" }
      })).status).toBe(403);
    });

    it("can not edit or delete a role stronger than their own", async () => {
      expect((await world.api("PATCH", `/roles/${strongRoleId}`, {
        session: auth(keeperSession), body: { permissions: ["audit.read"] }
      })).status).toBe(403);
      const unused = await world.api("POST", "/roles", {
        session: auth(adminSessionA), body: { code: "unused-strong", name: "Unused", permissions: ["booking.manage"] }
      });
      expect((await world.api("DELETE", `/roles/${unused.body.id}`, { session: auth(keeperSession) })).status).toBe(403);
      expect((await world.api("DELETE", `/roles/${unused.body.id}`, { session: auth(adminSessionA) })).status).toBe(204);
    });
  });

  describe("membership status decided at tenant level", () => {
    it("an organization manager can not lift a tenant-level suspension or any revocation", async () => {
      const org = await organization();
      const created = await world.api("POST", `/organizations/${org.id}/employees`, {
        session: auth(org.session), body: staff(org.departmentId, `${world.unique("status")}@example.test`)
      });
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      const patch = (status: string): Promise<{ status: number }> =>
        world.api("PATCH", `/organizations/${org.id}/employees/${id}`, { session: auth(org.session), body: { status } });

      expect((await world.api("PATCH", `/tenants/members/${id}/status`, {
        session: auth(adminSessionA), body: { status: "SUSPENDED", reason: "tenant decision" }
      })).status).toBe(200);
      expect((await patch("ACTIVE")).status).toBe(403);
      expect((await world.prisma.tenantMembership.findUniqueOrThrow({ where: { id } })).status).toBe("SUSPENDED");

      // Once the tenant lifts it, the organization manages its own suspensions again.
      expect((await world.api("PATCH", `/tenants/members/${id}/status`, {
        session: auth(adminSessionA), body: { status: "ACTIVE" }
      })).status).toBe(200);
      expect((await patch("SUSPENDED")).status).toBe(200);
      expect((await patch("ACTIVE")).status).toBe(200);

      expect((await patch("REVOKED")).status).toBe(200);
      expect((await world.prisma.tenantMembership.findUniqueOrThrow({ where: { id } })).revokedAt).not.toBeNull();
      expect((await patch("ACTIVE")).status).toBe(403);
    });
  });

  describe("an invitation becomes active only through its owner's acceptance", () => {
    let org: Awaited<ReturnType<typeof organization>>;

    async function invite(): Promise<{ owner: TestUser; id: string }> {
      const owner = await world.createUser(b, { roles: ["traveler"] });
      const reply = await world.api("POST", `/organizations/${org.id}/employees`, {
        session: auth(org.session), body: staff(org.departmentId, owner.email)
      });
      expect(reply.status).toBe(201);
      expect(reply.body.awaitingOwnerConsent).toBe(true);
      return { owner, id: reply.body.id as string };
    }
    const tenantStatus = (id: string, status: string): Promise<{ status: number }> =>
      world.api("PATCH", `/tenants/members/${id}/status`, { session: auth(adminSessionA), body: { status } });

    beforeAll(async () => {
      org = await organization();
    });

    it("revoking an invitation does not make it activatable by the tenant", async () => {
      const { owner, id } = await invite();
      expect((await tenantStatus(id, "REVOKED")).status).toBe(200);
      expect((await tenantStatus(id, "ACTIVE")).status).toBe(409);
      expect((await tenantStatus(id, "SUSPENDED")).status).toBe(200);
      expect((await tenantStatus(id, "ACTIVE")).status).toBe(409);
      expect(await world.prisma.tenantMembership.findUniqueOrThrow({ where: { id } }))
        .toMatchObject({ status: "SUSPENDED", awaitingOwnerConsent: true });
      expect((await world.login({ ...owner, tenant: a })).status).toBe(401);
    });

    it("a declined invitation can be activated by nobody, not even a platform administrator", async () => {
      const { owner, id } = await invite();
      const ownerSession = await world.session(owner);
      expect((await world.api("POST", `/users/me/invitations/${id}/decline`, { session: auth(ownerSession) })).status).toBe(200);
      expect((await tenantStatus(id, "ACTIVE")).status).toBe(409);
      expect((await world.api("PATCH", `/organizations/${org.id}/employees/${id}`, {
        session: auth(org.session), body: { status: "ACTIVE" }
      })).status).toBe(409);
      const platformAdmin = await world.createUser(a, { roles: ["tenant-admin"], isPlatformAdmin: true });
      const platform = await world.api("PATCH", `/platform/memberships/${id}/access`, {
        session: auth(await world.session(platformAdmin)),
        body: { roleIds: [a.roleIds["travel-company"]], permissionOverrides: {}, status: "ACTIVE", providerOrganizationId: org.id }
      });
      expect(platform.status).toBe(409);
      expect(await world.prisma.tenantMembership.findUniqueOrThrow({ where: { id } }))
        .toMatchObject({ status: "REVOKED", awaitingOwnerConsent: true });
      // The decline is final for this invitation: it is no longer offered and can not be accepted later.
      expect((await world.api("GET", "/users/me/invitations", { session: auth(ownerSession) })).body).toEqual([]);
      expect((await world.api("POST", `/users/me/invitations/${id}/accept`, { session: auth(ownerSession) })).status).toBe(404);
      expect((await world.login({ ...owner, tenant: a })).status).toBe(401);
    });

    it("the database refuses an active membership without consent and clearing consent without activation", async () => {
      const { id } = await invite();
      await expect(world.asRole({ bypass: true }, `UPDATE tenant_memberships SET status = 'ACTIVE' WHERE id = $1`, [id]))
        .rejects.toThrow(/tenant_memberships_active_requires_consent/);
      await expect(world.asRole({ bypass: true },
        `UPDATE tenant_memberships SET status = 'REVOKED', "awaitingOwnerConsent" = false WHERE id = $1`, [id]))
        .rejects.toThrow(/only by its owner accepting/);
      const accepted = await world.asRole({ bypass: true },
        `UPDATE tenant_memberships SET status = 'ACTIVE', "awaitingOwnerConsent" = false WHERE id = $1`, [id]);
      expect(accepted.rowCount).toBe(1);
    });

    it("a manager holding every tenant-admin permission still can not hand out the tenant-admin role", async () => {
      const adminRole = await world.prisma.role.findUniqueOrThrow({
        where: { id: a.roleIds["tenant-admin"] }, include: { permissions: { include: { permission: true } } }
      });
      const near = await world.api("POST", "/roles", {
        session: auth(adminSessionA),
        body: { code: "near-admin", name: "Near admin", permissions: adminRole.permissions.map(({ permission }) => permission.code) }
      });
      expect(near.status).toBe(201);
      const holder = await world.createUser(a, { roles: ["traveler"] });
      expect((await world.api("PUT", `/memberships/${holder.membershipId}/roles`, {
        session: auth(adminSessionA), body: { roleIds: [near.body.id] }
      })).status).toBe(200);
      const target = await world.createUser(a, { roles: ["traveler"] });
      const promote = await world.api("PUT", `/memberships/${target.membershipId}/roles`, {
        session: auth(await world.session(holder)), body: { roleIds: [a.roleIds["tenant-admin"]] }
      });
      expect(promote.status).toBe(403);
    });
  });

  describe("platform permissions never come from a tenant role or override", () => {
    it("drops platform.* from the effective permissions even when a legacy role row or an override grants it", async () => {
      const legacy = await world.createTenant("authz-legacy");
      const permission = await world.prisma.permission.findUniqueOrThrow({ where: { code: "platform.tenant.create" } });
      await world.prisma.rolePermission.createMany({
        data: [{ roleId: legacy.roleIds["tenant-admin"]!, permissionId: permission.id }], skipDuplicates: true
      });
      const admin = await world.createUser(legacy, { roles: ["tenant-admin"] });
      await world.prisma.tenantMembership.update({
        where: { id: admin.membershipId }, data: { permissionOverrides: { "platform.tenant.create": true } }
      });
      const session = await world.session(admin);
      expect(session.user.permissions.some((code) => code.startsWith("platform."))).toBe(false);
      expect(session.user.permissions).toContain("identity.role.manage");
      expect((await world.api("GET", "/platform/tenants", { session: auth(session) })).status).toBe(403);
    });
  });

  describe("database layer for global tables and the audit trail", () => {
    it("keeps the audit trail append-only and platform-level rows to the system scope", async () => {
      const row = await world.prisma.auditEvent.create({ data: { tenantId: a.id, action: "test.audit" } });
      await expect(world.asRole({ tenantId: a.id }, `UPDATE audit_events SET action = 'tampered' WHERE id = $1`, [row.id]))
        .rejects.toThrow(/permission denied/);
      await expect(world.asRole({ bypass: true }, `DELETE FROM audit_events WHERE id = $1`, [row.id])).rejects.toThrow(/permission denied/);
      await expect(world.asRole({ tenantId: a.id }, `INSERT INTO audit_events (id, "tenantId", action) VALUES (gen_random_uuid(), NULL, 'forged')`))
        .rejects.toThrow(/row-level security/);
      const system = await world.asRole({ bypass: true }, `INSERT INTO audit_events (id, "tenantId", action) VALUES (gen_random_uuid(), NULL, 'platform')`);
      expect(system.rowCount).toBe(1);
      const own = await world.asRole({ tenantId: a.id }, `INSERT INTO audit_events (id, "tenantId", action) VALUES (gen_random_uuid(), $1, 'own')`, [a.id]);
      expect(own.rowCount).toBe(1);
    });

    it("confines role_permissions to the session's own roles", async () => {
      const permission = await world.prisma.permission.findUniqueOrThrow({ where: { code: "booking.manage" } });
      await expect(world.asRole({ tenantId: a.id }, `INSERT INTO role_permissions ("roleId", "permissionId") VALUES ($1, $2)`,
        [b.roleIds["traveler"], permission.id])).rejects.toThrow(/row-level security/);
      const own = await world.asRole({ tenantId: a.id }, `INSERT INTO role_permissions ("roleId", "permissionId") VALUES ($1, $2)`,
        [a.roleIds["traveler"], permission.id]);
      expect(own.rowCount).toBe(1);
      const foreign = await world.asRole<{ n: number }>({ tenantId: a.id },
        `SELECT count(*)::int AS n FROM role_permissions WHERE "roleId" = $1`, [b.roleIds["tenant-admin"]]);
      expect(foreign.rows[0]?.n).toBe(0);
      const removed = await world.asRole({ tenantId: a.id }, `DELETE FROM role_permissions WHERE "roleId" = $1`, [b.roleIds["tenant-admin"]]);
      expect(removed.rowCount).toBe(0);
    });

    it("keeps the permission catalogue and the platform-admin flag out of reach of tenant sessions", async () => {
      await expect(world.asRole({ tenantId: a.id }, `INSERT INTO permissions (id, code) VALUES (gen_random_uuid(), 'smuggled.code')`))
        .rejects.toThrow(/permission denied/);
      await expect(world.asRole({ tenantId: a.id }, `UPDATE users SET "isPlatformAdmin" = true WHERE id = $1`, [adminA.userId]))
        .rejects.toThrow(/only be changed by the platform/);
      const profile = await world.asRole({ tenantId: a.id }, `UPDATE users SET "displayName" = 'Renamed' WHERE id = $1`, [adminA.userId]);
      expect(profile.rowCount).toBe(1);
      const platform = await world.asRole({ bypass: true }, `UPDATE users SET "isPlatformAdmin" = true WHERE id = $1`, [adminA.userId]);
      expect(platform.rowCount).toBe(1);
    });
  });

  describe("the platform-admin guard does not depend on the role name", () => {
    it("blocks a differently named runtime login that holds safry_app privileges without SET ROLE", async () => {
      const login = `g3b_rt_${Date.now().toString(36)}`;
      const password = randomUUID();
      await world.sql.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' INHERIT`);
      await world.sql.query(`GRANT safry_app TO ${login}`);
      const url = new URL(world.databaseUrl);
      url.username = login;
      url.password = password;
      const client = new pg.Client({ connectionString: url.toString() });
      try {
        await client.connect();
        expect((await client.query("SELECT current_user AS u")).rows[0]?.u).toBe(login);
        await expect(client.query(`UPDATE users SET "isPlatformAdmin" = true WHERE id = $1`, [adminA.userId]))
          .rejects.toThrow(/only be changed by the platform/);
      } finally {
        await client.end();
        await world.sql.query(`REVOKE safry_app FROM ${login}`);
        await world.sql.query(`DROP ROLE ${login}`);
      }
    });
  });

  describe("input validation", () => {
    it("accepts only typed tenant settings and keeps stored keys on a partial update", async () => {
      const patch = (settings: unknown): Promise<{ status: number; body: { settings?: Record<string, unknown> } }> =>
        world.api("PATCH", "/tenants/current", { session: auth(adminSessionA), body: { settings } });
      for (const bad of [
        { currency: "XXXX" },
        { timezone: "Mars/Olympus" },
        { locale: "fr-FR" },
        { branding: { logoUrl: "javascript:alert(1)" } },
        { branding: { primaryColor: "red;background:url(x)" } },
        { branding: { script: "<script>" } },
        { features: { anything: true } },
        { unknownKey: 1 }
      ])
        expect((await patch(bad)).status, JSON.stringify(bad)).toBe(400);
      expect((await patch({ currency: "SAR", timezone: "Asia/Riyadh" })).status).toBe(200);
      const second = await patch({ branding: { primaryColor: "#0f766e", logoUrl: "https://cdn.example.test/logo.svg" } });
      expect(second.status).toBe(200);
      expect(second.body.settings).toMatchObject({ currency: "SAR", timezone: "Asia/Riyadh", branding: { primaryColor: "#0f766e" } });
    });

    it("rejects unknown or malformed permission overrides, long specialties and long search terms", async () => {
      const org = await organization();
      for (const permissionOverrides of [{ "identity.user.manage": true }, { "booking.read": "yes" }, { "booking.read": true, extra: 1 }])
        expect((await world.api("POST", `/organizations/${org.id}/employees`, {
          session: auth(org.session),
          body: { ...staff(org.departmentId, `${world.unique("ovr")}@example.test`), permissionOverrides }
        })).status, JSON.stringify(permissionOverrides)).toBe(400);
      const ok = await world.api("POST", `/organizations/${org.id}/employees`, {
        session: auth(org.session),
        body: { ...staff(org.departmentId, `${world.unique("ovr")}@example.test`), permissionOverrides: { "booking.manage": false } }
      });
      expect(ok.status).toBe(201);
      expect(ok.body.permissionOverrides).toEqual({ "booking.manage": false });
      // A "__proto__" key is dropped by the transformer: nothing reaches storage and no prototype is polluted.
      const proto = await world.api("POST", `/organizations/${org.id}/employees`, {
        session: auth(org.session),
        body: { ...staff(org.departmentId, `${world.unique("ovr")}@example.test`), permissionOverrides: JSON.parse('{"__proto__": {"booking.manage": true}}') as object }
      });
      expect(proto.status).toBe(201);
      expect(proto.body.permissionOverrides).toEqual({});
      expect(({} as Record<string, unknown>)["booking.manage"]).toBeUndefined();
      expect((await world.api("PATCH", `/organizations/${org.id}/specialties`, {
        session: auth(org.session), body: { specialties: ["x".repeat(81)] }
      })).status).toBe(400);
      expect((await world.api("GET", `/tenants/members?q=${"a".repeat(101)}`, { session: auth(adminSessionA) })).status).toBe(400);
      expect((await world.api("GET", "/tenants/members?q=abc", { session: auth(adminSessionA) })).status).toBe(200);
    });
  });

  describe("legal identity of an organization", () => {
    it("is editable by its manager and the tenant admin, not by ordinary staff", async () => {
      const org = await organization();
      const clerk = await world.createUser(a, { roles: ["travel-company"], organizationId: org.id });
      const clerkSession = await world.session(clerk);
      const body = { licenseNumber: "LIC-CHANGED" };
      expect((await world.api("PATCH", `/providers/${org.id}`, { session: auth(clerkSession), body })).status).toBe(403);
      expect((await world.api("PATCH", `/providers/${org.id}`, { session: auth(org.session), body })).status).toBe(200);
      const event = await world.prisma.auditEvent.findFirstOrThrow({ where: { entityId: org.id, action: "provider.update" } });
      expect(event.metadata).toMatchObject({ after: { licenseNumber: "LIC-CHANGED" } });
    });
  });

  describe("bounded lists", () => {
    it("caps the provider and role lists server-side", async () => {
      const big = await world.createTenant("authz-big");
      const admin = await world.createUser(big, { roles: ["tenant-admin"] });
      await world.prisma.providerOrganization.createMany({
        data: Array.from({ length: 510 }, (_, i) => ({
          tenantId: big.id, name: `bulk-${i}`, nameAr: `bulk-${i}`, nameEn: `bulk-${i}`, type: "HOTEL" as const, city: "Riyadh", contactEmail: `bulk-${i}@example.test`
        }))
      });
      await world.prisma.role.createMany({
        data: Array.from({ length: 210 }, (_, i) => ({ tenantId: big.id, code: `bulk-role-${i}`, name: `Bulk ${i}` }))
      });
      const session = await world.session(admin);
      const providers = await world.api("GET", "/providers", { session: auth(session) });
      expect(providers.status).toBe(200);
      // keyset paging (BEPERF): default page is 100; the rest is reachable through ?cursor=
      expect((providers.body as unknown[]).length).toBe(100);
      const roles = await world.api("GET", "/roles", { session: auth(session) });
      expect((roles.body as unknown[]).length).toBe(200);
    });
  });

  describe("bookings and services lists are paged", () => {
    it("caps services by default and by the maximum, and pages with limit and offset", async () => {
      const big = await world.createTenant("authz-paged");
      const admin = await world.createUser(big, { roles: ["tenant-admin"] });
      const orgId = await world.createOrganization(big);
      const owner = await world.createUser(big, { roles: ["travel-company"], organizationId: orgId });
      const serviceId = await world.createService(big, owner);
      const { id: _id, createdAt: _c, updatedAt: _u, ...row } = await world.prisma.travelService.findUniqueOrThrow({ where: { id: serviceId } });
      await world.prisma.travelService.createMany({ data: Array.from({ length: 204 }, () => ({ ...row })) as never });
      const session = auth(await world.session(admin));
      const list = (query: string): Promise<{ status: number; body: unknown }> => world.api("GET", `/services${query}`, { session });
      expect(((await list("")).body as unknown[]).length).toBe(100);
      expect(((await list("?limit=200")).body as unknown[]).length).toBe(200);
      expect((await list("?limit=201")).status).toBe(400);
      expect((await list("?limit=0")).status).toBe(400);
      expect((await list("?offset=-1")).status).toBe(400);
      expect((await list("?offset=1001")).status).toBe(400);
      expect((await list("?offset=1000")).status).toBe(200);
      const first = (await list("?limit=3")).body as { id: string }[];
      const next = (await list("?limit=3&offset=3")).body as { id: string }[];
      expect(first.length + next.length).toBe(6);
      expect(new Set([...first, ...next].map(({ id }) => id)).size).toBe(6);
      expect(((await list("?limit=100&offset=200")).body as unknown[]).length).toBe(5);
      expect((await world.api("GET", "/services/marketplace?limit=201", { session })).status).toBe(400);
      expect((await world.api("GET", "/bookings?limit=201", { session })).status).toBe(400);
      expect((await world.api("GET", "/bookings?limit=5", { session })).status).toBe(200);
    });
  });

  describe("negative cases on the remaining authorization surface", () => {
    it("(a) a manager of one organization can not manage another organization of the same tenant", async () => {
      const mine = await organization();
      const theirs = await organization();
      const session = auth(mine.session);
      expect((await world.api("GET", `/organizations/${theirs.id}/management`, { session })).status).toBe(403);
      expect((await world.api("POST", `/organizations/${theirs.id}/departments`, { session, body: { code: "x-dept", name: "Other dept" } })).status).toBe(403);
      expect((await world.api("PATCH", `/organizations/${theirs.id}/employees/${theirs.manager.membershipId}`, { session, body: { jobTitle: "Agent X" } })).status).toBe(403);
      const clerk = await world.createUser(a, { roles: ["travel-company"], organizationId: mine.id });
      expect((await world.api("POST", `/organizations/${mine.id}/departments`, {
        session: auth(await world.session(clerk)), body: { code: "clerk-dept", name: "Clerk dept" }
      })).status).toBe(403);
    });

    it("(b) only a tenant admin creates providers or changes their status; non-members can not edit them", async () => {
      const mine = await organization();
      const theirs = await organization();
      const session = auth(mine.session);
      expect((await world.api("PATCH", `/providers/${theirs.id}/status`, { session, body: { status: "SUSPENDED" } })).status).toBe(403);
      expect((await world.api("PATCH", `/providers/${theirs.id}`, { session, body: { city: "Jeddah" } })).status).toBe(404);
      expect((await world.api("POST", "/providers", { session, body: {} })).status).toBe(403);
    });

    it("(c, g) a provider can not edit another organization's service, and mass assignment is refused", async () => {
      const mine = await organization();
      const theirs = await organization();
      const service = await world.createService(a, { ...theirs.manager, organizationId: theirs.id });
      const edit = await world.api("PATCH", `/services/${service}`, { session: auth(mine.session), body: { title: "Hijacked title" } });
      expect([403, 404]).toContain(edit.status);
      const own = await world.createService(a, { ...mine.manager, organizationId: mine.id });
      for (const body of [{ tenantId: b.id }, { providerOrganizationId: theirs.id }, { providerMembershipId: theirs.manager.membershipId }])
        expect((await world.api("PATCH", `/services/${own}`, { session: auth(mine.session), body })).status, JSON.stringify(body)).toBe(400);
    });

    it("(d) platform routes refuse a tenant administrator token", async () => {
      const session = auth(adminSessionA);
      for (const [method, path] of [
        ["GET", "/platform/overview"], ["GET", "/platform/references"], ["GET", "/platform/records/users"],
        ["POST", "/platform/users"], ["PATCH", `/platform/users/${adminA.userId}`],
        ["PATCH", `/platform/memberships/${adminA.membershipId}/access`], ["GET", "/platform/tenants"]
      ] as const)
        expect((await world.api(method, path, { session, ...(method === "GET" ? {} : { body: {} }) })).status, `${method} ${path}`).toBe(403);
    });

    it("(h) interleaved requests of two tenants over the shared connection pool never see each other's data", async () => {
      const adminB = await world.createUser(b, { roles: ["tenant-admin"] });
      const sessionB = await world.session(adminB);
      const calls = Array.from({ length: 40 }, (_, i): [Session, string] => (i % 2 === 0 ? [adminSessionA, a.id] : [sessionB, b.id]));
      const replies = await Promise.all(calls.map(async ([session, tenantId]) => {
        const [current, members] = await Promise.all([
          world.api("GET", "/tenants/current", { session: auth(session) }),
          world.api("GET", "/tenants/members", { session: auth(session) })
        ]);
        return { tenantId, current, members };
      }));
      for (const { tenantId, current, members } of replies) {
        expect(current.body.id).toBe(tenantId);
        const ids = new Set((await world.prisma.tenantMembership.findMany({ where: { tenantId }, select: { id: true } })).map((m) => m.id));
        expect((members.body as Array<{ id: string }>).every((member) => ids.has(member.id))).toBe(true);
      }
    });
  });
});

describe("consent state machine migration backfill", () => {
  it("reverts ACTIVE memberships that still await owner consent to INVITED, audits them, and re-applies cleanly", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const world = await World.start();
    try {
      const tenant = await world.createTenant("mig-consent");
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const ok = await world.createUser(tenant, { roles: ["traveler"] });
      const sql = readFileSync(
        fileURLToPath(new URL("../prisma/migrations/20261008_authz_consent_state_machine/migration.sql", import.meta.url)),
        "utf8"
      );
      // Recreate the pre-migration state: no constraint, plus a row an older version left ACTIVE while awaiting consent.
      await world.sql.query('ALTER TABLE "tenant_memberships" DROP CONSTRAINT tenant_memberships_active_requires_consent');
      await world.sql.query("SELECT set_config('app.bypass_rls','on',false)");
      await world.sql.query('UPDATE "tenant_memberships" SET "awaitingOwnerConsent" = true WHERE id = $1', [user.membershipId]);
      await world.sql.query("SELECT set_config('app.bypass_rls','',false)");

      await world.sql.query(sql); // must not abort on the bad row
      await world.sql.query(sql); // idempotent

      await world.sql.query("SELECT set_config('app.bypass_rls','on',false)");
      const rows = await world.sql.query('SELECT id, status FROM "tenant_memberships" WHERE id = ANY($1)', [[user.membershipId, ok.membershipId]]);
      const status = Object.fromEntries(rows.rows.map((r: { id: string; status: string }) => [r.id, r.status]));
      expect(status[user.membershipId]).toBe("INVITED");
      expect(status[ok.membershipId]).toBe("ACTIVE");
      const audit = await world.sql.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action = 'membership.consent_backfill_reverted' AND \"entityId\" = $1",
        [user.membershipId]
      );
      expect(audit.rows[0].n).toBe(1);
      await world.sql.query("SELECT set_config('app.bypass_rls','',false)");
      await expect(
        world.sql.query('UPDATE "tenant_memberships" SET status = \'ACTIVE\' WHERE id = $1', [user.membershipId])
      ).rejects.toThrow();
    } finally {
      await world.stop();
    }
  });
});
