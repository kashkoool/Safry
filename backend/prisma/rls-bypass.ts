import type { Prisma, PrismaClient } from "../src/generated/prisma/client.js";

/**
 * Operator scripts (bootstrap, seed, bootstrap-platform-admin) run as the database OWNER. Migration 0010 puts FORCE ROW
 * LEVEL SECURITY on the tenant tables, so an owner that is neither superuser nor BYPASSRLS (the normal case on a managed
 * PostgreSQL) is confined like anybody else and every insert fails with 42501.
 *
 * The bypass flag is transaction-local (`set_config(..., true)`): it only lasts inside this one explicit transaction, so
 * every statement of the script must use the `tx` client passed to `work`, never the outer client.
 */
export async function withRlsBypass<T>(prisma: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return work(tx);
    },
    { timeout: 120_000, maxWait: 30_000 }
  );
}
