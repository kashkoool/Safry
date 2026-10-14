import { useState } from "react";
import { api, getLoginPortal } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { useRetryCountdown } from "../../lib/useRetryCountdown";
import { Modal } from "../BusinessForms";
import { SessionsPanel } from "../SessionsPanel";
import { useLanguage } from "../../i18n/useLanguage";
import { useText } from "../../i18n/useText";

/** The active sign-ins list plus "sign out everywhere" (POST /auth/logout-all, which also ends THIS sign-in). */
export function SessionsSection() {
  const { pick } = useLanguage();
  const tr = useText();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const throttle = useRetryCountdown();

  async function signOutEverywhere() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.logoutAll();
      // The server ended every session and the client state is already cleared: a full navigation drops anything left in memory.
      window.location.replace(`/login/${getLoginPortal() ?? "customer"}`);
    } catch (reason) {
      throttle.note(reason);
      setError(errorText(reason, pick, tr));
      setBusy(false);
    }
  }

  return (
    <div className="account-stack">
      <SessionsPanel />
      <article className="work-panel" aria-labelledby="signout-all-title">
        <h2 id="signout-all-title">{pick("تسجيل الخروج من كل مكان", "Sign out everywhere")}</h2>
        <p className="form-hint">
          {pick(
            "يُنهي كل جلسات حسابك على كل الأجهزة، ومنها هذا الجهاز. ستحتاج إلى تسجيل الدخول من جديد.",
            "Ends every sign-in of your account on every device, including this one. You will need to sign in again."
          )}
        </p>
        <button type="button" className="secondary-button account-danger" onClick={() => { setError(""); setConfirming(true); }}>
          {pick("تسجيل الخروج من كل الأجهزة", "Sign out of all devices")}
        </button>
      </article>
      {confirming && (
        <Modal title={pick("تسجيل الخروج من كل الأجهزة؟", "Sign out of all devices?")} onClose={() => { if (!busy) setConfirming(false); }}>
          <div className="account-form">
            <p>{pick("ستنتهي كل الجلسات الآن، ومنها هذه الجلسة، وستعود إلى صفحة تسجيل الدخول.", "Every sign-in ends now, including this one, and you return to the sign-in page.")}</p>
            {error && <p role="alert" className="form-error">{error}</p>}
            <div className="account-actions">
              <button type="button" className="primary-button" disabled={busy || throttle.remaining > 0} onClick={() => void signOutEverywhere()}>
                {throttle.remaining > 0 ? pick(`أعد المحاولة بعد ${throttle.remaining} ث`, `Try again in ${throttle.remaining} s`) : pick("تسجيل الخروج من الكل", "Sign out of all")}
              </button>
              <button type="button" className="ghost-button" disabled={busy} onClick={() => setConfirming(false)}>{pick("إلغاء", "Cancel")}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
