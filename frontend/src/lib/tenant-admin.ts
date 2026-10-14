import { afterWrite, read, request } from "./api";

const seg = encodeURIComponent;

export type MemberStatus = "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
export interface Member {
  id: string;
  status: MemberStatus;
  awaitingOwnerConsent: boolean;
  jobTitle?: string | null;
  createdAt: string;
  user: { id: string; email: string; displayName: string; phone?: string | null; status: string };
  roles: Array<{ role: { code: string; name: string } }>;
}
export interface AuditEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  metadata: unknown;
  occurredAt: string;
}
export interface RoleSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  members: number;
}
export interface PermissionInfo {
  code: string;
  description: string | null;
}
export interface TenantSettings {
  locale?: string;
  timezone?: string;
  currency?: string;
  branding?: { primaryColor?: string; logoUrl?: string };
  [key: string]: unknown;
}
export interface TenantProfile {
  id: string;
  code: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  settings: TenantSettings;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}
/** Body of PATCH /tenants/current: only the keys the user changed (the API merges `settings` key by key). */
export interface TenantPatch {
  name?: string;
  settings?: Omit<TenantSettings, "features">;
}

export const tenantAdmin = {
  /** `q` is matched by the server against e-mail and display name (the list is capped at 500, oldest first). */
  members: (q: string, signal?: AbortSignal) =>
    request<Member[]>(`/tenants/members${q ? `?${new URLSearchParams({ q })}` : ""}`, { signal }),
  setMemberStatus: (id: string, status: Exclude<MemberStatus, "INVITED">, reason?: string) =>
    request<Member>(`/tenants/members/${seg(id)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, ...(reason ? { reason } : {}) })
    }),
  memberHistory: (id: string) => request<AuditEvent[]>(`/tenants/members/${seg(id)}/history`),
  roles: () => request<RoleSummary[]>("/roles"),
  permissions: () => request<PermissionInfo[]>("/permissions"),
  createRole: (input: { code: string; name: string; description?: string; permissions: string[] }) =>
    request<RoleSummary>("/roles", { method: "POST", body: JSON.stringify(input) }),
  updateRole: (id: string, input: { name?: string; description?: string; permissions?: string[] }) =>
    request<RoleSummary>(`/roles/${seg(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteRole: (id: string) => request<void>(`/roles/${seg(id)}`, { method: "DELETE" }),
  assignRoles: (membershipId: string, roleIds: string[]) =>
    request<{ membershipId: string; roles: Array<{ id: string; code: string; name: string }> }>(
      `/memberships/${seg(membershipId)}/roles`,
      { method: "PUT", body: JSON.stringify({ roleIds }) }
    ),
  /** Role and permission related events of this tenant, newest first; the API accepts only `limit` (1-200). */
  accessAudit: (limit: number) => request<AuditEvent[]>(`/access/audit?${new URLSearchParams({ limit: String(limit) })}`),
  tenant: () => read("tenant", () => request<TenantProfile>("/tenants/current")),
  updateTenant: (patch: TenantPatch) =>
    afterWrite(["tenant"], request<TenantProfile>("/tenants/current", { method: "PATCH", body: JSON.stringify(patch) }))
};
