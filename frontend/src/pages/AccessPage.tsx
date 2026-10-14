import { Navigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/auth-context";
import { useLanguage } from "../i18n/useLanguage";
import { TenantAdminLayout } from "./tenant-admin/TenantAdminLayout";
import { RolesPanel } from "./tenant-admin/RolesPanel";
import { AuditPanel } from "./tenant-admin/AuditPanel";

/** /workspace/access/:section - roles and permissions (identity.role.manage) and the permission audit (audit.read). */
export function AccessPage() {
  const { pick } = useLanguage();
  const { user } = useAuth();
  const { section } = useParams();
  const canRoles = Boolean(user?.permissions.includes("identity.role.manage"));
  const canAudit = Boolean(user?.permissions.includes("audit.read"));
  const current = section === "roles" || section === "audit" ? section : null;
  const allowed = (current === "roles" && canRoles) || (current === "audit" && canAudit);
  if (!allowed) {
    // Existing forbidden handling: send the user to a section they may open, else back to the workspace.
    const fallback = canRoles ? "roles" : canAudit ? "audit" : null;
    return <Navigate to={fallback ? `/workspace/access/${fallback}` : "/workspace/overview"} replace />;
  }
  const tabs = [
    ...(canRoles ? [{ to: "/workspace/access/roles", label: pick("الأدوار والصلاحيات", "Roles and permissions"), active: current === "roles" }] : []),
    ...(canAudit ? [{ to: "/workspace/access/audit", label: pick("تدقيق الصلاحيات", "Permission audit"), active: current === "audit" }] : [])
  ];
  return (
    <TenantAdminLayout
      title={current === "roles" ? pick("الأدوار والصلاحيات", "Roles and permissions") : pick("تدقيق الصلاحيات", "Permission audit")}
      intro={pick("حدّد من يستطيع فعل ماذا في مساحة العمل، وراجع كل تغيير في الأدوار والصلاحيات.", "Decide who can do what in this workspace, and review every change to roles and permissions.")}
      tabs={tabs}
    >
      {current === "roles" ? <RolesPanel /> : <AuditPanel />}
    </TenantAdminLayout>
  );
}
