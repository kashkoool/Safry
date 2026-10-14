import { useState } from "react";
import { useLanguage } from "../../i18n/useLanguage";

/**
 * Shows a fresh set of recovery codes exactly once. The codes live only in the parent's state: `onDone` fires after the
 * user confirms they saved them and the parent must drop them. Nothing is written to web storage.
 */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { pick } = useLanguage();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setError("");
    } catch {
      setError(pick("تعذر النسخ. نزّل الملف بدلاً من ذلك.", "Copy failed. Download the file instead."));
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`${codes.join("\n")}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "safry-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="account-codes">
      <p>
        {pick(
          "احفظ هذه الرموز في مكان آمن. كل رمز يعمل مرة واحدة فقط، ولن تظهر هذه الرموز مرة أخرى.",
          "Save these codes somewhere safe. Each code works once, and they will not be shown again."
        )}
      </p>
      <ul dir="ltr" aria-label={pick("رموز الاسترداد", "Recovery codes")}>
        {codes.map((code) => <li key={code}><code>{code}</code></li>)}
      </ul>
      <div className="account-actions">
        <button type="button" className="secondary-button" onClick={() => void copy()}>
          {copied ? pick("تم النسخ", "Copied") : pick("نسخ الرموز", "Copy codes")}
        </button>
        <button type="button" className="secondary-button" onClick={download}>{pick("تنزيل ملف", "Download file")}</button>
      </div>
      <p role="status" className="form-hint">{copied ? pick("نُسخت الرموز إلى الحافظة.", "The codes were copied to the clipboard.") : ""}</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <label className="account-check">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        {pick("حفظت الرموز في مكان آمن", "I have saved these codes")}
      </label>
      <button type="button" className="primary-button" disabled={!saved} onClick={onDone}>{pick("تم", "Done")}</button>
    </div>
  );
}
