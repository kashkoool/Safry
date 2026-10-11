import { ForbiddenException } from "@nestjs/common";

/** Prisma model name -> column that holds the tenant of the row. */
export const TENANT_KEY: Readonly<Record<string, string>> = {
  Tenant: "id",
  TenantMembership: "tenantId",
  ProviderOrganization: "tenantId",
  OrganizationDepartment: "tenantId",
  TravelService: "tenantId",
  ServiceComponent: "tenantId",
  Booking: "tenantId",
  Role: "tenantId",
  MembershipRole: "tenantId",
  RefreshSession: "tenantId",
  AuditEvent: "tenantId"
};

const FILTERED = new Set([
  "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy", "updateMany", "deleteMany"
]);
const UNIQUE = new Set(["findUnique", "findUniqueOrThrow", "update", "delete", "upsert"]);
const CREATES = new Set(["create", "createMany", "createManyAndReturn"]);

export class TenantIsolationError extends ForbiddenException {
  constructor(detail: string) {
    super(`Tenant isolation violation: ${detail}`);
  }
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Rejects a value that points at another tenant; returns true when the key was present. */
function checkOwn(row: Row, key: string, tenantId: string, where: string): boolean {
  if (!(key in row) || row[key] === undefined) return false;
  if (row[key] !== tenantId) throw new TenantIsolationError(`${where} targets another tenant`);
  return true;
}

function confineWhere(where: unknown, key: string, tenantId: string, unique: boolean): Row {
  const source = isRow(where) ? where : {};
  if (key in source && source[key] !== undefined) {
    if (typeof source[key] === "string") {
      checkOwn(source, key, tenantId, "where");
      return source;
    }
    if (unique) throw new TenantIsolationError("filter on the tenant key is not allowed here");
    return { AND: [source, { [key]: tenantId }] };
  }
  return { ...source, [key]: tenantId };
}

/**
 * Audit events may be platform-level (no tenant), but only from the system scope: inside a tenant
 * session a NULL tenant is stamped with the session's tenant (the RLS policy agrees).
 */
const NULLABLE_KEY = new Set(["AuditEvent"]);

/** A relation-style create may only connect the session's own tenant. */
function checkRelation(data: Row, tenantId: string): void {
  const relation = data["tenant"];
  const connect = isRow(relation) ? relation["connect"] : undefined;
  if (!isRow(relation) || Object.keys(relation).join() !== "connect" || !isRow(connect) ||
    Object.keys(connect).join() !== "id" || connect["id"] !== tenantId)
    throw new TenantIsolationError("tenant relation must connect the current tenant");
}

function confineData(data: unknown, model: string, key: string, tenantId: string, where: string): unknown {
  if (!isRow(data)) return data;
  if (model === "Tenant") throw new TenantIsolationError("tenants can only be created by the platform");
  if (NULLABLE_KEY.has(model) && data[key] === null) return { ...data, [key]: tenantId };
  const present = checkOwn(data, key, tenantId, where);
  if ("tenant" in data) {
    checkRelation(data, tenantId);
    return data;
  }
  return present ? data : { ...data, [key]: tenantId };
}

/**
 * Application-level tenant confinement: injects the verified tenant into every
 * top-level query on a tenant-owned model and rejects data aimed at another tenant.
 * PostgreSQL row-level security enforces the same rule underneath (migration 0010).
 */
export function confineToTenant(model: string, operation: string, args: unknown, tenantId: string): unknown {
  const key = TENANT_KEY[model];
  if (!key) return args;
  const input: Row = isRow(args) ? { ...args } : {};
  if (FILTERED.has(operation) || UNIQUE.has(operation))
    input["where"] = confineWhere(input["where"], key, tenantId, UNIQUE.has(operation));
  if (operation === "create" || operation === "upsert" && isRow(input["create"])) {
    const field = operation === "create" ? "data" : "create";
    input[field] = confineData(input[field], model, key, tenantId, field);
  }
  if (operation === "update" || operation === "updateMany" || operation === "upsert") {
    const field = operation === "upsert" ? "update" : "data";
    if (isRow(input[field])) checkOwn(input[field], key, tenantId, field);
  }
  if (CREATES.has(operation) && operation !== "create") {
    const rows = Array.isArray(input["data"]) ? input["data"] : [input["data"]];
    const confined = rows.map((row) => confineData(row, model, key, tenantId, "data"));
    input["data"] = Array.isArray(input["data"]) ? confined : confined[0];
  }
  return input;
}
