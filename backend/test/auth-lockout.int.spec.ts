import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Reply, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Login throttling: failures are counted per e-mail and
 * client address with a progressive, always-expiring block, the check is atomic, and the answers
 * do not reveal whether an account exists or is blocked.
 */
describe("auth login throttling", () => {
  let world: World;
  let tenant: TestTenant;
  let ipCounter = 0;
  const nextIp = (): string => `198.51.100.${++ipCounter}`;

  const loginFrom = (ip: string, user: Pick<TestUser, "email" | "tenant">, password: string): Promise<Reply> =>
    world.api("POST", "/auth/login", {
      headers: { "x-forwarded-for": ip },
      body: { email: user.email, password, tenantCode: user.tenant.code }
    });
  const failedAudits = async (userId: string): Promise<Array<{ reason: string }>> =>
    (
      await world.prisma.auditEvent.findMany({ where: { actorUserId: userId, action: "identity.login.failed" }, select: { metadata: true } })
    ).map((event) => event.metadata as { reason: string });

  beforeAll(async () => {
    world = await World.start({ TRUST_PROXY: "true", LOGIN_MAX_ATTEMPTS: "5", LOGIN_LOCKOUT_MINUTES: "15" });
    tenant = await world.createTenant("lock");
  });

  afterAll(async () => {
    await world.stop();
  });

  it("blocks the attacking address but not the owner signing in from elsewhere", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const attacker = nextIp();
    for (let attempt = 0; attempt < 5; attempt++) expect((await loginFrom(attacker, user, "Wrong-Password-1")).status).toBe(401);
    // The attacker's address is now blocked even with the right password ...
    expect((await loginFrom(attacker, user, user.password)).status).toBe(401);
    // ... while the owner, from a different address, gets in.
    expect((await loginFrom(nextIp(), user, user.password)).status).toBe(200);
  });

  it("answers a blocked account exactly like a wrong password or an unknown e-mail (no 429, no remaining time)", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const ip = nextIp();
    const wrong = await loginFrom(ip, user, "Wrong-Password-1");
    for (let attempt = 0; attempt < 4; attempt++) await loginFrom(ip, user, "Wrong-Password-1");
    const blocked = await loginFrom(ip, user, user.password);
    const unknown = await loginFrom(ip, { email: `${world.unique("nobody")}@example.test`, tenant }, "Wrong-Password-1");
    const shape = (reply: Reply): unknown => ({ status: reply.status, statusCode: reply.body.statusCode, message: reply.body.message, keys: Object.keys(reply.body).sort() });
    expect(blocked.status).toBe(401);
    expect(shape(blocked)).toEqual(shape(wrong));
    expect(shape(unknown)).toEqual(shape(wrong));
  });

  it("does the same throttle work for unknown e-mails (throttle rows written, no audit row stored)", async () => {
    const email = `${world.unique("ghost")}@example.test`;
    const before = await world.prisma.loginThrottle.count();
    const audits = await world.prisma.auditEvent.count({ where: { action: "identity.login.failed", actorUserId: null } });
    const reply = await loginFrom(nextIp(), { email, tenant }, "Wrong-Password-1");
    expect(reply.status).toBe(401);
    expect(await world.prisma.loginThrottle.count()).toBe(before + 2);
    // An unknown account has nothing to attach the row to: it is counted in a metric instead (see audit-growth.int.spec.ts).
    expect(await world.prisma.auditEvent.count({ where: { action: "identity.login.failed", actorUserId: null } })).toBe(audits);
  });

  it("checks and counts atomically: a burst of parallel guesses cannot exceed the limit", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const ip = nextIp();
    const replies = await Promise.all(Array.from({ length: 20 }, () => loginFrom(ip, user, "Wrong-Password-1")));
    expect(replies.every((reply) => reply.status === 401)).toBe(true);
    const verified = (await failedAudits(user.userId)).filter((metadata) => metadata.reason === "bad_password");
    expect(verified.length).toBeLessThanOrEqual(5);
  });

  it("never locks permanently: the block expires on its own and grows progressively", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const ip = nextIp();
    for (let attempt = 0; attempt < 5; attempt++) await loginFrom(ip, user, "Wrong-Password-1");
    const first = await world.prisma.loginThrottle.findMany({ where: { blockedUntil: { not: null } } });
    const firstBlock = Math.max(...first.map((row) => row.blockedUntil!.getTime()));
    expect(firstBlock).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    // Expire every block, as time would.
    await world.prisma.loginThrottle.updateMany({ data: { blockedUntil: new Date(Date.now() - 1000) } });
    const before = Date.now();
    expect((await loginFrom(ip, user, "Wrong-Password-1")).status).toBe(401);
    const rows = await world.prisma.loginThrottle.findMany({ where: { blockedUntil: { gt: new Date() } } });
    // The sixth consecutive failure blocks for longer than the fifth (progressive delay), still bounded.
    expect(rows.length).toBeGreaterThan(0);
    const longest = Math.max(...rows.map((row) => row.blockedUntil!.getTime() - before));
    expect(longest).toBeGreaterThan(60_000);
    expect(longest).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    await world.prisma.loginThrottle.updateMany({ data: { blockedUntil: new Date(Date.now() - 1000) } });
    expect((await loginFrom(ip, user, user.password)).status).toBe(200);
  });

  it("bounds distributed guessing account-wide, exempts the owner's known address, and lets a platform admin unlock", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const home = nextIp();
    expect((await loginFrom(home, user, user.password)).status).toBe(200);
    // 21 guesses from 21 addresses: each address stays under its own limit, the e-mail does not.
    for (let attempt = 0; attempt < 21; attempt++) expect((await loginFrom(nextIp(), user, "Wrong-Password-1")).status).toBe(401);
    expect((await loginFrom(nextIp(), user, user.password)).status).toBe(401);
    // The address the owner signed in from before is exempt from the account-wide block.
    expect((await loginFrom(home, user, user.password)).status).toBe(200);

    const unlock = (session: { accessToken: string; user: { tenantId: string } }) =>
      world.api("POST", "/auth/login-throttle/unlock", { session: { accessToken: session.accessToken, tenantId: session.user.tenantId }, body: { email: user.email } });
    const someone = await world.createUser(tenant, { roles: ["traveler"] });
    expect((await unlock(await world.session(someone))).status).toBe(403);
    expect((await loginFrom(nextIp(), user, user.password)).status).toBe(401);
    const admin = await world.createUser(tenant, { roles: ["traveler"], isPlatformAdmin: true });
    expect((await unlock(await world.session(admin))).status).toBe(204);
    expect((await loginFrom(nextIp(), user, user.password)).status).toBe(200);
    expect(await world.prisma.auditEvent.count({ where: { actorUserId: admin.userId, action: "identity.login_throttle.unlock" } })).toBe(1);
  });

  it("does not let registration with a wrong password block the owner's login", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const other = await world.createTenant("lock-other");
    const ip = nextIp();
    for (let attempt = 0; attempt < 6; attempt++)
      await world.api("POST", "/auth/register/customer", {
        headers: { "x-forwarded-for": ip },
        body: { displayName: "Squatter", email: user.email, password: "Wrong-Password-12345", tenantCode: other.code }
      });
    expect((await loginFrom(nextIp(), user, user.password)).status).toBe(200);
  });

  it("does not tell a registrant whether or where the e-mail is registered", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const other = await world.createTenant("lock-reg");
    const reply = await world.api("POST", "/auth/register/customer", {
      headers: { "x-forwarded-for": nextIp() },
      body: { displayName: "Probe", email: user.email, password: "Wrong-Password-12345", tenantCode: other.code }
    });
    expect(reply.status).toBe(401);
    expect(JSON.stringify(reply.body)).not.toMatch(/جهة أخرى|another tenant/);
  });
});
