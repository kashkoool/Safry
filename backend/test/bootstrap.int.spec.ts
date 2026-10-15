import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { bootstrapCore } from "../prisma/bootstrap-core.js";
import { createOwnerDatabase, type OwnerDatabase } from "./support/owner-db.js";

/** the real (non-demo) bootstrap creates what a fresh deployment needs and never undoes an operator's change. */
describe("deployment bootstrap", () => {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: inject("databaseUrl") }) });
  const code = `boot-${randomUUID().slice(0, 8)}`;
  const adminEmail = `admin-${code}@example.test`;
  const input = { tenantCode: code, tenantName: "Bootstrap Test", adminEmail, adminPasswordHash: "not-a-real-hash" };
  afterAll(async () => prisma.$disconnect());

  it("creates the tenant, system roles, role permissions and one administrator, and no demo accounts", async () => {
    const result = await bootstrapCore(prisma, input);
    expect([...result.roles.keys()]).toContain("tenant-admin");
    const members = await prisma.tenantMembership.findMany({ where: { tenantId: result.tenant.id }, include: { user: true } });
    expect(members.map((m) => m.user.emailNormalized)).toEqual([adminEmail]);
    expect(members[0]!.user.isPlatformAdmin).toBe(true);
    const grants = await prisma.rolePermission.count({ where: { role: { tenantId: result.tenant.id, code: "tenant-admin" } } });
    expect(grants).toBeGreaterThan(0);
    expect(await prisma.user.count({ where: { emailNormalized: { in: ["provider@safry.local", "traveler@safry.local"] }, memberships: { some: { tenantId: result.tenant.id } } } })).toBe(0);
  });

  it("is idempotent and does not re-activate a suspended administrator or reset the password", async () => {
    const first = await prisma.tenantMembership.findFirstOrThrow({ where: { tenant: { code }, user: { emailNormalized: adminEmail } } });
    await prisma.tenantMembership.update({ where: { id: first.id }, data: { status: "SUSPENDED" } });
    await prisma.user.update({ where: { emailNormalized: adminEmail }, data: { passwordHash: "operator-changed" } });
    await bootstrapCore(prisma, { ...input, adminPasswordHash: "different" });
    const after = await prisma.tenantMembership.findUniqueOrThrow({ where: { id: first.id }, include: { user: true } });
    expect(after.status).toBe("SUSPENDED");
    expect(after.user.passwordHash).toBe("operator-changed");
    expect(await prisma.tenantMembership.count({ where: { tenant: { code } } })).toBe(1);
  });

  it("refuses to adopt an existing ordinary account as tenant administrator, creating nothing", async () => {
    const victimEmail = `traveler-${code}@example.test`;
    await prisma.user.create({ data: { email: victimEmail, emailNormalized: victimEmail, displayName: "Ordinary", passwordHash: "x" } });
    const other = `${code}-other`;
    await expect(bootstrapCore(prisma, { ...input, tenantCode: other, adminEmail: victimEmail })).rejects.toThrow(/ordinary account/);
    expect(await prisma.tenantMembership.count({ where: { tenant: { code: other } } })).toBe(0);
    // explicit opt-in adopts it, still without promoting it to platform admin or touching its password
    const adopted = await bootstrapCore(prisma, { ...input, tenantCode: other, adminEmail: victimEmail }, { adoptExistingAccount: true });
    expect(adopted.adminMembershipCreated).toBe(true);
    const user = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: victimEmail } });
    expect(user.isPlatformAdmin).toBe(false);
    expect(user.passwordHash).toBe("x");
  });

  it("refuses an existing non-ACTIVE account even for a platform admin", async () => {
    const email = `disabled-${code}@example.test`;
    await prisma.user.create({ data: { email, emailNormalized: email, displayName: "Off", passwordHash: "x", isPlatformAdmin: true, status: "DISABLED" } });
    await expect(bootstrapCore(prisma, { ...input, tenantCode: `${code}-dis`, adminEmail: email })).rejects.toThrow(/not active/);
  });

  it("create-only - a role or role permission an operator removed is not re-granted on re-run", async () => {
    const membership = await prisma.tenantMembership.findFirstOrThrow({ where: { tenant: { code }, user: { emailNormalized: adminEmail } } });
    await prisma.membershipRole.deleteMany({ where: { membershipId: membership.id } });
    const travelerRole = await prisma.role.findFirstOrThrow({ where: { tenant: { code }, code: "traveler" } });
    const grant = await prisma.rolePermission.findFirstOrThrow({ where: { roleId: travelerRole.id } });
    await prisma.rolePermission.deleteMany({ where: { roleId: grant.roleId, permissionId: grant.permissionId } });
    const again = await bootstrapCore(prisma, input);
    expect(again.adminMembershipCreated).toBe(false);
    expect(await prisma.membershipRole.count({ where: { membershipId: membership.id } })).toBe(0);
    expect(await prisma.rolePermission.count({ where: { roleId: grant.roleId, permissionId: grant.permissionId } })).toBe(0);
  });
});

/** the operator scripts must work for a hosted owner that is neither superuser nor BYPASSRLS (FORCE RLS applies to it). */
describe("bootstrap as a non-superuser, non-BYPASSRLS owner", () => {
  let db: OwnerDatabase;
  let owner: PrismaClient;
  beforeAll(async () => {
    const server = new URL(inject("databaseUrl"));
    server.pathname = "/postgres";
    db = await createOwnerDatabase(server.toString());
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.ownerUrl }) });
  }, 180_000);
  afterAll(async () => {
    await owner?.$disconnect();
    await db?.drop();
  });

  it("bootstrapCore succeeds and creates the tenant, roles and administrator", async () => {
    const result = await bootstrapCore(owner, { tenantCode: "own-tenant", tenantName: "Owner Test", adminEmail: "owner-admin@example.test", adminPasswordHash: "h" });
    expect(result.adminMembershipCreated).toBe(true);
    const again = await bootstrapCore(owner, { tenantCode: "own-tenant", tenantName: "Owner Test", adminEmail: "owner-admin@example.test", adminPasswordHash: "h" });
    expect(again.adminMembershipCreated).toBe(false);
  });

  it("the bypass flag does not leak out of the transaction (the owner is confined again afterwards)", async () => {
    const rows = await owner.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM tenants`;
    expect(Number(rows[0]!.n)).toBe(0);
  });

  const root = resolve(import.meta.dirname, "..");
  function runScript(script: string, env: Record<string, string>): string {
    return execFileSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), script], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "development", DATABASE_MIGRATE_URL: db.ownerUrl, ...env },
      stdio: "pipe"
    }).toString();
  }
  const generated = (): string => `Pw-${randomBytes(12).toString("hex")}`;

  it("prisma/bootstrap.ts (db:bootstrap) runs as that owner and reports what it really did", () => {
    const env = { BOOTSTRAP_ADMIN_EMAIL: "script-admin@example.test", BOOTSTRAP_ADMIN_PASSWORD: generated(), BOOTSTRAP_TENANT_CODE: "script-tenant" };
    expect(runScript("prisma/bootstrap.ts", env)).toContain("created the tenant; created the administrator account; granted tenant-admin");
    expect(runScript("prisma/bootstrap.ts", env)).toContain("tenant already existed; administrator account already existed (not modified); membership already existed");
  });

  it("scripts/bootstrap-platform-admin.ts runs as that owner (audit_events is FORCE RLS)", async () => {
    const email = "promote@example.test";
    const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.adminUrl }) });
    try {
      await admin.user.create({ data: { email, emailNormalized: email, displayName: "P", passwordHash: "x" } });
      // An account without MFA is refused; the same script succeeds once the account has enrolled.
      expect(() => runScript("scripts/bootstrap-platform-admin.ts", { BOOTSTRAP_ADMIN_EMAIL: email })).toThrow();
      expect((await admin.user.findUniqueOrThrow({ where: { emailNormalized: email } })).isPlatformAdmin).toBe(false);
      await admin.user.update({ where: { emailNormalized: email }, data: { mfaEnabledAt: new Date() } });
      runScript("scripts/bootstrap-platform-admin.ts", { BOOTSTRAP_ADMIN_EMAIL: email });
      expect((await admin.user.findUniqueOrThrow({ where: { emailNormalized: email } })).isPlatformAdmin).toBe(true);
      expect(await admin.auditEvent.count({ where: { action: "platform.admin.bootstrap" } })).toBe(1);
    } finally {
      await admin.$disconnect();
    }
  });

  it("prisma/seed.ts (db:seed) runs as that owner", () => {
    runScript("prisma/seed.ts", { BOOTSTRAP_ADMIN_EMAIL: "seed-admin@example.test", BOOTSTRAP_ADMIN_PASSWORD: generated(), DEMO_SEED_PASSWORD: generated(), BOOTSTRAP_TENANT_CODE: "seed-tenant" });
  }, 120_000);
});
