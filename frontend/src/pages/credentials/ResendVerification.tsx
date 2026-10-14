import { useRef, useState, useId, type FormEvent } from "react";
import { Mail, Send } from "lucide-react";
import { useLanguage } from "../../i18n/useLanguage";
import { useText } from "../../i18n/useText";
import { credentials } from "../../lib/credentials";
import { errorText } from "../../lib/errors";
import { useRetryCountdown } from "../../lib/useRetryCountdown";
import { FocusMessage } from "./FocusMessage";
import "./credentials.css";

/** The server allows one mail per minute per account; the button waits as long, then offers another send. */
export const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Asks for a new confirmation link. The answer is always the same neutral sentence, so the form never reveals whether
 * an address has an account or is already confirmed.
 */
export function ResendVerification({ initialEmail = "" }: { initialEmail?: string }) {
  const { pick } = useLanguage();
  const tr = useText();
  const fieldId = useId();
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const cooldown = useRetryCountdown();
  const errorId = `${fieldId}-error`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || cooldown.remaining > 0) return;
    inFlight.current = true; setBusy(true); setError(""); setSent(false);
    try {
      await credentials.resendVerification(email.trim());
      setSent(true);
      cooldown.start(RESEND_COOLDOWN_SECONDS);
    } catch (reason) {
      cooldown.note(reason);
      setError(errorText(reason, pick, tr));
    } finally { inFlight.current = false; setBusy(false); }
  }

  const label = busy ? pick("جاري الإرسال…", "Sending…")
    : cooldown.remaining > 0 ? pick(`يمكنك الإرسال مجدداً بعد ${cooldown.remaining} ث`, `Send again in ${cooldown.remaining} s`)
      : sent ? pick("إرسال رابط جديد", "Send another link") : pick("إرسال رابط التأكيد", "Send confirmation link");

  return <form className="auth-form credential-resend" onSubmit={event => void submit(event)} aria-busy={busy}>
    <label htmlFor={fieldId}><span>{pick("البريد الإلكتروني", "Email address")}</span>
      <div className="auth-input"><Mail size={18} aria-hidden="true" />
        <input id={fieldId} type="email" dir="ltr" name="email" placeholder="name@company.com" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" required maxLength={320} disabled={busy}
          aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} /></div>
    </label>
    {sent && <FocusMessage kind="success">{pick("إن كان هذا البريد مسجلاً ولم يُؤكَّد بعد، فقد أرسلنا إليه رابطاً جديداً. تحقق من صندوق الوارد والبريد غير المرغوب فيه.", "If this address has an account that is not confirmed yet, we sent it a new link. Check your inbox and spam folder.")}</FocusMessage>}
    {error && <p className="auth-error" id={errorId} role="alert">{error}</p>}
    <button className="auth-submit" type="submit" disabled={busy || cooldown.remaining > 0}>{label}<Send size={18} className="auth-directional" aria-hidden="true" /></button>
  </form>;
}
