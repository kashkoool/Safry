import { useLanguage } from "../../i18n/useLanguage";

export interface PermissionLabel { label: string; hint: string }

/** Localised name of each permission code and of each domain (the part before the first dot). Unknown codes show as-is. */
export function usePermissionLabels() {
  const { pick } = useLanguage();
  const labels: Record<string, PermissionLabel> = {
    "tenant.read": { label: pick("عرض مساحة العمل", "View workspace"), hint: pick("قراءة اسم مساحة العمل وإعداداتها", "Read the workspace name and settings") },
    "tenant.update": { label: pick("تعديل مساحة العمل", "Edit workspace"), hint: pick("تغيير الاسم واللغة والعملة والعلامة", "Change name, language, currency and branding") },
    "identity.user.read": { label: pick("عرض المستخدمين", "View users"), hint: pick("قائمة أعضاء مساحة العمل", "List the workspace members") },
    "identity.user.manage": { label: pick("إدارة المستخدمين", "Manage users"), hint: pick("تغيير حالة الأعضاء وإدارة المنشآت", "Change member status and manage companies") },
    "identity.role.manage": { label: pick("إدارة الأدوار", "Manage roles"), hint: pick("إنشاء الأدوار وإسنادها", "Create roles and assign them") },
    "audit.read": { label: pick("قراءة سجل التدقيق", "Read the audit trail"), hint: pick("عرض سجل التغييرات", "See the change history") },
    "catalog.service.read": { label: pick("تصفح الخدمات", "Browse services"), hint: pick("عرض الخدمات والعروض", "See services and offers") },
    "catalog.service.manage": { label: pick("إدارة الخدمات", "Manage services"), hint: pick("إنشاء الخدمات وتعديلها", "Create and edit services") },
    "booking.read": { label: pick("عرض الحجوزات", "View bookings"), hint: pick("الحجوزات المتاحة لدورك", "Bookings visible to the role") },
    "booking.create": { label: pick("إنشاء الحجوزات", "Create bookings"), hint: pick("طلب الحجز وتعديله وإلغاؤه", "Request, edit and cancel bookings") },
    "booking.manage": { label: pick("إدارة الحجوزات", "Manage bookings"), hint: pick("تأكيد الحجوزات وإلغاؤها", "Confirm and cancel bookings") },
    "organization.staff.manage": { label: pick("إدارة موظفي المنشأة", "Manage company staff"), hint: pick("الأقسام والموظفون في منشأة محددة", "Departments and staff of one company") }
  };
  const domains: Record<string, string> = {
    tenant: pick("مساحة العمل", "Workspace"), identity: pick("المستخدمون والوصول", "Users and access"), audit: pick("التدقيق", "Audit"),
    catalog: pick("الخدمات", "Services"), booking: pick("الحجوزات", "Bookings"), organization: pick("المنشآت", "Companies")
  };
  return {
    label: (code: string): PermissionLabel => labels[code] ?? { label: code, hint: "" },
    domain: (code: string): string => domains[code.split(".")[0] ?? ""] ?? code.split(".")[0] ?? code
  };
}
