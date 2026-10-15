import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hotp, totpStep } from "../dist/common/security/totp.js";
import { World, type Session, type TestTenant } from "./support/world.js";

/** Platform administrators must hold an enrolled second factor; without one they can only enrol. */
describe("platform administrators need MFA", () => {
  let world: World;
  let tenant: TestTenant;

  const auth = (session: Session): { accessToken: string; tenantId: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user.tenantId
  });

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("pla-mfa");
  });

  afterAll(async () => {
    await world.stop();
  });

  it("denies every platform route with 403 mfa_enrollment_required until the administrator enrols, but allows enrolment, /me and logout", async () => {
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true, mfa: false });
    const session = await world.session(admin);
    for (const [method, path] of [
      ["GET", "/platform/overview"],
      ["GET", "/platform/references"],
      ["GET", "/platform/tenants"],
      ["POST", "/auth/login-throttle/unlock"]
    ] as const) {
      const reply = await world.api(method, path, { session: auth(session), body: method === "POST" ? { email: "x@example.test" } : undefined });
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(reply.body?.code, `${method} ${path}`).toBe("mfa_enrollment_required");
    }
    // The enrolment path stays open, so nobody is locked out.
    const me = await world.api("GET", "/auth/me", { session: auth(session) });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ isPlatformAdmin: true, mfaEnabled: false });
    expect((await world.api("GET", "/auth/mfa", { session: auth(session) })).status).toBe(200);
    await world.enrollMfa(admin);
    const after = await world.session(admin);
    expect((await world.api("GET", "/platform/overview", { session: auth(after) })).status).toBe(200);
    expect((await world.api("GET", "/auth/me", { session: auth(after) })).body?.mfaEnabled).toBe(true);
  });

  it("the enrolling session itself passes the guard right after enabling MFA (state is read per request)", async () => {
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true, mfa: false });
    const session = await world.session(admin);
    expect((await world.api("GET", "/platform/overview", { session: auth(session) })).status).toBe(403);
    const setup = await world.api("POST", "/auth/mfa/setup", { session: auth(session), body: { password: admin.password } });
    expect(setup.status).toBe(200);
    const enabled = await world.api("POST", "/auth/mfa/enable", { session: auth(session), body: { code: hotp(setup.body?.secret as string, totpStep()) } });
    expect(enabled.status).toBe(200);
    expect((await world.api("GET", "/platform/overview", { session: auth(session) })).status).toBe(200);
  });

  it("step-up for a platform administrator always needs a code, never the password alone", async () => {
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
    const target = await world.createUser(tenant, { roles: ["traveler"] });
    await world.enrollMfa(target);
    const session = await world.session(admin);
    const grant = (extra: object) =>
      world.api("PATCH", `/platform/users/${target.userId}`, { session: auth(session), body: { isPlatformAdmin: true, ...extra } });
    expect((await grant({ currentPassword: admin.password })).status).toBe(401);
    expect((await grant({ currentPassword: admin.password, mfaCode: "000000" })).status).toBe(401);
    expect((await world.prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).isPlatformAdmin).toBe(false);
    expect((await grant({ currentPassword: admin.password, mfaCode: await world.mfaCode(admin) })).status).toBe(200);
    // Survivor: the new administrator signs in (with the code) and reaches platform routes.
    const next = await world.session(target);
    expect((await world.api("GET", "/platform/overview", { session: auth(next) })).status).toBe(200);
  });

  it("an administrator whose factor was cleared is stopped by the guard before any step-up", async () => {
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
    const session = await world.session(admin);
    await world.prisma.user.update({ where: { id: admin.userId }, data: { mfaEnabledAt: null, mfaSecretEnc: null } });
    const reply = await world.api("PATCH", `/platform/users/${admin.userId}`, {
      session: auth(session),
      body: { displayName: "Renamed", isPlatformAdmin: true, currentPassword: admin.password }
    });
    expect(reply.status).toBe(403);
    expect(reply.body?.code).toBe("mfa_enrollment_required");
  });

  it("rejects granting platform administration to an account without MFA, and accepts it once enrolled", async () => {
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
    const target = await world.createUser(tenant, { roles: ["traveler"] });
    const session = await world.session(admin);
    // The step-up code is single use, so ask for a fresh one per call.
    const grant = async () =>
      world.api("PATCH", `/platform/users/${target.userId}`, {
        session: auth(session),
        body: { isPlatformAdmin: true, currentPassword: admin.password, mfaCode: await world.mfaCode(admin) }
      });
    const refused = await grant();
    expect(refused.status).toBe(409);
    expect(refused.body?.code).toBe("target_mfa_required");
    expect((await world.prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).isPlatformAdmin).toBe(false);
    await world.enrollMfa(target);
    expect((await grant()).status).toBe(200);
    // Survivor: an ordinary edit of an existing administrator is not blocked by the grant rule.
    await world.prisma.user.update({ where: { id: target.userId }, data: { mfaEnabledAt: null } });
    const rename = await world.api("PATCH", `/platform/users/${target.userId}`, {
      session: auth(session),
      body: { displayName: "Still admin", isPlatformAdmin: true }
    });
    expect(rename.status).toBe(200);
  });

  it("a platform administrator cannot switch their own MFA off", async () => {
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
    const session = await world.session(admin);
    const reply = await world.api("POST", "/auth/mfa/disable", {
      session: auth(session),
      body: { password: admin.password, code: await world.mfaCode(admin) }
    });
    expect(reply.status).toBe(409);
    expect((await world.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } })).mfaEnabledAt).not.toBeNull();
  });

  it("leaves tenant users unaffected", async () => {
    const tenantAdmin = await world.createUser(tenant, { roles: ["tenant-admin"] });
    const session = await world.session(tenantAdmin);
    expect((await world.api("GET", "/tenants/current", { session: auth(session) })).status).toBe(200);
    expect((await world.api("GET", "/auth/me", { session: auth(session) })).body?.mfaEnabled).toBe(false);
    // A non-admin is refused on platform routes with the plain 403 and no enrolment hint.
    const reply = await world.api("GET", "/platform/overview", { session: auth(session) });
    expect(reply.status).toBe(403);
    expect(reply.body?.code).toBeUndefined();
  });
});
