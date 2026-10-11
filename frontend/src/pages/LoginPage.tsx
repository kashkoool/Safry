import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowUpRight, Building2, Compass, Eye, EyeOff, Globe2, Hotel, KeyRound, LockKeyhole, Mail, Plane, ShieldCheck } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/auth-context";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../i18n/LanguageSwitch";
import { useLanguage } from "../i18n/useLanguage";
import { useText } from "../i18n/useText";
import type { LoginInput, MfaChallenge } from "../lib/api";
import "./auth-premium.css";

type Portal = "customer" | "provider" | "admin";
const DEMOS = [
  { portal: "admin", label: ["مدير المنصة", "Platform admin"], email: "admin@safry.local" },
  { portal: "provider", label: ["شركة سياحة", "Travel company"], email: "provider@safry.local" },
  { portal: "customer", label: ["المسافر", "Traveler"], email: "traveler@safry.local" },
  ...[
    ["شركة عمرة", "Umrah company", "umrah"], ["فندق", "Hotel", "hotel"],
    ["شركة طيران", "Airline", "airline"], ["شركة نقل", "Transport", "transport"],
    ["مطعم", "Restaurant", "restaurant"], ["تأشيرات", "Visa", "visa"], ["زيارات", "Tours", "visit"]
  ].map(([ar, en, alias]) => ({ portal: "provider", label: [ar, en], email: `${alias}@safry.local` }))
];

/** Shared travel identity. Decorative graphics never imply live booking data. */
export function AuthStory({ portal }: { portal: Portal }) {
  const { pick } = useLanguage();
  return <section className="auth-story" aria-label={pick("عن سفري", "About Safry")}>
    <Brand />
    <div className="auth-story__copy">
      <span className="auth-eyebrow"><span />{pick("عالم السفر. في مكان واحد.", "A world of travel. One workspace.")}</span>
      <h1>{portal === "customer"
        ? <>{pick("رحلتك القادمة،", "Your next journey,")}<br /><em>{pick("تبدأ من هنا.", "starts here.")}</em></>
        : portal === "provider"
          ? <>{pick("خدماتك أقرب.", "Connect your services.")}<br /><em>{pick("أعمالك أوضح.", "Simplify your day.")}</em></>
          : <>{pick("الصورة الكاملة،", "The complete picture,")}<br /><em>{pick("في متناولك.", "within reach.")}</em></>}</h1>
      <p>{portal === "customer"
        ? pick("اكتشف خدمات السفر، اختر ما يناسبك، وتابع حجوزاتك من مساحة واحدة واضحة.", "Discover travel services, find what suits you, and keep your bookings together in one clear space.")
        : portal === "provider"
          ? pick("مساحة تجمع خدمات منشأتك وحجوزاتها وفريقها، لتبقى التفاصيل منظمة والخطوة التالية واضحة.", "Bring your company's services, bookings, and team together. Keep the details organized and the next step clear.")
          : pick("تابع نشاط المنصة، وأدر الحسابات والصلاحيات من مساحة مخصصة لإدارة النظام.", "Follow platform activity and manage accounts and permissions in a dedicated administration workspace.")}</p>
    </div>
    <div className="auth-orbit" aria-hidden="true">
      <svg className="auth-orbit__map" viewBox="0 0 560 310" fill="none">
        <defs>
          <radialGradient id="auth-globe"><stop stopColor="#243b54" stopOpacity=".5" /><stop offset="1" stopColor="#142134" stopOpacity=".1" /></radialGradient>
          <linearGradient id="auth-route" x1="60" y1="210" x2="510" y2="60" gradientUnits="userSpaceOnUse"><stop stopColor="#d8b36a" stopOpacity=".1" /><stop offset=".5" stopColor="#d8b36a" /><stop offset="1" stopColor="#d8b36a" stopOpacity=".2" /></linearGradient>
        </defs>
        <circle cx="290" cy="160" r="135" fill="url(#auth-globe)" stroke="#31475e" />
        <ellipse cx="290" cy="160" rx="83" ry="135" stroke="#2a3d54" /><ellipse cx="290" cy="160" rx="35" ry="135" stroke="#2a3d54" />
        <ellipse cx="290" cy="160" rx="135" ry="48" stroke="#2a3d54" /><ellipse cx="290" cy="160" rx="135" ry="99" stroke="#2a3d54" />
        <path d="M155 160H425M290 25V295" stroke="#2a3d54" />
        <path d="M45 231C112 214 148 75 293 104C404 126 438 58 512 67" stroke="url(#auth-route)" strokeWidth="2" strokeDasharray="5 7" />
        <circle cx="160" cy="144" r="7" fill="#d8b36a" /><circle cx="160" cy="144" r="15" stroke="#d8b36a" strokeOpacity=".3" />
        <circle cx="414" cy="105" r="5" fill="#d8b36a" /><circle cx="414" cy="105" r="13" stroke="#d8b36a" strokeOpacity=".3" />
      </svg>
      <div className="auth-orbit__ticket auth-orbit__ticket--flight"><span><Plane size={20} /></span><div><small>{pick("استكشف", "Discover")}</small><strong>{pick("وجهتك القادمة", "Your next destination")}</strong></div><ArrowUpRight size={16} /></div>
      <div className="auth-orbit__ticket auth-orbit__ticket--stay"><span><Hotel size={20} /></span><div><small>{pick("إقامة ونقل وتجارب", "Stays, transfers & experiences")}</small><strong>{pick("كل تفاصيل السفر", "Every travel detail")}</strong></div></div>
      <span className="auth-orbit__compass"><Compass size={30} strokeWidth={1.2} /></span>
    </div>
    <div className="auth-story__footer"><Globe2 size={17} /><span>{pick("للمسافرين وشركاء السفر", "For travelers and travel partners")}</span><span className="auth-story__footer-dot" /><span>{pick("عربي / English", "English / العربية")}</span></div>
  </section>;
}

export function LoginPage({ portal }: { portal: Portal }) {
  const { pick } = useLanguage();
  const tr = useText();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, login, verifyMfa } = useAuth();
  const [form, setForm] = useState<LoginInput>({ email: "", password: "", tenantCode: "safry" });
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [code, setCode] = useState("");
  const returnTo = searchParams.get("returnTo");
  const title = portal === "customer" ? pick("أهلاً بعودتك", "Welcome back") : portal === "provider" ? pick("مساحة شركتك، بانتظارك", "Your workspace awaits") : pick("إدارة المنصة", "Platform administration");
  const portalLabel = portal === "customer" ? pick("بوابة المسافر", "Traveler portal") : portal === "provider" ? pick("بوابة شركاء السفر", "Travel partner portal") : pick("بوابة مدير النظام", "Administrator portal");

  useEffect(() => {
    if (!user) return;
    const fallback = user.isPlatformAdmin ? "/admin/accounts-permissions" : "/workspace/overview";
    // Normalize dot segments before checking internal routes. Never trust a supplied admin destination for a non-admin.
    const internalPath = returnTo?.startsWith("/") && !returnTo.startsWith("//") && !returnTo.includes("\\")
      && ![...returnTo].some(char => char.charCodeAt(0) < 32);
    const target = internalPath && returnTo ? new URL(returnTo, window.location.origin) : null;
    const safeReturn = target?.origin === window.location.origin && (
      /^\/workspace\/[^/]+(?:\/.*)?$/.test(target.pathname)
      || (user.isPlatformAdmin && /^\/admin\/[^/]+$/.test(target.pathname))
    );
    navigate(safeReturn && target ? `${target.pathname}${target.search}${target.hash}` : fallback, { replace: true });
  }, [user, navigate, returnTo]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setSubmitting(true);
    try {
      const pending = await login({ ...form, portal });
      if (pending) { setChallenge(pending); setCode(""); setForm(current => ({ ...current, password: "" })); }
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : pick("تعذر تسجيل الدخول", "Unable to sign in")); }
    finally { setSubmitting(false); }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!challenge) return; setError(""); setSubmitting(true);
    try { await verifyMfa(challenge.mfaToken, code.trim(), portal); }
    catch (reason) {
      // The server consumes the challenge on every attempt, right or wrong: a retry needs a fresh password login.
      setChallenge(null); setCode("");
      setError(reason instanceof Error ? reason.message : pick("تعذر التحقق من الرمز", "Unable to verify the code"));
    }
    finally { setSubmitting(false); }
  }

  return <main className={`premium-auth premium-auth--${portal}`}>
    <AuthStory portal={portal} />
    <section className="auth-panel">
      <div className="auth-panel__top"><div className="auth-mobile-brand"><Brand compact /></div><LanguageSwitch /></div>
      <div className="auth-card">
        <div className="auth-role-icon">{portal === "customer" ? <Compass /> : portal === "provider" ? <Building2 /> : <ShieldCheck />}</div>
        <header className="auth-heading"><span className="auth-eyebrow">{portalLabel}</span><h2>{title}</h2><p>{pick("سجّل الدخول لمتابعة رحلتك مع سفري.", "Sign in to continue your journey with Safry.")}</p></header>
        <nav className="auth-portals" aria-label={pick("بوابات الدخول", "Sign-in portals")}>
          <Link aria-current={portal === "customer" ? "page" : undefined} to="/login/customer"><Compass size={16} />{pick("المسافر", "Traveler")}</Link>
          <Link aria-current={portal === "provider" ? "page" : undefined} to="/login/provider"><Building2 size={16} />{pick("الشركات", "Partners")}</Link>
          <Link aria-current={portal === "admin" ? "page" : undefined} to="/login/admin"><ShieldCheck size={16} />{pick("الإدارة", "Admin")}</Link>
        </nav>
        {searchParams.has("expired") && <p className="auth-notice" role="status">{pick("انتهت جلستك. سجّل الدخول مجدداً للمتابعة.", "Your session ended. Sign in again to continue.")}</p>}
        {challenge ? <form className="auth-form" onSubmit={submitCode} aria-busy={submitting} aria-label={pick("التحقق بخطوتين", "Two-step verification")}>
          <p className="auth-notice" role="status">{pick("أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة، أو أحد رموز الاسترداد.", "Enter the 6-digit code from your authenticator app, or one of your recovery codes.")}</p>
          <label><span>{pick("رمز التحقق", "Verification code")}</span><div className="auth-input"><ShieldCheck size={18} /><input type="text" dir="ltr" inputMode="text" name="mfaCode" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" autoFocus minLength={6} maxLength={24} required /></div></label>
          {error && <p className="auth-error" role="alert">{tr(error)}</p>}
          <button className="auth-submit" type="submit" disabled={submitting}>{submitting ? pick("جاري التحقق…", "Verifying…") : pick("تأكيد", "Verify")}<ArrowLeft size={19} className="auth-directional" /></button>
          <button className="auth-link-button" type="button" onClick={() => { setChallenge(null); setCode(""); setError(""); }}>{pick("رجوع إلى تسجيل الدخول", "Back to sign in")}</button>
        </form> : <form className="auth-form" onSubmit={submit} aria-busy={submitting}>
          <label><span>{pick("البريد الإلكتروني", "Email address")}</span><div className="auth-input"><Mail size={18} /><input type="email" dir="ltr" placeholder="name@company.com" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} autoComplete="email" required /></div></label>
          <label><span>{pick("كلمة المرور", "Password")}</span><div className="auth-input"><LockKeyhole size={18} /><input type={showPassword ? "text" : "password"} dir="ltr" placeholder="••••••••••••" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} autoComplete="current-password" required /><button className="auth-password-toggle" type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? pick("إخفاء كلمة المرور", "Hide password") : pick("إظهار كلمة المرور", "Show password")} aria-pressed={showPassword}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
          <label><span>{pick("رمز الجهة", "Workspace code")}</span><div className="auth-input"><KeyRound size={18} /><input type="text" dir="ltr" value={form.tenantCode} onChange={event => setForm({ ...form, tenantCode: event.target.value.toLowerCase() })} autoComplete="organization" required /></div><small className="auth-field-hint">{pick("اترك الرمز safry ما لم تزودك جهتك برمز آخر.", "Keep safry unless your organization provided another code.")}</small></label>
          {error && <p className="auth-error" role="alert">{tr(error)}</p>}
          <button className="auth-submit" type="submit" disabled={submitting}>{submitting ? pick("جاري تسجيل الدخول…", "Signing in…") : pick("تسجيل الدخول", "Sign in")}<ArrowLeft size={19} className="auth-directional" /></button>
        </form>}
        {portal !== "admin" && <p className="auth-switch-account">{pick("جديد على سفري؟", "New to Safry?")} <Link to={`/register/${portal}`}>{pick("إنشاء حساب", "Create an account")}</Link></p>}
        {portal === "provider" && <p className="auth-staff-note">{pick("موظف في شركة؟ اطلب بيانات حسابك من مدير منشأتك.", "Company employee? Ask your organization manager for your account details.")}</p>}
        {import.meta.env.DEV && <details className="auth-demo"><summary>{pick("حسابات التجربة المحلية", "Local demo accounts")}</summary><p>{pick("اختر حساباً لتعبئة بريده، ثم أدخل كلمة المرور التي عيّنتها عند تشغيل البذر المحلي.", "Choose an account to fill in its email, then enter the password you set when you ran the local seed.")}</p><div>{DEMOS.filter(demo => demo.portal === portal).map(demo => <button type="button" key={demo.email} className={form.email === demo.email ? "is-selected" : ""} onClick={() => { setForm({ email: demo.email, password: "", tenantCode: "safry" }); setError(""); }}>{pick(demo.label[0], demo.label[1])}</button>)}</div></details>}
      </div>
      <footer className="auth-panel__footer"><LockKeyhole size={14} />{pick("مساحتك الخاصة لإدارة السفر", "Your personal travel workspace")}</footer>
    </section>
  </main>;
}
