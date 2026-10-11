import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hotp, totpStep } from "../dist/common/security/totp.js";
import { World, type Json, type Session, type TestTenant, type TestUser } from "./support/world.js";

/** Authentication & Login Management: lifecycle, lockout and MFA. */
describe("authentication", () => {
  let world: World;
  let tenant: TestTenant;

  const auth = (session: Pick<Session, "accessToken"> & Partial<Pick<Session, "user">>): { accessToken: string; tenantId?: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user?.tenantId
  });

  const auditActions = async (userId: string): Promise<string[]> =>
    (await world.prisma.auditEvent.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: "asc" }, select: { action: true } })).map(
      (event) => event.action
    );

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("auth");
  });

  afterAll(async () => {
    await world.stop();
  });

  describe("login, refresh and logout", () => {
    let user: TestUser;
    beforeAll(async () => {
      user = await world.createUser(tenant, { roles: ["traveler"] });
    });

    it("issues a token pair and audits the login in the tenant", async () => {
      const reply = await world.login(user);
      expect(reply.status).toBe(200);
      expect(reply.body.accessToken).toEqual(expect.any(String));
      expect(reply.body.refreshToken).toEqual(expect.any(String));
      expect(reply.body.user).toMatchObject({ tenantId: tenant.id, userId: user.userId, roles: ["traveler"] });
      const event = await world.prisma.auditEvent.findFirst({ where: { actorUserId: user.userId, action: "identity.login" } });
      expect(event?.tenantId).toBe(tenant.id);
    });

    it("gives the same answer for a wrong password and an unknown account", async () => {
      const wrong = await world.login(user, {}, "Not-The-Password-1");
      const unknown = await world.login({ ...user, email: `ghost-${world.stamp}@example.test` });
      const wrongTenant = await world.api("POST", "/auth/login", { body: { email: user.email, password: user.password, tenantCode: "no-such-tenant" } });
      for (const reply of [wrong, unknown, wrongTenant]) {
        expect(reply.status).toBe(401);
        expect(reply.body.message).toBe("Invalid credentials or tenant");
      }
    });

    it("only admits accounts to the portal that matches their role", async () => {
      expect((await world.login(user, { portal: "customer" })).status).toBe(200);
      expect((await world.login(user, { portal: "admin" })).status).toBe(401);
      expect((await world.login(user, { portal: "provider" })).status).toBe(401);
    });

    it("rotates refresh tokens and rejects a replayed one (ending the whole session family)", async () => {
      const first = await world.session(user);
      const rotated = await world.api("POST", "/auth/refresh", { body: { refreshToken: first.refreshToken } });
      expect(rotated.status).toBe(200);
      expect(rotated.body.refreshToken).not.toBe(first.refreshToken);
      expect((await world.api("GET", "/auth/me", { session: auth(rotated.body as Session) })).status).toBe(200);
      // Past the rotation grace window a replay is theft.
      await world.sql.query(`UPDATE refresh_sessions SET "revokedAt" = now() - interval '5 minutes' WHERE "userId" = $1 AND "revokedAt" IS NOT NULL`, [user.userId]);
      const replay = await world.api("POST", "/auth/refresh", { body: { refreshToken: first.refreshToken } });
      expect(replay.status).toBe(401);
      expect((await world.api("GET", "/auth/me", { session: auth(rotated.body as Session) })).status).toBe(401);
    });

    it("ends the session on logout and audits it against the tenant", async () => {
      const session = await world.session(user);
      const out = await world.api("POST", "/auth/logout", { session: auth(session), body: { refreshToken: session.refreshToken } });
      expect(out.status).toBe(204);
      expect((await world.api("POST", "/auth/refresh", { body: { refreshToken: session.refreshToken } })).status).toBe(401);
      const event = await world.prisma.auditEvent.findFirst({ where: { actorUserId: user.userId, action: "identity.logout" } });
      expect(event?.tenantId).toBe(tenant.id);
    });

    it("expires a session after the idle timeout", async () => {
      const session = await world.session(user);
      expect((await world.api("GET", "/auth/me", { session: auth(session) })).status).toBe(200);
      await world.prisma.refreshSession.updateMany({
        where: { userId: user.userId, revokedAt: null },
        data: { lastUsedAt: new Date(Date.now() - 16 * 60_000) }
      });
      const expired = await world.api("GET", "/auth/me", { session: auth(session) });
      expect(expired.status).toBe(401);
    });

    it("rejects an access token once the membership is no longer active", async () => {
      const other = await world.createUser(tenant, { roles: ["traveler"] });
      const session = await world.session(other);
      await world.prisma.tenantMembership.update({ where: { id: other.membershipId }, data: { status: "SUSPENDED" } });
      expect((await world.api("GET", "/auth/me", { session: auth(session) })).status).toBe(401);
      expect((await world.login(other)).status).toBe(401);
    });

    it("rejects a malformed or tampered access token", async () => {
      const session = await world.session(user);
      expect((await world.api("GET", "/auth/me", { session: { accessToken: `${session.accessToken}x` } })).status).toBe(401);
      expect((await world.api("GET", "/auth/me", { session: { accessToken: "garbage" } })).status).toBe(401);
    });
  });

  describe("login-attempt lockout", () => {
    it("locks the account after repeated failures, even for the correct password", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      for (let attempt = 1; attempt <= 5; attempt++) {
        const reply = await world.login(user, {}, `Wrong-Password-${attempt}`);
        expect(reply.status, `attempt ${attempt}`).toBe(401);
      }
      // Blocked from this address: the same generic 401 as a wrong password, no 429 and no remaining time.
      const locked = await world.login(user);
      expect(locked.status).toBe(401);
      expect(locked.body.message).toBe("Invalid credentials or tenant");
      const blocks = (await world.prisma.loginThrottle.findMany({ where: { blockedUntil: { gt: new Date() } } })).map((row) => row.blockedUntil!.getTime());
      expect(blocks.length).toBeGreaterThan(0);
      expect(Math.max(...blocks)).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000);
      expect((await auditActions(user.userId)).filter((action) => action === "identity.login.failed")).toHaveLength(6);
      expect(await auditActions(user.userId)).toContain("identity.account.locked");
      await world.prisma.loginThrottle.updateMany({ data: { blockedUntil: null } });
    });

    it("lets the user back in when the lock expires and resets the counters", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      for (let attempt = 0; attempt < 5; attempt++) await world.login(user, {}, "Wrong-Password-x");
      expect((await world.login(user)).status).toBe(401);
      await world.prisma.loginThrottle.updateMany({ data: { blockedUntil: new Date(Date.now() - 1000) } });
      expect((await world.login(user)).status).toBe(200);
      // The success cleared the address's streak: four more failures do not block it again.
      for (let attempt = 0; attempt < 4; attempt++) await world.login(user, {}, "Wrong-Password-x");
      expect((await world.login(user)).status).toBe(200);
    });

    it("counts only consecutive failures: a success resets the streak", async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      for (let attempt = 0; attempt < 4; attempt++) await world.login(user, {}, "Wrong-Password-x");
      expect((await world.login(user)).status).toBe(200);
      for (let attempt = 0; attempt < 4; attempt++) expect((await world.login(user, {}, "Wrong-Password-x")).status).toBe(401);
      expect((await world.login(user)).status).toBe(200);
    });

    it("does not lock an account because of failures against a different identity", async () => {
      const victim = await world.createUser(tenant, { roles: ["traveler"] });
      const bystander = await world.createUser(tenant, { roles: ["traveler"] });
      for (let attempt = 0; attempt < 5; attempt++) await world.login(victim, {}, "Wrong-Password-x");
      expect((await world.login(bystander)).status).toBe(200);
    });
  });

  describe("multi-factor authentication", () => {
    let user: TestUser;
    let session: Session;
    let secret: string;
    let recoveryCodes: string[];

    beforeAll(async () => {
      user = await world.createUser(tenant, { roles: ["traveler"] });
      session = await world.session(user);
    });

    /** A code from the next time step: valid within the drift window and newer than any step already used. */
    const nextCode = (offset = 1): string => hotp(secret, totpStep() + offset);

    it("requires the password to start the setup", async () => {
      expect((await world.api("POST", "/auth/mfa/setup", { session: auth(session), body: { password: "Wrong-Password-1" } })).status).toBe(401);
      expect((await world.api("GET", "/auth/mfa", { session: auth(session) })).body).toMatchObject({ enabled: false });
    });

    it("sets up the authenticator and stores the secret encrypted", async () => {
      const setup = await world.api("POST", "/auth/mfa/setup", { session: auth(session), body: { password: user.password } });
      expect(setup.status).toBe(200);
      secret = setup.body.secret as string;
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(setup.body.otpauthUri).toContain(`secret=${secret}`);
      const row = await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row.mfaSecretEnc).toMatch(/^v1\./);
      expect(row.mfaSecretEnc).not.toContain(secret);
      expect(row.mfaEnabledAt).toBeNull();
      expect((await world.api("GET", "/auth/mfa", { session: auth(session) })).body).toMatchObject({ enabled: false, pendingSetup: true });
    });

    it("does not enable with a wrong code, then enables and returns recovery codes once", async () => {
      expect((await world.api("POST", "/auth/mfa/enable", { session: auth(session), body: { code: "000000" } })).status).toBe(400);
      const enabled = await world.api("POST", "/auth/mfa/enable", { session: auth(session), body: { code: hotp(secret, totpStep()) } });
      expect(enabled.status).toBe(200);
      recoveryCodes = enabled.body.recoveryCodes as string[];
      expect(recoveryCodes).toHaveLength(8);
      expect(new Set(recoveryCodes).size).toBe(8);
      const row = await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(JSON.stringify(row.mfaRecoveryHashes)).not.toContain(recoveryCodes[0]!);
      expect((await world.api("GET", "/auth/mfa", { session: auth(session) })).body).toMatchObject({ enabled: true, recoveryCodesRemaining: 8 });
      expect((await world.api("POST", "/auth/mfa/setup", { session: auth(session), body: { password: user.password } })).status).toBe(409);
    });

    it("answers a correct password with a challenge instead of tokens", async () => {
      const reply = await world.login(user);
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ mfaRequired: true });
      expect(reply.body.accessToken).toBeUndefined();
      expect(reply.body.refreshToken).toBeUndefined();
      // The challenge token is not an access token.
      expect((await world.api("GET", "/auth/me", { session: { accessToken: reply.body.mfaToken as string } })).status).toBe(401);
    });

    it("rejects a wrong code, accepts the right one, and refuses replay of the same code", async () => {
      const first = (await world.login(user)).body as Json;
      const wrong = await world.api("POST", "/auth/mfa/verify", { body: { mfaToken: first.mfaToken, code: "123456" === nextCode() ? "654321" : "123456" } });
      expect(wrong.status).toBe(401);
      // The wrong answer consumed that challenge; a new password login starts a new one.
      const challenge = (await world.login(user)).body as Json;
      const code = nextCode();
      const ok = await world.api("POST", "/auth/mfa/verify", { body: { mfaToken: challenge.mfaToken, code } });
      expect(ok.status).toBe(200);
      expect(ok.body.accessToken).toEqual(expect.any(String));
      expect(ok.body.user.userId).toBe(user.userId);
      const again = (await world.login(user)).body as Json;
      const replay = await world.api("POST", "/auth/mfa/verify", { body: { mfaToken: again.mfaToken, code } });
      expect(replay.status).toBe(401);
      const actions = await auditActions(user.userId);
      expect(actions).toContain("identity.login.mfa");
      expect(actions).toContain("identity.login.failed");
    });

    it("rejects an invalid or expired challenge token", async () => {
      const reply = await world.api("POST", "/auth/mfa/verify", { body: { mfaToken: "x".repeat(40), code: nextCode() } });
      expect(reply.status).toBe(401);
    });

    it("accepts each recovery code exactly once", async () => {
      const challenge = (await world.login(user)).body as Json;
      const used = recoveryCodes[0]!;
      const ok = await world.api("POST", "/auth/mfa/verify", { body: { mfaToken: challenge.mfaToken, code: used } });
      expect(ok.status).toBe(200);
      const next = (await world.login(user)).body as Json;
      const reuse = await world.api("POST", "/auth/mfa/verify", { body: { mfaToken: next.mfaToken, code: used } });
      expect(reuse.status).toBe(401);
      expect((await world.api("GET", "/auth/mfa", { session: auth(ok.body as Session) })).body).toMatchObject({ recoveryCodesRemaining: 7 });
    });

    it("locks the account after repeated wrong second-factor codes", async () => {
      const victim = await world.createUser(tenant, { roles: ["traveler"] });
      const victimSession = await world.session(victim);
      const setup = await world.api("POST", "/auth/mfa/setup", { session: auth(victimSession), body: { password: victim.password } });
      await world.api("POST", "/auth/mfa/enable", { session: auth(victimSession), body: { code: hotp(setup.body.secret as string, totpStep()) } });
      for (let attempt = 0; attempt < 5; attempt++) {
        const challenge = (await world.login(victim)).body as Json;
        const reply = await world.api("POST", "/auth/mfa/verify", { body: { mfaToken: challenge.mfaToken, code: "111111" } });
        expect(reply.status).toBe(401);
      }
      // Five wrong codes from this address block it, even though every password step was correct.
      const blocked = await world.login(victim);
      expect(blocked.status).toBe(401);
      expect(blocked.body.mfaToken).toBeUndefined();
    });

    it("disables MFA with the password and a code, then logs in with the password alone", async () => {
      const wrongPassword = await world.api("POST", "/auth/mfa/disable", { session: auth(session), body: { password: "Wrong-Password-1", code: recoveryCodes[1]! } });
      expect(wrongPassword.status).toBe(401);
      const disabled = await world.api("POST", "/auth/mfa/disable", { session: auth(session), body: { password: user.password, code: recoveryCodes[1]! } });
      expect(disabled.status).toBe(204);
      const row = await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row).toMatchObject({ mfaEnabledAt: null, mfaSecretEnc: null });
      const reply = await world.login(user);
      expect(reply.body.accessToken).toEqual(expect.any(String));
      const actions = await auditActions(user.userId);
      expect(actions).toEqual(expect.arrayContaining(["identity.mfa.setup", "identity.mfa.enable", "identity.mfa.disable"]));
    });
  });
});
