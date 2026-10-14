import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAuth } from "../../auth/auth-context";
import { AuditTable } from "../../components/AuditTable";
import { useLanguage } from "../../i18n/useLanguage";
import { useText } from "../../i18n/useText";
import { currentLocale } from "../../i18n/locale";
import { tenantAdmin, type AuditEvent } from "../../lib/tenant-admin";
import { useTenantTimeZone } from "../../lib/useTenantTimeZone";

const STEP = 25;

/** Calendar day (YYYY-MM-DD) of an instant in the given zone; compared with the date inputs. */
function dayOf(iso: string, timeZone?: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone });
  } catch {
    return iso.slice(0, 10);
  }
}

export function AuditPanel() {
  const tr = useText();
  const { pick } = useLanguage();
  const { user } = useAuth();
  const timeZone = useTenantTimeZone();
  const canNames = Boolean(user?.permissions.includes("identity.user.read"));
  const [limit, setLimit] = useState(100);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [actors, setActors] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [shown, setShown] = useState(STEP);

  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    Promise.all([
      tenantAdmin.accessAudit(limit),
      canNames ? tenantAdmin.members("").catch(() => []) : Promise.resolve([])
    ])
      .then(([rows, members]) => {
        if (!live) return;
        setEvents(rows);
        setActors(new Map(members.map((m) => [m.user.id, m.user.displayName])));
        setError("");
        setShown(STEP);
      })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : pick("تعذر تحميل السجل", "Unable to load the audit trail")); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit, tick, canNames]);

  const actions = useMemo(() => [...new Set(events.map((e) => e.action))].sort(), [events]);
  const actorIds = useMemo(() => [...new Set(events.map((e) => e.actorUserId).filter((id): id is string => Boolean(id)))], [events]);
  const filtered = useMemo(() => events.filter((e) => {
    const day = dayOf(e.occurredAt, timeZone);
    return (!from || day >= from) && (!to || day <= to) && (!actor || e.actorUserId === actor) && (!action || e.action === action);
  }), [events, from, to, actor, action, timeZone]);

  return (
    <section className="work-panel ta-panel" aria-busy={loading}>
      <h2>{pick("سجل تغييرات الصلاحيات", "Permission change history")}</h2>
      <p className="form-hint">{pick("يعرض الأدوار والصلاحيات وإسناد الأدوار فقط، من الأحدث إلى الأقدم.", "Shows role, permission and role-assignment changes only, newest first.")}</p>
      <div className="ta-toolbar">
        <label>{pick("عدد السجلات المحمّلة", "Records to load")}
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>{pick("من تاريخ", "From date")}<input type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setShown(STEP); }} /></label>
        <label>{pick("إلى تاريخ", "To date")}<input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setShown(STEP); }} /></label>
        <label>{pick("المنفذ", "Actor")}
          <select value={actor} onChange={(e) => { setActor(e.target.value); setShown(STEP); }}>
            <option value="">{pick("الكل", "Everyone")}</option>
            {actorIds.map((id) => <option key={id} value={id}>{actors.get(id) ?? id.slice(0, 8)}</option>)}
          </select>
        </label>
        <label>{pick("العملية", "Action")}
          <select value={action} onChange={(e) => { setAction(e.target.value); setShown(STEP); }}>
            <option value="">{pick("الكل", "All")}</option>
            {actions.map((a) => <option key={a} value={a}>{tr(a)}</option>)}
          </select>
        </label>
        <button className="ghost-button" disabled={loading} onClick={() => setTick((v) => v + 1)}><RefreshCw size={16} aria-hidden="true" /> {pick("تحديث", "Refresh")}</button>
      </div>
      <p className="form-hint">{pick("المرشحات تعمل على السجلات المحمّلة (حتى 200 كحد أقصى)، وليس على كامل التاريخ.", "Filters apply to the loaded records (200 at most), not to the full history.")}</p>
      {error && <p className="form-error" role="alert">{tr(error)}</p>}
      {loading && <p role="status">{pick("جاري تحميل السجل…", "Loading the audit trail…")}</p>}
      {!loading && !error && (filtered.length === 0 ? <p className="empty-state">{pick("لا توجد أحداث مطابقة.", "No matching events.")}</p> : (
        <>
          <p className="ta-count" role="status">{pick("المعروض:", "Showing:")} {Math.min(shown, filtered.length).toLocaleString(currentLocale())} / {filtered.length.toLocaleString(currentLocale())}</p>
          <AuditTable events={filtered.slice(0, shown)} actors={actors} timeZone={timeZone} caption={pick("سجل تغييرات الصلاحيات", "Permission change history")} />
          {shown < filtered.length && <div className="ta-more"><button className="ghost-button" onClick={() => setShown((v) => v + STEP)}>{pick("عرض المزيد", "Load more")}</button></div>}
          {events.length >= limit && limit === 200 && <p className="ta-note">{pick("هذا هو الحد الأقصى؛ الأحداث الأقدم غير متاحة هنا.", "This is the maximum; older events are not available here.")}</p>}
        </>
      ))}
    </section>
  );
}
