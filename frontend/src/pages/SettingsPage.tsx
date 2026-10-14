import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/auth-context";
import { TenantSettingsFields } from "../components/TenantSettingsFields";
import { useLanguage } from "../i18n/useLanguage";
import { useText } from "../i18n/useText";
import { tenantAdmin, type TenantPatch, type TenantProfile } from "../lib/tenant-admin";
import { formFromSettings, settingsPatch, validTimeZone, type SettingsForm } from "../lib/tenant-settings";
import { formatWhen } from "../lib/format-when";
import { TenantAdminLayout } from "./tenant-admin/TenantAdminLayout";

/** /workspace/settings - read and update the current workspace (name, language, time zone, currency, branding). */
export function SettingsPage() {
  const { user } = useAuth();
  const canOpen = Boolean(user?.permissions.includes("tenant.update"));
  if (!canOpen) return <Navigate to="/workspace/overview" replace />;
  return <SettingsContent />;
}

function SettingsContent() {
  const tr = useText();
  const { pick } = useLanguage();
  const [tenant, setTenant] = useState<TenantProfile | null>(null);
  const [name, setName] = useState("");
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  function adopt(next: TenantProfile): void {
    setTenant(next);
    setName(next.name);
    setForm(formFromSettings(next.settings));
  }
  useEffect(() => {
    let live = true;
    tenantAdmin.tenant()
      .then((next) => { if (live) adopt(next); })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : pick("تعذر تحميل الإعدادات", "Unable to load the settings")); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initial = useMemo(() => formFromSettings(tenant?.settings), [tenant]);
  const patch: TenantPatch | undefined = useMemo(() => {
    if (!tenant || !form) return undefined;
    const settings = settingsPatch(initial, form);
    const nameChanged = name.trim() !== tenant.name;
    return nameChanged || settings ? { ...(nameChanged ? { name: name.trim() } : {}), ...(settings ? { settings } : {}) } : undefined;
  }, [tenant, form, initial, name]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!patch || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      adopt(await tenantAdmin.updateTenant(patch));
      setMessage(pick("تم حفظ إعدادات مساحة العمل", "Workspace settings saved"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : pick("تعذر حفظ الإعدادات", "Unable to save the settings"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <TenantAdminLayout
      title={pick("إعدادات مساحة العمل", "Workspace settings")}
      intro={pick("الاسم واللغة والعملة والمنطقة الزمنية والعلامة التي تظهر لأعضاء مساحة العمل.", "The name, language, currency, time zone and branding that members of this workspace see.")}
    >
      <section className="work-panel ta-panel" aria-busy={loading}>
        {loading && <p role="status">{pick("جاري تحميل الإعدادات…", "Loading settings…")}</p>}
        {error && <p className="form-error" role="alert">{tr(error)}</p>}
        {message && <p className="workspace-alert" role="status">{tr(message)}</p>}
        {tenant && form && (
          <form className="ta-form" onSubmit={submit}>
            <label>{pick("اسم مساحة العمل", "Workspace name")}
              <input value={name} required minLength={2} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </label>
            <dl className="details-list">
              <div><dt>{pick("رمز مساحة العمل", "Workspace code")}</dt><dd><bdi dir="ltr">{tenant.code}</bdi></dd></div>
              <div><dt>{pick("آخر تحديث", "Last updated")}</dt><dd>{formatWhen(tenant.updatedAt, validTimeZone(tenant.settings))}</dd></div>
            </dl>
            <TenantSettingsFields value={form} onChange={setForm} name={name} idPrefix="settings" />
            <p className="ta-note">{pick("تُطبَّق العملة الافتراضية كعملة عرض للأعضاء الذين لم يختاروا عملة بأنفسهم، وتُستخدم المنطقة الزمنية في أوقات سجلات التدقيق.", "The default currency is used as the display currency for members who have not picked one, and the time zone is used for audit trail times.")}</p>
            <div className="form-actions">
              <button type="button" className="ghost-button" disabled={!patch || busy} onClick={() => adopt(tenant)}>{pick("تراجع عن التغييرات", "Discard changes")}</button>
              <button className="primary-button" disabled={!patch || busy}>{busy ? pick("جاري الحفظ…", "Saving…") : pick("حفظ الإعدادات", "Save settings")}</button>
            </div>
          </form>
        )}
      </section>
    </TenantAdminLayout>
  );
}
