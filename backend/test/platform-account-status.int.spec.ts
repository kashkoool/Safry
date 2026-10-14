import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Session, type TestTenant, type TestUser } from "./support/world.js";

/** The platform accounts list shows per-row sign-in block and e-mail verification state to platform admins only. */
describe("platform accounts list: sign-in block and verification state", () => {
  let world: World;
  let tenant: TestTenant;
  let platform: Session;
  let tenantAdmin: Session;
  let locked: TestUser;
  let unverified: TestUser;
  let clean: TestUser;
  const auth = (s: Session): { accessToken: string; tenantId: string } => ({ accessToken: s.accessToken, tenantId: s.user.tenantId });
  const row = async (user: TestUser): Promise<Record<string, unknown> | undefined> => {
    const reply = await world.api("GET", `/platform/records/users?page=1&q=${encodeURIComponent(user.email)}`, { session: auth(platform) });
    expect(reply.status).toBe(200);
    return (reply.body.items as Array<Record<string, unknown>>).find((item) => item.email === user.email);
  };

  beforeAll(async () => {
    world = await World.start({ LOGIN_MAX_ATTEMPTS: "5", LOGIN_LOCKOUT_MINUTES: "15" });
    tenant = await world.createTenant("acctstatus");
    platform = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true }));
    tenantAdmin = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"] }));
    locked = await world.createUser(tenant, { roles: ["traveler"] });
    unverified = await world.createUser(tenant, { roles: ["traveler"] });
    clean = await world.createUser(tenant, { roles: ["traveler"] });
    await world.prisma.user.update({ where: { id: unverified.userId }, data: { emailVerifiedAt: null } });
    await world.prisma.user.update({ where: { id: clean.userId }, data: { emailVerifiedAt: new Date() } });
    await world.prisma.user.update({ where: { id: locked.userId }, data: { emailVerifiedAt: new Date() } });
  });
  afterAll(async () => {
    await world.stop();
  });

  it("refuses a non-platform-admin", async () => {
    const reply = await world.api("GET", "/platform/records/users?page=1", { session: auth(tenantAdmin) });
    expect(reply.status).toBe(403);
    expect(JSON.stringify(reply.body)).not.toMatch(/lockedUntil|emailVerifiedAt/);
  });

  it("shows lockedUntil and emailVerifiedAt to a platform admin, and clears lockedUntil after unlock", async () => {
    for (let i = 0; i < 25; i++)
      await world.api("POST", "/auth/login", { body: { email: locked.email, password: "Wrong-Password-1", tenantCode: tenant.code } });
    const lockedRow = await row(locked);
    expect(new Date(lockedRow!.lockedUntil as string).getTime()).toBeGreaterThan(Date.now());
    expect(lockedRow!.emailVerifiedAt).not.toBeNull();
    const unverifiedRow = await row(unverified);
    expect(unverifiedRow!.emailVerifiedAt).toBeNull();
    expect(unverifiedRow!.lockedUntil).toBeNull();
    const cleanRow = await row(clean);
    expect(cleanRow!.lockedUntil).toBeNull();
    expect(cleanRow!.emailVerifiedAt).not.toBeNull();
    expect(Object.keys(cleanRow!)).not.toEqual(expect.arrayContaining(["passwordHash"]));

    expect((await world.api("POST", "/auth/login-throttle/unlock", { session: auth(platform), body: { email: locked.email } })).status).toBe(204);
    expect((await row(locked))!.lockedUntil).toBeNull();
  });
});
