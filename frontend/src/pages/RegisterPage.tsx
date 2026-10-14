import { useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, Building2, CheckCircle2, Compass, Eye, EyeOff, LockKeyhole } from "lucide-react";
import { useAuth } from "../auth/auth-context";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../i18n/LanguageSwitch";
import { useLanguage } from "../i18n/useLanguage";
import { useText } from "../i18n/useText";
import { api, type ProviderType, type RegistrationInput } from "../lib/api";
import { AuthStory } from "./LoginPage";
import { ResendVerification } from "./credentials/ResendVerification";
import "./auth-premium.css";

const kinds = ["customer", "provider"] as const;
const providerTypes: Array<[ProviderType, string, string]> = [
  ["UMRAH_COMPANY", "شركة عمرة", "Umrah company"], ["TRAVEL_COMPANY", "شركة سياحة", "Travel company"],
  ["HOTEL", "فندق", "Hotel"], ["AIRLINE", "شركة طيران", "Airline"], ["TRANSPORT", "شركة نقل", "Transport"],
  ["RESTAURANT", "مطعم", "Restaurant"], ["VISA", "تأشيرات", "Visa services"], ["VISIT", "زيارات", "Tours"], ["OTHER", "خدمة أخرى", "Other service"]
];

/** Moves keyboard focus to the confirmation so the outcome is announced and reachable. */
const focusOnMount = (node: HTMLElement | null) => node?.focus();

export function RegisterPage() {
  const tr = useText();
  const { pick } = useLanguage();
  const { kind } = useParams();
  const { user } = useAuth();
  const [form, setForm] = useState<RegistrationInput>({ displayName: "", email: "", password: "", tenantCode: "safry", organizationName: "", organizationNameEn: "", type: "UMRAH_COMPANY", city: "", phone: "", licenseNumber: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  if (user) return <Navigate to={user.isPlatformAdmin ? "/admin/accounts-permissions" : "/workspace/overview"} replace />;
  if (!kinds.some(item => item === kind)) return <Navigate to="/register/customer" replace />;
  const currentKind = kind as typeof kinds[number];
  const isProvider = currentKind === "provider";
  const loginLink = `/login/${currentKind}`;

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setSuccess(false);
    try {
      const base = { displayName: form.displayName, email: form.email, password: form.password, tenantCode: form.tenantCode };
      const input = isProvider ? { ...base, organizationName: form.organizationName, organizationNameEn: form.organizationNameEn, type: form.type, city: form.city, phone: form.phone, licenseNumber: form.licenseNumber } : base;
      await api.register(currentKind, input); setSuccess(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : pick("تعذر إنشاء الحساب", "Unable to create the account")); }
    finally { setBusy(false); }
  }

  return <main className="premium-auth premium-auth--register">
    <AuthStory portal={currentKind} />
    <section className="auth-panel">
      <div className="auth-panel__top"><div className="auth-mobile-brand"><Brand compact /></div><LanguageSwitch /></div>
      <div className="auth-card auth-card--register">
        <Link className="auth-back" to={loginLink}><ArrowLeft size={16} className="auth-directional" />{pick("العودة إلى تسجيل الدخول", "Back to sign in")}</Link>
        {success ? <div className="auth-success" role="status" ref={focusOnMount} tabIndex={-1}><CheckCircle2 size={42} aria-hidden="true" /><h1>{pick("تحقق من بريدك الإلكتروني", "Check your email")}</h1><p>{pick("تم إنشاء حسابك. أرسلنا رابط تأكيد إلى بريدك الإلكتروني إن لزم؛ أكّده ثم سجّل الدخول. الرابط صالح لفترة قصيرة.", "Your account was created. If your email needs confirming, we sent you a link. Confirm it, then sign in. The link is valid for a short time.")}</p><div className="credential-resend-panel"><p className="credential-resend-hint">{pick("لم تصلك الرسالة؟ تحقق من البريد غير المرغوب فيه أو اطلب رابطاً جديداً.", "No message? Check your spam folder or ask for a new link.")}</p><ResendVerification initialEmail={form.email} /></div><Link className="auth-submit" to={loginLink}>{pick("متابعة إلى تسجيل الدخول", "Continue to sign in")}<ArrowLeft size={18} className="auth-directional" /></Link></div> : <>
          <header className="auth-heading"><span className="auth-eyebrow">{pick("ابدأ مع سفري", "Get started with Safry")}</span><h2>{isProvider ? pick("لنبدأ بشركتك", "Let's start with your company") : pick("رحلتك تبدأ بحساب", "Your journey starts here")}</h2><p>{isProvider ? pick("سجّل منشأتك، ثم نظّم خدماتك وفريقك من مساحة واحدة.", "Register your organization, then organize your services and team in one workspace.") : pick("أنشئ حسابك لاستكشاف الخدمات ومتابعة حجوزاتك.", "Create an account to discover services and keep track of your bookings.")}</p></header>
          <nav className="auth-portals auth-portals--two" aria-label={pick("نوع الحساب", "Account type")}><Link aria-current={!isProvider ? "page" : undefined} to="/register/customer"><Compass size={17} />{pick("حساب مسافر", "Traveler account")}</Link><Link aria-current={isProvider ? "page" : undefined} to="/register/provider"><Building2 size={17} />{pick("حساب شركة", "Company account")}</Link></nav>
          <form className="auth-form auth-form--register" onSubmit={event => void submit(event)} aria-busy={busy}>
            <fieldset className="auth-fieldset"><legend><span>01</span>{isProvider ? pick("بيانات مدير الشركة", "Company manager details") : pick("بيانات حسابك", "Your account details")}</legend><div className="auth-form-grid">
              <label><span>{pick("الاسم الكامل", "Full name")}</span><input required minLength={2} maxLength={200} value={form.displayName} onChange={event => setForm({ ...form, displayName: event.target.value })} autoComplete="name" /></label>
              <label><span>{pick("البريد الإلكتروني", "Email address")}</span><input required type="email" dir="ltr" placeholder="name@company.com" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} autoComplete="email" /></label>
              <label><span>{pick("كلمة المرور", "Password")}</span><div className="auth-input"><input required type={showPassword ? "text" : "password"} dir="ltr" minLength={12} maxLength={128} value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} autoComplete="new-password" aria-describedby="password-help" /><button className="auth-password-toggle" type="button" aria-label={showPassword ? pick("إخفاء كلمة المرور", "Hide password") : pick("إظهار كلمة المرور", "Show password")} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div><small className="auth-field-hint" id="password-help">{pick("12 حرفاً على الأقل. اختر كلمة مرور يصعب تخمينها.", "At least 12 characters. Choose a password that is hard to guess.")}</small></label>
              <label><span>{pick("رمز الجهة", "Workspace code")}</span><input required minLength={2} maxLength={64} pattern="[a-z0-9-]+" dir="ltr" value={form.tenantCode} onChange={event => setForm({ ...form, tenantCode: event.target.value.toLowerCase() })} /><small className="auth-field-hint">{pick("اترك safry ما لم يكن لديك رمز آخر.", "Keep safry unless you have another code.")}</small></label>
            </div></fieldset>
            {isProvider && <fieldset className="auth-fieldset"><legend><span>02</span>{pick("بيانات المنشأة", "Organization details")}</legend><div className="auth-form-grid">
              <label><span>{pick("اسم الشركة بالعربية", "Company name in Arabic")}</span><input dir="rtl" lang="ar" required minLength={3} maxLength={200} value={form.organizationName} onChange={event => setForm({ ...form, organizationName: event.target.value })} /></label>
              <label><span>{pick("اسم الشركة بالإنجليزية", "Company name in English")}</span><input dir="ltr" lang="en" required minLength={3} maxLength={200} value={form.organizationNameEn} onChange={event => setForm({ ...form, organizationNameEn: event.target.value })} /></label>
              <label><span>{pick("نوع مقدم الخدمة", "Provider type")}</span><select value={form.type} onChange={event => setForm({ ...form, type: event.target.value as ProviderType })}>{providerTypes.map(([value, ar, en]) => <option key={value} value={value}>{pick(ar, en)}</option>)}</select></label>
              <label><span>{pick("المدينة", "City")}</span><input required minLength={2} maxLength={120} value={form.city} onChange={event => setForm({ ...form, city: event.target.value })} autoComplete="address-level2" /></label>
              <label><span>{pick("الهاتف", "Phone")} <small>{pick("اختياري", "Optional")}</small></span><input type="tel" dir="ltr" maxLength={32} value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} autoComplete="tel" /></label>
              <label><span>{pick("رقم الترخيص", "License number")} <small>{pick("اختياري", "Optional")}</small></span><input maxLength={120} value={form.licenseNumber} onChange={event => setForm({ ...form, licenseNumber: event.target.value })} /></label>
            </div></fieldset>}
            {isProvider && <div className="auth-notice"><Building2 size={18} /><p>{pick("أكّد بريدك الإلكتروني أولاً ثم سجّل الدخول. نشر الخدمات يتطلب موافقة الإدارة، ويضيف مدير المنشأة موظفيه من لوحة الشركة.", "Confirm your email address first, then sign in. Publishing services requires approval, and the organization manager adds staff from the company workspace.")}</p></div>}
            {error && <p className="auth-error" role="alert">{tr(error)}</p>}
            <button className="auth-submit" type="submit" disabled={busy}>{busy ? pick("جاري إنشاء الحساب…", "Creating your account…") : isProvider ? pick("إنشاء حساب الشركة", "Create company account") : pick("إنشاء حسابي", "Create my account")}<ArrowLeft size={19} className="auth-directional" /></button>
          </form>
          <p className="auth-switch-account">{pick("لديك حساب بالفعل؟", "Already have an account?")} <Link to={loginLink}>{pick("تسجيل الدخول", "Sign in")}</Link></p>
        </>}
      </div>
      <footer className="auth-panel__footer"><LockKeyhole size={14} />{pick("مساحتك الخاصة لإدارة السفر", "Your personal travel workspace")}</footer>
    </section>
  </main>;
}
