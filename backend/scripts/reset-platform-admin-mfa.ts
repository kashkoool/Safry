import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { withRlsBypass } from "../prisma/rls-bypass.js";

/**
 * Break-glass reset of the second factor of ONE platform administrator who lost both the authenticator and the recovery codes.
 * Usage: tsx scripts/reset-platform-admin-mfa.ts --email <address> --reason <ticket or short text> --confirm
 * See docs/DEPLOYMENT.md, "Lost authenticator and recovery codes". Prints no secret.
 */
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const email = option("--email")?.trim().toLowerCase();
const reason = option("--reason")?.trim();
if (!email) throw new Error("--email <address> is required");
if (!reason || reason.length < 3 || reason.startsWith("--")) throw new Error("--reason <ticket id or short text> is required (it is written to the audit event)");
if (!process.argv.includes("--confirm")) throw new Error("Refusing to run without --confirm. This signs the administrator out everywhere and removes their second factor.");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: (process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL)! }) });
try {
  // One transaction with the RLS bypass flag (audit_events and refresh_sessions are FORCE RLS): all or nothing.
  const sessions = await withRlsBypass(prisma, async (tx) => {
    const user = await tx.user.findUnique({ where: { emailNormalized: email } });
    if (!user) throw new Error("No account with that e-mail");
    if (!user.isPlatformAdmin) throw new Error("Refused: the account is not a platform administrator");
    if (user.status !== "ACTIVE" || user.deletedAt) throw new Error("Refused: the account is not active");
    // Lock the row so a login or an enrolment running now cannot interleave with the reset.
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id"=${user.id}::uuid FOR UPDATE`;
    const ended = await tx.refreshSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.user.update({
      where: { id: user.id },
      data: { mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, mfaRecoveryHashes: [], mfaChallengeHash: null, mfaRecoveryRegenerationRequired: false }
    });
    await tx.auditEvent.create({
      data: {
        actorUserId: null,
        action: "platform.admin.mfa_reset",
        entityType: "user",
        entityId: user.id,
        metadata: { reason, hadMfa: user.mfaEnabledAt !== null, sessionsRevoked: ended.count, channel: "operator-script" }
      }
    });
    return ended.count;
  });
  console.log(`MFA reset for the platform administrator; ${sessions} session(s) ended. They must sign in with the password and enrol again.`);
} finally {
  await prisma.$disconnect();
}
