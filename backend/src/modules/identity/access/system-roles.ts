/**
 * Roles & Permissions: the permission catalogue and the system roles every tenant starts with.
 * Shared by the seed script and by tenant creation so both always produce the same baseline.
 */
export const PERMISSIONS = [
  ["platform.tenant.create", "Create platform tenants"],
  ["tenant.read", "Read the current tenant"],
  ["tenant.update", "Update the current tenant"],
  ["identity.user.read", "Read tenant users"],
  ["identity.user.manage", "Manage tenant users"],
  ["identity.role.manage", "Manage roles and permissions"],
  ["audit.read", "Read audit events"],
  ["catalog.service.read", "Browse travel services"],
  ["catalog.service.manage", "Create and manage provider services"],
  ["booking.read", "Read bookings visible to the current role"],
  ["booking.create", "Create traveler bookings"],
  ["booking.manage", "Manage booking status"],
  ["organization.staff.manage", "Manage staff and departments of an assigned organization"]
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number][0];

export const SYSTEM_ROLES = [
  ["tenant-admin", "مدير الجهة"],
  ["service-provider", "مقدم خدمة"],
  ["travel-company", "شركة سياحة"],
  ["traveler", "مسافر"],
  ["organization-manager", "مسؤول المنشأة"]
] as const;

export type SystemRoleCode = (typeof SYSTEM_ROLES)[number][0];

export const ROLE_PERMISSIONS: Readonly<Record<SystemRoleCode, readonly PermissionCode[]>> = {
  "tenant-admin": PERMISSIONS.map(([code]) => code)
    .filter((code) => code !== "organization.staff.manage" && !code.startsWith("platform.")),
  "organization-manager": ["organization.staff.manage"],
  "service-provider": ["tenant.read", "catalog.service.read", "catalog.service.manage", "booking.read", "booking.manage"],
  "travel-company": ["tenant.read", "catalog.service.read", "catalog.service.manage", "booking.read", "booking.manage"],
  traveler: ["tenant.read", "catalog.service.read", "booking.read", "booking.create"]
};

/** Permissions that only the platform may grant; a tenant can never put them in a custom role. */
export const PLATFORM_ONLY_PREFIX = "platform.";

export const SYSTEM_ROLE_CODES: ReadonlySet<string> = new Set(SYSTEM_ROLES.map(([code]) => code));
