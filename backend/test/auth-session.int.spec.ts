import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Session, type TestTenant, type TestUser } from "./support/world.js";

/** Session lifecycle hardening: refresh reuse detection, absolute lifetime, logout, password change, token claims. */
describe("auth sessions", () => {
  const secret = "integration-test-secret-with-more-than-32-chars";
  let world: World;
  let tenant: TestTenant;

  const auth = (session: Session): { accessToken: string; tenantId: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user.tenantId
  });
  const refresh = (refreshToken: string) => world.api("POST", "/auth/refresh", { body: { refreshToken } });
  const actions = async (userId: string): Promise<string[]> =>
    (await world.prisma.auditEvent.findMany({ where: { actorUserId: userId }, select: { action: true } })).map((event) => event.action);

  beforeAll(async () => {
    world = await World.start({ SESSION_ABSOLUTE_TIMEOUT_HOURS: "12" });
    tenant = await world.createTenant("sess");
  });

  afterAll(async () => {
    await world.stop();
  });

  describe("routine rotation", () => {
    it("writes no audit row per refresh, but keeps sign-in, sign-out and reuse rows", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      let session = await world.session(user);
      for (let i = 0; i < 5; i += 1) {
        const rotated = await refresh(session.refreshToken);
        expect(rotated.status).toBe(200);
        session = rotated.body as Session;
      }
      // Five rotations made five new session rows, and not one audit row.
      expect(Number((await world.sql.query(`SELECT count(*) FROM refresh_sessions WHERE "userId" = $1`, [user.userId])).rows[0].count)).toBe(6);
      const before = await actions(user.userId);
      expect(before).not.toContain("identity.session.refresh");
      expect(before.filter((action) => action === "identity.login")).toHaveLength(1);
      await world.api("POST", "/auth/logout", { body: { refreshToken: session.refreshToken } });
      expect(await actions(user.userId)).toContain("identity.logout");
    });
  });

  describe("refresh-token reuse detection", () => {
    it("revokes the whole session family when a rotated refresh token is presented again", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const first = await world.session(user);
      const rotated = await refresh(first.refreshToken);
      expect(rotated.status).toBe(200);
      const second = rotated.body as Session;
      expect((await world.api("GET", "/auth/me", { session: auth(second) })).status).toBe(200);

      // Well after the rotation grace window, an attacker (or the victim) replays the already-rotated token.
      await world.sql.query(`UPDATE refresh_sessions SET "revokedAt" = now() - interval '5 minutes' WHERE "userId" = $1 AND "revokedAt" IS NOT NULL`, [user.userId]);
      expect((await refresh(first.refreshToken)).status).toBe(401);

      // The legitimate-looking descendant is now dead as well: refresh and access token.
      expect((await refresh(second.refreshToken)).status).toBe(401);
      expect((await world.api("GET", "/auth/me", { session: auth(second) })).status).toBe(401);
      expect(await actions(user.userId)).toContain("identity.session.reuse_detected");
    });

    it("answers 401 without ending the family when the same token is presented twice at once", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const first = await world.session(user);
      const replies = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401]);
      const winner = replies.find((reply) => reply.status === 200)!.body as Session;
      // Two tabs, one winner: the session the winner minted is alive and keeps refreshing.
      expect((await world.api("GET", "/auth/me", { session: auth(winner) })).status).toBe(200);
      expect((await refresh(winner.refreshToken)).status).toBe(200);
      expect(await actions(user.userId)).not.toContain("identity.session.reuse_detected");
    });

    it("leaves other logins of the same user alone", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const other = await world.session(user);
      const first = await world.session(user);
      await refresh(first.refreshToken);
      await refresh(first.refreshToken);
      expect((await world.api("GET", "/auth/me", { session: auth(other) })).status).toBe(200);
    });
  });

  describe("absolute session lifetime", () => {
    it("caps the session at the configured absolute lifetime and never extends it on rotation", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const before = Date.now();
      const session = await world.session(user);
      const row = await world.prisma.refreshSession.findFirstOrThrow({ where: { userId: user.userId } });
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(before + 12 * 3_600_000 + 5_000);
      const rotated = (await refresh(session.refreshToken)).body as Session;
      const rows = await world.prisma.refreshSession.findMany({ where: { userId: user.userId }, orderBy: { createdAt: "asc" } });
      expect(rows).toHaveLength(2);
      expect(rows[1]!.expiresAt.getTime()).toBeLessThanOrEqual(rows[0]!.expiresAt.getTime());
      expect(rotated.accessToken).toEqual(expect.any(String));
    });

    it("refuses to refresh once the login is older than the absolute lifetime, even if active", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const session = await world.session(user);
      // Simulate a login from 13 hours ago that activity has kept alive (it is not idle).
      await world.sql.query(
        `UPDATE refresh_sessions SET "authenticatedAt" = now() - interval '13 hours', "lastUsedAt" = now() WHERE "userId" = $1`,
        [user.userId]
      );
      expect((await refresh(session.refreshToken)).status).toBe(401);
    });
  });

  describe("logout", () => {
    it("revokes the server session with only the refresh token, after the access token expired", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const session = await world.session(user);
      const reply = await world.api("POST", "/auth/logout", { body: { refreshToken: session.refreshToken } });
      expect(reply.status).toBe(204);
      expect((await refresh(session.refreshToken)).status).toBe(401);
      expect((await world.api("GET", "/auth/me", { session: auth(session) })).status).toBe(401);
      expect(await actions(user.userId)).toContain("identity.logout");
    });

    it("answers an unknown refresh token the same way and changes nothing", async () => {
      const reply = await world.api("POST", "/auth/logout", { body: { refreshToken: "x".repeat(64) } });
      expect(reply.status).toBe(204);
    });

    it("logs out every session of the user", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const a = await world.session(user);
      const b = await world.session(user);
      expect((await world.api("POST", "/auth/logout-all", { session: auth(a) })).status).toBe(204);
      expect((await world.api("GET", "/auth/me", { session: auth(a) })).status).toBe(401);
      expect((await world.api("GET", "/auth/me", { session: auth(b) })).status).toBe(401);
      expect((await refresh(b.refreshToken)).status).toBe(401);
    });
  });

  describe("change password", () => {
    let user: TestUser;
    beforeAll(async () => {
      user = await world.createUser(tenant, { roles: ["traveler"] });
    });

    it("requires the current password", async () => {
      const session = await world.session(user);
      const reply = await world.api("POST", "/auth/password", {
        session: auth(session),
        body: { currentPassword: "Wrong-Password-123", newPassword: "A-Brand-New-Password-42" }
      });
      expect(reply.status).toBe(401);
      expect((await world.login(user)).status).toBe(200);
    });

    it("rejects a new password that is too short or equal to the current one", async () => {
      const session = await world.session(user);
      for (const newPassword of ["short-1", user.password]) {
        const reply = await world.api("POST", "/auth/password", { session: auth(session), body: { currentPassword: user.password, newPassword } });
        expect(reply.status, newPassword.length.toString()).toBe(400);
      }
    });

    it("changes the password, ends every other session and keeps the current one", async () => {
      const other = await world.session(user);
      const current = await world.session(user);
      const newPassword = "A-Brand-New-Password-42";
      const reply = await world.api("POST", "/auth/password", {
        session: auth(current),
        body: { currentPassword: user.password, newPassword }
      });
      expect(reply.status).toBe(204);
      expect((await world.api("GET", "/auth/me", { session: auth(other) })).status).toBe(401);
      expect((await refresh(other.refreshToken)).status).toBe(401);
      expect((await world.api("GET", "/auth/me", { session: auth(current) })).status).toBe(200);
      expect((await world.login(user)).status).toBe(401);
      expect((await world.login(user, {}, newPassword)).status).toBe(200);
      expect(await actions(user.userId)).toContain("identity.password.change");
    });
  });

  describe("access-token claims", () => {
    const base64url = (value: object | string): string =>
      Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
    const sign = (header: object, payload: object): string => {
      const body = `${base64url(header)}.${base64url(payload)}`;
      return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
    };

    it("refuses a token signed with the right key but without the expected issuer and audience", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const session = await world.session(user);
      const real = JSON.parse(Buffer.from(session.accessToken.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
      expect(real).toMatchObject({ iss: expect.any(String), aud: expect.any(String) });
      const { iss: _iss, aud: _aud, ...claims } = real;
      const forged = sign({ alg: "HS256", typ: "JWT" }, claims);
      expect((await world.api("GET", "/auth/me", { session: { accessToken: forged, tenantId: session.user.tenantId } })).status).toBe(401);
      // The same claims with issuer and audience are accepted, which proves the refusal is about those claims.
      const valid = sign({ alg: "HS256", typ: "JWT" }, real);
      expect((await world.api("GET", "/auth/me", { session: { accessToken: valid, tenantId: session.user.tenantId } })).status).toBe(200);
    });
  });
});
