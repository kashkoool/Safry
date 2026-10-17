import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { withRlsBypass } from "../prisma/rls-bypass.js";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: (process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL)! }) });
try {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("BOOTSTRAP_ADMIN_EMAIL is required");
  // One transaction with the RLS bypass flag: audit_events has FORCE RLS, so a non-superuser owner needs it.
  await withRlsBypass(prisma, async (tx) => {
    // Same row lock as the platform grant and the MFA disable paths: the MFA check below and the promotion are one atomic step.
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "emailNormalized" = ${email} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { emailNormalized: email } });
    if (user.status !== "ACTIVE" || user.deletedAt) throw new Error("Bootstrap administrator must be active");
    if (user.isPlatformAdmin) return;
    // A platform administrator needs a second factor: enrol 2FA on the account first (the first admin created by
    // `db:bootstrap` enrols after signing in and is not promoted by this script).
    if (!user.mfaEnabledAt) throw new Error("Bootstrap administrator must have MFA enabled before promotion; sign in and enrol two-factor authentication first");
    await tx.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
    await tx.auditEvent.create({
      data: { actorUserId: user.id, action: "platform.admin.bootstrap", entityType: "user", entityId: user.id }
    });
  });
  console.log("Configured bootstrap account is ready as platform administrator.");
} finally {
  await prisma.$disconnect();
}
