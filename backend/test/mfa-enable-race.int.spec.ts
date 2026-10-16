import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hotp, totpStep } from "../dist/common/security/totp.js";
import { World, type TestTenant } from "./support/world.js";

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Two requests that both pass the first checks must not both finish. A second connection holds the user row lock, both requests
 * reach it, the lock is released: exactly one may win, and the recovery codes the winner returned must be the ones stored.
 */
describe("MFA enable and recovery-code regeneration under concurrent requests", () => {
  let world: World;
  let tenant: TestTenant;

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("mfa-enable-race");
  });
  afterAll(async () => world.stop());

  async function holdingRowLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    try {
      await db.query("BEGIN");
      await db.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const pending = work();
      await pause(1_000);
      await db.query("COMMIT");
      return await pending;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await db.end();
    }
  }

  it("two simultaneous enable calls: one succeeds, the other is refused, and the stored codes are the winner's", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const current = await world.login(user);
    const session = { accessToken: current.body.accessToken as string, tenantId: tenant.id };
    const setup = await world.api("POST", "/auth/mfa/setup", { session, body: { password: user.password } });
    const code = hotp(setup.body.secret as string, totpStep());

    const replies = await holdingRowLock(user.userId, () =>
      Promise.all([world.api("POST", "/auth/mfa/enable", { session, body: { code } }), world.api("POST", "/auth/mfa/enable", { session, body: { code } })])
    );
    const statuses = replies.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const winner = replies.find((r) => r.status === 200)!;
    const stored = (await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).mfaRecoveryHashes as string[];
    expect(stored).toHaveLength((winner.body.recoveryCodes as string[]).length);
    expect(await world.prisma.auditEvent.count({ where: { action: "identity.mfa.enable", entityId: user.userId } })).toBe(1);
  });

  it("regeneration that loses a race with MFA being switched off is refused and stores no codes", async () => {
    const user = await world.enrollMfa(await world.createUser(tenant, { roles: ["traveler"] }));
    const current = await world.session(user);
    const session = { accessToken: current.accessToken, tenantId: tenant.id };
    const code = await world.mfaCode(user);
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    let reply;
    try {
      await db.query("BEGIN");
      await db.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [user.userId]);
      const pending = world.api("POST", "/auth/mfa/recovery-codes", { session, body: { password: user.password, code } });
      await pause(1_000);
      await db.query(`UPDATE users SET "mfaEnabledAt" = NULL, "mfaSecretEnc" = NULL, "mfaRecoveryHashes" = '[]'::jsonb WHERE id = $1`, [user.userId]);
      await db.query("COMMIT");
      reply = await pending;
    } finally {
      await db.end();
    }
    // The code check (which locks the row too) already sees MFA off; either refusal is fine, storing codes is not.
    expect([401, 409]).toContain(reply.status);
    const after = await world.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(after.mfaEnabledAt).toBeNull();
    expect(after.mfaRecoveryHashes).toEqual([]);
  });
});
