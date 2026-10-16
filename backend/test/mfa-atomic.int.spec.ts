import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hotp, totpStep } from "../dist/common/security/totp.js";
import { World, type TestTenant } from "./support/world.js";

/** Enabling or disabling MFA changes the account, ends the other sessions and writes the audit event as ONE unit. */
describe("MFA enable and disable are atomic", () => {
  let world: World;
  let tenant: TestTenant;

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("mfa-atomic");
  });
  beforeEach(async () => {
    await world.sql.query(`DROP TRIGGER IF EXISTS fail_mfa_audit ON audit_events`);
  });
  afterAll(async () => {
    await world.sql.query(`DROP TRIGGER IF EXISTS fail_mfa_audit ON audit_events; DROP FUNCTION IF EXISTS fail_mfa_audit()`);
    await world.stop();
  });

  /** Makes the audit insert for one action fail, which is the last step of the unit. */
  async function breakAudit(action: string): Promise<void> {
    await world.sql.query(`DROP TRIGGER IF EXISTS fail_mfa_audit ON audit_events`);
    await world.sql.query(`CREATE OR REPLACE FUNCTION fail_mfa_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await world.sql.query(`CREATE TRIGGER fail_mfa_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_mfa_audit()`);
  }
  async function repairAudit(): Promise<void> {
    await world.sql.query(`DROP TRIGGER IF EXISTS fail_mfa_audit ON audit_events`);
  }
  const live = (userId: string): Promise<number> => world.prisma.refreshSession.count({ where: { userId, revokedAt: null } });

  it("enable: a failing audit write leaves MFA off and the other session alive; success then ends the other session", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const current = await world.login(user);
    await world.login(user); // the "other" (possibly stolen) session
    const session = { accessToken: current.body.accessToken as string, tenantId: tenant.id };
    const setup = await world.api("POST", "/auth/mfa/setup", { session, body: { password: user.password } });
    const secret = setup.body.secret as string;
    expect(await live(user.userId)).toBe(2);

    await breakAudit("identity.mfa.enable");
    const failed = await world.api("POST", "/auth/mfa/enable", { session, body: { code: hotp(secret, totpStep()) } });
    expect(failed.status).toBe(500);
    const after = await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(after.mfaEnabledAt).toBeNull();
    expect(after.mfaRecoveryHashes).toEqual([]);
    expect(await live(user.userId)).toBe(2);

    await repairAudit();
    await world.prisma.user.update({ where: { id: user.userId }, data: { mfaLastStep: null } });
    const ok = await world.api("POST", "/auth/mfa/enable", { session, body: { code: hotp(secret, totpStep()) } });
    expect(ok.status).toBe(200);
    expect((await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).mfaEnabledAt).not.toBeNull();
    expect(await live(user.userId)).toBe(1);
    expect(await world.prisma.auditEvent.count({ where: { action: "identity.mfa.enable", entityId: user.userId } })).toBe(1);
  });

  it("disable: a failing audit write leaves MFA on and the other session alive", async () => {
    const user = await world.enrollMfa(await world.createUser(tenant, { roles: ["traveler"] }));
    const current = await world.session(user);
    await world.session(user);
    const session = { accessToken: current.accessToken, tenantId: tenant.id };
    const before = await live(user.userId);
    expect(before).toBeGreaterThanOrEqual(2);

    await breakAudit("identity.mfa.disable");
    const failed = await world.api("POST", "/auth/mfa/disable", { session, body: { password: user.password, code: await world.mfaCode(user) } });
    expect(failed.status).toBe(500);
    const after = await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(after.mfaEnabledAt).not.toBeNull();
    expect(after.mfaSecretEnc).not.toBeNull();
    expect(await live(user.userId)).toBe(before);
    await repairAudit();
  });
});
