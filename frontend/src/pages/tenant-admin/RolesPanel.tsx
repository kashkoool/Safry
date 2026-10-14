import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Lock, Plus, RefreshCw } from "lucide-react";
import { useAuth } from "../../auth/auth-context";
import { Dialog } from "../../components/Dialog";
import { useLanguage } from "../../i18n/useLanguage";
import { useText } from "../../i18n/useText";
import { currentLocale } from "../../i18n/locale";
import { tenantAdmin, type PermissionInfo, type RoleSummary } from "../../lib/tenant-admin";
import { usePermissionLabels } from "./permission-labels";

const errorOf = (reason: unknown, fallback: string): string => (reason instanceof Error ? reason.message : fallback);
const snapshot = (r: Pick<RoleSummary, "name" | "description" | "permissions">): string =>
  JSON.stringify({ name: r.name, description: r.description ?? "", permissions: [...r.permissions].sort() });

export function RolesPanel() {
  const tr = useText();
  const { pick } = useLanguage();
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [permissions, setPermissions] = useState<PermissionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<RoleSummary | "new" | null>(null);
  const [removing, setRemoving] = useState<RoleSummary | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [nextRoles, nextPermissions] = await Promise.all([tenantAdmin.roles(), tenantAdmin.permissions()]);
      setRoles(nextRoles);
      setPermissions(nextPermissions);
      setError("");
    } catch (reason) {
      setError(errorOf(reason, pick("تعذر تحميل الأدوار", "Unable to load roles")));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function saved(text: string): void {
    setEditor(null);
    setRemoving(null);
    setMessage(text);
    void load();
  }

  return (
    <section className="work-panel ta-panel" aria-busy={loading}>
      <h2>{pick("الأدوار", "Roles")}</h2>
      <p className="form-hint">{pick("أدوار النظام جاهزة ومحمية من التعديل. أنشئ أدواراً مخصصة بصلاحيات محددة ثم أسندها من قائمة المستخدمين.", "System roles are built in and protected. Create custom roles with specific permissions, then assign them from the users list.")}</p>
      <div className="ta-toolbar">
        <button className="primary-button" onClick={() => setEditor("new")} disabled={loading || permissions.length === 0}><Plus size={16} aria-hidden="true" /> {pick("دور جديد", "New role")}</button>
        <button className="ghost-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} aria-hidden="true" /> {pick("تحديث", "Refresh")}</button>
      </div>
      {error && <p className="form-error" role="alert">{tr(error)}</p>}
      {message && <p className="workspace-alert" role="status">{tr(message)}</p>}
      {loading && <p role="status">{pick("جاري تحميل الأدوار…", "Loading roles…")}</p>}
      {!loading && !error && (roles.length === 0 ? <p className="empty-state">{pick("لا توجد أدوار.", "No roles yet.")}</p> : (
        <>
          <p className="ta-count" role="status">{pick("عدد الأدوار:", "Roles:")} {roles.length.toLocaleString(currentLocale())}{roles.length >= 200 ? ` ${pick("(الحد الأقصى المعروض)", "(maximum shown)")}` : ""}</p>
          <div className="ta-table-wrap">
            <table className="ta-table">
              <caption className="ta-visually-hidden">{pick("أدوار مساحة العمل", "Workspace roles")}</caption>
              <thead><tr>
                <th scope="col">{pick("الدور", "Role")}</th><th scope="col">{pick("النوع", "Type")}</th>
                <th scope="col">{pick("الصلاحيات", "Permissions")}</th><th scope="col">{pick("الأعضاء", "Members")}</th>
                <th scope="col">{pick("الإجراءات", "Actions")}</th>
              </tr></thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td data-label={pick("الدور", "Role")}><strong>{tr(role.name)}</strong><small dir="ltr">{role.code}</small>{role.description && <small>{tr(role.description)}</small>}</td>
                    <td data-label={pick("النوع", "Type")}>{role.isSystem
                      ? <span className="ta-badge ta-badge--muted"><Lock size={12} aria-hidden="true" /> {pick("دور نظام", "System role")}</span>
                      : <span className="ta-badge">{pick("دور مخصص", "Custom role")}</span>}</td>
                    <td data-label={pick("الصلاحيات", "Permissions")}>{role.permissions.length.toLocaleString(currentLocale())}</td>
                    <td data-label={pick("الأعضاء", "Members")}>{role.members.toLocaleString(currentLocale())}</td>
                    <td data-label={pick("الإجراءات", "Actions")}>
                      <div className="ta-actions">
                        <button className="ghost-button" onClick={() => setEditor(role)} disabled={role.isSystem} aria-describedby={role.isSystem ? "system-role-note" : undefined}>{pick("تعديل", "Edit")}</button>
                        <button className="ghost-button ta-danger" onClick={() => setRemoving(role)} disabled={role.isSystem || role.members > 0} aria-describedby={role.isSystem ? "system-role-note" : role.members > 0 ? "in-use-note" : undefined}>{pick("حذف", "Delete")}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p id="system-role-note" className="ta-note">{pick("لا يمكن تعديل أدوار النظام أو حذفها لأن النظام يعتمد عليها.", "System roles cannot be edited or deleted because the platform depends on them.")}</p>
          <p id="in-use-note" className="ta-note">{pick("لا يمكن حذف دور مسند لأعضاء؛ انقل أعضاءه إلى دور آخر أولاً.", "A role held by members cannot be deleted; move its members to another role first.")}</p>
        </>
      ))}
      {editor && <RoleEditor role={editor === "new" ? null : editor} permissions={permissions} onClose={() => setEditor(null)} onSaved={saved} />}
      {removing && <RemoveRole role={removing} onClose={() => setRemoving(null)} onDone={saved} />}
    </section>
  );
}

function RoleEditor({ role, permissions, onClose, onSaved }: {
  role: RoleSummary | null; permissions: PermissionInfo[]; onClose: () => void; onSaved: (text: string) => void;
}) {
  const tr = useText();
  const { pick } = useLanguage();
  const { user } = useAuth();
  const names = usePermissionLabels();
  const [base, setBase] = useState<RoleSummary | null>(role);
  const [code, setCode] = useState("");
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [chosen, setChosen] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState<RoleSummary | null>(null);
  const held = new Set(user?.permissions ?? []);
  const grouped = useMemo(() => {
    const groups = new Map<string, PermissionInfo[]>();
    permissions.forEach((p) => { const key = p.code.split(".")[0] ?? p.code; groups.set(key, [...(groups.get(key) ?? []), p]); });
    return [...groups.entries()];
  }, [permissions]);
  function toggle(permission: string): void {
    setChosen((current) => { const next = new Set(current); if (next.has(permission)) next.delete(permission); else next.add(permission); return next; });
  }
  function adopt(latest: RoleSummary): void {
    setBase(latest); setName(latest.name); setDescription(latest.description ?? ""); setChosen(new Set(latest.permissions)); setStale(null);
  }
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const list = [...chosen].sort();
      if (!role) {
        await tenantAdmin.createRole({ code, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), permissions: list });
        onSaved(pick("تم إنشاء الدور", "Role created"));
        return;
      }
      // Optimistic check: the API has no version field, so compare with the latest stored copy before overwriting it.
      const latest = (await tenantAdmin.roles()).find((r) => r.id === role.id);
      if (!latest) { setError(pick("حُذف هذا الدور من قبل مستخدم آخر.", "This role was deleted by someone else.")); return; }
      if (base && snapshot(latest) !== snapshot(base)) { setStale(latest); return; }
      await tenantAdmin.updateRole(role.id, { name: name.trim(), description: description.trim(), permissions: list });
      onSaved(pick("تم حفظ الدور", "Role saved"));
    } catch (failure) {
      setError(errorOf(failure, pick("تعذر حفظ الدور", "Unable to save the role")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={role ? pick("تعديل الدور", "Edit role") : pick("دور جديد", "New role")} onClose={onClose}>
      <form className="ta-dialog" onSubmit={submit}>
        {!role && (
          <label>{pick("رمز الدور", "Role code")}
            <input value={code} dir="ltr" required pattern="[a-z][a-z0-9\-]{2,59}" maxLength={60} autoComplete="off" onChange={(e) => setCode(e.target.value)} aria-describedby="role-code-hint" />
            <span id="role-code-hint" className="ta-field-hint">{pick("أحرف إنجليزية صغيرة وأرقام وشرطات، من 3 إلى 60 حرفاً، يبدأ بحرف. لا يمكن تغييره لاحقاً.", "Lowercase letters, digits and dashes, 3 to 60 characters, starting with a letter. It cannot be changed later.")}</span>
          </label>
        )}
        <div className="ta-row">
          <label>{pick("اسم الدور", "Role name")}
            <input value={name} required minLength={2} maxLength={160} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <label>{pick("الوصف (اختياري)", "Description (optional)")}
          <textarea rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="ta-matrix">
          {grouped.map(([key, list]) => (
            <fieldset key={key}>
              <legend>{names.domain(`${key}.x`)}</legend>
              {list.map((p) => {
                const locked = !held.has(p.code);
                const info = names.label(p.code);
                return (
                  <label key={p.code} className="ta-perm">
                    <input type="checkbox" checked={chosen.has(p.code)} disabled={locked} onChange={() => toggle(p.code)} />
                    <span>{info.label}<small dir="auto">{info.hint}{locked ? ` ${pick("(لا تملك هذه الصلاحية فلا يمكنك منحها)", "(you do not hold this permission, so you cannot grant it)")}` : ""}</small></span>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
        {chosen.size > 50 && <p className="form-error" role="alert">{pick("الحد الأقصى 50 صلاحية.", "At most 50 permissions.")}</p>}
        {role && role.members > 0 && <p className="ta-note">{pick("تغيير الصلاحيات يُنهي جلسات الأعضاء الحاملين لهذا الدور ليسري التغيير.", "Changing permissions signs out the members who hold this role so the change takes effect.")}</p>}
        {stale && (
          <div className="ta-note" role="alert">
            {pick("عُدّل هذا الدور من مستخدم آخر بعد فتحه. راجع النسخة الأحدث قبل الحفظ.", "Someone else changed this role after you opened it. Review the latest version before saving.")}
            {" "}<button type="button" className="ghost-button" onClick={() => adopt(stale)}>{pick("تحميل النسخة الأحدث", "Load the latest version")}</button>
          </div>
        )}
        {error && <p className="form-error" role="alert">{tr(error)}</p>}
        <div className="form-actions">
          <button type="button" className="ghost-button" onClick={onClose}>{pick("رجوع", "Cancel")}</button>
          <button className="primary-button" disabled={busy || chosen.size > 50}>{busy ? pick("جاري الحفظ…", "Saving…") : pick("حفظ", "Save")}</button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveRole({ role, onClose, onDone }: { role: RoleSummary; onClose: () => void; onDone: (text: string) => void }) {
  const tr = useText();
  const { pick } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await tenantAdmin.deleteRole(role.id);
      onDone(pick("تم حذف الدور", "Role deleted"));
    } catch (failure) {
      setError(errorOf(failure, pick("تعذر حذف الدور", "Unable to delete the role")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={pick("حذف الدور", "Delete role")} onClose={onClose}>
      <div className="ta-dialog">
        <p>{pick("سيُحذف الدور نهائياً:", "This role will be permanently deleted:")} <strong>{tr(role.name)}</strong> (<bdi dir="ltr">{role.code}</bdi>)</p>
        {error && <p className="form-error" role="alert">{tr(error)}</p>}
        <div className="form-actions">
          <button className="ghost-button" onClick={onClose}>{pick("رجوع", "Cancel")}</button>
          <button className="primary-button ta-danger" disabled={busy} onClick={() => void remove()}>{busy ? pick("جاري الحذف…", "Deleting…") : pick("حذف الدور", "Delete role")}</button>
        </div>
      </div>
    </Dialog>
  );
}
