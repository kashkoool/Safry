import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CircleUserRound, RefreshCw } from "lucide-react";
import { useAuth } from "../auth/auth-context";
import { useLanguage } from "../i18n/useLanguage";
import { useText } from "../i18n/useText";
import { currentLocale } from "../i18n/locale";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { tenantAdmin, type AuditEvent, type Member, type MemberStatus, type RoleSummary } from "../lib/tenant-admin";
import { useTenantTimeZone } from "../lib/useTenantTimeZone";
import { Dialog } from "./Dialog";
import { AuditTable } from "./AuditTable";
import "../pages/tenant-admin.css";

const STEP = 25;
const CAP = 500;
type Target = Exclude<MemberStatus, "INVITED">;
const errorOf = (reason: unknown, fallback: string): string => (reason instanceof Error ? reason.message : fallback);

function useStatusText() {
  const { pick } = useLanguage();
  return (member: Pick<Member, "status" | "awaitingOwnerConsent">): string => {
    if (member.status === "INVITED" && member.awaitingOwnerConsent) return pick("بانتظار قبول الدعوة", "Awaiting acceptance");
    return ({
      ACTIVE: pick("نشط", "Active"), SUSPENDED: pick("موقوف", "Suspended"),
      REVOKED: pick("ملغى", "Revoked"), INVITED: pick("مدعو", "Invited")
    } as Record<string, string>)[member.status] ?? member.status;
  };
}

function useRoleName() {
  const { pick } = useLanguage();
  const names: Record<string, string> = {
    "tenant-admin": pick("مدير الجهة", "Workspace administrator"), "service-provider": pick("مقدم خدمة", "Service provider"),
    "travel-company": pick("شركة سياحة", "Travel company"), traveler: pick("مسافر", "Traveler"),
    "organization-manager": pick("مدير المنشأة", "Company manager")
  };
  return (code: string, name: string): string => names[code] ?? name;
}

export function TeamDirectory() {
  const tr = useText();
  const { pick } = useLanguage();
  const { user } = useAuth();
  const statusText = useStatusText();
  const roleName = useRoleName();
  const timeZone = useTenantTimeZone();
  const perms = user?.permissions ?? [];
  const canManage = perms.includes("identity.user.manage");
  const canHistory = perms.includes("identity.user.read") && perms.includes("audit.read");
  const canRoles = perms.includes("identity.role.manage");
  const isTenantAdmin = Boolean(user?.roles.includes("tenant-admin"));
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 300);
  const [statusFilter, setStatusFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [shown, setShown] = useState(STEP);
  const [tick, setTick] = useState(0);
  const [statusFor, setStatusFor] = useState<Member | null>(null);
  const [historyFor, setHistoryFor] = useState<Member | null>(null);
  const [rolesFor, setRolesFor] = useState<Member | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    tenantAdmin.members(query, controller.signal)
      .then((rows) => { if (live) { setMembers(rows); setError(""); setShown(STEP); } })
      .catch((reason) => {
        if (live && !(reason instanceof DOMException && reason.name === "AbortError")) setError(errorOf(reason, pick("تعذر تحميل المستخدمين", "Unable to load users")));
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tick]);

  const roleOptions = useMemo(() => {
    const seen = new Map<string, string>();
    members.forEach((m) => m.roles.forEach(({ role }) => seen.set(role.code, role.name)));
    return [...seen.entries()];
  }, [members]);
  const filtered = useMemo(() => members.filter((m) =>
    (!statusFilter || (statusFilter === "AWAITING" ? m.awaitingOwnerConsent : m.status === statusFilter && !m.awaitingOwnerConsent)) &&
    (!roleFilter || m.roles.some(({ role }) => role.code === roleFilter))), [members, statusFilter, roleFilter]);
  const actors = useMemo(() => new Map(members.map((m) => [m.user.id, m.user.displayName])), [members]);

  function done(text: string): void {
    setStatusFor(null);
    setRolesFor(null);
    setMessage(text);
    setTick((value) => value + 1);
  }
  const protectedRow = (m: Member): boolean => m.user.id === user?.userId || (!isTenantAdmin && m.roles.some(({ role }) => role.code === "tenant-admin"));

  return (
    <section className="work-panel ta-panel" aria-busy={loading}>
      <h2>{pick("مستخدمو مساحة العمل", "Workspace users")}</h2>
      <p className="form-hint">{pick("ابحث عن الأعضاء، غيّر حالتهم أو أدوارهم، واطّلع على سجل التغييرات.", "Find members, change their status or roles, and review their change history.")}</p>
      <div className="ta-toolbar" role="search">
        <label className="ta-grow">{pick("بحث بالاسم أو البريد", "Search by name or email")}
          <input type="search" value={q} maxLength={100} autoComplete="off" onChange={(e) => setQ(e.target.value)} placeholder={pick("اسم أو بريد إلكتروني…", "Name or email…")} />
        </label>
        <label>{pick("الحالة", "Status")}
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setShown(STEP); }}>
            <option value="">{pick("الكل", "All")}</option>
            <option value="ACTIVE">{pick("نشط", "Active")}</option>
            <option value="SUSPENDED">{pick("موقوف", "Suspended")}</option>
            <option value="REVOKED">{pick("ملغى", "Revoked")}</option>
            <option value="AWAITING">{pick("بانتظار قبول الدعوة", "Awaiting acceptance")}</option>
          </select>
        </label>
        <label>{pick("الدور", "Role")}
          <select value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setShown(STEP); }}>
            <option value="">{pick("كل الأدوار", "All roles")}</option>
            {roleOptions.map(([code, name]) => <option key={code} value={code}>{roleName(code, name)}</option>)}
          </select>
        </label>
        <button className="ghost-button" disabled={loading} onClick={() => setTick((v) => v + 1)}><RefreshCw size={16} /> {pick("تحديث", "Refresh")}</button>
      </div>
      <p className="form-hint">{pick("البحث يتم على الخادم؛ تصفية الحالة والدور تتم على النتائج المحمّلة.", "Search runs on the server; the status and role filters apply to the loaded results.")}</p>
      {error && <p className="form-error" role="alert">{tr(error)}</p>}
      {message && <p className="workspace-alert" role="status">{tr(message)}</p>}
      {loading && <p role="status">{pick("جاري تحميل المستخدمين…", "Loading users…")}</p>}
      {!loading && !error && (
        <>
          <p className="ta-count" role="status">{pick("المعروض:", "Showing:")} {Math.min(shown, filtered.length).toLocaleString(currentLocale())} / {filtered.length.toLocaleString(currentLocale())}</p>
          {members.length >= CAP && <p className="ta-note">{pick("تعرض القائمة أول 500 عضو فقط. استخدم البحث لتضييق النتائج.", "The list shows only the first 500 members. Use search to narrow the results.")}</p>}
          {filtered.length === 0 ? <p className="empty-state">{pick("لا يوجد مستخدمون مطابقون.", "No matching users.")}</p> : (
            <div className="ta-table-wrap">
              <table className="ta-table">
                <caption className="ta-visually-hidden">{pick("مستخدمو مساحة العمل", "Workspace users")}</caption>
                <thead><tr>
                  <th scope="col">{pick("العضو", "Member")}</th><th scope="col">{pick("الأدوار", "Roles")}</th>
                  <th scope="col">{pick("الحالة", "Status")}</th><th scope="col">{pick("الإجراءات", "Actions")}</th>
                </tr></thead>
                <tbody>
                  {filtered.slice(0, shown).map((m) => {
                    const locked = protectedRow(m);
                    return (
                      <tr key={m.id}>
                        <td data-label={pick("العضو", "Member")}>
                          <strong><CircleUserRound size={15} aria-hidden="true" /> {tr(m.user.displayName)}</strong>
                          <small dir="ltr">{m.user.email}</small>
                          {m.jobTitle && <small>{tr(m.jobTitle)}</small>}
                        </td>
                        <td data-label={pick("الأدوار", "Roles")}>{m.roles.length ? m.roles.map(({ role }) => <span key={role.code} className="role-pill">{roleName(role.code, role.name)}</span>) : "—"}</td>
                        <td data-label={pick("الحالة", "Status")}><span className={`ta-badge ${m.status === "ACTIVE" ? "" : "ta-badge--warn"}`}>{statusText(m)}</span></td>
                        <td data-label={pick("الإجراءات", "Actions")}>
                          <div className="ta-actions">
                            {canHistory && <button className="ghost-button" onClick={() => setHistoryFor(m)}>{pick("السجل", "History")}</button>}
                            {canManage && !locked && <button className="ghost-button" onClick={() => setStatusFor(m)}>{pick("تغيير الحالة", "Change status")}</button>}
                            {canRoles && !locked && m.status !== "REVOKED" && !m.awaitingOwnerConsent && <button className="ghost-button" onClick={() => setRolesFor(m)}>{pick("الأدوار", "Roles")}</button>}
                            {locked && <small>{m.user.id === user?.userId ? pick("حسابك الحالي", "Your own account") : pick("حساب مدير الجهة", "Workspace administrator")}</small>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {shown < filtered.length && <div className="ta-more"><button className="ghost-button" onClick={() => setShown((v) => v + STEP)}>{pick("عرض المزيد", "Load more")} ({(filtered.length - shown).toLocaleString(currentLocale())})</button></div>}
        </>
      )}
      {statusFor && <StatusDialog member={statusFor} onClose={() => setStatusFor(null)} onDone={done} />}
      {rolesFor && <AssignRolesDialog member={rolesFor} onClose={() => setRolesFor(null)} onDone={done} roleName={roleName} />}
      {historyFor && <HistoryDialog member={historyFor} actors={actors} timeZone={timeZone} onClose={() => setHistoryFor(null)} />}
    </section>
  );
}

function StatusDialog({ member, onClose, onDone }: { member: Member; onClose: () => void; onDone: (text: string) => void }) {
  const tr = useText();
  const { pick } = useLanguage();
  const awaiting = member.awaitingOwnerConsent;
  const all: Target[] = ["ACTIVE", "SUSPENDED", "REVOKED"];
  const options: Target[] = (awaiting ? all.filter((s) => s === "REVOKED") : all).filter((s) => s !== member.status);
  const [status, setStatus] = useState<Target>(options[0] ?? "REVOKED");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const labels: Record<Target, string> = { ACTIVE: pick("تفعيل", "Activate"), SUSPENDED: pick("إيقاف مؤقت", "Suspend"), REVOKED: pick("إلغاء العضوية", "Revoke membership") };
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await tenantAdmin.setMemberStatus(member.id, status, reason.trim() || undefined);
      onDone(pick("تم تحديث حالة العضو", "Member status updated"));
    } catch (failure) {
      setError(errorOf(failure, pick("تعذر تحديث الحالة", "Unable to update the status")));
    } finally {
      setBusy(false);
    }
  }
  const needsReason = status !== "ACTIVE";
  return (
    <Dialog title={pick("تغيير حالة العضو", "Change member status")} onClose={onClose}>
      <form className="ta-dialog" onSubmit={submit}>
        <p><strong>{tr(member.user.displayName)}</strong> · <bdi dir="ltr">{member.user.email}</bdi></p>
        {awaiting && <p className="ta-note">{pick("هذه الدعوة بانتظار قبول صاحب الحساب، لذا لا يمكن إلا سحبها (إلغاء العضوية).", "This invitation is awaiting the account holder, so it can only be withdrawn (revoke membership).")}</p>}
        <label>{pick("الحالة الجديدة", "New status")}
          <select value={status} onChange={(e) => setStatus(e.target.value as Target)}>
            {options.map((s) => <option key={s} value={s}>{labels[s]}</option>)}
          </select>
        </label>
        <label>{needsReason ? pick("السبب (مطلوب)", "Reason (required)") : pick("السبب (اختياري)", "Reason (optional)")}
          <textarea rows={3} value={reason} maxLength={500} minLength={needsReason ? 3 : undefined} required={needsReason} onChange={(e) => setReason(e.target.value)} aria-describedby="status-hint" />
          <span id="status-hint" className="ta-field-hint">{pick("بين 3 و500 حرف. يُسجَّل في سجل التدقيق.", "3 to 500 characters. Recorded in the audit trail.")}</span>
        </label>
        {needsReason && <p className="ta-note">{pick("ستنتهي جلسات هذا العضو في مساحة العمل فوراً.", "This member's sessions in this workspace end immediately.")}</p>}
        {error && <p className="form-error" role="alert">{tr(error)}</p>}
        <div className="form-actions">
          <button type="button" className="ghost-button" onClick={onClose}>{pick("رجوع", "Cancel")}</button>
          <button className="primary-button" disabled={busy || !options.length}>{busy ? pick("جاري الحفظ…", "Saving…") : pick("تأكيد", "Confirm")}</button>
        </div>
      </form>
    </Dialog>
  );
}

function AssignRolesDialog({ member, onClose, onDone, roleName }: {
  member: Member; onClose: () => void; onDone: (text: string) => void; roleName: (code: string, name: string) => string;
}) {
  const tr = useText();
  const { pick } = useLanguage();
  const [roles, setRoles] = useState<RoleSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const held = new Set(member.roles.map(({ role }) => role.code));
    tenantAdmin.roles()
      .then((rows) => { if (live) { setRoles(rows); setSelected(new Set(rows.filter((r) => held.has(r.code)).map((r) => r.id))); } })
      .catch((failure) => { if (live) setError(errorOf(failure, pick("تعذر تحميل الأدوار", "Unable to load roles"))); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member]);
  function toggle(id: string): void {
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await tenantAdmin.assignRoles(member.id, [...selected]);
      onDone(pick("تم تحديث أدوار العضو", "Member roles updated"));
    } catch (failure) {
      setError(errorOf(failure, pick("تعذر تحديث الأدوار", "Unable to update roles")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={pick("أدوار العضو", "Member roles")} onClose={onClose}>
      <form className="ta-dialog" onSubmit={submit}>
        <p><strong>{tr(member.user.displayName)}</strong> · <bdi dir="ltr">{member.user.email}</bdi></p>
        {!roles && !error && <p role="status">{pick("جاري تحميل الأدوار…", "Loading roles…")}</p>}
        {roles && (
          <fieldset className="ta-matrix"><legend>{pick("اختر دوراً واحداً على الأقل (حتى 20)", "Choose at least one role (up to 20)")}</legend>
            {roles.map((r) => (
              <label key={r.id} className="ta-perm ta-inline">
                <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                <span>{r.isSystem ? roleName(r.code, r.name) : tr(r.name)}<small>{r.isSystem ? pick("دور نظام", "System role") : pick("دور مخصص", "Custom role")}</small></span>
              </label>
            ))}
          </fieldset>
        )}
        <p className="ta-note">{pick("عند الحفظ يُسجَّل خروج العضو لتسري الصلاحيات الجديدة.", "Saving signs the member out so the new access takes effect.")}</p>
        {error && <p className="form-error" role="alert">{tr(error)}</p>}
        <div className="form-actions">
          <button type="button" className="ghost-button" onClick={onClose}>{pick("رجوع", "Cancel")}</button>
          <button className="primary-button" disabled={busy || !roles || selected.size < 1 || selected.size > 20}>{busy ? pick("جاري الحفظ…", "Saving…") : pick("حفظ", "Save")}</button>
        </div>
      </form>
    </Dialog>
  );
}

function HistoryDialog({ member, actors, timeZone, onClose }: { member: Member; actors: Map<string, string>; timeZone?: string; onClose: () => void }) {
  const tr = useText();
  const { pick } = useLanguage();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    tenantAdmin.memberHistory(member.id)
      .then((rows) => { if (live) setEvents(rows); })
      .catch((failure) => { if (live) setError(errorOf(failure, pick("تعذر تحميل السجل", "Unable to load the history"))); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id]);
  return (
    <Dialog title={pick("سجل العضو", "Member history")} onClose={onClose}>
      <div className="ta-dialog">
        <p><strong>{tr(member.user.displayName)}</strong> · <bdi dir="ltr">{member.user.email}</bdi></p>
        {!events && !error && <p role="status">{pick("جاري تحميل السجل…", "Loading history…")}</p>}
        {error && <p className="form-error" role="alert">{tr(error)}</p>}
        {events && (events.length === 0 ? <p className="empty-state">{pick("لا توجد أحداث مسجلة.", "No recorded events.")}</p> : (
          <>
            <AuditTable events={events} actors={actors} timeZone={timeZone} caption={pick("سجل العضو", "Member history")} />
            {events.length >= 200 && <p className="ta-note">{pick("يعرض السجل أحدث 200 حدث فقط.", "The history shows the latest 200 events only.")}</p>}
          </>
        ))}
      </div>
    </Dialog>
  );
}
