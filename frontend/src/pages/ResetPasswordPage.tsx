import { useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Eye, EyeOff, LockKeyhole } from "lucide-react";
import { useLanguage } from "../i18n/useLanguage";
import { useText } from "../i18n/useText";
import { ApiError, getLoginPortal } from "../lib/api";
import { credentials, passwordStrength, PASSWORD_MAX, PASSWORD_MIN } from "../lib/credentials";
import { errorText } from "../lib/errors";
import { useRetryCountdown } from "../lib/useRetryCountdown";
import { CredentialLayout } from "./credentials/CredentialLayout";
import { FocusMessage } from "./credentials/FocusMessage";
import { useFragmentToken } from "./credentials/useFragmentToken";

type Phase = "form" | "done" | "invalid";
const INVALID_LINK = /invalid or expired/i;

export function ResetPasswordPage() {
  const { pick } = useLanguage();
  const tr = useText();
  const ids = useId();
  const { token, forget } = useFragmentToken();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<Phase>(token ? "form" : "invalid");
  const inFlight = useRef(false);
  const cooldown = useRetryCountdown();
  const strength = passwordStrength(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const errorId = `${ids}-error`;
  const helpId = `${ids}-help`;
  const strengthId = `${ids}-strength`;
  const confirmErrorId = `${ids}-confirm-error`;

  const strengthText = strength === "short" ? pick("أقصر من الحد الأدنى", "Shorter than the minimum")
    : strength === "weak" ? pick("ضعيفة: امزج أنواعاً مختلفة من الأحرف", "Weak: mix different kinds of characters")
      : strength === "fair" ? pick("مقبولة", "Fair") : pick("قوية", "Strong");
  const level = { short: 0, weak: 1, fair: 3, strong: 4 }[strength];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || cooldown.remaining > 0 || !token) return;
    if (password.trim().length === 0 || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      setError(pick(`كلمة المرور يجب أن تكون بين ${PASSWORD_MIN} و${PASSWORD_MAX} حرفاً.`, `The password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`)); return;
    }
    if (password !== confirm) { setError(pick("كلمتا المرور غير متطابقتين.", "The two passwords do not match.")); return; }
    inFlight.current = true; setBusy(true); setError("");
    try {
      await credentials.resetPassword(token, password);
      setPassword(""); setConfirm(""); setShow(false);
      forget();
      setPhase("done");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 400 && INVALID_LINK.test(reason.message)) {
        forget(); setPassword(""); setConfirm(""); setPhase("invalid");
      } else { cooldown.note(reason); setError(errorText(reason, pick, tr)); }
    } finally { inFlight.current = false; setBusy(false); }
  }

  const portal = getLoginPortal() ?? "customer";
  const eyebrow = pick("استعادة الحساب", "Account recovery");

  if (phase === "done") return <CredentialLayout eyebrow={eyebrow} title={pick("تم تغيير كلمة المرور", "Password changed")}>
    <FocusMessage kind="success" title={pick("كلمة مرورك الجديدة جاهزة", "Your new password is set")}>{pick("تم إنهاء جميع الجلسات الأخرى المفتوحة لحسابك. سجّل الدخول الآن بكلمة المرور الجديدة.", "All other sessions signed in to your account were ended. Sign in now with your new password.")}</FocusMessage>
    <div className="credential-actions"><Link className="auth-submit" to={`/login/${portal}`}>{pick("متابعة إلى تسجيل الدخول", "Continue to sign in")}<ArrowLeft size={18} className="auth-directional" aria-hidden="true" /></Link></div>
  </CredentialLayout>;

  if (phase === "invalid") return <CredentialLayout eyebrow={eyebrow} title={pick("الرابط غير صالح", "This link cannot be used")}>
    <FocusMessage kind="error" title={pick("الرابط غير صالح أو انتهت صلاحيته", "The link is invalid or has expired")}>{pick("روابط استعادة كلمة المرور تُستخدم مرة واحدة ولمدة قصيرة. اطلب رابطاً جديداً للمتابعة.", "Password reset links work once and only for a short time. Request a new link to continue.")}</FocusMessage>
    <div className="credential-actions"><Link className="auth-submit" to="/forgot-password">{pick("طلب رابط جديد", "Request a new link")}<ArrowLeft size={18} className="auth-directional" aria-hidden="true" /></Link></div>
  </CredentialLayout>;

  const toggle = <button className="auth-password-toggle" type="button" onClick={() => setShow(value => !value)} aria-label={show ? pick("إخفاء كلمة المرور", "Hide password") : pick("إظهار كلمة المرور", "Show password")} aria-pressed={show}>{show ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}</button>;

  return <CredentialLayout eyebrow={eyebrow} title={pick("اختر كلمة مرور جديدة", "Choose a new password")}
    intro={pick("بعد التغيير سيتم تسجيل خروجك من جميع الأجهزة الأخرى.", "After the change you are signed out of all your other devices.")}>
    <form className="auth-form" onSubmit={event => void submit(event)} aria-busy={busy}>
      <label htmlFor={`${ids}-new`}><span>{pick("كلمة المرور الجديدة", "New password")}</span>
        <div className="auth-input"><LockKeyhole size={18} aria-hidden="true" />
          <input id={`${ids}-new`} type={show ? "text" : "password"} dir="ltr" name="new-password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" autoFocus required minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} disabled={busy}
            aria-invalid={error ? true : undefined} aria-describedby={`${helpId} ${strengthId}${error ? ` ${errorId}` : ""}`} />{toggle}</div>
        <small className="auth-field-hint" id={helpId}>{pick(`من ${PASSWORD_MIN} إلى ${PASSWORD_MAX} حرفاً. اختر عبارة يصعب تخمينها ولا تستخدمها في موقع آخر.`, `${PASSWORD_MIN} to ${PASSWORD_MAX} characters. Pick a phrase that is hard to guess and not used anywhere else.`)}</small>
      </label>
      <div className="credential-strength" data-level={strength} id={strengthId}>
        <div className="credential-strength__bars" aria-hidden="true">{[1, 2, 3, 4].map(n => <span key={n} data-on={n <= level} />)}</div>
        <span className="credential-strength__label">{password ? `${pick("قوة كلمة المرور", "Password strength")}: ${strengthText}` : ""}</span>
      </div>
      <label htmlFor={`${ids}-confirm`}><span>{pick("تأكيد كلمة المرور", "Confirm password")}</span>
        <div className="auth-input"><LockKeyhole size={18} aria-hidden="true" />
          <input id={`${ids}-confirm`} type={show ? "text" : "password"} dir="ltr" name="confirm-password" value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="new-password" required maxLength={PASSWORD_MAX} disabled={busy}
            aria-invalid={mismatch ? true : undefined} aria-describedby={confirmErrorId} /></div>
        <small className="auth-field-hint" id={confirmErrorId}>{mismatch ? pick("كلمتا المرور غير متطابقتين.", "The two passwords do not match.") : ""}</small>
      </label>
      {error && <p className="auth-error" id={errorId} role="alert">{error}</p>}
      <button className="auth-submit" type="submit" disabled={busy || cooldown.remaining > 0}>{busy ? pick("جاري الحفظ…", "Saving…") : cooldown.remaining > 0 ? pick(`أعد المحاولة بعد ${cooldown.remaining} ث`, `Try again in ${cooldown.remaining} s`) : pick("تغيير كلمة المرور", "Change password")}<ArrowLeft size={19} className="auth-directional" aria-hidden="true" /></button>
    </form>
  </CredentialLayout>;
}
