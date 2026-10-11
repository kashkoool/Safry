import type { AuthUser } from "./auth-user.js";

/** Tenant administrator (manages everything inside the tenant). */
export const isTenantAdmin = (user: AuthUser): boolean => user.roles.includes("tenant-admin");

/** Staff member of a provider organization (service provider / travel company). */
export const isOperator = (user: AuthUser): boolean => Boolean(user.providerOrganizationId);

/**
 * Privilege ceiling: a manager who is not a tenant administrator may only grant,
 * edit or take away access that they hold themselves.
 */
export const withinCeiling = (user: AuthUser, codes: Iterable<string>): boolean =>
  isTenantAdmin(user) || [...codes].every((code) => user.permissions.includes(code));

/** Role codes and permissions currently held through one membership. */
export interface HeldAccess {
  roles: Array<{ role: { code: string; permissions?: Array<{ permission: { code: string } }> } }>;
}

export const heldPermissionCodes = (member: HeldAccess): string[] =>
  member.roles.flatMap(({ role }) => role.permissions?.map(({ permission }) => permission.code) ?? []);
