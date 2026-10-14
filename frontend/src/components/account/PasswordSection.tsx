import { useId, useState, type FormEvent } from "react";
import { account } from "../../lib/account";
import { errorText } from "../../lib/errors";
import { useRetryCountdown } from "../../lib/useRetryCountdown";
import { useLanguage } from "../../i18n/useLanguage";
import { useText } from "../../i18n/useText";

/** POST /auth/password. The server ends every OTHER sign-in of the account; this one stays, and the page says so. */
export function PasswordSection() {
  const { pick } = useLanguage();
  const tr = useText();
  const id = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState<{ field: "next" | "confirm"; text: string } | null>(null);
  const [done, setDone] = useState(false);
  const throttle = useRetryCountdown();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setDone(false);
    if (!next.trim()) return setFieldError({ field: "next", text: pick("كلمة المرور الجديدة لا يمكن أن تكون فراغات فقط.", "The new password cannot be only spaces.") });
    if (next === current) return setFieldError({ field: "next", text: pick("يجب أن تختلف كلمة المرور الجديدة عن الحالية.", "The new password must be different from the current one.") });
    if (next !== confirm) return setFieldError({ field: "confirm", text: pick("التأكيد لا يطابق كلمة المرور الجديدة.", "The confirmation does not match the new password.") });
    setFieldError(null);
    setBusy(true);
    try {
      await account.changePassword(current, next);
      setDone(true);
    } catch (reason) {
      throttle.note(reason);
      setError(errorText(reason, pick, tr, { wrongSecret: pick("كلمة المرور الحالية غير صحيحة.", "The current password is incorrect.") }));
    } finally {
      // Secrets never outlive the attempt, whatever the outcome.
      setCurrent("");
      setNext("");
      setConfirm("");
      setBusy(false);
    }
  }

  return (
    <form className="account-form" onSubmit={(event) => void submit(event)}>
      <p className="form-hint">
        {pick(
          "بعد التغيير يُنهى تسجيل دخولك على كل الأجهزة الأخرى، ويبقى هذا الجهاز مسجّلاً.",
          "After you change it, every other device is signed out. This device stays signed in."
        )}
      </p>
      <label>
        {pick("كلمة المرور الحالية", "Current password")}
        <input dir="ltr" type="password" required minLength={8} maxLength={128} autoComplete="current-password" value={current}
          onChange={(event) => setCurrent(event.target.value)} />
      </label>
      <label>
        {pick("كلمة المرور الجديدة", "New password")}
        <input dir="ltr" type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={next}
          aria-describedby={`${id}-rule${fieldError?.field === "next" ? ` ${id}-next` : ""}`} aria-invalid={fieldError?.field === "next" || undefined}
          onChange={(event) => { setFieldError(null); setNext(event.target.value); }} />
        <small id={`${id}-rule`} className="form-hint">{pick("12 خانة على الأقل، وتختلف عن الحالية.", "At least 12 characters, different from the current one.")}</small>
        {fieldError?.field === "next" && <small id={`${id}-next`} role="alert" className="account-field-error">{fieldError.text}</small>}
      </label>
      <label>
        {pick("تأكيد كلمة المرور الجديدة", "Confirm new password")}
        <input dir="ltr" type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirm}
          aria-describedby={fieldError?.field === "confirm" ? `${id}-confirm` : undefined} aria-invalid={fieldError?.field === "confirm" || undefined}
          onChange={(event) => { setFieldError(null); setConfirm(event.target.value); }} />
        {fieldError?.field === "confirm" && <small id={`${id}-confirm`} role="alert" className="account-field-error">{fieldError.text}</small>}
      </label>
      {error && <p role="alert" className="form-error">{error}</p>}
      {done && (
        <p role="status" className="workspace-alert">
          {pick("تم تغيير كلمة المرور. أُنهيت جلساتك على الأجهزة الأخرى.", "Password changed. Your other devices were signed out.")}
        </p>
      )}
      <div className="account-actions">
        <button className="primary-button" type="submit" disabled={busy || throttle.remaining > 0}>
          {throttle.remaining > 0 ? pick(`أعد المحاولة بعد ${throttle.remaining} ث`, `Try again in ${throttle.remaining} s`) : pick("تغيير كلمة المرور", "Change password")}
        </button>
      </div>
    </form>
  );
}
