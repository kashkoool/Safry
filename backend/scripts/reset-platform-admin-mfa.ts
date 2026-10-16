import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { withRlsBypass } from "../prisma/rls-bypass.js";

/**
 * Break-glass reset of the second factor of ONE platform administrator who lost both the authenticator and the recovery codes.
 * Usage: tsx scripts/reset-platform-admin-mfa.ts --email <address> --reason <ticket or short text> --operator <name> --approver <name> --confirm
 * The current password is invalidated in the same transaction (otherwise anyone who knows it could enrol their own authenticator after
 * the reset): the administrator must set a new password through the normal e-mail reset flow before signing in.
 * See docs/DEPLOYMENT.md, "Lost authenticator and recovery codes". Prints no secret.
 */
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const email = option("--email")?.trim().toLowerCase();
const reason = option("--reason")?.trim();
const operator = option("--operator")?.trim();
const approver = option("--approver")?.trim();
if (!email) throw new Error("--email <address> is required");
if (!reason || reason.length < 3 || reason.startsWith("--")) throw new Error("--reason <ticket id or short text> is required (it is written to the audit event)");
for (const [name, value] of [["--operator", operator], ["--approver", approver]] as const)
  if (!value || value.startsWith("--")) throw new Error(`${name} <name> is required (it is written to the audit event)`);
if (!process.argv.includes("--confirm")) throw new Error("Refusing to run without --confirm. This signs the administrator out everywhere and removes their second factor.");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: (process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL)! }) });
try {
  // One transaction with the RLS bypass flag (audit_events and refresh_sessions are FORCE RLS): all or nothing.
  const sessions = await withRlsBypass(prisma, async (tx) => {
    // Lock first, then judge the row: a concurrent demotion or disable can not slip between the check and the reset.
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "emailNormalized"=${email} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { emailNormalized: email } });
    if (!user) throw new Error("No account with that e-mail");
    if (!user.isPlatformAdmin) throw new Error("Refused: the account is not a platform administrator");
    if (user.status !== "ACTIVE" || user.deletedAt) throw new Error("Refused: the account is not active");
    const ended = await tx.refreshSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.user.update({
      where: { id: user.id },
      data: {
        // Not a valid hash of any password: sign-in is impossible until the e-mail password reset sets a new one.
        passwordHash: `!reset-required:${randomUUID()}`,
        authVersion: { increment: 1 },
        mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, mfaRecoveryHashes: [], mfaChallengeHash: null, mfaRecoveryRegenerationRequired: false
      }
    });
    // A reset link requested before the reset must not set the new password.
    await tx.credentialToken.updateMany({ where: { userId: user.id, purpose: "PASSWORD_RESET", usedAt: null }, data: { usedAt: new Date() } });
    await tx.auditEvent.create({
      data: {
        actorUserId: null,
        action: "platform.admin.mfa_reset",
        entityType: "user",
        entityId: user.id,
        metadata: { reason, hadMfa: user.mfaEnabledAt !== null, sessionsRevoked: ended.count, channel: "operator-script", operator, approver, passwordInvalidated: true }
      }
    });
    return ended.count;
  });
  console.log(`MFA reset for the platform administrator; ${sessions} session(s) ended. Their password is invalidated: they must use the e-mail password reset, sign in, and enrol again.`);
} finally {
  await prisma.$disconnect();
}
