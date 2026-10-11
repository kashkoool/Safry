import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useLanguage } from "../i18n/useLanguage";

/**
 * The server invalidated this user's old MFA recovery codes (GET /auth/mfa ->
 * recoveryCodesRegenerationRequired). A modal that cannot be dismissed (no Esc, no backdrop close) walks the user through
 * POST /auth/mfa/recovery-codes (password + current TOTP) and shows the new codes once. The codes live only in component state:
 * never stored, and dropped as soon as the user confirms they saved them.
 */
export function MfaRecoveryNotice() {
  const { pick } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [required, setRequired] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api.mfaStatus().then(
      (status) => { if (live) setRequired(status.enabled && status.recoveryCodesRegenerationRequired); },
      () => undefined // the notice is best effort: a failed status call must not break the dashboard
    );
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (required && element && !element.open) element.showModal();
  }, [required]);

  if (!required) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.regenerateRecoveryCodes(password, code);
      setCodes(result.recoveryCodes);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : pick("تعذر إنشاء الرموز. تحقق من كلمة المرور والرمز.", "Could not create the codes. Check your password and code."));
    } finally {
      setPassword("");
      setCode("");
      setBusy(false);
    }
  }

  async function copy() {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setError(pick("تعذر النسخ، حمّل الملف بدلاً من ذلك.", "Copy failed, download the file instead."));
    }
  }

  function download() {
    if (!codes) return;
    const url = URL.createObjectURL(new Blob([codes.join("\n") + "\n"], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "safry-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  function done() {
    setCodes(null);
    setRequired(false);
    dialog.current?.close();
  }

  return (
    <dialog
      ref={dialog}
      className="business-dialog"
      aria-labelledby="mfa-recovery-title"
      onCancel={(event) => event.preventDefault()} // Esc must not dismiss it
    >
      <header>
        <h2 id="mfa-recovery-title">{pick("أنشئ رموز استرداد جديدة", "Create new recovery codes")}</h2>
      </header>
      {!codes ? (
        <form onSubmit={(event) => void submit(event)}>
          <p role="alert">
            {pick(
              "أُلغيت رموز الاسترداد القديمة لحسابك ولن تعمل. أنشئ مجموعة جديدة الآن حتى لا تفقد الوصول إذا فقدت هاتفك.",
              "Your old recovery codes were switched off and no longer work. Create a new set now so you are not locked out if you lose your phone."
            )}
          </p>
          <label>
            {pick("كلمة المرور الحالية", "Current password")}
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label>
            {pick("رمز التحقق من التطبيق", "Authenticator app code")}
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} dir="ltr" />
          </label>
          {error && <p role="alert" className="form-error">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy}>{pick("إنشاء الرموز", "Create codes")}</button>
        </form>
      ) : (
        <div>
          <p>
            {pick(
              "احفظ هذه الرموز في مكان آمن. كل رمز يعمل مرة واحدة ولن تظهر مرة أخرى.",
              "Save these codes somewhere safe. Each works once and they will not be shown again."
            )}
          </p>
          <ul dir="ltr" aria-label={pick("رموز الاسترداد", "Recovery codes")}>
            {codes.map((c) => <li key={c}><code>{c}</code></li>)}
          </ul>
          <div>
            <button type="button" className="secondary-button" onClick={() => void copy()}>{copied ? pick("تم النسخ", "Copied") : pick("نسخ", "Copy")}</button>
            {" "}
            <button type="button" className="secondary-button" onClick={download}>{pick("تنزيل", "Download")}</button>
          </div>
          {error && <p role="alert" className="form-error">{error}</p>}
          <label>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />{" "}
            {pick("حفظت الرموز", "I have saved these codes")}
          </label>
          <button className="primary-button" type="button" disabled={!saved} onClick={done}>{pick("تم", "Done")}</button>
        </div>
      )}
    </dialog>
  );
}
