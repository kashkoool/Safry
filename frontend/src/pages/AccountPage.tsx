import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowRight, LogOut } from "lucide-react";
import { useAuth } from "../auth/auth-context";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../i18n/LanguageSwitch";
import { useLanguage } from "../i18n/useLanguage";
import { ProfileSection } from "../components/account/ProfileSection";
import { PasswordSection } from "../components/account/PasswordSection";
import { TwoFactorSection } from "../components/account/TwoFactorSection";
import { SessionsSection } from "../components/account/SessionsSection";
import "./account.css";

const SECTIONS = ["profile", "security", "sessions"] as const;
type Section = (typeof SECTIONS)[number];
const isSection = (value: string | undefined): value is Section => SECTIONS.some((section) => section === value);

/** `/account/:section` for every signed-in user, whatever the portal or role: profile, password + two-factor, sign-ins. */
export function AccountPage() {
  const { pick } = useLanguage();
  const { user, logout } = useAuth();
  const { section } = useParams();
  if (!isSection(section)) return <Navigate to="/account/profile" replace />;

  const labels: Record<Section, string> = {
    profile: pick("الملف الشخصي", "Profile"),
    security: pick("الأمان", "Security"),
    sessions: pick("الجلسات", "Sign-ins")
  };

  return (
    <div className="account-page">
      <a className="workspace-skip-link" href="#account-content">{pick("تخطي إلى المحتوى", "Skip to content")}</a>
      <header className="account-header">
        <Brand compact />
        <div className="account-header__actions">
          <Link className="ghost-button" to="/workspace/overview">
            <ArrowRight className="auth-directional" size={16} aria-hidden="true" />
            {pick("العودة إلى مساحة العمل", "Back to workspace")}
          </Link>
          <LanguageSwitch />
          <button type="button" className="icon-button" aria-label={pick("تسجيل الخروج", "Sign out")}
            onClick={() => void logout().catch(() => window.location.reload())}>
            <LogOut size={19} aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="account-main" id="account-content" tabIndex={-1}>
        <h1>{pick("حسابي", "My account")}</h1>
        <p className="account-email" dir="ltr">{user?.email}</p>
        <nav className="account-tabs" aria-label={pick("أقسام الحساب", "Account sections")}>
          {SECTIONS.map((item) => (
            <Link key={item} to={`/account/${item}`} aria-current={item === section ? "page" : undefined}>{labels[item]}</Link>
          ))}
        </nav>
        {section === "profile" && (
          <article className="work-panel" aria-labelledby="account-profile-title">
            <h2 id="account-profile-title">{pick("بياناتك", "Your details")}</h2>
            <ProfileSection />
          </article>
        )}
        {section === "security" && (
          <div className="account-stack">
            <article className="work-panel" aria-labelledby="account-password-title">
              <h2 id="account-password-title">{pick("تغيير كلمة المرور", "Change password")}</h2>
              <PasswordSection />
            </article>
            <article className="work-panel" aria-labelledby="account-mfa-title">
              <h2 id="account-mfa-title">{pick("المصادقة الثنائية", "Two-factor sign-in")}</h2>
              <TwoFactorSection />
            </article>
          </div>
        )}
        {section === "sessions" && <SessionsSection />}
      </main>
    </div>
  );
}
