import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hotp, totpStep } from "../dist/common/security/totp.js";
import { runAsSystem } from "../dist/common/context/request-context.js";
import { AccountSecurityService } from "../dist/modules/identity/auth/account-security.service.js";
import { World, type Json, type Session, type TestTenant, type TestUser } from "./support/world.js";

/** MFA hardening: single-use challenge, session revocation, strong recovery codes. */
describe("auth MFA hardening", () => {
  let world: World;
  let tenant: TestTenant;

  const auth = (session: Session): { accessToken: string; tenantId: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user.tenantId
  });

  /** Creates a user with MFA enabled; returns the TOTP secret, the recovery codes and the enabling session. */
  async function mfaUser(): Promise<{ user: TestUser; secret: string; recoveryCodes: string[]; session: Session; other: Session }> {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const other = await world.session(user);
    const session = await world.session(user);
    const setup = await world.api("POST", "/auth/mfa/setup", { session: auth(session), body: { password: user.password } });
    const secret = setup.body.secret as string;
    const enabled = await world.api("POST", "/auth/mfa/enable", { session: auth(session), body: { code: hotp(secret, totpStep()) } });
    expect(enabled.status).toBe(200);
    return { user, secret, recoveryCodes: enabled.body.recoveryCodes as string[], session, other };
  }

  const verify = (mfaToken: string, code: string) => world.api("POST", "/auth/mfa/verify", { body: { mfaToken, code } });

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("mfa");
  });

  afterAll(async () => {
    await world.stop();
  });

  it("ends the other sessions when MFA is enabled, keeping the one that enabled it", async () => {
    const { session, other } = await mfaUser();
    expect((await world.api("GET", "/auth/me", { session: auth(other) })).status).toBe(401);
    expect((await world.api("GET", "/auth/me", { session: auth(session) })).status).toBe(200);
  });

  it("ends the other sessions when MFA is disabled", async () => {
    const { user, secret, recoveryCodes, session } = await mfaUser();
    const challenge = (await world.login(user)).body as Json;
    const second = (await verify(challenge.mfaToken as string, hotp(secret, totpStep() + 1))).body as Session;
    const disabled = await world.api("POST", "/auth/mfa/disable", {
      session: auth(session),
      body: { password: user.password, code: recoveryCodes[0]! }
    });
    expect(disabled.status).toBe(204);
    expect((await world.api("GET", "/auth/me", { session: auth(second) })).status).toBe(401);
    expect((await world.api("GET", "/auth/me", { session: auth(session) })).status).toBe(200);
  });

  it("accepts a challenge token only once", async () => {
    const { user, secret, recoveryCodes } = await mfaUser();
    const challenge = (await world.login(user)).body as Json;
    expect((await verify(challenge.mfaToken as string, hotp(secret, totpStep() + 1))).status).toBe(200);
    // A second, otherwise valid code (an unused recovery code) cannot mint another session from the same challenge.
    expect((await verify(challenge.mfaToken as string, recoveryCodes[0]!)).status).toBe(401);
    expect((await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).mfaRecoveryHashes).toHaveLength(8);
  });

  it("consumes the challenge on a wrong code, so each guess needs a fresh password login", async () => {
    const { user, secret } = await mfaUser();
    const challenge = (await world.login(user)).body as Json;
    const wrong = hotp(secret, totpStep() + 1) === "123456" ? "654321" : "123456";
    expect((await verify(challenge.mfaToken as string, wrong)).status).toBe(401);
    expect((await verify(challenge.mfaToken as string, hotp(secret, totpStep() + 1))).status).toBe(401);
    const fresh = (await world.login(user)).body as Json;
    expect((await verify(fresh.mfaToken as string, hotp(secret, totpStep() + 1))).status).toBe(200);
  });

  it("issues recovery codes with at least 80 bits and stores them under a keyed, per-user hash", async () => {
    const { user, recoveryCodes } = await mfaUser();
    for (const code of recoveryCodes) expect(code.replace(/-/g, "")).toMatch(/^[A-Z2-7]{16,}$/);
    const row = await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    const stored = JSON.stringify(row.mfaRecoveryHashes);
    const plainSha = createHash("sha256").update(recoveryCodes[0]!.replace(/-/g, "")).digest("hex");
    expect(stored).not.toContain(plainSha);
    expect(stored).not.toContain(recoveryCodes[0]!);
    const challenge = (await world.login(user)).body as Json;
    expect((await verify(challenge.mfaToken as string, recoveryCodes[0]!)).status).toBe(200);
    const next = (await world.login(user)).body as Json;
    expect((await verify(next.mfaToken as string, recoveryCodes[0]!)).status).toBe(401);
  });

  it("limits second-factor guesses through the login throttle", async () => {
    const { user } = await mfaUser();
    let lastStatus = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const challenge = (await world.login(user)).body as Json;
      if (!challenge.mfaToken) {
        lastStatus = 401;
        break;
      }
      lastStatus = (await verify(challenge.mfaToken as string, "111111")).status;
    }
    expect(lastStatus).toBe(401);
    // After the burst the password alone no longer even yields a challenge from this address.
    const reply = await world.login(user);
    expect(reply.status).toBe(401);
  });

  const legacyHash = (code: string): string => createHash("sha256").update(code).digest("hex");
  const regenerate = (session: Session, password: string, code: string) =>
    world.api("POST", "/auth/mfa/recovery-codes", { session: auth(session), body: { password, code } });

  it("a legacy (plain SHA-256) recovery code no longer signs in; TOTP still does; the user is told to regenerate", async () => {
    const { user, secret, session } = await mfaUser();
    // State left by migration 20261012_auth_invalidate_legacy_recovery_codes for a user who only had legacy codes: no hashes, flag set.
    // Here we additionally plant a legacy hash, to prove the runtime ignores it too (defence in depth if a row slips through).
    await world.prisma.user.update({
      where: { id: user.userId },
      data: { mfaRecoveryHashes: [legacyHash("ABCDEFGH")], mfaRecoveryRegenerationRequired: true }
    });
    const challenge = (await world.login(user)).body as Json;
    expect((await verify(challenge.mfaToken as string, "ABCDEFGH")).status).toBe(401);
    const status = await world.api("GET", "/auth/mfa", { session: auth(session) });
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesRegenerationRequired: true });
    const next = (await world.login(user)).body as Json;
    expect((await verify(next.mfaToken as string, hotp(secret, totpStep() + 1))).status).toBe(200);
  });

  it("regenerating needs the password and a fresh authenticator code, replaces every old code and clears the flag", async () => {
    const { user, secret, recoveryCodes, session } = await mfaUser();
    await world.prisma.user.update({ where: { id: user.userId }, data: { mfaRecoveryRegenerationRequired: true } });
    expect((await regenerate(session, "wrong-password-1", hotp(secret, totpStep() + 1))).status).toBe(401);
    expect((await regenerate(session, user.password, recoveryCodes[0]!)).status).toBe(400); // a recovery code is not a fresh second factor here
    expect((await regenerate(session, user.password, wrongCode(secret))).status).toBe(401);
    const reply = await regenerate(session, user.password, hotp(secret, totpStep() + 1));
    expect(reply.status).toBe(200);
    const fresh = reply.body.recoveryCodes as string[];
    expect(fresh).toHaveLength(8);
    expect(fresh.some((code) => recoveryCodes.includes(code))).toBe(false);
    const status = await world.api("GET", "/auth/mfa", { session: auth(session) });
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesRemaining: 8, recoveryCodesRegenerationRequired: false });
    const challenge = (await world.login(user)).body as Json;
    expect((await verify(challenge.mfaToken as string, recoveryCodes[1]!)).status).toBe(401);
    const second = (await world.login(user)).body as Json;
    expect((await verify(second.mfaToken as string, fresh[0]!)).status).toBe(200);
  });

  const disable = (session: Session, password: string, code: string) =>
    world.api("POST", "/auth/mfa/disable", { session: auth(session), body: { password, code } });
  const wrongCode = (secret: string): string => {
    const valid = new Set([-1, 0, 1].map((offset) => hotp(secret, totpStep() + offset)));
    return ["111111", "222222", "333333"].find((code) => !valid.has(code))!;
  };

  it("wrong codes on /auth/mfa/disable count against the throttle; the right code is refused during back-off", async () => {
    const { user, secret, recoveryCodes, session } = await mfaUser();
    for (let attempt = 0; attempt < 20; attempt++) expect((await disable(session, user.password, wrongCode(secret))).status).toBe(401);
    expect((await disable(session, user.password, recoveryCodes[0]!)).status).toBe(401);
    expect((await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).mfaEnabledAt).not.toBeNull();
  });

  it("failed disable attempts share the back-off with the login second step", async () => {
    const { user, secret, session } = await mfaUser();
    const challenge = (await world.login(user)).body as Json;
    for (let attempt = 0; attempt < 5; attempt++) await disable(session, user.password, wrongCode(secret));
    expect((await verify(challenge.mfaToken as string, hotp(secret, totpStep() + 1))).status).toBe(401);
  });

  it("parallel refunds each give back exactly one attempt (no lost update)", async () => {
    const security = world.app.get(AccountSecurityService);
    const email = `${world.unique("refund")}@example.test`;
    const ip = "10.77.0.1";
    for (let attempt = 0; attempt < 4; attempt++) await runAsSystem(() => security.begin(email, ip));
    const keys = [
      createHash("sha256").update(`login:pair:${email}:${ip}`).digest("hex"),
      createHash("sha256").update(`login:account:${email}`).digest("hex")
    ];
    const failures = async (): Promise<number[]> =>
      (await world.prisma.loginThrottle.findMany({ where: { key: { in: keys } }, orderBy: { key: "asc" } })).map((row) => row.failures);
    expect(await failures()).toEqual([4, 4]);
    await Promise.all(Array.from({ length: 4 }, () => runAsSystem(() => security.refund(email, ip))));
    expect(await failures()).toEqual([0, 0]);
    await Promise.all(Array.from({ length: 3 }, () => runAsSystem(() => security.refund(email, ip))));
    expect(await failures()).toEqual([0, 0]);
  });

  it("enabling and disabling MFA ends the identity's other sessions in every tenant", async () => {
    const other = await world.createTenant("mfa-b");
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const linked = await world.link(other, user.userId, user.email, user.password, { roles: ["traveler"] });
    const elsewhere = await world.session(linked);
    const session = await world.session(user);
    const setup = await world.api("POST", "/auth/mfa/setup", { session: auth(session), body: { password: user.password } });
    const secret = setup.body.secret as string;
    const enabled = await world.api("POST", "/auth/mfa/enable", { session: auth(session), body: { code: hotp(secret, totpStep()) } });
    expect(enabled.status).toBe(200);
    expect((await world.api("GET", "/auth/me", { session: auth(elsewhere) })).status).toBe(401);
    const challenge = (await world.login(linked)).body as Json;
    const second = (await verify(challenge.mfaToken as string, hotp(secret, totpStep() + 1))).body as Session;
    expect((await world.api("GET", "/auth/me", { session: auth(second) })).status).toBe(200);
    const codes = enabled.body.recoveryCodes as string[];
    expect((await disable(session, user.password, codes[0]!)).status).toBe(204);
    expect((await world.api("GET", "/auth/me", { session: auth(second) })).status).toBe(401);
  });
});
