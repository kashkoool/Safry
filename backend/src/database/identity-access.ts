import type { Prisma } from "../generated/prisma/client.js";

/**
 * Row-level security on `users` (migration 20261018) lets a tenant session see only identities that have a membership in
 * its tenant. Staff creation and invitations must look an identity up by e-mail, and create one, BEFORE that membership
 * exists. This raises one narrow, transaction-local flag (`app.identity_system`) around exactly that work: it allows SELECT
 * and INSERT on `users` only (no UPDATE, no DELETE), and is restored afterwards. Use it for the minimal statement group,
 * never around business logic.
 */
export async function withIdentityLookup<T>(tx: Prisma.TransactionClient, work: () => Promise<T>): Promise<T> {
  const [previous] = await tx.$queryRaw<Array<{ value: string }>>`SELECT coalesce(current_setting('app.identity_system', true), 'off') AS value`;
  await tx.$queryRaw`SELECT set_config('app.identity_system', 'on', true)`;
  try {
    return await work();
  } finally {
    // After a failed statement the transaction is aborted and rolls back anyway, so a failing reset is harmless.
    await tx.$queryRaw`SELECT set_config('app.identity_system', ${previous?.value === "on" ? "on" : "off"}, true)`.catch(() => undefined);
  }
}
