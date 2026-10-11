import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Database scope of the current request (Tenant Data Isolation).
 * - tenant: the verified tenant of the authenticated principal; queries are confined to it.
 * - system: explicit cross-tenant access (platform administration, pre-authentication flows).
 * A request without a scope can not touch tenant data: the database layer fails closed.
 */
export type DbScope = { kind: "tenant"; tenantId: string } | { kind: "system" };

export interface RequestContextData {
  requestId: string;
  scope?: DbScope;
}

export const requestContext = new AsyncLocalStorage<RequestContextData>();

export function currentScope(): DbScope | undefined {
  return requestContext.getStore()?.scope;
}

/** Binds the rest of the request to one tenant. Called only after the token has been verified. */
export function bindTenantScope(tenantId: string): void {
  const store = requestContext.getStore();
  if (store) store.scope = { kind: "tenant", tenantId };
}

/** Marks the rest of the request as an explicit platform-level (cross-tenant) operation. */
export function bindSystemScope(): void {
  const store = requestContext.getStore();
  if (store) store.scope = { kind: "system" };
}

/**
 * Runs a callback with explicit cross-tenant access (login, token refresh, public registration).
 * The callback is awaited inside the scope: Prisma promises are lazy and would otherwise
 * start running after the scope has been left.
 */
export function runAsSystem<T>(callback: () => PromiseLike<T>): Promise<T> {
  const store = requestContext.getStore() ?? { requestId: "system" };
  return requestContext.run({ ...store, scope: { kind: "system" } }, async () => await callback());
}
