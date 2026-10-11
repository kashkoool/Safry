import "dotenv/config";
import { hash } from "argon2";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { bootstrapCore } from "./bootstrap-core.js";
import { adminPassword } from "./seed-guard.js";

/**
 * Real-deployment bootstrap (no demo accounts, no demo catalogue, safe in production):
 * BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD (>= 12 chars, not a placeholder), optional
 * BOOTSTRAP_TENANT_CODE / BOOTSTRAP_TENANT_NAME. Run once: pnpm db:bootstrap
 * An existing ordinary account with that e-mail is refused unless BOOTSTRAP_ADOPT_EXISTING_ACCOUNT=true.
 */
const databaseUrl = process.env["DATABASE_MIGRATE_URL"] ?? process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_MIGRATE_URL or DATABASE_URL is required");
const adminEmail = process.env["BOOTSTRAP_ADMIN_EMAIL"]?.trim().toLowerCase();
if (!adminEmail) throw new Error("BOOTSTRAP_ADMIN_EMAIL is required");
const password = adminPassword();

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
try {
  const tenantCode = (process.env["BOOTSTRAP_TENANT_CODE"] ?? "safry").toLowerCase();
  const tenantName = process.env["BOOTSTRAP_TENANT_NAME"] ?? "Safry Platform";
  const result = await bootstrapCore(
    prisma,
    { tenantCode, tenantName, adminEmail, adminPasswordHash: await hash(password) },
    { adoptExistingAccount: process.env["BOOTSTRAP_ADOPT_EXISTING_ACCOUNT"] === "true" }
  );
  const did = [
    result.tenantCreated ? "created the tenant" : "tenant already existed",
    result.userCreated ? "created the administrator account" : "administrator account already existed (not modified)",
    result.adminMembershipCreated ? "granted tenant-admin" : "membership already existed (roles not changed)"
  ];
  console.log(`Bootstrap complete for tenant "${tenantCode}": ${did.join("; ")}.`);
} finally {
  await prisma.$disconnect();
}
