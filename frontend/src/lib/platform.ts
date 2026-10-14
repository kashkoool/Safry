import { request } from "./api";
import type { AuditEvent } from "./tenant-admin";
import { cached, invalidate } from "./cache";

const seg = encodeURIComponent;
const afterWrite = <T>(work: Promise<T>): Promise<T> => work.finally(() => invalidate("platform:"));
/** Step-up credentials of the ACTING admin (never stored). The API answers 401 when they are missing or wrong. */
export interface StepUp {
  currentPassword: string;
  mfaCode?: string;
}
export interface AdminRole {
  id: string;
  code: string;
  name: string;
  tenantId: string;
  permissions: Array<{ permission: { code: string } }>;
}
export interface AdminMembership {
  id: string;
  tenantId: string;
  status: string;
  providerOrganizationId: string | null;
  permissionOverrides: Record<string, boolean>;
  tenant: { name: string; code: string };
  roles: Array<{ role: AdminRole }>;
  organization: { name: string } | null;
}
export interface AdminRecord {
  id: string;
  displayName?: string;
  email?: string;
  phone?: string | null;
  status?: string;
  isPlatformAdmin?: boolean;
  deletedAt?: string | null;
  createdAt?: string;
  occurredAt?: string;
  action?: string;
  entityId?: string;
  name?: string;
  title?: string;
  code?: string;
  type?: string;
  category?: string;
  tenant?: { name: string; code: string } | null;
  organization?: { name: string };
  service?: { title: string };
  user?: { id: string; displayName: string; email: string };
  actor?: { displayName: string; email: string } | null;
  memberships?: AdminMembership[];
  revokedAt?: string | null;
  expiresAt?: string;
}
export interface AdminReferences {
  tenants: Array<{ id: string; name: string; code: string }>;
  roles: AdminRole[];
  permissions: Array<{ code: string; description: string | null }>;
  organizations: Array<{ id: string; tenantId: string; name: string; type: string }>;
}
export interface AdminPage {
  items: AdminRecord[];
  total: number;
  page: number;
  pageSize: number;
}
export interface AdminProfile {
  displayName: string;
  email: string;
  phone: string;
  isPlatformAdmin?: boolean;
  /** Step-up credentials, required by the API when granting platform administration. Never stored. */
  currentPassword?: string;
  mfaCode?: string;
}
export interface NewAccount extends AdminProfile {
  password: string;
  tenantId: string;
  roleId: string;
  providerOrganizationId?: string;
}
export interface PlatformTenant {
  id: string;
  code: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
}
export const platform = {
  createTenant: (input: { code: string; name: string; settings?: Record<string, unknown> }) =>
    afterWrite(request<PlatformTenant>("/platform/tenants", { method: "POST", body: JSON.stringify(input) })),
  setTenantStatus: (id: string, status: PlatformTenant["status"], reason: string) =>
    afterWrite(request<PlatformTenant>(`/platform/tenants/${seg(id)}/status`, { method: "POST", body: JSON.stringify({ status, reason }) })),
  tenantActivity: (id: string) => request<AuditEvent[]>(`/platform/tenants/${seg(id)}/activity`),
  /** Clears a sign-in block for an e-mail address; the API answers 204 whether or not one existed. */
  unlockLogin: (email: string) => request<void>("/auth/login-throttle/unlock", { method: "POST", body: JSON.stringify({ email }) }),
  overview: () => cached("platform:overview", 15_000, () => request<Record<string, number | string>>("/platform/overview")),
  references: () => cached("platform:references", 5 * 60_000, () => request<AdminReferences>("/platform/references")),
  records: (kind: string, page: number, tenantId: string, q: string, signal?: AbortSignal) =>
    request<AdminPage>(
      `/platform/records/${seg(kind)}?${new URLSearchParams({ page: String(page), ...(tenantId ? { tenantId } : {}), ...(q ? { q } : {}) })}`,
      { signal }
    ),
  create: (input: NewAccount) =>
    afterWrite(request<AdminRecord>("/platform/users", { method: "POST", body: JSON.stringify(input) }, !input.currentPassword)),
  update: (id: string, input: AdminProfile) =>
    afterWrite(request<AdminRecord>(
      `/platform/users/${seg(id)}`,
      { method: "PATCH", body: JSON.stringify(input) },
      // A 401 on a step-up call means a wrong password/code: never rotate the refresh token and replay the guess.
      !input.currentPassword
    )),
  state: (id: string, action: string, reason: string, stepUp?: StepUp) =>
    afterWrite(request<AdminRecord>(`/platform/users/${seg(id)}/state`, {
      method: "POST",
      body: JSON.stringify({ action, reason, ...stepUp })
    }, !stepUp?.currentPassword)),
  revoke: (id: string) => afterWrite(request(`/platform/users/${seg(id)}/revoke-sessions`, { method: "POST" })),
  access: (
    id: string,
    input: {
      roleIds: string[];
      status: string;
      providerOrganizationId: string | null;
      permissionOverrides: Record<string, boolean>;
    } & Partial<StepUp>
  ) => afterWrite(request(`/platform/memberships/${seg(id)}/access`, { method: "PATCH", body: JSON.stringify(input) }, !input.currentPassword))
};
