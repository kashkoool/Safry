import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Mail, Send } from "lucide-react";
import { useLanguage } from "../i18n/useLanguage";
import { useText } from "../i18n/useText";
import { credentials } from "../lib/credentials";
import { errorText } from "../lib/errors";
import { useRetryCountdown } from "../lib/useRetryCountdown";
import { CredentialLayout } from "./credentials/CredentialLayout";
import { FocusMessage } from "./credentials/FocusMessage";
import { RESEND_COOLDOWN_SECONDS } from "./credentials/ResendVerification";

export function ForgotPasswordPage() {
  const { pick } = useLanguage();
  const tr = useText();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const cooldown = useRetryCountdown();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || cooldown.remaining > 0) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await credentials.forgotPassword(email.trim());
      // Same answer for every address: never hint whether an account exists.
      setSent(true);
      cooldown.start(RESEND_COOLDOWN_SECONDS);
    } catch (reason) {
      cooldown.note(reason);
      setError(errorText(reason, pick, tr));
    } finally { inFlight.current = false; setBusy(false); }
  }

  const label = busy ? pick("جاري الإرسال…", "Sending…")
    : cooldown.remaining > 0 ? pick(`يمكنك الإرسال مجدداً بعد ${cooldown.remaining} ث`, `Send again in ${cooldown.remaining} s`)
      : sent ? pick("إرسال الرابط مجدداً", "Send the link again") : pick("إرسال رابط الاستعادة", "Send reset link");

  return <CredentialLayout eyebrow={pick("استعادة الحساب", "Account recovery")} title={pick("نسيت كلمة المرور؟", "Forgot your password?")}
    intro={pick("اكتب بريدك الإلكتروني وسنرسل لك رابطاً لتعيين كلمة مرور جديدة.", "Enter your email address and we will send you a link to choose a new password.")}>
    {sent && <FocusMessage kind="success" title={pick("تحقق من بريدك", "Check your email")}>{pick("إن كان لهذا البريد حساب، فقد أرسلنا إليه رابطاً لتعيين كلمة مرور جديدة. الرابط صالح لفترة قصيرة. إن لم يصلك، تحقق من البريد غير المرغوب فيه.", "If an account exists for this address, we sent it a link to set a new password. The link is valid for a short time. If you do not see it, check your spam folder.")}</FocusMessage>}
    <form className="auth-form" onSubmit={event => void submit(event)} aria-busy={busy}>
      <label htmlFor="forgot-email"><span>{pick("البريد الإلكتروني", "Email address")}</span>
        <div className="auth-input"><Mail size={18} aria-hidden="true" />
          <input id="forgot-email" type="email" dir="ltr" name="email" placeholder="name@company.com" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" autoFocus required maxLength={320} disabled={busy}
            aria-invalid={error ? true : undefined} aria-describedby={error ? "forgot-error" : undefined} /></div>
      </label>
      {error && <p className="auth-error" id="forgot-error" role="alert">{error}</p>}
      <button className="auth-submit" type="submit" disabled={busy || cooldown.remaining > 0}>{label}<Send size={18} className="auth-directional" aria-hidden="true" /></button>
    </form>
    <p className="auth-switch-account">{pick("تذكرت كلمة المرور؟", "Remembered it?")} <Link to="/login/customer">{pick("تسجيل الدخول", "Sign in")}</Link></p>
  </CredentialLayout>;
}
