import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Session, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Row-level security on the global `users` table (migration 20261018): a tenant session reaches only identities that hold
 * a membership in its tenant, cannot delete or create identities by itself, and cannot rewrite identity columns.
 * Pre-authentication and platform paths run in the explicit system scope and must keep working.
 */
describe("users row-level security", () => {
  let world: World;
  let a: TestTenant;
  let b: TestTenant;
  let adminA: TestUser;
  let travelerA: TestUser;
  let travelerB: TestUser;
  let outsiderB: TestUser;
  let platformAdmin: TestUser;
  let sessionAdminA: Session;

  const auth = (session: Session): { accessToken: string; tenantId: string } => ({ accessToken: session.accessToken, tenantId: session.user.tenantId });

  beforeAll(async () => {
    world = await World.start();
    a = await world.createTenant("urls-a");
    b = await world.createTenant("urls-b");
    adminA = await world.createUser(a, { roles: ["tenant-admin"] });
    travelerA = await world.createUser(a, { roles: ["traveler"] });
    travelerB = await world.createUser(b, { roles: ["traveler"] });
    outsiderB = await world.createUser(b, { roles: ["traveler"] });
    platformAdmin = await world.createUser(a, { roles: ["tenant-admin"], isPlatformAdmin: true });
    sessionAdminA = await world.session(adminA);
  });

  afterAll(async () => {
    await world.stop();
  });

  it("enables and forces RLS on users", async () => {
    const row = await world.sql.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'users'`
    );
    expect(row.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  describe("tenant session (database layer)", () => {
    it("sees only identities with a membership in its tenant, and nothing without a tenant", async () => {
      const mine = await world.asRole<{ id: string }>({ tenantId: a.id }, `SELECT id FROM users`);
      const ids = mine.rows.map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining([adminA.userId, travelerA.userId, platformAdmin.userId]));
      expect(ids).not.toContain(travelerB.userId);
      const foreign = await world.asRole({ tenantId: a.id }, `SELECT 1 FROM users WHERE id = $1 OR "emailNormalized" = $2`, [travelerB.userId, travelerB.email]);
      expect(foreign.rowCount).toBe(0);
      const none = await world.asRole<{ n: number }>({}, `SELECT count(*)::int AS n FROM users`);
      expect(none.rows[0]?.n).toBe(0);
    });

    it("cannot update an identity of another tenant", async () => {
      const result = await world.asRole({ tenantId: a.id }, `UPDATE users SET "displayName" = 'tampered' WHERE id = $1`, [travelerB.userId]);
      expect(result.rowCount).toBe(0);
      const hash = await world.asRole({ tenantId: a.id }, `UPDATE users SET "passwordHash" = 'x', email = 'x@evil.test', "mfaEnabledAt" = NULL WHERE id = $1`, [travelerB.userId]);
      expect(hash.rowCount).toBe(0);
      const stored = await world.sql.query<{ displayName: string }>(`SELECT "displayName" FROM users WHERE id = $1`, [travelerB.userId]);
      expect(stored.rows[0]?.displayName).not.toBe("tampered");
    });

    it("may edit profile columns of a member, but not email, password hash, MFA state or status, even of its own members", async () => {
      const profile = await world.asRole({ tenantId: a.id }, `UPDATE users SET "displayName" = 'Renamed', phone = '1', locale = 'en-US' WHERE id = $1`, [travelerA.userId]);
      expect(profile.rowCount).toBe(1);
      for (const column of [`"passwordHash" = 'x'`, `email = 'x@evil.test'`, `"emailNormalized" = 'x@evil.test'`, `"mfaEnabledAt" = now()`, `"mfaSecretEnc" = 'x'`, `"authVersion" = 99`, `status = 'DISABLED'`, `"deletedAt" = now()`])
        await expect(world.asRole({ tenantId: a.id }, `UPDATE users SET ${column} WHERE id = $1`, [travelerA.userId]), column).rejects.toThrow(/only be changed by the platform/);
    });

    it("cannot delete an identity, even a member", async () => {
      const own = await world.asRole({ tenantId: a.id }, `DELETE FROM users WHERE id = $1`, [travelerA.userId]);
      expect(own.rowCount).toBe(0);
      const foreign = await world.asRole({ tenantId: a.id }, `DELETE FROM users WHERE id = $1`, [travelerB.userId]);
      expect(foreign.rowCount).toBe(0);
    });

    const insert = `INSERT INTO users (id, email, "emailNormalized", "passwordHash", "displayName", "updatedAt") VALUES (gen_random_uuid(), 'rls-new@example.test', 'rls-new@example.test', 'x', 'x', now())`;

    it("cannot create an identity on its own, only through the narrow identity flag, which allows SELECT and INSERT but never UPDATE or DELETE", async () => {
      await expect(world.asRole({ tenantId: a.id }, insert)).rejects.toThrow(/row-level security/);
      const created = await world.asRole({ tenantId: a.id, identity: true }, `${insert} RETURNING id`);
      expect(created.rowCount).toBe(1);
      const lookup = await world.asRole({ tenantId: a.id, identity: true }, `SELECT id FROM users WHERE "emailNormalized" = $1`, [travelerB.email]);
      expect(lookup.rowCount).toBe(1);
      const update = await world.asRole({ tenantId: a.id, identity: true }, `UPDATE users SET "displayName" = 'tampered' WHERE id = $1`, [travelerB.userId]);
      expect(update.rowCount).toBe(0);
      const remove = await world.asRole({ tenantId: a.id, identity: true }, `DELETE FROM users WHERE id = $1`, [travelerB.userId]);
      expect(remove.rowCount).toBe(0);
      await expect(world.asRole({ tenantId: a.id, identity: true }, insert.replace('"updatedAt")', '"updatedAt", "isPlatformAdmin")').replace("now())", "now(), true)")))
        .rejects.toThrow(/only be changed by the platform/);
    });

    it("the system scope still reads and writes every identity", async () => {
      const all = await world.asRole<{ n: number }>({ bypass: true }, `SELECT count(*)::int AS n FROM users WHERE id = ANY($1)`, [[travelerA.userId, travelerB.userId]]);
      expect(all.rows[0]?.n).toBe(2);
      const edited = await world.asRole({ bypass: true }, `UPDATE users SET "passwordHash" = "passwordHash" WHERE id = $1`, [travelerB.userId]);
      expect(edited.rowCount).toBe(1);
    });
  });

  describe("mutation check: the isolation assertions fail when the protection is removed", () => {
    // Each mutation runs inside the probe's own rolled-back transaction, so the shared test database is never changed.
    const crossTenantRead = (before: string[]) =>
      world.asRole({ tenantId: a.id }, `SELECT 1 FROM users WHERE id = $1`, [travelerB.userId], before);
    const crossTenantUpdate = (before: string[]) =>
      world.asRole({ tenantId: a.id }, `UPDATE users SET "displayName" = 'tampered' WHERE id = $1`, [travelerB.userId], before);
    const identityWrite = (before: string[]) =>
      world.asRole({ tenantId: a.id }, `UPDATE users SET "passwordHash" = 'x' WHERE id = $1`, [travelerA.userId], before);

    it("baseline: all three probes are blocked", async () => {
      expect((await crossTenantRead([])).rowCount).toBe(0);
      expect((await crossTenantUpdate([])).rowCount).toBe(0);
      await expect(identityWrite([])).rejects.toThrow();
    });

    it("dropping the select policy and opening it up lets tenant A read tenant B's identity", async () => {
      const opened = await crossTenantRead([`DROP POLICY users_select ON users`, `CREATE POLICY users_select ON users FOR SELECT USING (true)`]);
      expect(opened.rowCount).toBe(1);
    });

    it("dropping the update policy and opening it up lets tenant A change tenant B's identity", async () => {
      const opened = await crossTenantUpdate([`DROP POLICY users_select ON users`, `CREATE POLICY users_select ON users FOR SELECT USING (true)`, `DROP POLICY users_update ON users`, `CREATE POLICY users_update ON users FOR UPDATE USING (true) WITH CHECK (true)`]);
      expect(opened.rowCount).toBe(1);
    });

    it("disabling row-level security on users removes the isolation", async () => {
      const opened = await crossTenantRead([`ALTER TABLE users DISABLE ROW LEVEL SECURITY`]);
      expect(opened.rowCount).toBe(1);
    });

    it("dropping the column guard lets a tenant session rewrite a password hash", async () => {
      const opened = await identityWrite([`DROP TRIGGER users_platform_admin_guard ON users`]);
      expect(opened.rowCount).toBe(1);
    });
  });

  describe("flows that run before a tenant is known or as the platform keep working", () => {
    it("login, registration, forgot-password and platform administration", async () => {
      expect((await world.login(travelerA)).status).toBe(200);
      const email = `${world.unique("rls-reg")}@example.test`;
      const registered = await world.api("POST", "/auth/register/customer", { body: { displayName: "Reg", email, password: "Registered-Pass-2026", tenantCode: a.code } });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      const forgot = await world.api("POST", "/auth/password/forgot", { body: { email: travelerA.email } });
      expect(forgot.status).toBe(202);
      const platform = await world.session(platformAdmin);
      const list = await world.api("GET", `/platform/records/users?page=1&q=${encodeURIComponent(travelerB.email)}`, { session: auth(platform) });
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain(travelerB.email);
    });

    it("a tenant admin can create staff with a new identity, invite an identity that exists only in another tenant, and reads no foreign profile", async () => {
      const orgId = await world.createOrganization(a);
      const manager = await world.session(await world.createUser(a, { roles: ["travel-company", "organization-manager"], organizationId: orgId }));
      const department = await world.api("POST", `/organizations/${orgId}/departments`, { session: auth(manager), body: { code: "ops", name: "Ops" } });
      const body = (email: string) => ({ email, displayName: "Typed Name", password: `Staff-Typed-${world.stamp}-Pw`, jobTitle: "Agent", departmentId: department.body.id, roleIds: [a.roleIds["travel-company"]] });
      const fresh = await world.api("POST", `/organizations/${orgId}/employees`, { session: auth(manager), body: body(`${world.unique("rls-staff")}@example.test`) });
      expect(fresh.status).toBe(201);
      expect(fresh.body).toMatchObject({ status: "ACTIVE" });
      const invited = await world.api("POST", `/organizations/${orgId}/employees`, { session: auth(manager), body: body(travelerB.email) });
      expect(invited.status).toBe(201);
      expect(invited.body).toMatchObject({ status: "INVITED", awaitingOwnerConsent: true });
      const stored = await world.sql.query<{ displayName: string }>(`SELECT "displayName" FROM users WHERE id = $1`, [travelerB.userId]);
      expect(stored.rows[0]?.displayName).not.toBe("Typed Name");
      const accept = await world.api("POST", `/users/me/invitations/${invited.body.id as string}/accept`, { session: auth(await world.session(travelerB)) });
      expect(accept.status).toBeLessThan(300);
    });

    it("a member profile update and the member list work in the tenant session", async () => {
      const update = await world.api("PATCH", "/users/me", { session: auth(sessionAdminA), body: { displayName: "Admin A Renamed" } });
      expect(update.status).toBe(200);
      const members = await world.api("GET", "/tenants/members", { session: auth(sessionAdminA) });
      expect(members.status).toBe(200);
      expect(JSON.stringify(members.body)).not.toContain(outsiderB.email);
    });
  });
});
