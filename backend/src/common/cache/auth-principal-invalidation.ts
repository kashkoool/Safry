import type { InvalidationTarget } from "./auth-principal-cache.js";

/** Models whose rows feed the cached principal (session, membership, roles, permissions, user, tenant). */
const AFFECTING = new Set([
  "RefreshSession", "TenantMembership", "MembershipRole", "Role", "RolePermission", "Permission", "User", "Tenant"
]);
const WRITES = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"
]);

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Fields written by `data`, including nested relation writes (any of which could change a role or status). */
function dataKeys(args: Row): string[] {
  return isRow(args["data"]) ? Object.keys(args["data"]) : [];
}

/**
 * Decides what a write invalidates. Conservative on purpose: when the affected principals can not be
 * identified from the arguments the whole cache is flushed. Returns undefined when the write can not
 * change a principal (a different model, or a session that only had `lastUsedAt` touched or was created).
 */
export function invalidationFor(model: string, operation: string, args: unknown): InvalidationTarget | undefined {
  if (!AFFECTING.has(model) || !WRITES.has(operation)) return undefined;
  const input: Row = isRow(args) ? args : {};
  const where: Row = isRow(input["where"]) ? input["where"] : {};
  if (model === "RefreshSession") {
    if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") return undefined;
    const keys = dataKeys(input);
    if (operation !== "delete" && operation !== "deleteMany" && keys.length > 0 && keys.every((k) => k === "lastUsedAt"))
      return undefined;
    const id = str(where["id"]);
    if (id) return { sessionId: id };
    const userId = str(where["userId"]);
    return userId ? { userId } : "all";
  }
  if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") {
    // New rows can only matter when they attach to an existing membership/role/user.
    if (model === "User" || model === "Tenant" || model === "Permission" || model === "TenantMembership") return undefined;
    const data = isRow(input["data"]) ? input["data"] : undefined;
    const membershipId = str(data?.["membershipId"]);
    if (model === "MembershipRole" && membershipId) return { membershipId };
    return "all";
  }
  switch (model) {
    case "User":
      return str(where["id"]) ? { userId: str(where["id"])! } : "all";
    case "Tenant":
      return str(where["id"]) ? { tenantId: str(where["id"])! } : "all";
    case "TenantMembership": {
      if (str(where["id"])) return { membershipId: str(where["id"])! };
      if (str(where["userId"])) return { userId: str(where["userId"])! };
      return "all";
    }
    case "MembershipRole":
      return str(where["membershipId"]) ? { membershipId: str(where["membershipId"])! } : "all";
    case "Role":
      return str(where["tenantId"]) ? { tenantId: str(where["tenantId"])! } : "all";
    default:
      return "all";
  }
}
