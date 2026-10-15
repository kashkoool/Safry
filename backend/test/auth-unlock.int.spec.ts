import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Reply, type TestTenant, type TestUser } from "./support/world.js";

/** The platform administrator's Unlock lifts every sign-in block of the e-mail, including the one of the address that caused it. */
describe("login throttle unlock", () => {
  let world: World;
  let tenant: TestTenant;
  let ipCounter = 0;
  const nextIp = (): string => `198.51.100.${100 + ++ipCounter}`;

  const loginFrom = (ip: string, user: Pick<TestUser, "email" | "tenant">, password: string): Promise<Reply> =>
    world.api("POST", "/auth/login", { headers: { "x-forwarded-for": ip }, body: { email: user.email, password, tenantCode: user.tenant.code } });

  beforeAll(async () => {
    world = await World.start({ TRUST_PROXY: "true", LOGIN_MAX_ATTEMPTS: "5", LOGIN_LOCKOUT_MINUTES: "15" });
    tenant = await world.createTenant("unlk");
  });
  afterAll(async () => {
    await world.stop();
  });

  const unlockAs = async (admin: { email: string; password: string; tenant: TestTenant } & TestUser, email: string): Promise<Reply> => {
    const session = await world.session(admin);
    return world.api("POST", "/auth/login-throttle/unlock", { session: { accessToken: session.accessToken, tenantId: session.user.tenantId }, body: { email } });
  };

  it("lets the user sign in again from every address that was blocked, and only that user", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const bystander = await world.createUser(tenant, { roles: ["traveler"] });
    const [a, b] = [nextIp(), nextIp()];
    for (const ip of [a, b]) for (let i = 0; i < 5; i += 1) await loginFrom(ip, user, "Wrong-Password-1");
    for (const ip of [a, b]) expect((await loginFrom(ip, user, user.password)).status).toBe(401);
    // The bystander's own block from address a must survive an unlock of somebody else.
    for (let i = 0; i < 5; i += 1) await loginFrom(a, bystander, "Wrong-Password-1");
    expect((await loginFrom(a, bystander, bystander.password)).status).toBe(401);

    const admin = await world.createUser(tenant, { roles: ["traveler"], isPlatformAdmin: true });
    expect((await unlockAs(admin, user.email)).status).toBe(204);
    expect((await loginFrom(a, user, user.password)).status).toBe(200);
    expect((await loginFrom(b, user, user.password)).status).toBe(200);
    expect((await loginFrom(a, bystander, bystander.password)).status).toBe(401);
    expect(await world.prisma.auditEvent.count({ where: { actorUserId: admin.userId, action: "identity.login_throttle.unlock" } })).toBe(1);
  });

  it("stays platform-administrator only", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const ip = nextIp();
    for (let i = 0; i < 5; i += 1) await loginFrom(ip, user, "Wrong-Password-1");
    const tenantAdmin = await world.createUser(tenant, { roles: ["tenant-admin"] });
    expect((await unlockAs(tenantAdmin, user.email)).status).toBe(403);
    expect((await loginFrom(ip, user, user.password)).status).toBe(401);
  });
});
