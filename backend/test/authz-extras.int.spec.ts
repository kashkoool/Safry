import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { hotp, totpStep } from "../dist/common/security/totp.js";
import { World, type Session } from "./support/world.js";

/** Authorization extras: forged cursors, body limit, invitation races, privileged step-up, idempotent bookings. */
describe("authorization extras", () => {
  let world: World;
  const auth = (session: Session): { accessToken: string; tenantId: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user.tenantId
  });

  beforeAll(async () => {
    world = await World.start();
  });
  afterAll(async () => {
    await world.stop();
  });

  it("a forged provider cursor with a non-UUID id answers 400, not 500", async () => {
    const tenant = await world.createTenant("w2-cursor");
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"] });
    const session = await world.session(admin);
    const cursor = Buffer.from(JSON.stringify({ name: "a", id: "not-a-uuid" })).toString("base64url");
    expect((await world.api("GET", `/providers?cursor=${cursor}`, { session: auth(session) })).status).toBe(400);
  });

  it("a body over BODY_LIMIT answers 413 with a fixed message", async () => {
    const reply = await world.api("POST", "/auth/login", { body: { email: "a@example.test", password: "x".repeat(300_000) } });
    expect(reply.status).toBe(413);
    expect(reply.body.message).toBe("Payload too large");
  });

  /** An identity with an ACTIVE membership in its home tenant and a pending invitation into `tenant`. */
  async function invitation(tenant: Awaited<ReturnType<World["createTenant"]>>): Promise<{ id: string; session: Session }> {
    const home = await world.createTenant("w2-home");
    const owner = await world.createUser(home, { roles: ["traveler"] });
    const row = await world.prisma.tenantMembership.create({
      data: { tenantId: tenant.id, userId: owner.userId, status: "INVITED", awaitingOwnerConsent: true }
    });
    return { id: row.id, session: await world.session(owner) };
  }

  it("a concurrent accept and decline of one invitation cannot both succeed", async () => {
    const tenant = await world.createTenant("w2-race");
    const { id, session } = await invitation(tenant);
    const replies = await Promise.all([
      world.api("POST", `/users/me/invitations/${id}/accept`, { session: auth(session) }),
      world.api("POST", `/users/me/invitations/${id}/decline`, { session: auth(session) })
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 404]);
    const audits = await world.prisma.auditEvent.count({
      where: { entityId: id, action: { startsWith: "identity.membership.invitation." } }
    });
    expect(audits).toBe(1);
  });

  it("a pending invitation cannot be suspended (it would be a dead end); it can be revoked", async () => {
    const tenant = await world.createTenant("w2-suspend");
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"] });
    const adminSession = await world.session(admin);
    const { id } = await invitation(tenant);
    const suspend = await world.api("PATCH", `/tenants/members/${id}/status`, { session: auth(adminSession), body: { status: "SUSPENDED" } });
    expect(suspend.status).toBe(409);
    expect((await world.prisma.tenantMembership.findUniqueOrThrow({ where: { id } })).status).toBe("INVITED");
    const revoke = await world.api("PATCH", `/tenants/members/${id}/status`, { session: auth(adminSession), body: { status: "REVOKED" } });
    expect(revoke.status).toBe(200);
  });

  it("an identity holding the maximum of unanswered invitations gets no more", async () => {
    const tenant = await world.createTenant("w2-spam");
    const manager = await world.createUser(tenant, { roles: ["tenant-admin"] });
    const orgId = await world.createOrganization(tenant);
    const orgManager = await world.createUser(tenant, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
    const managerSession = await world.session(orgManager);
    void manager;
    const department = await world.api("POST", `/organizations/${orgId}/departments`, { session: auth(managerSession), body: { code: "ops", name: "Operations" } });
    expect(department.status).toBe(201);
    const victim = await world.createUser(await world.createTenant("w2-victim-home"), { roles: ["traveler"] });
    for (let i = 0; i < 20; i++) {
      const other = await world.createTenant("w2-other");
      await world.prisma.tenantMembership.create({ data: { tenantId: other.id, userId: victim.userId, status: "INVITED", awaitingOwnerConsent: true } });
    }
    const invite = (email: string): Promise<{ status: number }> =>
      world.api("POST", `/organizations/${orgId}/employees`, {
        session: auth(managerSession),
        body: {
          email, displayName: "Typed", password: `Manager-Typed-${world.stamp}-Pw`, jobTitle: "Agent",
          departmentId: department.body.id, roleIds: [tenant.roleIds["travel-company"]]
        }
      });
    expect((await invite(victim.email)).status).toBe(409);
    expect(await world.prisma.tenantMembership.count({ where: { tenantId: tenant.id, userId: victim.userId } })).toBe(0);
    expect((await invite(`fresh-${world.stamp}@example.test`)).status).toBe(201);
  });

  it("tenant settings reject arrays where an object is required", async () => {
    const tenant = await world.createTenant("w2-array");
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"] });
    const session = await world.session(admin);
    const patch = (settings: unknown): Promise<{ status: number }> =>
      world.api("PATCH", "/tenants/current", { session: auth(session), body: { settings } });
    expect((await patch({ branding: [{ primaryColor: "#fff000" }] })).status).toBe(400);
    expect((await patch([{ currency: "SAR" }])).status).toBe(400);
    expect((await patch({ branding: { primaryColor: "#fff000" } })).status).toBe(200);
  });

  describe("granting platform administration needs a second step", () => {
    it("refuses without the acting admin's password, and with a wrong one; accepts with the right one", async () => {
      const tenant = await world.createTenant("w2-grant");
      const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
      const target = await world.enrollMfa(await world.createUser(tenant, { roles: ["traveler"] }));
      const session = await world.session(admin);
      const grant = (extra: object): Promise<{ status: number }> =>
        world.api("PATCH", `/platform/users/${target.userId}`, { session: auth(session), body: { isPlatformAdmin: true, ...extra } });
      const isAdmin = async (): Promise<boolean> => (await world.prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).isPlatformAdmin;
      expect((await grant({})).status).toBe(401);
      expect((await grant({ currentPassword: "Wrong-Password-123" })).status).toBe(401);
      expect((await grant({ currentPassword: admin.password })).status).toBe(401); // a platform admin never steps up on the password alone
      expect(await isAdmin()).toBe(false);
      expect((await grant({ currentPassword: admin.password, mfaCode: await world.mfaCode(admin) })).status).toBe(200);
      expect(await isAdmin()).toBe(true);
      // Survivors: ordinary edits and a re-save of an existing admin stay step-up free.
      const fresh = await world.session(admin);
      const rename = await world.api("PATCH", `/platform/users/${target.userId}`, { session: auth(fresh), body: { displayName: "Renamed", isPlatformAdmin: true } });
      expect(rename.status).toBe(200);
    });

    it("needs a current MFA code (platform admins always have MFA), and never leaks the secrets into the audit row", async () => {
      const tenant = await world.createTenant("w2-grant-mfa");
      const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
      const target = await world.enrollMfa(await world.createUser(tenant, { roles: ["traveler"] }));
      const first = await world.session(admin);
      const secret = admin.mfaSecret as string;
      const grant = (extra: object): Promise<{ status: number }> =>
        world.api("PATCH", `/platform/users/${target.userId}`, { session: auth(first), body: { isPlatformAdmin: true, ...extra } });
      expect((await grant({ currentPassword: admin.password })).status).toBe(401);
      expect((await grant({ currentPassword: admin.password, mfaCode: "000000" })).status).toBe(401);
      expect((await world.prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).isPlatformAdmin).toBe(false);
      expect((await grant({ currentPassword: admin.password, mfaCode: hotp(secret, totpStep() + 1) })).status).toBe(200);
      const audit = await world.prisma.auditEvent.findMany({ where: { entityId: target.userId, action: "platform.account.update" } });
      expect(JSON.stringify(audit)).not.toContain(admin.password);
    });
  });

  describe("the other privilege-granting platform operations need the same second step", () => {
    it("POST /platform/users with the tenant-admin role needs the password; an ordinary role does not", async () => {
      const tenant = await world.createTenant("w2-su-create");
      const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
      const session = await world.session(admin);
      const body = (roleCode: string, extra: object = {}): object => ({ email: `${world.unique("su")}@example.test`, displayName: "Created", phone: "", password: `Created-${world.stamp}-Pw1`, tenantId: tenant.id, roleId: tenant.roleIds[roleCode], ...extra });
      const post = (payload: object): Promise<{ status: number }> => world.api("POST", "/platform/users", { session: auth(session), body: payload });
      expect((await post(body("tenant-admin"))).status).toBe(401);
      expect((await post(body("tenant-admin", { currentPassword: "Wrong-Password-123" }))).status).toBe(401);
      expect((await post(body("tenant-admin", { currentPassword: admin.password }))).status).toBe(401); // password alone is never enough
      expect((await post(body("tenant-admin", { currentPassword: admin.password, mfaCode: await world.mfaCode(admin) }))).status).toBe(201);
      expect((await post(body("traveler"))).status).toBe(201); // survivor: ordinary accounts stay step-up free
    });

    it("PATCH /platform/memberships/:id/access needs it only when it grants tenant-admin", async () => {
      const tenant = await world.createTenant("w2-su-access");
      const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
      const target = await world.createUser(tenant, { roles: ["traveler"] });
      const session = await world.session(admin);
      const patch = (roleCodes: string[], extra: object = {}): Promise<{ status: number }> =>
        world.api("PATCH", `/platform/memberships/${target.membershipId}/access`, {
          session: auth(session),
          body: { roleIds: roleCodes.map((code) => tenant.roleIds[code]), permissionOverrides: {}, status: "ACTIVE", ...extra }
        });
      const roles = async (): Promise<string[]> =>
        (await world.prisma.membershipRole.findMany({ where: { membershipId: target.membershipId }, include: { role: true } })).map((r) => r.role.code).sort();
      expect((await patch(["tenant-admin"])).status).toBe(401);
      expect(await roles()).toEqual(["traveler"]);
      expect((await patch(["tenant-admin"], { currentPassword: admin.password, mfaCode: await world.mfaCode(admin) })).status).toBe(200);
      expect(await roles()).toEqual(["tenant-admin"]);
      // survivors: keeping the admin role (re-save) and demoting need no step-up
      expect((await patch(["tenant-admin"])).status).toBe(200);
      expect((await patch(["traveler"])).status).toBe(200);
    });

    it("POST /platform/users/:id/state on another platform administrator needs it; on an ordinary account it does not", async () => {
      const tenant = await world.createTenant("w2-su-state");
      const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
      const otherAdmin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
      const ordinary = await world.createUser(tenant, { roles: ["traveler"] });
      const session = await world.session(admin);
      const state = (id: string, extra: object = {}): Promise<{ status: number }> =>
        world.api("POST", `/platform/users/${id}/state`, { session: auth(session), body: { action: "SUSPENDED", reason: "test", ...extra } });
      expect((await state(otherAdmin.userId)).status).toBe(401);
      expect((await world.prisma.user.findUniqueOrThrow({ where: { id: otherAdmin.userId } })).status).toBe("ACTIVE");
      expect((await state(otherAdmin.userId, { currentPassword: admin.password, mfaCode: await world.mfaCode(admin) })).status).toBe(201);
      expect((await state(ordinary.userId)).status).toBe(201);
    });
  });

  describe("an idempotent replay returns the stored booking without re-validating", () => {
    it("a retry after the service became unavailable still gets the first booking; a different body for the key is 409; a fresh key is refused", async () => {
      const tenant = await world.createTenant("w2-idem-replay");
      const orgId = await world.createOrganization(tenant, "TRAVEL_COMPANY");
      const owner = await world.createUser(tenant, { roles: ["travel-company"], organizationId: orgId });
      const serviceId = await world.createService(tenant, owner, { capacity: 50 });
      const traveler = await world.createUser(tenant, { roles: ["traveler"] });
      const session = await world.session(traveler);
      const body = { serviceId, travelersCount: 2, serviceDate: world.futureDate() };
      const post = (extra: object, key: string) => world.api("POST", "/bookings", { session: auth(session), body: { ...body, ...extra }, headers: { "idempotency-key": key } });
      const key = `replay-${world.stamp}-1`;
      const first = await post({}, key);
      expect(first.status).toBe(201);
      await world.prisma.travelService.update({ where: { id: serviceId }, data: { status: "INACTIVE" } });
      const retry = await post({}, key);
      expect(retry.status).toBe(201);
      expect(retry.body.id).toBe(first.body.id);
      expect((await post({ travelersCount: 3 }, key)).status).toBe(409);
      expect((await post({ serviceDate: world.futureDate(40) }, key)).status).toBe(409);
      // survivor: a NEW key for the unavailable service is still refused
      expect((await post({}, `replay-${world.stamp}-2`)).status).toBe(409);
      expect(await world.prisma.booking.count({ where: { travelerMembershipId: traveler.membershipId } })).toBe(1);
    });
  });

  describe("Idempotency-Key on POST /bookings", () => {
    it("returns the first booking for a retried request, refuses a reused key with a different request, and never merges keyless bookings", async () => {
      const tenant = await world.createTenant("w2-idem");
      const orgId = await world.createOrganization(tenant, "TRAVEL_COMPANY");
      const owner = await world.createUser(tenant, { roles: ["travel-company"], organizationId: orgId });
      const serviceId = await world.createService(tenant, owner, { capacity: 50 });
      const traveler = await world.createUser(tenant, { roles: ["traveler"] });
      const other = await world.createUser(tenant, { roles: ["traveler"] });
      const session = await world.session(traveler);
      const otherSession = await world.session(other);
      const body = { serviceId, travelersCount: 2, serviceDate: world.futureDate() };
      const post = (s: Session, extra: object, headers: Record<string, string> = {}) =>
        world.api("POST", "/bookings", { session: auth(s), body: { ...body, ...extra }, headers });
      const count = (membershipId: string): Promise<number> => world.prisma.booking.count({ where: { travelerMembershipId: membershipId } });
      const key = `retry-${world.stamp}-1`;

      const first = await post(session, {}, { "idempotency-key": key });
      expect(first.status).toBe(201);
      const again = await post(session, {}, { "idempotency-key": key });
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(first.body.id);
      expect(await count(traveler.membershipId)).toBe(1);

      // The same key with a different request is a client bug, not a retry.
      expect((await post(session, { travelersCount: 3 }, { "idempotency-key": key })).status).toBe(409);
      expect(await count(traveler.membershipId)).toBe(1);
      // Another traveler's identical key is a different booking.
      expect((await post(otherSession, {}, { "idempotency-key": key })).status).toBe(201);
      // A malformed key is refused up front.
      expect((await post(session, {}, { "idempotency-key": "short" })).status).toBe(400);
      // Without a key every submit is a new booking, as before.
      expect((await post(session, {})).status).toBe(201);
      expect((await post(session, {})).status).toBe(201);
      expect(await count(traveler.membershipId)).toBe(3);

      // Two simultaneous submits with one key create exactly one booking.
      const racing = `race-${world.stamp}-2`;
      const replies = await Promise.all([post(session, {}, { "idempotency-key": racing }), post(session, {}, { "idempotency-key": racing })]);
      expect(replies.map((reply) => reply.status)).toEqual([201, 201]);
      expect(replies[0]!.body.id).toBe(replies[1]!.body.id);
      expect(await count(traveler.membershipId)).toBe(4);
    });
  });

  it("platform record paging is capped at page 1000", async () => {
    const tenant = await world.createTenant("w2-page");
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
    const session = await world.session(admin);
    expect((await world.api("GET", "/platform/records/users?page=1001", { session: auth(session) })).status).toBe(400);
    expect((await world.api("GET", "/platform/records/users?page=1000", { session: auth(session) })).status).toBe(200);
  });

  // Keep last: the failed boot leaves a half-started app behind in this process.
  it("the API refuses to boot when DATABASE_APP_ROLE bypasses row-level security", async () => {
    const role = `w2_bypass_${world.stamp}`;
    await world.sql.query(`CREATE ROLE ${role} NOLOGIN BYPASSRLS`);
    // With TEST_APP_AS_RUNTIME=1 the app login must be allowed to switch to the role, or the boot probe fails earlier for another reason.
    const runtimeLogin = inject("runtimeDatabaseUrl") ? new URL(inject("runtimeDatabaseUrl")).username : "";
    if (runtimeLogin) await world.sql.query(`GRANT ${role} TO ${runtimeLogin}`);
    try {
      await expect(World.start({ DATABASE_APP_ROLE: role })).rejects.toThrow(/row-level security would not apply/);
    } finally {
      delete process.env["DATABASE_APP_ROLE"];
      await world.sql.query(`DROP ROLE ${role}`);
    }
  });
});
