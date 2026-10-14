import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useLanguage } from "../i18n/useLanguage";
import { useText } from "../i18n/useText";
import { ApiError, getLoginPortal } from "../lib/api";
import { credentials } from "../lib/credentials";
import { errorText } from "../lib/errors";
import { useCooldown } from "../lib/useCooldown";
import { CredentialLayout } from "./credentials/CredentialLayout";
import { FocusMessage } from "./credentials/FocusMessage";
import { ResendVerification } from "./credentials/ResendVerification";
import { useFragmentToken } from "./credentials/useFragmentToken";

type Phase = "verifying" | "verified" | "invalid" | "failed";

export function VerifyEmailPage() {
  const { pick } = useLanguage();
  const tr = useText();
  const { token, forget } = useFragmentToken();
  const [phase, setPhase] = useState<Phase>(token ? "verifying" : "invalid");
  const [failure, setFailure] = useState("");
  const started = useRef(false);
  const cooldown = useCooldown();

  async function verify(value: string) {
    setPhase("verifying"); setFailure("");
    try { await credentials.verifyEmail(value); forget(); setPhase("verified"); }
    catch (reason) {
      if (reason instanceof ApiError && reason.status === 400) { forget(); setPhase("invalid"); return; }
      // Network failure, throttle or server fault: the link may still be good, so keep the token and offer a retry.
      cooldown.note(reason);
      setFailure(errorText(reason, pick, tr));
      setPhase("failed");
    }
  }

  // Verifies exactly once on load. The guard also covers the development-only double effect run.
  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    void verify(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one automatic attempt per page load
  }, []);

  const portal = getLoginPortal() ?? "customer";
  const eyebrow = pick("تأكيد البريد الإلكتروني", "Email confirmation");
  const title = phase === "verified" ? pick("تم تأكيد بريدك", "Email confirmed")
    : phase === "invalid" ? pick("الرابط غير صالح", "This link cannot be used")
      : pick("نؤكد بريدك الإلكتروني", "Confirming your email");

  return <CredentialLayout eyebrow={eyebrow} title={title}>
    {phase === "verifying" && <div className="credential-message credential-message--info" role="status" aria-busy="true"><span className="credential-spinner" aria-hidden="true" /><div><strong>{pick("جاري التحقق من الرابط…", "Checking your link…")}</strong><p>{pick("لحظات وننتهي.", "This only takes a moment.")}</p></div></div>}
    {phase === "verified" && <>
      <FocusMessage kind="success" title={pick("بريدك الإلكتروني مؤكَّد", "Your email address is confirmed")}>{pick("يمكنك الآن تسجيل الدخول إلى حسابك.", "You can now sign in to your account.")}</FocusMessage>
      <div className="credential-actions"><Link className="auth-submit" to={`/login/${portal}`}>{pick("متابعة إلى تسجيل الدخول", "Continue to sign in")}<ArrowLeft size={18} className="auth-directional" aria-hidden="true" /></Link></div>
    </>}
    {phase === "invalid" && <>
      <FocusMessage kind="error" title={pick("الرابط غير صالح أو انتهت صلاحيته", "The link is invalid or has expired")}>{pick("روابط التأكيد تُستخدم مرة واحدة ولمدة محدودة. أدخل بريدك لنرسل لك رابطاً جديداً.", "Confirmation links work once and only for a limited time. Enter your email address and we will send a new one.")}</FocusMessage>
      <ResendVerification />
    </>}
    {phase === "failed" && <>
      <FocusMessage kind="error" title={pick("تعذر إكمال التأكيد", "We could not finish confirming")}>{failure}</FocusMessage>
      <div className="credential-actions"><button className="auth-submit" type="button" disabled={cooldown.remaining > 0 || !token} onClick={() => token && void verify(token)}>{cooldown.remaining > 0 ? pick(`أعد المحاولة بعد ${cooldown.remaining} ث`, `Try again in ${cooldown.remaining} s`) : pick("إعادة المحاولة", "Try again")}<RefreshCw size={18} aria-hidden="true" /></button></div>
    </>}
  </CredentialLayout>;
}
