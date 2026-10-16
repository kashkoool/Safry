import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Session, type TestTenant } from "./support/world.js";

describe("platform account edits end the account's sessions when the sign-in address changes", () => {
  let world: World;
  let tenant: TestTenant;
  let platform: Session;
  const auth = (s: Session): { accessToken: string; tenantId: string } => ({ accessToken: s.accessToken, tenantId: s.user.tenantId });

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("email-sessions");
    platform = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true }));
  });
  afterAll(async () => world.stop());

  it("revokes refresh sessions and invalidates the access token after an e-mail change, but not after a name-only change", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const first = await world.session(user);
    const rename = await world.api("PATCH", `/platform/users/${user.userId}`, { session: auth(platform), body: { displayName: "Renamed" } });
    expect(rename.status).toBe(200);
    expect(await world.prisma.refreshSession.count({ where: { userId: user.userId, revokedAt: null } })).toBe(1);
    expect((await world.api("GET", "/auth/me", { session: first })).status).toBe(200);

    const changed = await world.api("PATCH", `/platform/users/${user.userId}`, { session: auth(platform), body: { email: `new-${world.unique("addr")}@example.test` } });
    expect(changed.status).toBe(200);
    expect(await world.prisma.refreshSession.count({ where: { userId: user.userId, revokedAt: null } })).toBe(0);
    expect((await world.api("POST", "/auth/refresh", { body: { refreshToken: first.refreshToken } })).status).toBe(401);
    expect((await world.api("GET", "/auth/me", { session: first })).status).toBe(401);
  });
});
