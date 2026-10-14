import { useEffect, useState } from "react";
import { api, type AuthSessionInfo } from "../lib/api";
import { useLanguage } from "../i18n/useLanguage";
import { useText } from "../i18n/useText";
import { errorText } from "../lib/errors";
import { currentLocale } from "../i18n/locale";

const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(currentLocale(), { calendar: "gregory" }) : "-";

/** The caller's own active logins (GET /auth/sessions) with a per-row revoke (DELETE /auth/sessions/:id). */
export function SessionsPanel() {
  const { pick } = useLanguage();
  const tr = useText();
  const [rows, setRows] = useState<AuthSessionInfo[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.sessions().then(
      (list) => { if (live) { setRows(list); setError(""); } },
      (reason: unknown) => {
        if (live) setError(errorText(reason, pick, tr, { fallback: pick("تعذر تحميل الجلسات", "Could not load sessions") }));
      }
    );
    return () => { live = false; };
  }, [tick, pick, tr]);

  async function revoke(id: string) {
    setBusyId(id);
    try {
      await api.endSession(id);
      setTick((n) => n + 1);
    } catch (reason) {
      setError(errorText(reason, pick, tr, { fallback: pick("تعذر إنهاء الجلسة", "Could not end the session") }));
    } finally {
      setBusyId("");
    }
  }

  return (
    <article className="work-panel" aria-labelledby="sessions-title">
      <h2 id="sessions-title">{pick("جلسات الدخول النشطة", "Active sign-ins")}</h2>
      <p className="form-hint">
        {pick("أنهِ أي جلسة لا تعرفها. إنهاء الجلسة يمنع تجديدها.", "End any sign-in you do not recognise. Ending a sign-in stops it from renewing.")}
      </p>
      {error && <p role="alert" className="form-error">{error}</p>}
      {rows && rows.length === 0 && <p className="form-hint">{pick("لا توجد جلسات نشطة.", "No active sign-ins.")}</p>}
      <ul className="sessions-list">
        {rows?.map((row) => (
          <li key={row.id}>
            <div>
              <strong dir="ltr">{row.userAgent || pick("جهاز غير معروف", "Unknown device")}</strong>
              <div className="form-hint" dir="ltr">
                {row.ipAddress || "-"} · {pick("آخر استخدام:", "Last used:")} {when(row.lastUsedAt)}
              </div>
              <div className="form-hint">{pick("تسجيل الدخول:", "Signed in:")} {when(row.signedInAt)}</div>
            </div>
            <button className="secondary-button" disabled={busyId === row.id} onClick={() => void revoke(row.id)}>
              {pick("إنهاء الجلسة", "End session")}
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}
