import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type TestTenant } from "./support/world.js";

/** Break-glass reset (scripts/reset-platform-admin-mfa.ts): lost authenticator and lost recovery codes. */
describe("platform administrator MFA reset script", () => {
  let world: World;
  let tenant: TestTenant;
  const root = resolve(import.meta.dirname, "..");

  function run(args: string[]): { ok: boolean; output: string } {
    try {
      const output = execFileSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), "scripts/reset-platform-admin-mfa.ts", ...args], {
        cwd: root,
        env: { ...process.env, NODE_ENV: "development", DATABASE_MIGRATE_URL: world.databaseUrl },
        stdio: "pipe"
      }).toString();
      return { ok: true, output };
    } catch (error) {
      const failure = error as { stderr?: Buffer; stdout?: Buffer };
      return { ok: false, output: `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}` };
    }
  }

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("mfa-reset");
  }, 180_000);
  afterAll(async () => world.stop());

  it("refuses without --confirm, without --reason, for a non-administrator and for an unknown account, changing nothing", async () => {
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
    const ordinary = await world.createUser(tenant, { roles: ["tenant-admin"] });
    await world.enrollMfa(ordinary);
    expect(run(["--email", admin.email, "--reason", "ticket-1", "--operator", "op-a", "--approver", "ap-b"]).ok).toBe(false);
    expect(run(["--email", admin.email, "--reason", "ticket-1", "--confirm"]).ok).toBe(false);
    expect(run(["--email", admin.email, "--reason", "ticket-1", "--operator", "op-a", "--confirm"]).ok).toBe(false);
    expect(run(["--email", admin.email, "--reason", "ticket-1", "--approver", "ap-b", "--confirm"]).ok).toBe(false);
    expect(run(["--reason", "ticket-1", "--operator", "op-a", "--approver", "ap-b", "--confirm"]).ok).toBe(false);
    const notAdmin = run(["--email", ordinary.email, "--reason", "ticket-1", "--operator", "op-a", "--approver", "ap-b", "--confirm"]);
    expect(notAdmin.ok).toBe(false);
    expect(notAdmin.output).toContain("not a platform administrator");
    expect(run(["--email", "nobody@example.test", "--reason", "ticket-1", "--operator", "op-a", "--approver", "ap-b", "--confirm"]).ok).toBe(false);
    expect((await world.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } })).mfaEnabledAt).not.toBeNull();
    expect((await world.prisma.user.findUniqueOrThrow({ where: { id: ordinary.userId } })).mfaEnabledAt).not.toBeNull();
    expect(await world.prisma.auditEvent.count({ where: { action: "platform.admin.mfa_reset" } })).toBe(0);
  });

  it("clears the second factor, ends every session, audits it and leaves the administrator able to re-enrol and nothing else", async () => {
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
    const before = await world.session(admin);
    expect((await world.api("GET", "/platform/overview", { session: before })).status).toBe(200);

    const result = run(["--email", admin.email.toUpperCase(), "--reason", "ticket-42", "--operator", "op-a", "--approver", "ap-b", "--confirm"]);
    expect(result.ok, result.output).toBe(true);
    expect(result.output).not.toMatch(/[A-Z2-7]{4}-[A-Z2-7]{4}/);

    const row = await world.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(row).toMatchObject({ mfaEnabledAt: null, mfaSecretEnc: null, mfaLastStep: null, mfaChallengeHash: null, isPlatformAdmin: true, status: "ACTIVE" });
    expect(row.mfaRecoveryHashes).toEqual([]);
    expect(await world.prisma.refreshSession.count({ where: { userId: admin.userId, revokedAt: null } })).toBe(0);
    const audit = await world.prisma.auditEvent.findFirstOrThrow({ where: { action: "platform.admin.mfa_reset", entityId: admin.userId } });
    expect(audit.metadata).toMatchObject({ reason: "ticket-42", hadMfa: true, channel: "operator-script", operator: "op-a", approver: "ap-b", passwordInvalidated: true });
    expect(JSON.stringify(audit.metadata)).not.toContain(admin.mfaSecret!);

    // the old refresh token no longer works
    expect((await world.api("POST", "/auth/refresh", { body: { refreshToken: before.refreshToken } })).status).toBe(401);
    // the old password is dead: whoever knows it can not sign in and enrol their own authenticator
    expect((await world.login(admin)).status).toBe(401);
    // the administrator sets a new password through the normal e-mail flow, then signs in without an MFA challenge
    const { MAIL_TRANSPORT } = await import("../dist/modules/mail/mail.types.js");
    const transport = world.app.get(MAIL_TRANSPORT) as { outbox: Array<{ to: string; text: string }>; clear(): void };
    transport.clear();
    expect((await world.api("POST", "/auth/password/forgot", { body: { email: admin.email } })).status).toBe(202);
    await new Promise((done) => setTimeout(done, 500));
    const mail = transport.outbox.filter((m) => m.to === admin.email).at(-1);
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? "")?.[1];
    expect(token).toBeTruthy();
    const fresh = `Np-${randomBytes(9).toString("hex")}-Zz`;
    expect((await world.api("POST", "/auth/password/reset", { body: { token, newPassword: fresh } })).status).toBe(204);
    admin.password = fresh;
    const login = await world.login(admin);
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBeFalsy();
    const session = { accessToken: login.body.accessToken as string, tenantId: tenant.id };
    const closed = await world.api("GET", "/platform/overview", { session });
    expect(closed.status).toBe(403);
    expect(closed.body?.code).toBe("mfa_enrollment_required");
    expect((await world.api("GET", "/auth/mfa", { session })).status).toBe(200);
    await world.enrollMfa(admin);
    expect((await world.api("GET", "/platform/overview", { session: await world.session(admin) })).status).toBe(200);
  });
});
