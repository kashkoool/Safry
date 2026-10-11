import type { Prisma } from "../../generated/prisma/client.js";

type SessionClient = { refreshSession: { updateMany(args: { where: Prisma.RefreshSessionWhereInput; data: { revokedAt: Date } }): Promise<{ count: number }> } };

/** Revokes every still-active refresh session matching `where` (the one place that stamps `revokedAt`). Returns how many ended. */
export async function revokeActiveSessions(db: SessionClient, where: Prisma.RefreshSessionWhereInput): Promise<number> {
  const result = await db.refreshSession.updateMany({ where: { ...where, revokedAt: null }, data: { revokedAt: new Date() } });
  return result.count;
}
