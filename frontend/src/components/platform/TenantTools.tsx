import { useEffect, useState, type FormEvent } from "react";
import { Dialog } from "../Dialog";
import { AuditTable } from "../AuditTable";
import { TenantSettingsFields } from "../TenantSettingsFields";
import { useLanguage } from "../../i18n/useLanguage";
import { useText } from "../../i18n/useText";
import { platform, type PlatformTenant } from "../../lib/platform";
import type { AuditEvent } from "../../lib/tenant-admin";
import { formFromSettings, settingsPatch } from "../../lib/tenant-settings";
import "../../pages/tenant-admin.css";

const errorOf = (reason: unknown, fallback: string): string => (reason instanceof Error ? reason.message : fallback);

export function CreateTenantDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const tr = useText();
  const { pick } = useLanguage();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [form, setForm] = useState(formFromSettings(undefined));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const settings = settingsPatch(formFromSettings(undefined), form);
      await platform.createTenant({ code: code.trim(), name: name.trim(), ...(settings ? { settings } : {}) });
      onSaved();
    } catch (failure) {
      setError(errorOf(failure, pick("تعذر إنشاء مساحة العمل", "Unable to create the workspace")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={pick("مساحة عمل جديدة", "New workspace")} onClose={onClose}>
      <form className="ta-dialog" onSubmit={submit}>
        <div className="ta-row">
          <label>{pick("رمز مساحة العمل", "Workspace code")}
            <input dir="ltr" required minLength={2} maxLength={64} pattern="[a-z0-9\-]+" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} aria-describedby="tenant-code-hint" />
            <span id="tenant-code-hint" className="ta-field-hint">{pick("أحرف إنجليزية صغيرة وأرقام وشرطات (2 إلى 64). يُستخدم عند تسجيل الدخول.", "Lowercase letters, digits and dashes (2 to 64). Used when signing in.")}</span>
          </label>
          <label>{pick("اسم مساحة العمل", "Workspace name")}
            <input required minLength={2} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <TenantSettingsFields value={form} onChange={setForm} name={name} idPrefix="new-tenant" />
        {error && <p className="form-error" role="alert">{tr(error)}</p>}
        <div className="form-actions">
          <button type="button" className="ghost-button" onClick={onClose}>{pick("رجوع", "Cancel")}</button>
          <button className="primary-button" disabled={busy}>{busy ? pick("جاري الإنشاء…", "Creating…") : pick("إنشاء", "Create")}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function TenantStatusDialog({ tenant, ownTenantId, onClose, onSaved }: {
  tenant: PlatformTenant; ownTenantId: string; onClose: () => void; onSaved: () => void;
}) {
  const tr = useText();
  const { pick } = useLanguage();
  const archived = tenant.status === "ARCHIVED";
  const own = tenant.id === ownTenantId;
  const options = (["ACTIVE", "SUSPENDED", "ARCHIVED"] as const).filter((s) => s !== tenant.status && (!own || s === "ACTIVE"));
  const [status, setStatus] = useState<PlatformTenant["status"]>(options[0] ?? "ACTIVE");
  const [reason, setReason] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const labels = { ACTIVE: pick("تفعيل", "Activate"), SUSPENDED: pick("تعليق", "Suspend"), ARCHIVED: pick("أرشفة (نهائي)", "Archive (permanent)") };
  const blocked = archived || options.length === 0;
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || blocked) return;
    setBusy(true);
    setError("");
    try {
      await platform.setTenantStatus(tenant.id, status, reason.trim());
      onSaved();
    } catch (failure) {
      setError(errorOf(failure, pick("تعذر تغيير الحالة", "Unable to change the status")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={pick("حالة مساحة العمل", "Workspace status")} onClose={onClose}>
      <form className="ta-dialog" onSubmit={submit}>
        <p><strong>{tr(tenant.name)}</strong> · <bdi dir="ltr">{tenant.code}</bdi></p>
        {archived && <p className="ta-note">{pick("مساحة العمل هذه مؤرشفة ولا يمكن تغيير حالتها.", "This workspace is archived and its status cannot be changed.")}</p>}
        {own && !archived && <p className="ta-note">{pick("هذه مساحة العمل التي تعمل منها؛ لا يمكنك تعليقها أو أرشفتها.", "This is the workspace you are working from; you cannot suspend or archive it.")}</p>}
        <label>{pick("الحالة الجديدة", "New status")}
          <select disabled={blocked} value={status} onChange={(e) => { setStatus(e.target.value as PlatformTenant["status"]); setSure(false); }}>
            {options.map((s) => <option key={s} value={s}>{labels[s]}</option>)}
          </select>
        </label>
        <label>{pick("السبب (مطلوب)", "Reason (required)")}
          <textarea disabled={blocked} rows={3} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {status !== "ACTIVE" && !blocked && <p className="ta-note">{pick("ستنتهي جميع جلسات مساحة العمل فوراً.", "All sessions of this workspace end immediately.")}</p>}
        {status === "ARCHIVED" && !blocked && (
          <label className="ta-inline"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
            {pick("أفهم أن الأرشفة نهائية ولا يمكن التراجع عنها.", "I understand that archiving is final and cannot be undone.")}
          </label>
        )}
        {error && <p className="form-error" role="alert">{tr(error)}</p>}
        <div className="form-actions">
          <button type="button" className="ghost-button" onClick={onClose}>{pick("رجوع", "Cancel")}</button>
          <button className="primary-button" disabled={busy || blocked || (status === "ARCHIVED" && !sure)}>{busy ? pick("جاري الحفظ…", "Saving…") : pick("تأكيد", "Confirm")}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function TenantActivityDialog({ tenant, timeZone, onClose }: { tenant: PlatformTenant; timeZone?: string; onClose: () => void }) {
  const tr = useText();
  const { pick } = useLanguage();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    platform.tenantActivity(tenant.id)
      .then((rows) => { if (live) setEvents(rows); })
      .catch((failure) => { if (live) setError(errorOf(failure, pick("تعذر تحميل النشاط", "Unable to load the activity"))); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id]);
  return (
    <Dialog title={pick("نشاط مساحة العمل", "Workspace activity")} onClose={onClose}>
      <div className="ta-dialog">
        <p><strong>{tr(tenant.name)}</strong> · <bdi dir="ltr">{tenant.code}</bdi></p>
        {!events && !error && <p role="status">{pick("جاري تحميل النشاط…", "Loading activity…")}</p>}
        {error && <p className="form-error" role="alert">{tr(error)}</p>}
        {events && (events.length === 0 ? <p className="empty-state">{pick("لا يوجد نشاط مسجل.", "No recorded activity.")}</p> : (
          <>
            <AuditTable events={events} actors={new Map()} timeZone={timeZone} caption={pick("نشاط مساحة العمل", "Workspace activity")} />
            {events.length >= 200 && <p className="ta-note">{pick("يعرض السجل أحدث 200 حدث فقط.", "Only the latest 200 events are shown.")}</p>}
          </>
        ))}
      </div>
    </Dialog>
  );
}

export function UnlockLoginDialog({ onClose, onDone }: { onClose: () => void; onDone: (text: string) => void }) {
  const tr = useText();
  const { pick } = useLanguage();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const target = email.trim();
      await platform.unlockLogin(target);
      onDone(`${pick("تم الطلب لـ", "Unlock requested for")} ${target}. ${pick("إن كان الحساب محظوراً فيمكنه تسجيل الدخول الآن؛ لا يُعرض أي إشعار إن لم يكن محظوراً.", "If the account was blocked it can sign in again now; nothing is reported when it was not blocked.")}`);
    } catch (failure) {
      setError(errorOf(failure, pick("تعذر رفع الحظر", "Unable to unlock sign-in")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={pick("رفع حظر تسجيل الدخول", "Unlock sign-in")} onClose={onClose}>
      <form className="ta-dialog" onSubmit={submit}>
        <p className="ta-note">{pick("بعد محاولات دخول فاشلة متكررة يُحظر الدخول مؤقتاً. أدخل بريد الحساب لرفع الحظر فوراً. تُسجَّل العملية في سجل التدقيق.", "After repeated failed sign-ins an account is blocked for a while. Enter the account email to lift the block now. The action is recorded in the audit trail.")}</p>
        <label>{pick("البريد الإلكتروني للحساب", "Account email")}
          <input type="email" dir="ltr" required maxLength={320} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{tr(error)}</p>}
        <div className="form-actions">
          <button type="button" className="ghost-button" onClick={onClose}>{pick("رجوع", "Cancel")}</button>
          <button className="primary-button" disabled={busy}>{busy ? pick("جاري التنفيذ…", "Working…") : pick("رفع الحظر", "Unlock")}</button>
        </div>
      </form>
    </Dialog>
  );
}
