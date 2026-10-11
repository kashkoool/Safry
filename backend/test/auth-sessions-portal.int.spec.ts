import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Session, type TestTenant } from "./support/world.js";

/** Session list and revoke, opt-in portal enforcement. */
describe("auth sessions and portal", () => {
  let world: World;
  let tenant: TestTenant;
  const auth = (session: Session): { accessToken: string; tenantId: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user.tenantId
  });

  beforeAll(async () => {
    world = await World.start({ LOGIN_PORTAL_REQUIRED: "true" });
    tenant = await world.createTenant("auth-w2");
  });
  afterAll(async () => {
    await world.stop();
  });

  it("with LOGIN_PORTAL_REQUIRED=true a login without a portal is refused, with the right portal it works", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    expect((await world.login(user)).status).toBe(401);
    expect((await world.login(user, { portal: "provider" })).status).toBe(401);
    expect((await world.login(user, { portal: "customer" })).status).toBe(200);
  });

  describe("own session list and revoke", () => {
    it("lists one entry per login, hides other users, and ends exactly the chosen login", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const stranger = await world.createUser(tenant, { roles: ["traveler"] });
      const laptop = await world.session(user, { portal: "customer" });
      const phone = await world.session(user, { portal: "customer" });
      const strangerSession = await world.session(stranger, { portal: "customer" });
      // Rotation must not add an entry: one login stays one entry.
      const rotated = (await world.api("POST", "/auth/refresh", { body: { refreshToken: phone.refreshToken } })).body as Session;

      const list = await world.api("GET", "/auth/sessions", { session: auth(laptop) });
      expect(list.status).toBe(200);
      const entries = list.body as Array<{ id: string }>;
      expect(entries).toHaveLength(2);
      expect(JSON.stringify(entries)).not.toContain(strangerSession.refreshToken);
      expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|refreshToken/);

      // The stranger can neither see nor end the user's logins; the answer is the same as for an unknown id.
      expect((await world.api("GET", "/auth/sessions", { session: auth(strangerSession) })).body).toHaveLength(1);
      const foreign = await world.api("DELETE", `/auth/sessions/${entries[0]!.id}`, { session: auth(strangerSession) });
      expect(foreign.status).toBe(404);
      expect((await world.api("DELETE", "/auth/sessions/00000000-0000-4000-8000-000000000000", { session: auth(strangerSession) })).status).toBe(404);
      expect((await world.api("DELETE", "/auth/sessions/not-a-uuid", { session: auth(strangerSession) })).status).toBe(400);

      const latest = await world.sql.query(`SELECT "familyId" FROM refresh_sessions WHERE "userId" = $1 AND "revokedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`, [user.userId]);
      const phoneEntry = latest.rows[0].familyId as string;
      expect((await world.api("DELETE", `/auth/sessions/${phoneEntry}`, { session: auth(laptop) })).status).toBe(204);
      // The ended login can no longer refresh; the other one still can.
      expect((await world.api("POST", "/auth/refresh", { body: { refreshToken: rotated.refreshToken } })).status).toBe(401);
      expect((await world.api("GET", "/auth/sessions", { session: auth(laptop) })).body).toHaveLength(1);
      const laptopRotated = await world.api("POST", "/auth/refresh", { body: { refreshToken: laptop.refreshToken } });
      expect(laptopRotated.status).toBe(200);
      expect((await world.api("DELETE", `/auth/sessions/${phoneEntry}`, { session: auth(laptopRotated.body as Session) })).status).toBe(404);
    });
  });
});
